import base64
import hashlib
import json
import os
import secrets
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from google.auth.transport.requests import Request

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
]


class AuthHandler:
    def __init__(self):
        self.client_id = os.environ["GOOGLE_CLIENT_ID"]
        self.client_secret = os.environ["GOOGLE_CLIENT_SECRET"]
        self.redirect_uri = os.environ.get("REDIRECT_URI", "http://localhost:8501")

    def _make_flow(self) -> Flow:
        client_config = {
            "web": {
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "redirect_uris": [self.redirect_uri],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        }
        return Flow.from_client_config(
            client_config, scopes=SCOPES, redirect_uri=self.redirect_uri
        )

    @staticmethod
    def _generate_pkce() -> tuple[str, str]:
        """Generate PKCE code_verifier and code_challenge (S256)."""
        code_verifier = secrets.token_urlsafe(64)
        digest = hashlib.sha256(code_verifier.encode()).digest()
        code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
        return code_verifier, code_challenge

    def get_auth_url(self) -> str:
        """
        Build the Google authorization URL.
        PKCE code_verifier is embedded in the 'state' parameter so it
        survives across Cloud Run instances (stateless design).
        """
        code_verifier, code_challenge = self._generate_pkce()
        flow = self._make_flow()
        auth_url, state = flow.authorization_url(
            access_type="offline",
            prompt="consent",
            code_challenge=code_challenge,
            code_challenge_method="S256",
        )

        # Embed code_verifier into state so we can retrieve it on callback
        payload = json.dumps({"s": state, "v": code_verifier})
        new_state = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")

        # Replace state in URL using proper URL parsing
        parsed = urlparse(auth_url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        params["state"] = [new_state]
        new_query = urlencode(params, doseq=True)
        return urlunparse(parsed._replace(query=new_query))

    def exchange_code(self, code: str, raw_state: str = "") -> Credentials:
        """
        Exchange authorization code for credentials.
        Extracts code_verifier from the (possibly encoded) state parameter.
        """
        code_verifier = None

        # Try to decode the embedded state payload
        try:
            padded = raw_state + "=" * (-len(raw_state) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded).decode())
            code_verifier = payload.get("v")
        except Exception:
            pass  # state was not encoded by us; proceed without code_verifier

        flow = self._make_flow()
        fetch_kwargs: dict = {"code": code}
        if code_verifier:
            fetch_kwargs["code_verifier"] = code_verifier

        flow.fetch_token(**fetch_kwargs)
        return flow.credentials

    def credentials_from_refresh_token(self, refresh_token: str) -> Credentials:
        """Reconstruct credentials from a stored refresh token."""
        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=self.client_id,
            client_secret=self.client_secret,
            scopes=SCOPES,
        )
        creds.refresh(Request())
        return creds
