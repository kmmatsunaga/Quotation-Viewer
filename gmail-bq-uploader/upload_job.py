#!/usr/bin/env python3
"""
Cloud Run Job エントリポイント。
Gmail メール履歴を BigQuery へアップロードする。

Usage:
  python upload_job.py --user_email xxx@xxx.com --direction send --mode full
"""
import argparse
import sys
import traceback
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from auth_handler import AuthHandler
from gmail_client import GmailClient
from bigquery_client import BigQueryClient

INITIAL_START_DATE = "2025/01/01"
BATCH_SIZE = 500  # BigQueryへの1回の書き込み件数


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user_email", required=True)
    parser.add_argument("--direction",  required=True, choices=["send", "receive"])
    parser.add_argument("--mode",       default="incremental", choices=["full", "incremental"])
    args = parser.parse_args()

    bq = BigQueryClient()
    bq.ensure_tables_exist()

    is_send   = args.direction == "send"
    label     = "送信メール" if is_send else "受信メール"
    table     = "csmail_send" if is_send else "csmail_receive"
    send_recv = "send" if is_send else "receive"

    started_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{label}] 開始 user={args.user_email} mode={args.mode} at={started_at}")

    # シグナルをクリア（前回の残存シグナルを除去）
    bq.clear_job_signal(args.user_email, args.direction)

    try:
        # リフレッシュトークンから認証情報を復元
        token_data = bq.get_user_token(args.user_email)
        if not token_data:
            raise RuntimeError(
                f"ユーザー {args.user_email} のトークンが見つかりません。"
                "先にアプリからログインしてください。"
            )

        auth  = AuthHandler()
        creds = auth.credentials_from_refresh_token(token_data["refresh_token"])
        gmail = GmailClient(creds)

        # 取得期間を決定
        if args.mode == "full":
            after = INITIAL_START_DATE
        else:
            latest = bq.get_latest_datetime(table, args.user_email)
            after  = latest.strftime("%Y/%m/%d") if latest else INITIAL_START_DATE

        query = (
            f"from:{args.user_email} in:sent after:{after}"
            if is_send else
            f"to:{args.user_email} -in:sent -in:drafts -in:chats after:{after}"
        )
        print(f"[{label}] Gmail クエリ: {query}")

        # メッセージID一覧取得
        ids   = gmail.list_message_ids(query)
        total = len(ids)
        print(f"[{label}] {total} 件検出")

        uploaded_total = 0
        skipped        = 0
        batch          = []
        stopped_early  = False
        stop_reason    = ""

        for i, msg_id in enumerate(ids, 1):
            # シグナルチェック（500件ごと）
            if i % BATCH_SIZE == 1 and i > 1:
                signal = bq.get_job_signal(args.user_email, args.direction)
                if signal in ("pause", "cancel"):
                    stop_reason = signal
                    print(f"[{label}] シグナル受信: {signal} — 停止します")
                    stopped_early = True
                    break

            try:
                msg = gmail.get_message(msg_id)
                batch.append(gmail.parse_message(msg, send_recv, args.user_email))
            except Exception as e:
                skipped += 1
                print(f"[{label}] スキップ ID={msg_id}: {e}")

            # バッチが溜まったらアップロード
            if len(batch) >= BATCH_SIZE:
                uploaded_total += bq.upload_rows(table, batch)
                print(f"[{label}] {i}/{total} 処理済み — 累計追加 {uploaded_total} 件")
                batch = []

        # 残分をアップロード
        if batch:
            uploaded_total += bq.upload_rows(table, batch)

        finished_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        processed = i if 'i' in dir() else 0

        if stopped_early:
            status_str = "paused" if stop_reason == "pause" else "cancelled"
            print(f"[{label}] {status_str}: 処理={processed}件 / 追加={uploaded_total}件")
            bq.update_job_status(
                args.user_email, args.direction, status_str,
                started_at=started_at, finished_at=finished_at,
                total_fetched=processed, uploaded_count=uploaded_total,
                error_message=f"ユーザー操作により停止（{stop_reason}）",
            )
        else:
            print(f"[{label}] 完了: 追加={uploaded_total}件 / 取得={total}件 / スキップ={skipped}件")
            bq.update_job_status(
                args.user_email, args.direction, "completed",
                started_at=started_at, finished_at=finished_at,
                total_fetched=total, uploaded_count=uploaded_total,
            )

        sys.exit(0)

    except Exception as e:
        err_msg = str(e)
        print(f"[{label}] エラー: {err_msg}\n{traceback.format_exc()}", file=sys.stderr)
        finished_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        bq.update_job_status(
            args.user_email, args.direction, "failed",
            started_at=started_at, finished_at=finished_at,
            error_message=err_msg[:1000],
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
