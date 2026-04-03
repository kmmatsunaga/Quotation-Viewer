import base64
import re
import time
from email.utils import parsedate_to_datetime, getaddresses
from datetime import timezone, timedelta

JST = timezone(timedelta(hours=9))

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials


class GmailClient:
    def __init__(self, credentials: Credentials):
        self.service = build("gmail", "v1", credentials=credentials)
        self._user_email: str | None = None

    def get_user_email(self) -> str:
        if not self._user_email:
            profile = self.service.users().getProfile(userId="me").execute()
            self._user_email = profile["emailAddress"]
        return self._user_email

    def list_message_ids(self, query: str) -> list[str]:
        """Return all message IDs matching query (handles pagination)."""
        ids: list[str] = []
        page_token = None
        while True:
            resp = (
                self.service.users()
                .messages()
                .list(userId="me", q=query, maxResults=500, pageToken=page_token)
                .execute()
            )
            for m in resp.get("messages", []):
                ids.append(m["id"])
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
        return ids

    def get_message(self, msg_id: str, retries: int = 3) -> dict:
        """Fetch full message detail with exponential backoff on rate limit."""
        for attempt in range(retries):
            try:
                return (
                    self.service.users()
                    .messages()
                    .get(userId="me", id=msg_id, format="full")
                    .execute()
                )
            except HttpError as e:
                if e.resp.status == 429 and attempt < retries - 1:
                    time.sleep(2**attempt)
                else:
                    raise

    @staticmethod
    def _extract_addresses(header_value: str) -> str:
        """'Name <addr>, ...' → 'addr1, addr2, ...' に変換する。"""
        if not header_value:
            return ""
        pairs = getaddresses([header_value])
        return ", ".join(addr for _, addr in pairs if addr)

    def parse_message(
        self, msg: dict, send_receive: str, user_email: str
    ) -> dict:
        """Convert a raw Gmail message dict to a BigQuery-ready row."""
        headers = {
            h["name"]: h["value"]
            for h in msg["payload"].get("headers", [])
        }

        # Parse datetime → JST ISO string
        date_str = headers.get("Date", "")
        try:
            dt = parsedate_to_datetime(date_str).astimezone(JST)
            dt_iso = dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            dt_iso = None

        body = self._extract_text(msg["payload"])

        return {
            "User": user_email,
            "send_receive": send_receive,
            "Datetime": dt_iso,
            "From": self._extract_addresses(headers.get("From", "")),
            "To":   self._extract_addresses(headers.get("To", "")),
            "cc":   self._extract_addresses(headers.get("Cc", "")),
            "bcc":  self._extract_addresses(headers.get("Bcc", "")),
            "Subject": headers.get("Subject", ""),
            "Body": (body or "")[:65535],
            "message_id": headers.get("Message-ID") or msg["id"],
            "thread_id": msg.get("threadId", ""),
        }

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _extract_text(self, payload: dict) -> str:
        """Recursively extract text/plain body; fall back to HTML stripped."""
        mime = payload.get("mimeType", "")

        if mime == "text/plain":
            return self._decode_data(payload.get("body", {}).get("data", ""))

        if mime == "text/html":
            html = self._decode_data(payload.get("body", {}).get("data", ""))
            return re.sub(r"<[^>]+>", "", html)

        for part in payload.get("parts", []):
            text = self._extract_text(part)
            if text:
                return text

        return ""

    @staticmethod
    def _decode_data(data: str) -> str:
        if not data:
            return ""
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
