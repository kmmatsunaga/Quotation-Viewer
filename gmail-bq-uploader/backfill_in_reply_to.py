#!/usr/bin/env python3
"""
直近N日間のメールの in_reply_to をGmailから取得してBigQueryを更新するスクリプト。

Usage:
  python backfill_in_reply_to.py [--days 3]
"""
import argparse
import os
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from auth_handler import AuthHandler
from bigquery_client import BigQueryClient
from gmail_client import GmailClient
from google.cloud import bigquery as bq_lib

PROJECT_ID = "booking-data-388605"
DATASET_ID = "updated_tables"


def fetch_target_message_ids(bq_client, days: int, table: str = "both") -> dict[str, list[dict]]:
    """
    直近N日間のメールのうち in_reply_to が未設定のものを
    ユーザー別・テーブル別に返す。
    Returns: {user_email: [{"message_id": ..., "table": "csmail_send"|"csmail_receive"}, ...]}
    """
    client = bq_client.client
    result: dict[str, list[dict]] = {}

    tables = []
    if table in ("send", "both"):
        tables.append("csmail_send")
    if table in ("receive", "both"):
        tables.append("csmail_receive")

    for table_name in tables:
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"
        query = f"""
            SELECT User, message_id
            FROM {table_ref}
            WHERE DATE(Datetime) >= DATE_SUB(CURRENT_DATE(), INTERVAL {days} DAY)
              AND (in_reply_to IS NULL OR in_reply_to = '')
              AND message_id IS NOT NULL
            ORDER BY User, Datetime DESC
        """
        for row in client.query(query).result():
            user = row.User
            if user not in result:
                result[user] = []
            result[user].append({"message_id": row.message_id, "table": table_name})

    return result


def fetch_in_reply_to(gmail: GmailClient, rfc_message_id: str) -> str:
    """
    RFC Message-ID からGmail内部IDを検索し、In-Reply-Toヘッダーを取得する。
    """
    try:
        # <xxx@domain> の山括弧を除去してGmail検索用クエリを作成
        clean_id = rfc_message_id.strip("<>")
        # Gmail API で rfc822msgid 検索 → 内部IDを取得
        internal_ids = gmail.list_message_ids(f"rfc822msgid:{clean_id}")
        if not internal_ids:
            return ""
        msg = gmail.get_message(internal_ids[0])
        headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
        return headers.get("In-Reply-To", "") or ""
    except Exception as e:
        return ""


def update_in_reply_to_batch(client, table_name: str, updates: list[dict]) -> int:
    """
    (message_id, in_reply_to) のリストを使ってBigQueryをMERGEで一括更新。
    """
    if not updates:
        return 0

    table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"

    # MERGE用の値リストを構築
    value_rows = ", ".join(
        f"('{r['message_id'].replace(chr(39), '')}', '{r['in_reply_to'].replace(chr(39), '')}')"
        for r in updates
        if r.get("in_reply_to")  # 空文字は更新しない
    )
    if not value_rows:
        return 0

    merge_query = f"""
        MERGE {table_ref} AS T
        USING (
            SELECT message_id, in_reply_to
            FROM UNNEST([STRUCT<message_id STRING, in_reply_to STRING>
                {value_rows}])
        ) AS S ON T.message_id = S.message_id
        WHEN MATCHED THEN
            UPDATE SET T.in_reply_to = S.in_reply_to
    """

    try:
        job = client.query(merge_query)
        job.result()
        return job.num_dml_affected_rows or 0
    except Exception as e:
        print(f"  ERROR: MERGE失敗 ({table_name}): {e}")
        return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3, help="直近何日分を対象にするか")
    parser.add_argument("--table", choices=["send", "receive", "both"], default="both", help="対象テーブル")
    args = parser.parse_args()

    print(f"=== in_reply_to バックフィル開始（直近{args.days}日間）===")

    bq = BigQueryClient()
    auth = AuthHandler()

    # 対象メッセージを取得
    targets = fetch_target_message_ids(bq, args.days, args.table)
    total_msgs = sum(len(v) for v in targets.values())
    print(f"対象: {len(targets)}ユーザー / {total_msgs}件")

    if not total_msgs:
        print("更新対象なし。終了します。")
        return

    total_updated = 0

    for user_email, messages in targets.items():
        print(f"\n--- {user_email} ({len(messages)}件) ---")

        # ユーザーのリフレッシュトークンを取得
        token_data = bq.get_user_token(user_email)
        if not token_data or not token_data.get("refresh_token"):
            print(f"  SKIP: トークンなし")
            continue

        try:
            creds = auth.credentials_from_refresh_token(token_data["refresh_token"])
            gmail = GmailClient(creds)
        except Exception as e:
            print(f"  SKIP: 認証失敗: {e}")
            continue

        # テーブル別に仕分け
        by_table: dict[str, list[dict]] = {}
        for m in messages:
            t = m["table"]
            if t not in by_table:
                by_table[t] = []
            by_table[t].append(m)

        for table_name, msgs in by_table.items():
            updates = []
            for i, m in enumerate(msgs, 1):
                in_reply_to = fetch_in_reply_to(gmail, m["message_id"])
                if in_reply_to:
                    updates.append({"message_id": m["message_id"], "in_reply_to": in_reply_to})
                if i % 50 == 0:
                    print(f"  {i}/{len(msgs)} 件確認済み...")

            updated = update_in_reply_to_batch(bq.client, table_name, updates)
            print(f"  {table_name}: {updated}件更新")
            total_updated += updated

    print(f"\n=== 完了: 合計{total_updated}件更新 ===")


if __name__ == "__main__":
    main()
