"""
scheduler_job.py
Headless script executed by Cloud Run Jobs + Cloud Scheduler.
Runs incremental Gmail → BigQuery upload for all registered users.

Cloud Scheduler cron: 0 9,12,15,18 * * *  (JST)
"""

import logging
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv()

from auth_handler import AuthHandler
from gmail_client import GmailClient
from bigquery_client import BigQueryClient

INITIAL_START_DATE = "2026/03/01"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def _fmt_date(dt: datetime | None) -> str:
    return dt.strftime("%Y/%m/%d") if dt else INITIAL_START_DATE


def process_user(
    auth: AuthHandler,
    bq: BigQueryClient,
    token_row: dict,
) -> None:
    user_email: str = token_row["user_email"]
    refresh_token: str = token_row["refresh_token"]

    log.info("Processing user: %s", user_email)
    try:
        creds = auth.credentials_from_refresh_token(refresh_token)
    except Exception as e:
        log.error("Failed to refresh credentials for %s: %s", user_email, e)
        return

    gmail = GmailClient(creds)

    for table_name, send_receive, label in [
        ("csmail_send",    "send",    "in:sent"),
        ("csmail_receive", "receive", "in:inbox -in:sent"),
    ]:
        latest = bq.get_latest_datetime(table_name, user_email)
        after  = _fmt_date(latest)
        query  = f"{label} after:{after}"

        log.info("  [%s] query: %s", table_name, query)
        ids = gmail.list_message_ids(query)
        log.info("  [%s] %d messages found", table_name, len(ids))

        rows = []
        for msg_id in ids:
            try:
                msg = gmail.get_message(msg_id)
                rows.append(gmail.parse_message(msg, send_receive, user_email))
            except Exception as e:
                log.warning("  Skipping message %s: %s", msg_id, e)

        uploaded = bq.upload_rows(table_name, rows)
        log.info("  [%s] uploaded %d new rows", table_name, uploaded)

        if uploaded > 0:
            bq.update_last_upload(
                user_email, table_name.replace("csmail_", ""), datetime.now(timezone.utc)
            )


def main() -> None:
    log.info("Scheduler job started")
    auth = AuthHandler()
    bq   = BigQueryClient()
    bq.ensure_tables_exist()

    token_rows = bq.get_all_user_tokens()  # sync_enabled=FALSE のユーザーは除外済み
    log.info("Found %d active user(s) (sync_enabled users only)", len(token_rows))

    errors = 0
    for row in token_rows:
        try:
            process_user(auth, bq, row)
        except Exception as e:
            log.error("Unhandled error for user %s: %s", row.get("user_email"), e)
            errors += 1

    log.info("Scheduler job finished. Errors: %d", errors)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
