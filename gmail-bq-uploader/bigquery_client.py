import json
import os
from datetime import datetime, timezone

from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = "booking-data-388605"
DATASET_ID = "updated_tables"

# Schema shared by both send / receive tables
_EMAIL_SCHEMA = [
    bigquery.SchemaField("User",         "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("send_receive", "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("Datetime",     "TIMESTAMP", mode="NULLABLE"),
    bigquery.SchemaField("From",         "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("To",           "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("cc",           "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("bcc",          "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("Subject",      "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("Body",         "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("message_id",   "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("thread_id",    "STRING",    mode="NULLABLE"),
]

_TOKEN_SCHEMA = [
    bigquery.SchemaField("user_email",          "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("refresh_token",       "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("last_upload_send",    "TIMESTAMP", mode="NULLABLE"),
    bigquery.SchemaField("last_upload_receive", "TIMESTAMP", mode="NULLABLE"),
    bigquery.SchemaField("updated_at",          "TIMESTAMP", mode="NULLABLE"),
    bigquery.SchemaField("sync_enabled",        "BOOL",      mode="NULLABLE"),
]

# 削除済みメッセージIDの除外リスト（再アップロード防止用）
_DELETED_SCHEMA = [
    bigquery.SchemaField("message_id",  "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("table_name",  "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("User",        "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("Subject",     "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("deleted_at",  "TIMESTAMP", mode="NULLABLE"),
]

_JOB_STATUS_SCHEMA = [
    bigquery.SchemaField("user_email",      "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("direction",       "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("status",          "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("started_at",      "TIMESTAMP", mode="NULLABLE"),
    bigquery.SchemaField("finished_at",     "TIMESTAMP", mode="NULLABLE"),
    bigquery.SchemaField("total_fetched",   "INTEGER",   mode="NULLABLE"),
    bigquery.SchemaField("uploaded_count",  "INTEGER",   mode="NULLABLE"),
    bigquery.SchemaField("error_message",   "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("execution_name",  "STRING",    mode="NULLABLE"),
    bigquery.SchemaField("recorded_at",     "TIMESTAMP", mode="REQUIRED"),
]

_JOB_CONTROL_SCHEMA = [
    bigquery.SchemaField("user_email",  "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("direction",   "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("command",     "STRING",    mode="NULLABLE"),  # pause / cancel
    bigquery.SchemaField("created_at",  "TIMESTAMP", mode="REQUIRED"),
]

_CHUNK = 500  # rows per BigQuery streaming insert


class BigQueryClient:
    def __init__(self):
        key_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY_JSON")
        key_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY_PATH")

        if key_json:
            info = json.loads(key_json)
            creds = service_account.Credentials.from_service_account_info(info)
        elif key_path:
            creds = service_account.Credentials.from_service_account_file(key_path)
        else:
            creds = None  # use ADC (Application Default Credentials) on Cloud Run

        self.client = bigquery.Client(project=PROJECT_ID, credentials=creds)

    # ------------------------------------------------------------------
    # Table management
    # ------------------------------------------------------------------

    def ensure_tables_exist(self) -> None:
        for name, schema in [
            ("csmail_send",          _EMAIL_SCHEMA),
            ("csmail_receive",       _EMAIL_SCHEMA),
            ("user_tokens",          _TOKEN_SCHEMA),
            ("deleted_message_ids",  _DELETED_SCHEMA),
            ("job_status",           _JOB_STATUS_SCHEMA),
            ("job_control",          _JOB_CONTROL_SCHEMA),
        ]:
            table_ref = f"{PROJECT_ID}.{DATASET_ID}.{name}"
            table = bigquery.Table(table_ref, schema=schema)
            try:
                self.client.create_table(table)
            except Exception as e:
                if "Already Exists" not in str(e):
                    raise
        # カラム追加マイグレーション
        self._add_sync_enabled_if_missing()
        self._add_execution_name_if_missing()

    def _add_execution_name_if_missing(self) -> None:
        table_ref_str = f"{PROJECT_ID}.{DATASET_ID}.job_status"
        try:
            table = self.client.get_table(table_ref_str)
            if not any(f.name == "execution_name" for f in table.schema):
                new_schema = list(table.schema) + [
                    bigquery.SchemaField("execution_name", "STRING", mode="NULLABLE")
                ]
                table.schema = new_schema
                self.client.update_table(table, ["schema"])
        except Exception:
            pass

    def _add_sync_enabled_if_missing(self) -> None:
        table_ref_str = f"{PROJECT_ID}.{DATASET_ID}.user_tokens"
        try:
            table = self.client.get_table(table_ref_str)
            if not any(f.name == "sync_enabled" for f in table.schema):
                new_schema = list(table.schema) + [
                    bigquery.SchemaField("sync_enabled", "BOOL", mode="NULLABLE")
                ]
                table.schema = new_schema
                self.client.update_table(table, ["schema"])
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def upload_rows(self, table_name: str, rows: list[dict]) -> int:
        """Insert rows that don't already exist (dedup by message_id + 削除済み除外)."""
        if not rows:
            return 0

        existing = self._get_existing_message_ids(table_name)
        deleted  = self._get_deleted_message_ids(table_name)
        excluded = existing | deleted

        new_rows = [r for r in rows if r.get("message_id") not in excluded]
        if not new_rows:
            return 0

        table_ref = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
        for i in range(0, len(new_rows), _CHUNK):
            chunk = new_rows[i : i + _CHUNK]
            errors = self.client.insert_rows_json(table_ref, chunk)
            if errors:
                raise RuntimeError(f"BigQuery insert errors: {errors}")

        return len(new_rows)

    def _get_existing_message_ids(self, table_name: str) -> set[str]:
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"
        query = f"SELECT message_id FROM {table_ref}"
        try:
            return {row.message_id for row in self.client.query(query).result()}
        except Exception:
            return set()

    def _get_deleted_message_ids(self, table_name: str) -> set[str]:
        """削除済みIDリストを取得（再アップロード防止用）。"""
        ref = f"`{PROJECT_ID}.{DATASET_ID}.deleted_message_ids`"
        query = f"SELECT message_id FROM {ref} WHERE table_name = @tbl"
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("tbl", "STRING", table_name)]
        )
        try:
            return {row.message_id for row in self.client.query(query, job_config=job_config).result()}
        except Exception:
            return set()

    # ------------------------------------------------------------------
    # Search (削除UI用)
    # ------------------------------------------------------------------

    def search_emails(
        self,
        direction: str,          # "send" or "receive"
        user_email: str,         # ログイン中のユーザーに絞る
        date_from: str | None,   # "YYYY-MM-DD"
        date_to: str | None,     # "YYYY-MM-DD"
        address: str | None,     # 送信先(To) or 送信元(From) 部分一致
        subject: str | None,     # タイトル部分一致
        limit: int = 300,
    ) -> list[dict]:
        """フィルタ条件でメールを検索して返す（削除UI用）。"""
        table_name = "csmail_send" if direction == "send" else "csmail_receive"
        table_ref  = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"

        # ログインユーザーのデータのみ
        conditions: list[str] = ["User = @user_email"]
        params: list = [bigquery.ScalarQueryParameter("user_email", "STRING", user_email)]

        if date_from:
            conditions.append("DATE(Datetime) >= @date_from")
            params.append(bigquery.ScalarQueryParameter("date_from", "STRING", date_from))
        if date_to:
            conditions.append("DATE(Datetime) <= @date_to")
            params.append(bigquery.ScalarQueryParameter("date_to", "STRING", date_to))

        if address:
            col = "To" if direction == "send" else "`From`"
            conditions.append(f"LOWER({col}) LIKE LOWER(@address)")
            params.append(bigquery.ScalarQueryParameter("address", "STRING", f"%{address}%"))

        if subject:
            conditions.append("LOWER(Subject) LIKE LOWER(@subject)")
            params.append(bigquery.ScalarQueryParameter("subject", "STRING", f"%{subject}%"))

        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

        query = (
            f"SELECT message_id, User, send_receive, Datetime, `From`, `To`, cc, bcc, Subject "
            f"FROM {table_ref} "
            f"{where} "
            f"ORDER BY Datetime DESC "
            f"LIMIT {limit}"
        )
        job_config = bigquery.QueryJobConfig(query_parameters=params)

        results = []
        for row in self.client.query(query, job_config=job_config).result():
            r = dict(row)
            # Datetime を文字列化
            if isinstance(r.get("Datetime"), datetime):
                r["Datetime"] = r["Datetime"].strftime("%Y-%m-%d %H:%M UTC")
            results.append(r)
        return results

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def delete_by_message_ids(
        self,
        message_ids: list[str],
        table_name: str,
        rows_info: list[dict],
    ) -> int:
        """
        指定 message_id のレコードを削除し、
        deleted_message_ids テーブルへ登録して再追加を防ぐ。
        """
        if not message_ids:
            return 0

        # 1. メールテーブルから削除
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"
        query = f"DELETE FROM {table_ref} WHERE message_id IN UNNEST(@ids)"
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ArrayQueryParameter("ids", "STRING", message_ids)]
        )
        job = self.client.query(query, job_config=job_config)
        job.result()
        deleted = job.num_dml_affected_rows or 0

        # 2. 除外リストへ登録（再アップロード防止）
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        exclusion_ref = f"{PROJECT_ID}.{DATASET_ID}.deleted_message_ids"
        id_to_row = {r["message_id"]: r for r in rows_info}
        exclusion_rows = [
            {
                "message_id": mid,
                "table_name": table_name,
                "User":       id_to_row.get(mid, {}).get("User", ""),
                "Subject":    id_to_row.get(mid, {}).get("Subject", ""),
                "deleted_at": now_iso,
            }
            for mid in message_ids
        ]
        if exclusion_rows:
            self.client.insert_rows_json(exclusion_ref, exclusion_rows)

        return deleted

    def delete_by_subjects(self, subjects: list[str]) -> int:
        """Delete rows from both tables where Subject matches any entry."""
        if not subjects:
            return 0

        total = 0
        for table_name in ("csmail_send", "csmail_receive"):
            table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"
            query = f"DELETE FROM {table_ref} WHERE Subject IN UNNEST(@subjects)"
            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ArrayQueryParameter("subjects", "STRING", subjects)
                ]
            )
            job = self.client.query(query, job_config=job_config)
            job.result()
            total += job.num_dml_affected_rows or 0
        return total

    # ------------------------------------------------------------------
    # Incremental upload helpers
    # ------------------------------------------------------------------

    def get_latest_datetime(
        self, table_name: str, user_email: str
    ) -> datetime | None:
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.{table_name}`"
        query = (
            f"SELECT MAX(Datetime) AS latest FROM {table_ref} "
            "WHERE User = @user"
        )
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("user", "STRING", user_email)
            ]
        )
        try:
            for row in self.client.query(query, job_config=job_config).result():
                return row.latest  # datetime | None
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Token management (for scheduled job)
    # ------------------------------------------------------------------

    def save_user_token(self, user_email: str, refresh_token: str) -> None:
        """Upsert a user's refresh token (DELETE + INSERT)."""
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"

        delete_q = f"DELETE FROM {table_ref} WHERE user_email = @email"
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("email", "STRING", user_email)
            ]
        )
        self.client.query(delete_q, job_config=job_config).result()

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        insert_ref = f"{PROJECT_ID}.{DATASET_ID}.user_tokens"
        self.client.insert_rows_json(
            insert_ref,
            [
                {
                    "user_email": user_email,
                    "refresh_token": refresh_token,
                    "last_upload_send": None,
                    "last_upload_receive": None,
                    "updated_at": now_iso,
                    "sync_enabled": True,
                }
            ],
        )

    def get_all_user_tokens(self) -> list[dict]:
        """定期実行用: sync_enabled が FALSE のユーザーを除外して返す。"""
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"
        query = f"SELECT * FROM {table_ref} WHERE sync_enabled IS NULL OR sync_enabled = TRUE"
        try:
            return [dict(row) for row in self.client.query(query).result()]
        except Exception:
            return []

    def get_all_users_status(self) -> list[dict]:
        """管理者用: 全ユーザーの同期状態を返す。"""
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"
        query = (
            f"SELECT user_email, sync_enabled, last_upload_send, last_upload_receive, updated_at "
            f"FROM {table_ref} ORDER BY user_email"
        )
        try:
            return [dict(row) for row in self.client.query(query).result()]
        except Exception:
            return []

    def get_sync_status(self, user_email: str) -> bool:
        """ユーザーの sync_enabled を返す（NULL = True として扱う）。"""
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"
        query = f"SELECT sync_enabled FROM {table_ref} WHERE user_email = @email LIMIT 1"
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", user_email)]
        )
        try:
            for row in self.client.query(query, job_config=job_config).result():
                return row.sync_enabled is not False
        except Exception:
            pass
        return True  # デフォルトは有効

    def set_sync_enabled(self, user_email: str, enabled: bool) -> None:
        """ユーザーの自動同期を有効化/停止する。"""
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        query = (
            f"UPDATE {table_ref} "
            f"SET sync_enabled = @enabled, updated_at = '{now_iso}' "
            "WHERE user_email = @email"
        )
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("enabled", "BOOL", enabled),
                bigquery.ScalarQueryParameter("email", "STRING", user_email),
            ]
        )
        self.client.query(query, job_config=job_config).result()

    def update_last_upload(
        self, user_email: str, table_name: str, dt: datetime
    ) -> None:
        col = f"last_upload_{table_name}"
        tokens_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"
        dt_iso = dt.strftime("%Y-%m-%d %H:%M:%S UTC")
        query = (
            f"UPDATE {tokens_ref} "
            f"SET {col} = '{dt_iso}', updated_at = '{dt_iso}' "
            "WHERE user_email = @email"
        )
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("email", "STRING", user_email)
            ]
        )
        self.client.query(query, job_config=job_config).result()

    def get_user_token(self, user_email: str) -> dict | None:
        """指定ユーザーのトークン情報を返す。"""
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.user_tokens`"
        query = f"SELECT * FROM {table_ref} WHERE user_email = @email LIMIT 1"
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", user_email)]
        )
        try:
            for row in self.client.query(query, job_config=job_config).result():
                return dict(row)
        except Exception:
            pass
        return None

    def update_job_status(
        self,
        user_email: str,
        direction: str,
        status: str,
        started_at: str | None = None,
        finished_at: str | None = None,
        total_fetched: int | None = None,
        uploaded_count: int | None = None,
        error_message: str | None = None,
        execution_name: str | None = None,
    ) -> None:
        """Job の実行ステータスを job_status テーブルへ追記（append-only）。"""
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        insert_ref = f"{PROJECT_ID}.{DATASET_ID}.job_status"
        row = {
            "user_email":     user_email,
            "direction":      direction,
            "status":         status,
            "started_at":     started_at,
            "finished_at":    finished_at,
            "total_fetched":  total_fetched,
            "uploaded_count": uploaded_count,
            "error_message":  error_message,
            "execution_name": execution_name,
            "recorded_at":    now_iso,
        }
        self.client.insert_rows_json(insert_ref, [row])

    def set_job_signal(self, user_email: str, direction: str, command: str) -> None:
        """一時ストップ / 中断シグナルを job_control テーブルへ書き込む。"""
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        self.client.insert_rows_json(
            f"{PROJECT_ID}.{DATASET_ID}.job_control",
            [{"user_email": user_email, "direction": direction,
              "command": command, "created_at": now_iso}],
        )

    def get_job_signal(self, user_email: str, direction: str) -> str | None:
        """最新のシグナルを返す。なければ None。"""
        query = f"""
            SELECT command FROM `{PROJECT_ID}.{DATASET_ID}.job_control`
            WHERE user_email = @email AND direction = @dir
            ORDER BY created_at DESC LIMIT 1
        """
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("email", "STRING", user_email),
            bigquery.ScalarQueryParameter("dir",   "STRING", direction),
        ])
        try:
            rows = list(self.client.query(query, cfg).result())
            return rows[0]["command"] if rows else None
        except Exception:
            return None

    def clear_job_signal(self, user_email: str, direction: str) -> None:
        """シグナルをクリア（'cleared' を追記）。"""
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        self.client.insert_rows_json(
            f"{PROJECT_ID}.{DATASET_ID}.job_control",
            [{"user_email": user_email, "direction": direction,
              "command": "cleared", "created_at": now_iso}],
        )

    def get_job_status(self, user_email: str) -> dict:
        """
        ユーザーの send/receive 各方向の最新ステータスを返す。
        Returns: {"send": {...} | None, "receive": {...} | None}
        """
        table_ref = f"`{PROJECT_ID}.{DATASET_ID}.job_status`"
        query = f"""
            WITH ranked AS (
                SELECT *,
                    ROW_NUMBER() OVER (PARTITION BY direction ORDER BY recorded_at DESC) AS rn
                FROM {table_ref}
                WHERE user_email = @email
            )
            SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("email", "STRING", user_email)]
        )
        result: dict = {"send": None, "receive": None}
        try:
            for row in self.client.query(query, job_config=job_config).result():
                d = dict(row)
                result[d["direction"]] = d
        except Exception:
            pass
        return result
