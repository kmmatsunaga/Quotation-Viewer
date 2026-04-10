"""
メールを自動カテゴリ分けするスクリプト (Gemini API版)

・未分類のメールだけを対象に順次処理（インクリメンタル）
・Gemini APIでバッチ処理（1回30件ずつ）
・結果をcsmail_categoryテーブルに保存

実行: python categorize.py [--table receive|send|both] [--limit 500]
"""

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone

from google import genai
from google.cloud import bigquery
from google.oauth2 import service_account

from config import (
    PROJECT_ID, DATASET_ID, TABLE_RECEIVE, TABLE_SEND, TABLE_CATEGORY,
    BQ_KEY_PATH, GEMINI_MODEL, BATCH_SIZE, MAX_BODY_CHARS, CATEGORIES,
    EXCLUDE_SUBJECT_PATTERNS,
)

def extract_latest_message(body: str, max_chars: int = 500) -> str:
    """
    メール本文から最新（一番上）のメッセージ部分のみを抽出する。
    引用された過去のやり取りは除外する。
    """
    if not body:
        return ""

    # 引用ブロックの開始を示すパターン（ここより後は過去メール）
    QUOTE_PATTERNS = [
        r"\n{1,2}From:",                          # 英語Outlook: From: xxxx
        r"\n{1,2}差出人:",                         # 日本語Outlook
        r"\n{1,2}送信元:",
        r"\n{1,2}On .{5,50}wrote:",               # Gmail英語: On Mon, Jan 1 wrote:
        r"\n{1,2}_{5,}",                          # _____ 区切り線
        r"\n{1,2}-{5,}",                          # ----- 区切り線
        r"\n{1,2}[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日.{0,30}[0-9]{1,2}:[0-9]{2}",  # 2025年1月9日(木) 14:39
        r"\n{1,2}>[ \t]*[^\n]",                   # > 引用行
    ]

    combined = "|".join(f"(?:{p})" for p in QUOTE_PATTERNS)
    match = re.search(combined, body)
    latest = body[:match.start()] if match else body
    return latest.strip()[:max_chars]


# カテゴリのJSON文字列（プロンプト用）
CATEGORY_JSON = json.dumps(CATEGORIES, ensure_ascii=False, indent=2)

SYSTEM_PROMPT = f"""あなたはコンテナ船社のカスタマーサービスメール分類専門家です。
受信・送信メールを以下のカテゴリに分類してください。

カテゴリ一覧:
{CATEGORY_JSON}

注意:
- Subject（件名）と Body（本文冒頭）から判断してください
- 文字化けしている場合も、英語キーワード（BOOKING, OOG, DG, B/L, SI, VGM, SOC, SCHEDULE等）で判断できます
- 複数の内容が含まれる場合は最も主要なものを選んでください
- 確信度（confidence）は0.0〜1.0で評価してください（文字化けで不明確な場合は低めに）
"""


def get_bq_client():
    creds = service_account.Credentials.from_service_account_file(BQ_KEY_PATH)
    return bigquery.Client(project=PROJECT_ID, credentials=creds)


