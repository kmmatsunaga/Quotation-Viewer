#!/usr/bin/env python3
"""
csmail_send の in_reply_to を過去に遡って順次埋めるスクリプト。
直近から古い順に7日ずつチャンクで処理する。

Usage:
  python backfill_history.py [--chunk_days 7] [--start_days_ago 4]
"""
import argparse
import os
import sys
import time
from datetime import date, timedelta

from dotenv import load_dotenv
load_dotenv()

from auth_handler import AuthHandler
from bigquery_client import BigQueryClient
from backfill_in_reply_to import (
    fetch_in_reply_to,
    update_in_reply_to_batch,
)
from gmail_client import GmailClient
from google.cloud import bigquery as bq_lib

PROJECT_ID = "booking-data-388605"
DATASET_ID = "updated_tables"


def fetch_chunk(bq_client, date_from: date, date_to: date) -> dict[str, list[dict]]:
    """指定日付範囲で in_reply_to 未設定の送信メールをユーザー別に返す。"""
    client = bq_client.client
    result: dict[str, list[dict]] = {}

    query = f"""
        SELECT User, message_id
        FROM `{PROJECT_ID}.{DATASET_ID}.csmail_send`
        WHERE DATE(Datetime) >= '{date_from}'
          AND DATE(Datetime) <= '{date_to}'
          AND (in_reply_to IS NULL OR in_reply_to = '')
          AND message_id IS NOT NULL
        ORDER BY User, Datetime DESC
    """
    for row in client.query(query).result():
        user = row.User
        if user not in result:
            result[user] = []
        result[user].append({"message_id": row.message_id, "table": "csmail_send"})

    return result


def process_chunk(bq_client, auth, targets: dict, chunk_label: str) -> int:
    total_msgs = sum(len(v) for v in targets.values())
    if not total_msgs:
        print(f"  {chunk_label}: 未処理なし → スキップ")
        return 0

    print(f"  {chunk_label}: {total_msgs}件 処理開始")
    total_updated = 0

    for user_email, messages in targets.items():
        token_data = bq_client.get_user_token(user_email)
        if not token_data or not token_data.get("refresh_token"):
            continue
        try:
            creds = auth.credentials_from_refresh_token(token_data["refresh_token"])
            gmail = GmailClient(creds)
        except Exception as e:
            print(f"    SKIP {user_email}: 認証失敗 {e}")
            continue

        updates = []
        for m in messages:
            in_reply_to = fetch_in_reply_to(gmail, m["message_id"])
            if in_reply_to:
                updates.append({"message_id": m["message_id"], "in_reply_to": in_reply_to})

        updated = update_in_reply_to_batch(bq_client.client, "csmail_send", updates)
        if updated:
            print(f"    {user_email}: {updated}件更新")
        total_updated += updated

    print(f"  {chunk_label}: {total_updated}件更新完了")
    return total_updated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chunk_days",    type=int, default=7,  help="1チャンクの日数（デフォルト7日）")
    parser.add_argument("--start_days_ago", type=int, default=4, help="何日前から遡り開始（デフォルト4日前）")
    args = parser.parse_args()

    bq = BigQueryClient()
    auth = AuthHandler()

    today = date.today()
    chunk_end = today - timedelta(days=args.start_days_ago)

    # 最古日付を確認
    r = list(bq.client.query(f"""
        SELECT MIN(DATE(Datetime)) as oldest
        FROM `{PROJECT_ID}.{DATASET_ID}.csmail_send`
        WHERE in_reply_to IS NULL OR in_reply_to = ''
    """).result())
    oldest = r[0].oldest if r else None
    if not oldest:
        print("処理対象なし。終了します。")
        return

    print(f"=== 遡り処理開始: {chunk_end} → {oldest} （{args.chunk_days}日ずつ）===")
    grand_total = 0

    while chunk_end >= oldest:
        chunk_start = chunk_end - timedelta(days=args.chunk_days - 1)
        if chunk_start < oldest:
            chunk_start = oldest

        label = f"{chunk_start} 〜 {chunk_end}"
        targets = fetch_chunk(bq, chunk_start, chunk_end)
        updated = process_chunk(bq, auth, targets, label)
        grand_total += updated

        chunk_end = chunk_start - timedelta(days=1)

        # API負荷軽減のため少し休憩
        if updated > 0:
            time.sleep(2)

    print(f"\n=== 全期間完了: 合計{grand_total}件更新 ===")


if __name__ == "__main__":
    main()