def fetch_uncategorized(bq_client, source_table: str, limit: int) -> list[dict]:
    """まだcsmail_categoryに登録されていないメールを取得"""
    table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{source_table}`"
    cat_ref = f"`{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}`"

    query = f"""
        SELECT m.message_id, m.Subject, LEFT(m.Body, {MAX_BODY_CHARS}) AS Body_preview,
               m.User, m.Datetime
        FROM {table_ref} m
        LEFT JOIN {cat_ref} c
          ON m.message_id = c.message_id AND c.source_table = '{source_table}'
        WHERE c.message_id IS NULL
          AND m.message_id IS NOT NULL
          AND NOT REGEXP_CONTAINS(IFNULL(m.Subject, ''), 'Delivery Status Notification|Action Required|楽楽精算|セキュリティ通知|Undelivered Mail Returned to Sender|Returned mail: see transcript for details')
        ORDER BY m.Datetime DESC
        LIMIT {limit}
    """
    rows = []
    for row in bq_client.query(query).result():
        rows.append({
            "message_id":   row.message_id,
            "subject":      row.Subject or "",
            "body_preview": extract_latest_message(row.Body_preview or "", MAX_BODY_CHARS),
            "user":         row.User or "",
            "datetime":     str(row.Datetime),
        })
    return rows


def classify_batch(gemini_client, emails: list[dict]) -> list[dict]:
    """Gemini APIで複数メールを一括分類"""

    email_texts = []
    for i, e in enumerate(emails):
        email_texts.append(
            f"[{i}]\n"
            f"Subject: {e['subject']}\n"
            f"Body: {e['body_preview']}"
        )

    prompt = f"""{SYSTEM_PROMPT}

以下のメールをそれぞれ分類してください。

{chr(10).join(email_texts)}

JSON配列のみで回答してください（説明文・コードブロック不要）:
[
  {{"index": 0, "category_l1": "...", "category_l2": "...", "confidence": 0.9, "notes": "..."}},
  ...
]"""

    def _call_api():
        return gemini_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=genai.types.GenerateContentConfig(
                thinking_config=genai.types.ThinkingConfig(thinking_budget=0),
            ),
        )

    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_call_api)
    try:
        response = future.result(timeout=90)  # 90秒でタイムアウト
    except FutureTimeoutError:
        executor.shutdown(wait=False)
        raise Exception("APIタイムアウト（90秒）")
    finally:
        executor.shutdown(wait=False)

    text = response.text.strip()

    # ```json ... ``` ブロックの除去
    if "```" in text:
        parts = text.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("["):
                text = part
                break

    return json.loads(text)


def save_categories(bq_client, results: list[dict], emails: list[dict], source_table: str) -> int:
    """分類結果をBigQueryに保存"""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    rows = []

    email_by_index = {i: e for i, e in enumerate(emails)}

    for r in results:
        idx = r.get("index", -1)
        if idx not in email_by_index:
            continue
        email = email_by_index[idx]
        rows.append({
            "message_id":    email["message_id"],
            "source_table":  source_table,
            "category_l1":   r.get("category_l1"),
            "category_l2":   r.get("category_l2"),
            "confidence":    r.get("confidence"),
            "notes":         r.get("notes"),
            "categorized_at": now_iso,
            "method":        "gemini_api",
            "model":         GEMINI_MODEL,
        })

    if rows:
        table_ref = f"{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}"
        errors = bq_client.insert_rows_json(table_ref, rows)
        if errors:
            print(f"  WARNING 保存エラー: {errors}", file=sys.stderr)

    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="メール自動カテゴリ分け (Gemini API)")
    parser.add_argument("--table", choices=["receive", "send", "both"], default="both",
                        help="対象テーブル (デフォルト: both)")
    parser.add_argument("--limit", type=int, default=500,
                        help="1回の実行で処理する最大件数 (デフォルト: 500)")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("エラー: GEMINI_API_KEY が設定されていません", file=sys.stderr)
        print("  Google AI Studio (https://aistudio.google.com) でAPIキーを取得して、")
        print("  set GEMINI_API_KEY=your_key_here  を実行してから再試行してください")
        sys.exit(1)

    bq_client = get_bq_client()
    gemini_client = genai.Client(api_key=api_key)

    tables = []
    if args.table in ("receive", "both"):
        tables.append(TABLE_RECEIVE)
    if args.table in ("send", "both"):
        tables.append(TABLE_SEND)

    total_processed = 0

    for source_table in tables:
        print(f"\n=== {source_table} の処理開始 ===")

        emails = fetch_uncategorized(bq_client, source_table, args.limit)
        print(f"  未分類: {len(emails):,} 件")

        if not emails:
            print("  スキップ（未分類なし）")
            continue

        processed = 0
        for i in range(0, len(emails), BATCH_SIZE):
            batch = emails[i:i + BATCH_SIZE]
            print(f"  バッチ処理中: {i+1}〜{i+len(batch)} 件目...", end="", flush=True)

            try:
                results = classify_batch(gemini_client, batch)
                saved = save_categories(bq_client, results, batch, source_table)
                processed += saved
                print(f" -> {saved} 件保存")
            except Exception as e:
                print(f" WARNING エラー: {e}", file=sys.stderr)
                continue

        total_processed += processed
        print(f"  {source_table} 完了: {processed:,} 件処理")

    print(f"\n=== 全体完了: {total_processed:,} 件 ===")


if __name__ == "__main__":
    main()
