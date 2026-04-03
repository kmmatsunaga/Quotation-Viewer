"""
会議資料ダッシュボード - Flask バックエンド
BigQuery から実績データを取得、Firestore / Cloud Storage でデータを管理
"""
import os
import json
import uuid
import sqlite3
import secrets
import threading
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path


from flask import Flask, Response, jsonify, request, send_from_directory, session, redirect
from google.cloud import bigquery
import pandas as pd
import firebase_admin
from firebase_admin import credentials as fb_credentials, auth as fb_auth, firestore

from week_mapping import (
    get_week_info, get_weeks_for_month, get_week_date_range,
    get_months_range, get_3month_weeks, month_label, MONTH_WEEK_MAP
)

# ── Gemini AI ─────────────────────────────────────────
try:
    from google import genai
    _gemini_available = True
except ImportError:
    _gemini_available = False

# ── 環境判定 ──────────────────────────────────────────
IS_CLOUD_RUN = bool(os.environ.get("K_SERVICE"))  # Cloud Run では自動設定される

BASE_DIR = Path(__file__).parent
BOOTSTRAP_ADMIN_EMAIL = "matsunaga@ekmtc.com"
FIRESTORE_USERS_COLLECTION = "meeting_users"
DB_PATH = BASE_DIR / "data" / "prospects.db"
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

PROJECT_ID = "booking-data-388605"
FIRESTORE_DB_ID = "firestore-database-1012359"
FIRESTORE_CONFIG_COLLECTION = "meeting_config"
REFRESH_DOC_ID = "bq_refresh"

# タイムゾーン
JST = timezone(timedelta(hours=9))

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB
# Cloud Run では環境変数から固定キーを取得（複数インスタンス対応）
app.secret_key = os.environ.get("FLASK_SECRET_KEY", secrets.token_hex(32))

# ── Firebase Admin SDK 初期化 ─────────────────────────
_firebase_cred_json = os.environ.get("FIREBASE_CREDENTIALS_JSON")  # Cloud Run: Secret Manager経由
if _firebase_cred_json:
    # Cloud Run: 環境変数にJSON文字列
    _fb_cred = fb_credentials.Certificate(json.loads(_firebase_cred_json))
else:
    # ローカル開発: ファイルパス
    FIREBASE_SERVICE_ACCOUNT_KEY = Path(
        r"C:\Users\matsunaga\Claude-Code-Test\Freight-News\serviceAccountKey.json"
    )
    _fb_cred = fb_credentials.Certificate(str(FIREBASE_SERVICE_ACCOUNT_KEY))

firebase_admin.initialize_app(_fb_cred)
try:
    db = firestore.client(database_id=FIRESTORE_DB_ID)
    _firestore_available = True
    print("Firestore: 接続OK")
except Exception as _e:
    db = None
    _firestore_available = False
    print(f"Firestore: 利用不可 ({_e})")

# ── BigQuery クライアント ──────────────────────────────
if IS_CLOUD_RUN:
    # Cloud Run: Application Default Credentials (サービスアカウント自動認証)
    from google.auth import default as _google_auth_default
    _bq_credentials, _ = _google_auth_default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    bq_client = bigquery.Client(project=PROJECT_ID, credentials=_bq_credentials)
else:
    # ローカル開発: サービスアカウントキーファイル
    SERVICE_ACCOUNT_KEY = Path(
        r"C:\Users\matsunaga\Documents\key\booking-data-388605@appspot.gserviceaccount.com\booking-data-388605-ec9e7af2c0e1.json"
    )
    from google.oauth2 import service_account as _sa
    _bq_credentials = _sa.Credentials.from_service_account_file(
        str(SERVICE_ACCOUNT_KEY),
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    bq_client = bigquery.Client(project=PROJECT_ID, credentials=_bq_credentials)

# ── Google Cloud Storage 初期化 ──────────────────────
GCS_BUCKET_NAME = os.environ.get("GCS_BUCKET", "meeting-dashboard-uploads-388605")
_gcs_available = False
gcs_bucket = None

try:
    from google.cloud import storage as gcs_storage
    if IS_CLOUD_RUN:
        _gcs_client = gcs_storage.Client(project=PROJECT_ID)
    else:
        _gcs_client = gcs_storage.Client(project=PROJECT_ID, credentials=_bq_credentials)
    gcs_bucket = _gcs_client.bucket(GCS_BUCKET_NAME)
    if not gcs_bucket.exists():
        gcs_bucket = _gcs_client.create_bucket(GCS_BUCKET_NAME, location="asia-northeast1")
        print(f"GCS: バケット作成OK ({GCS_BUCKET_NAME})")
    else:
        print(f"GCS: バケット接続OK ({GCS_BUCKET_NAME})")
    _gcs_available = True
except Exception as _gcs_e:
    print(f"GCS: 利用不可 ({_gcs_e}) - ローカルファイルを使用")
    _gcs_available = False

# ── Gemini AI クライアント初期化 ──────────────────────
_gemini_client = None
if _gemini_available:
    try:
        _gemini_kwargs = dict(vertexai=True, project=PROJECT_ID, location="us-central1")
        if not IS_CLOUD_RUN:
            _gemini_kwargs["credentials"] = _bq_credentials
        _gemini_client = genai.Client(**_gemini_kwargs)
        print("Gemini AI: 接続OK")
    except Exception as _gem_e:
        print(f"Gemini AI: 利用不可 ({_gem_e})")

# Firestore コレクション名
FS_PROSPECTS = "meeting_prospects"
FS_MONTHLY_PROSPECTS = "meeting_monthly_prospects"
FS_BLOCKS = "meeting_blocks"
FS_SNAPSHOTS = "meeting_snapshots"
FS_TEMPLATE_CONFIG = "meeting_template_config"

# テンプレート一覧 (デフォルト表示順)
TEMPLATE_DEFINITIONS = [
    {"id": "shipper_increase_curr", "label": "📈 増加荷主 TOP3（当月）", "default_on": True,  "col_span": 1},
    {"id": "shipper_increase_next", "label": "📈 増加荷主 TOP3（翌月）", "default_on": True,  "col_span": 1},
    {"id": "shipper_decrease_curr", "label": "📉 減少荷主 TOP3（当月）", "default_on": True,  "col_span": 1},
    {"id": "shipper_decrease_next", "label": "📉 減少荷主 TOP3（翌月）", "default_on": True,  "col_span": 1},
    {"id": "cm1_range",          "label": "💰 CM1レンジ分析",       "default_on": True,  "col_span": 1},
    {"id": "new_customer",       "label": "🆕 New Customer",        "default_on": True,  "col_span": 1},
    {"id": "regain_customer",    "label": "🔄 Regain Customer",     "default_on": True,  "col_span": 1},
    {"id": "trade_lane",         "label": "🗺️ Trade Lane",          "default_on": True,  "col_span": 2},
    {"id": "cm1_waterfall",      "label": "📊 CM1/TEU 要因分解",    "default_on": False, "col_span": 1},
    {"id": "booking_count",      "label": "📋 Booking件数",         "default_on": True, "col_span": 1},
    {"id": "pol_count",          "label": "🏭 POL数",               "default_on": True, "col_span": 1},
    {"id": "sales_contribution", "label": "👤 営業マン寄与度",      "default_on": False, "col_span": 1},
]

# ── SQLite 初期化 (フォールバック用) ─────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # 見込みデータ (週 × エリア)
    c.execute("""
        CREATE TABLE IF NOT EXISTS prospects (
            week_key TEXT NOT NULL,   -- "2026-W09"
            area     TEXT NOT NULL,   -- "KR"
            teu      REAL,
            cm1      REAL,
            updated  TEXT,
            PRIMARY KEY (week_key, area)
        )
    """)
    # エリアメモ (週 × エリア)
    c.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            week_key TEXT NOT NULL,
            area     TEXT NOT NULL,
            note     TEXT,
            updated  TEXT,
            PRIMARY KEY (week_key, area)
        )
    """)
    # 画像メタデータ
    c.execute("""
        CREATE TABLE IF NOT EXISTS images (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            week_key TEXT NOT NULL,
            area     TEXT NOT NULL,
            filename TEXT NOT NULL,
            caption  TEXT,
            uploaded TEXT
        )
    """)
    # 月間見込み (月 × エリア)
    c.execute("""
        CREATE TABLE IF NOT EXISTS monthly_prospects (
            ym          TEXT NOT NULL,
            area        TEXT NOT NULL,
            teu         REAL,
            cm1_per_teu REAL,
            updated     TEXT,
            PRIMARY KEY (ym, area)
        )
    """)
    # ブロックエディター (週 × エリア × 順序)
    c.execute("""
        CREATE TABLE IF NOT EXISTS blocks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            week_key    TEXT NOT NULL,
            area        TEXT NOT NULL,
            block_order INTEGER NOT NULL DEFAULT 0,
            block_type  TEXT NOT NULL,
            content     TEXT,
            filename    TEXT,
            img_width   INTEGER DEFAULT 200,
            updated     TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

# ── Firestore ユーザー管理 ────────────────────────────
EDITOR_TEAMS = {"jpDigitalStrategy", "jpDigitalSales"}

def get_fs_user(email: str) -> dict | None:
    """Firestoreからユーザー情報を取得。team フィールドでロールを判定"""
    doc = db.collection(FIRESTORE_USERS_COLLECTION).document(email).get()
    if doc.exists:
        d = doc.to_dict()
        team = d.get("team", "")
        # team フィールドが editor_teams にあれば editor、なければ viewer
        if team in EDITOR_TEAMS:
            role = "editor"
        else:
            role = d.get("role", "viewer")  # 後方互換: role フィールドにフォールバック
        return {"email": email, "role": role,
                "display_name": d.get("display_name", email),
                "team": team}
    return None

def ensure_bootstrap_admin():
    """初期管理者を登録 / team フィールドが未設定なら追加"""
    col = db.collection(FIRESTORE_USERS_COLLECTION)
    doc_ref = col.document(BOOTSTRAP_ADMIN_EMAIL)
    doc = doc_ref.get()
    if not doc.exists:
        doc_ref.set({
            "team": "jpDigitalStrategy",
            "display_name": "管理者",
            "created_by": "system",
        })
        print(f"Bootstrap admin created: {BOOTSTRAP_ADMIN_EMAIL}")
    elif not doc.to_dict().get("team"):
        doc_ref.update({"team": "jpDigitalStrategy"})
        print(f"Bootstrap admin team updated: {BOOTSTRAP_ADMIN_EMAIL}")

ensure_bootstrap_admin()

# ── 認証ヘルパー ──────────────────────────────────────
def get_current_user():
    """セッションから現在のユーザー情報を返す。未ログインは None"""
    email = session.get("email")
    if not email:
        return None
    return {
        "email": email,
        "role": session.get("role", "viewer"),
        "display_name": session.get("display_name", email),
    }

def require_login(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not get_current_user():
            return jsonify({"error": "login required", "redirect": "/login"}), 401
        return f(*args, **kwargs)
    return wrapper

def require_editor(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "login required", "redirect": "/login"}), 401
        if user["role"] != "editor":
            return jsonify({"error": "editor role required"}), 403
        return f(*args, **kwargs)
    return wrapper

# ── Firestore: 最終更新日時 ───────────────────────────
def get_last_refresh() -> dict | None:
    """Firestoreから最終BQ更新情報を取得"""
    if not _firestore_available:
        return None
    try:
        doc = db.collection(FIRESTORE_CONFIG_COLLECTION).document(REFRESH_DOC_ID).get()
        return doc.to_dict() if doc.exists else None
    except Exception as e:
        print(f"get_last_refresh error: {e}")
        return None

def set_last_refresh(iso_str: str, refreshed_by: str):
    """Firestoreに最終BQ更新情報を保存"""
    if not _firestore_available:
        return
    try:
        db.collection(FIRESTORE_CONFIG_COLLECTION).document(REFRESH_DOC_ID).set({
            "last_refresh": iso_str,
            "refreshed_by": refreshed_by,
        })
    except Exception as e:
        print(f"set_last_refresh error: {e}")

# ── BigQuery ベースクエリ ──────────────────────────────
BASE_QUERY = """
WITH raw01 AS (
  SELECT
    Booking_No_,
    ETD,
    Booking_Shipper,
    BKG_Shipper_code,
    POL_Sales,
    POL,
    CTR,
    CASE
      WHEN POL IN ("YOK","TYO","CHB","SMZ","NGO","THS","YKK","OSA","UKB") AND CTR = "KR" THEN "JPC_KR"
      WHEN POL NOT IN ("YOK","TYO","CHB","SMZ","NGO","THS","YKK","OSA","UKB") AND CTR = "KR" THEN "JPN_KR"
      ELSE CTR
    END AS AREA,
    POD,
    DLY,
    SUM(TEU) AS TEU
  FROM `updated_tables.score_dailybooking`
  WHERE ETD >= "2025-01-01"
  GROUP BY 1,2,3,4,5,6,7,8,9,10
  ORDER BY ETD
),
raw02 AS (
  SELECT DISTINCT BKG_No, BL_No
  FROM `updated_tables.lifting_detail`
  WHERE FORMAT_DATE('%Y-%m', DATE(Year, Month, 1)) >= '2025-01'
),
raw03 AS (
  SELECT DISTINCT
    FORMAT_DATE('%Y-%m', DATE(Year, MON, 1)) AS YearMonth,
    B_L_No_ AS BL_No,
    TEU,
    CM1
  FROM `updated_tables.lpa_revised_monthly`
)
SELECT
  FORMAT_DATE('%Y-%m', raw01.ETD) AS YearMonth,
  raw01.Booking_No_,
  raw02.BL_No,
  raw01.Booking_Shipper,
  raw01.BKG_Shipper_code,
  raw01.POL_Sales,
  raw01.POL,
  raw01.CTR,
  raw01.AREA,
  raw01.POD,
  raw01.DLY,
  raw01.ETD,
  SUM(raw01.TEU) AS TEU_score,
  SUM(raw03.TEU) AS TEU_lpa,
  SUM(raw03.CM1) AS CM1
FROM raw01
LEFT JOIN raw02 ON raw01.Booking_No_ = raw02.BKG_No
LEFT JOIN raw03 ON raw02.BL_No = raw03.BL_No
GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12
ORDER BY BL_No
"""

def get_date_range_for_dashboard() -> tuple:
    """ダッシュボード用の日付範囲（過去6か月 〜 来月末）"""
    today = date.today()
    start = (today.replace(day=1) - timedelta(days=5*30)).replace(day=1)
    next_month_start = (today.replace(day=28) + timedelta(days=4)).replace(day=1)
    end = (next_month_start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    return start, end

# ── グローバル BQ キャッシュ ──────────────────────────
# データは起動時に1回ロード。以降はスケジューラーか手動更新のみ更新。
_bq_df: pd.DataFrame | None = None
_bq_loaded: bool = False
_bq_lock = threading.Lock()

_EMPTY_DF = pd.DataFrame(columns=[
    "ETD","YearMonth","Booking_No_","BL_No","Booking_Shipper","BKG_Shipper_code",
    "POL_Sales","POL","CTR","AREA","POD","DLY",
    "TEU_score","TEU_lpa","CM1","TEU",
    "week_year","week_no","week_key","month","ym","etd_ym","bq_ym"])

def _raw_fetch_bq() -> pd.DataFrame:
    """BigQuery から実際にデータを取得する（ロックなし）"""
    df = bq_client.query(BASE_QUERY).to_dataframe()
    df["ETD"] = pd.to_datetime(df["ETD"]).dt.date
    df["TEU_score"] = pd.to_numeric(df["TEU_score"], errors="coerce").fillna(0)
    df["TEU_lpa"]   = pd.to_numeric(df["TEU_lpa"],   errors="coerce")  # NaN を保持
    df["CM1"]       = pd.to_numeric(df["CM1"],        errors="coerce").fillna(0)
    # ① TEU_lpa があればそちらを優先、なければ TEU_score
    df["TEU"] = df["TEU_lpa"].fillna(df["TEU_score"])
    week_infos = df["ETD"].apply(get_week_info)
    df["week_year"]  = week_infos.apply(lambda x: x["year"])
    df["week_no"]    = week_infos.apply(lambda x: x["week"])
    df["week_key"]   = week_infos.apply(lambda x: x["week_key"])
    df["month"]      = week_infos.apply(lambda x: x["month"])
    df["ym"]         = week_infos.apply(lambda x: x["ym"])
    # 実カレンダー月 (ETD の年月) - 月間推移チャート用
    df["etd_ym"]     = df["ETD"].apply(lambda d: f"{d.year}-{d.month:02d}")
    # BQ YearMonth 列 (FORMAT_DATE('%Y-%m', ETD)) - 月間見込み・Top5用
    df["bq_ym"]      = df["YearMonth"].fillna(df["etd_ym"]).astype(str)
    return df

def do_refresh_bq(update_firestore: bool = True, refreshed_by: str = "system") -> bool:
    """BQデータをリフレッシュしてグローバルキャッシュに保存。
    update_firestore=True のときは Firestore の last_refresh も更新。"""
    global _bq_df, _bq_loaded
    with _bq_lock:
        try:
            df = _raw_fetch_bq()
            _bq_df = df
            _bq_loaded = True
            print(f"BQ data refreshed: {len(df)} rows")
            if update_firestore:
                now_jst = datetime.now(tz=JST).isoformat()
                set_last_refresh(now_jst, refreshed_by)
            return True
        except Exception as e:
            print(f"BigQuery refresh error: {e}")
            if not _bq_loaded:
                _bq_df = _EMPTY_DF.copy()
                _bq_loaded = True
            return False

def get_bq_df() -> pd.DataFrame:
    """グローバルキャッシュを返す。未ロードなら起動時ロード（Firestore更新なし）"""
    if not _bq_loaded:
        do_refresh_bq(update_firestore=False, refreshed_by="startup")
    return _bq_df if _bq_df is not None else _EMPTY_DF.copy()

# ローカルとの互換性のため fetch_bq_data も残す（引数は無視してキャッシュを返す）
def fetch_bq_data(start_date: date, end_date: date) -> pd.DataFrame:
    return get_bq_df()

# ── サブエリア定義 (PODベースの国内分割) ────────────────────
# key: サブエリア名, value: (親AREA, PODリスト, include=True/exclude=False)
SUB_AREA_DEFS = {
    "IN-West":  ("IN", ["NSA", "MUN"], True),     # NSA & MUN のみ
    "IN-East":  ("IN", ["NSA", "MUN"], False),     # NSA & MUN 以外
    "PKG&PEN":  ("MY", ["PKG", "PEN"], True),
    "PKW&PGU":  ("MY", ["PKW", "PGU"], True),
    "MIP":      ("PH", ["MIP"], True),
    "MNL":      ("PH", ["MNL"], True),
    "SGN":      ("VN", ["SGN"], True),
    "HPH":      ("VN", ["HPH"], True),
}

def _sub_area_parent(area: str) -> str | None:
    """サブエリアの親エリアを返す。サブエリアでなければ None。"""
    if area in SUB_AREA_DEFS:
        return SUB_AREA_DEFS[area][0]
    return None

def get_all_areas(df: pd.DataFrame) -> list:
    areas = sorted(df["AREA"].dropna().unique().tolist())
    # KR = JPC_KR + JPN_KR の合計として追加
    if "JPC_KR" in areas or "JPN_KR" in areas:
        areas = ["KR"] + areas
    # サブエリアは親エリアが存在すれば追加
    sub_areas = [sa for sa, (parent, _, _) in SUB_AREA_DEFS.items()
                 if parent in areas]
    all_available = set(areas) | set(sub_areas)
    # 表示順を固定
    preferred = [
        "KR", "JPC_KR", "JPN_KR", "AE", "NCN", "SCN",
        "HK", "ID",
        "IN", "IN-West", "IN-East",
        "PK",
        "MY", "PKG&PEN", "PKW&PGU",
        "PH", "MIP", "MNL",
        "SG", "TH",
        "VN", "SGN", "HPH",
        "MX", "US",
    ]
    ordered = [a for a in preferred if a in all_available]
    ordered += [a for a in areas if a not in preferred and a not in ordered]
    return ["ALL"] + ordered

# ── カレンダー月ユーティリティ ────────────────────────
def _cal_months(year: int, month: int, past: int, future: int) -> list:
    """実カレンダー月のリストを返す [(year, month), ...]"""
    res = []
    for i in range(past, 0, -1):
        m2, y2 = month - i, year
        while m2 <= 0:
            m2 += 12; y2 -= 1
        res.append((y2, m2))
    res.append((year, month))
    for i in range(1, future + 1):
        m2, y2 = month + i, year
        while m2 > 12:
            m2 -= 12; y2 += 1
        res.append((y2, m2))
    return res

# ── Firestore データアクセス ───────────────────────────
def load_prospects(week_keys: list, meeting_week: str = "") -> dict:
    """見込みデータを Firestore から取得。meeting_week で会議週スコープ。
    {week_key|area: {teu, cm1}}"""
    if not _firestore_available or not week_keys:
        return {}
    result = {}
    query = db.collection(FS_PROSPECTS)
    if meeting_week:
        query = query.where("meeting_week", "==", meeting_week)
    for i in range(0, len(week_keys), 30):
        chunk = week_keys[i:i+30]
        docs = query.where("week_key", "in", chunk).stream()
        for doc in docs:
            d = doc.to_dict()
            result[f"{d['week_key']}|{d['area']}"] = {"teu": d.get("teu"), "cm1": d.get("cm1")}
    return result

def load_monthly_prospects(yms: list, meeting_week: str = "") -> dict:
    """月間見込みを Firestore から取得。meeting_week で会議週スコープ。
    {ym|area: {teu, cm1_per_teu}}"""
    if not _firestore_available or not yms:
        return {}
    result = {}
    query = db.collection(FS_MONTHLY_PROSPECTS)
    if meeting_week:
        query = query.where("meeting_week", "==", meeting_week)
    for i in range(0, len(yms), 30):
        chunk = yms[i:i+30]
        docs = query.where("ym", "in", chunk).stream()
        for doc in docs:
            d = doc.to_dict()
            result[f"{d['ym']}|{d['area']}"] = {"teu": d.get("teu"), "cm1_per_teu": d.get("cm1_per_teu")}
    return result

def load_notes(week_key: str) -> dict:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    rows = c.execute(
        "SELECT area, note FROM notes WHERE week_key = ?", (week_key,)
    ).fetchall()
    conn.close()
    return {area: note for area, note in rows}

def load_images(week_key: str, area: str) -> list:
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    rows = c.execute(
        "SELECT id, filename, caption FROM images WHERE week_key=? AND area=?",
        (week_key, area)
    ).fetchall()
    conn.close()
    return [{"id": r[0], "filename": r[1], "caption": r[2]} for r in rows]

# ── API エンドポイント ─────────────────────────────────

@app.route("/")
def index():
    if not get_current_user():
        return redirect("/login")
    return send_from_directory("templates", "index.html")

@app.route("/login")
def login_page():
    return send_from_directory("templates", "login.html")

@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)

@app.route("/data/uploads/<path:filename>")
def uploaded_files(filename):
    """GCS（利用可能時）またはローカルから画像を配信"""
    if _gcs_available:
        blob = gcs_bucket.blob(f"meeting-uploads/{filename}")
        if blob.exists():
            content = blob.download_as_bytes()
            ct = blob.content_type or "image/png"
            return Response(content, content_type=ct)
        return "Not found", 404
    return send_from_directory(str(UPLOAD_DIR), filename)


@app.route("/api/auth/google", methods=["POST"])
def api_google_login():
    """Firebase IDトークンを検証してセッションを作成"""
    data = request.json or {}
    id_token = data.get("id_token", "")
    if not id_token:
        return jsonify({"error": "id_token required"}), 400

    try:
        decoded = fb_auth.verify_id_token(id_token)
    except Exception as e:
        return jsonify({"error": f"トークン検証失敗: {str(e)}"}), 401

    email = decoded.get("email", "")
    if not email:
        return jsonify({"error": "メールアドレスが取得できません"}), 400

    # Firestoreでユーザー確認
    fs_user = get_fs_user(email)
    if not fs_user:
        return jsonify({
            "error": f"このアカウント ({email}) はアクセス権限がありません。管理者に連絡してください。"
        }), 403

    # セッション作成
    display_name = decoded.get("name") or fs_user["display_name"]
    session["email"]        = email
    session["role"]         = fs_user["role"]
    session["display_name"] = display_name
    session.permanent       = False

    return jsonify({
        "email": email,
        "role":  fs_user["role"],
        "display_name": display_name,
    })

@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/auth/me")
def api_me():
    user = get_current_user()
    if not user:
        return jsonify({"logged_in": False}), 200
    return jsonify({"logged_in": True, **user})

@app.route("/api/auth/users", methods=["GET"])
@require_editor
def api_list_users():
    docs = db.collection(FIRESTORE_USERS_COLLECTION).stream()
    users = []
    for doc in docs:
        d = doc.to_dict()
        users.append({
            "email":        doc.id,
            "role":         d.get("role", "viewer"),
            "display_name": d.get("display_name", doc.id),
        })
    users.sort(key=lambda u: (u["role"] != "editor", u["email"]))
    return jsonify(users)

@app.route("/api/auth/users", methods=["POST"])
@require_editor
def api_add_user():
    data = request.json or {}
    email        = data.get("email", "").strip().lower()
    role         = data.get("role", "viewer")
    display_name = data.get("display_name", email)
    if not email:
        return jsonify({"error": "email required"}), 400
    if role not in ("editor", "viewer"):
        return jsonify({"error": "role must be editor or viewer"}), 400
    me = get_current_user()
    db.collection(FIRESTORE_USERS_COLLECTION).document(email).set({
        "role":         role,
        "display_name": display_name,
        "created_by":   me["email"] if me else "unknown",
    })
    return jsonify({"ok": True})

@app.route("/api/auth/users/<path:email>", methods=["DELETE"])
@require_editor
def api_delete_user(email):
    me = get_current_user()
    if me and me["email"] == email:
        return jsonify({"error": "自分自身は削除できません"}), 400
    db.collection(FIRESTORE_USERS_COLLECTION).document(email).delete()
    return jsonify({"ok": True})

@app.route("/api/auth/users/<path:email>/role", methods=["POST"])
@require_editor
def api_change_role(email):
    data = request.json or {}
    new_role = data.get("role", "viewer")
    if new_role not in ("editor", "viewer"):
        return jsonify({"error": "invalid role"}), 400
    db.collection(FIRESTORE_USERS_COLLECTION).document(email).update({"role": new_role})
    return jsonify({"ok": True})


@app.route("/api/areas")
@require_login
def api_areas():
    start, end = get_date_range_for_dashboard()
    df = fetch_bq_data(start, end)
    return jsonify({"areas": get_all_areas(df)})


def _week_key_to_date(week_key: str) -> date | None:
    """week_key (例: '2026-W16') → その週の開始日 (date) を返す"""
    import re
    m = re.match(r"(\d{4})-W(\d+)", week_key or "")
    if not m:
        return None
    yr, wk = int(m.group(1)), int(m.group(2))
    ws, _ = get_week_date_range(yr, wk)
    return ws


def _ref_date_from_meeting_week(meeting_week: str, today: date) -> date:
    """meeting_week から基準日を算出。チャート範囲のシフトに使用。
    meeting_week が空や無効ならば today を返す。"""
    if not meeting_week:
        return today
    d = _week_key_to_date(meeting_week)
    return d if d else today


def build_summary_for_area(area: str, df: pd.DataFrame, today: date,
                           meeting_week: str = "") -> dict:
    """エリア別サマリーを構築（api_summary / archive 共通ロジック）
    meeting_week: 会議週 (例: "2026-W14")。見込みデータのスコープに使用。
    チャート範囲は meeting_week の月を基準にシフトする。"""
    # チャート基準日: 選択週の月に合わせる
    ref = _ref_date_from_meeting_week(meeting_week, today)
    # エリアフィルタ (KR は JPC_KR + JPN_KR の合計、サブエリアはPODで絞込)
    df_area = _filter_area(df, area)

    empty = {"monthly": [], "weekly": [], "top_shippers": [],
             "shipper_count": 0, "prospects": {}}
    if df_area.empty:
        return empty

    # ── 月次集計 (BQ YearMonth列ベース: TEU/CM1合計) ──────
    # ref (選択週の基準日) でチャート範囲をシフト
    months_list = _cal_months(ref.year, ref.month, 4, 1)
    yms_monthly = [f"{y}-{m:02d}" for y, m in months_list]
    monthly_prospects_db = load_monthly_prospects(yms_monthly, meeting_week)

    # ref の月を基準に is_current / is_future を判定
    ref_ym = (ref.year, ref.month)
    monthly = []
    for y, m in months_list:
        ym_str = f"{y}-{m:02d}"
        sub = df_area[df_area["bq_ym"] == ym_str]
        teu = float(sub["TEU"].sum())
        cm1 = float(sub["CM1"].sum())
        is_fut  = (y, m) > ref_ym
        is_curr = (y, m) == ref_ym
        mp = monthly_prospects_db.get(f"{ym_str}|{area}", {})
        monthly.append({
            "ym": ym_str,
            "label": month_label(y, m),
            "year": y, "month": m,
            "TEU": round(teu),
            "CM1": round(cm1),
            "CM1_per_TEU": round(cm1 / teu) if teu > 0 else 0,
            "shipper_count": int(sub["Booking_Shipper"].nunique()),
            "is_future": is_fut,
            "is_current": is_curr,
            "m_prospect_teu": mp.get("teu"),
            "m_prospect_cm1": mp.get("cm1_per_teu"),
        })

    # ── 週次集計 (選択週の月を中心に前月・当月・来月) ────
    weeks_3m = get_3month_weeks(ref)
    all_week_keys = [w["week_key"] for w in weeks_3m]
    prospects_db = load_prospects(all_week_keys, meeting_week)

    weekly = []
    for w in weeks_3m:
        wk = w["week"]
        wy = w["year"]
        wkey = w["week_key"]
        ws = w["week_start"]
        we = w["week_end"]

        sub = df_area[df_area["week_key"] == wkey]
        teu = float(sub["TEU"].sum())
        cm1 = float(sub["CM1"].sum())
        w_shipper_count = int(sub["Booking_Shipper"].nunique()) if not sub.empty else 0

        p = prospects_db.get(f"{wkey}|{area}", {})
        p_teu = p.get("teu")
        p_cm1 = p.get("cm1")

        ws_date = date.fromisoformat(ws) if ws else None
        is_future = ws_date > ref if ws_date else False
        is_current = (ws_date <= ref <= date.fromisoformat(we)) if ws_date and we else False

        weekly.append({
            "week_key": wkey,
            "week": wk,
            "year": wy,
            "month": w["month"],
            "month_label": w["month_label"],
            "ym": w["ym"],
            "week_label": f"W{wk}",
            "week_start": ws,
            "week_end": we,
            "TEU": round(teu),
            "CM1": round(cm1),
            "CM1_per_TEU": round(cm1 / teu) if teu > 0 else 0,
            "shipper_count": w_shipper_count,
            "prospect_TEU": p_teu,
            "prospect_CM1": p_cm1,
            "is_future": is_future,
            "is_current": is_current,
        })

    # ── Top5 Shipper (BQ YearMonth列ベース) ─────────────
    months_6m = _cal_months(ref.year, ref.month, 5, 0)
    ym_6m = [f"{y}-{m:02d}" for y, m in months_6m]
    df_6m = df_area[df_area["bq_ym"].isin(ym_6m)]

    shipper_total = (
        df_6m.groupby("Booking_Shipper")["TEU"].sum()
        .sort_values(ascending=False)
        .head(5)
    )
    top5_shippers = shipper_total.index.tolist()

    months_3 = _cal_months(ref.year, ref.month, 1, 1)
    prev_y, prev_m = months_3[0]
    curr_y, curr_m = months_3[1]
    next_y, next_m = months_3[2]

    def shipper_stats(shipper, sy, sm):
        ym_str = f"{sy}-{sm:02d}"
        sub = df_area[(df_area["Booking_Shipper"] == shipper) & (df_area["bq_ym"] == ym_str)]
        teu = float(sub["TEU"].sum())
        cm1 = float(sub["CM1"].sum())
        return {"TEU": round(teu), "CM1_per_TEU": round(cm1 / teu) if teu > 0 else 0}

    top_shippers = []
    for s in top5_shippers:
        prev_s = shipper_stats(s, prev_y, prev_m)
        curr_s = shipper_stats(s, curr_y, curr_m)
        next_s = shipper_stats(s, next_y, next_m)
        top_shippers.append({
            "shipper": s,
            "total_6m_TEU": round(float(shipper_total[s])),
            "prev": prev_s, "curr": curr_s, "next": next_s,
            "gap_teu": curr_s["TEU"] - prev_s["TEU"],
        })

    curr_ym = f"{ref.year}-{ref.month:02d}"
    df_curr = df_area[df_area["bq_ym"] == curr_ym]
    shipper_count = int(df_curr["Booking_Shipper"].nunique())

    return {
        "monthly": monthly,
        "weekly": weekly,
        "top_shippers": top_shippers,
        "shipper_count": shipper_count,
        "prospects": {k.split("|")[0]: v for k, v in prospects_db.items() if k.endswith(f"|{area}")},
    }


@app.route("/api/summary")
@require_login
def api_summary():
    """エリア別ダッシュボードデータを返す ?area=KR&meeting_week=2026-W14"""
    today = date.today()
    df = get_bq_df()
    area = request.args.get("area", "ALL")
    meeting_week = request.args.get("meeting_week", "")
    return jsonify(build_summary_for_area(area, df, today, meeting_week))


# ── 予測 API ─────────────────────────────────────────────
# 4年分の軽量BQクエリ (予測専用: TEU_lpa + CM1 のみ)
PREDICT_QUERY = """
WITH raw01 AS (
  SELECT Booking_No_, ETD, POL,
    CASE
      WHEN POL IN ("YOK","TYO","CHB","SMZ","NGO","THS","YKK","OSA","UKB") AND CTR = "KR" THEN "JPC_KR"
      WHEN POL NOT IN ("YOK","TYO","CHB","SMZ","NGO","THS","YKK","OSA","UKB") AND CTR = "KR" THEN "JPN_KR"
      ELSE CTR
    END AS AREA,
    SUM(TEU) AS TEU
  FROM `updated_tables.score_dailybooking`
  WHERE ETD >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 4 YEAR), YEAR)
  GROUP BY 1,2,3,4
),
raw02 AS (
  SELECT DISTINCT BKG_No, BL_No
  FROM `updated_tables.lifting_detail`
  WHERE FORMAT_DATE('%Y-%m', DATE(Year, Month, 1)) >= FORMAT_DATE('%Y-%m', DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 4 YEAR), YEAR))
),
raw03 AS (
  SELECT DISTINCT FORMAT_DATE('%Y-%m', DATE(Year, MON, 1)) AS YearMonth,
    B_L_No_ AS BL_No, TEU, CM1
  FROM `updated_tables.lpa_revised_monthly`
)
SELECT FORMAT_DATE('%Y-%m', raw01.ETD) AS YearMonth,
  raw01.AREA, raw01.ETD,
  SUM(raw03.TEU) AS TEU_lpa,
  SUM(raw03.CM1) AS CM1
FROM raw01
LEFT JOIN raw02 ON raw01.Booking_No_ = raw02.BKG_No
LEFT JOIN raw03 ON raw02.BL_No = raw03.BL_No
GROUP BY 1,2,3
ORDER BY ETD
"""

# 予測用データキャッシュ (ボタン押下時にBQ問い合わせ → 1時間キャッシュ)
_predict_df: pd.DataFrame | None = None
_predict_loaded_at: float = 0
_predict_lock = threading.Lock()
_PREDICT_CACHE_SEC = 3600  # 1時間

def _fetch_predict_df() -> pd.DataFrame:
    """予測用4年分データをBQから取得 (キャッシュ付き)"""
    global _predict_df, _predict_loaded_at
    import time
    now = time.time()
    with _predict_lock:
        if _predict_df is not None and (now - _predict_loaded_at) < _PREDICT_CACHE_SEC:
            return _predict_df
    df = bq_client.query(PREDICT_QUERY).to_dataframe()
    df["ETD"] = pd.to_datetime(df["ETD"])
    df["TEU_lpa"] = pd.to_numeric(df["TEU_lpa"], errors="coerce")
    df["CM1"] = pd.to_numeric(df["CM1"], errors="coerce")
    print(f"Predict BQ: {len(df):,} rows, ETD {df['ETD'].min().date()} ~ {df['ETD'].max().date()}")
    with _predict_lock:
        _predict_df = df
        _predict_loaded_at = now
    return df


def _build_prediction(area: str, today: date,
                      meeting_week: str = "") -> dict:
    """4年分の TEU_lpa データで季節性分析 → 将来の TEU / CM1 を予測。
    月間: 月別季節性指数 × 直近6か月ベースライン (TEU_lpa のみ)
    CM1/TEU: 直近6か月の線形回帰でトレンド延長
    週間: 季節別(冬/夏/通常)の月内均等セグメント配分 (4年分フル活用)"""
    ref = _ref_date_from_meeting_week(meeting_week, today)
    df = _fetch_predict_df()

    # エリアフィルタ (予測クエリにPOD列なし → サブエリアは親エリアにフォールバック)
    df_area = _filter_area_no_pod(df, area)

    if df_area.empty:
        return {"monthly": {}, "weekly": {}}

    # ── 月別集計 (TEU_lpa のみ) ───────────────────────
    df_area["_ym"] = df_area["YearMonth"]
    df_area["_cal_month"] = df_area["ETD"].dt.month

    monthly_agg = df_area.groupby("_ym").agg(
        TEU_lpa=("TEU_lpa", "sum"), CM1=("CM1", "sum")
    ).reset_index()
    monthly_agg["CM1_per_TEU"] = monthly_agg.apply(
        lambda r: round(r["CM1"] / r["TEU_lpa"]) if r["TEU_lpa"] > 0 else 0, axis=1)
    monthly_agg["month_num"] = monthly_agg["_ym"].apply(lambda s: int(s.split("-")[1]))

    # 不完全月を除外 (当月以降 + データ欠損月)
    ref_ym = f"{ref.year}-{ref.month:02d}"
    complete = monthly_agg[monthly_agg["_ym"] < ref_ym].copy()

    # 外れ値除外: 各月の中央値から±2σ以上離れた月を除外
    if len(complete) > 6:
        for m_num in range(1, 13):
            sub = complete[complete["month_num"] == m_num]["TEU_lpa"]
            if len(sub) >= 2:
                median_val = sub.median()
                std_val = sub.std()
                if std_val > 0:
                    complete = complete[~(
                        (complete["month_num"] == m_num) &
                        ((complete["TEU_lpa"] - median_val).abs() > 2 * std_val)
                    )]

    # 季節性指数: 各月(1-12)の平均 TEU_lpa / 全体平均
    overall_avg = complete["TEU_lpa"].mean() if len(complete) > 0 else 1
    seasonal_idx = {}
    for m_num in range(1, 13):
        sub = complete[complete["month_num"] == m_num]
        if len(sub) > 0:
            seasonal_idx[m_num] = float(sub["TEU_lpa"].mean()) / overall_avg if overall_avg > 0 else 1.0
        else:
            seasonal_idx[m_num] = 1.0

    # 直近6か月の TEU_lpa (季節性除去してベースライン算出)
    # CM1/TEU はトレンド（下落・上昇）を捉えるため加重平均 + 線形回帰
    recent_months = _cal_months(ref.year, ref.month, 6, 0)[:-1]  # 当月除く過去6か月
    recent_teus = []
    recent_cm1s = []  # [(month_offset, cm1_per_teu)]
    for idx, (y, m) in enumerate(recent_months):
        ym_str = f"{y}-{m:02d}"
        sub = monthly_agg[monthly_agg["_ym"] == ym_str]
        if len(sub) > 0 and float(sub["TEU_lpa"].iloc[0]) > 0:
            raw_teu = float(sub["TEU_lpa"].iloc[0])
            raw_cm1t = float(sub["CM1_per_TEU"].iloc[0])
            si = seasonal_idx.get(m, 1.0)
            recent_teus.append(raw_teu / si if si > 0 else raw_teu)
            recent_cm1s.append((idx, raw_cm1t))

    base_teu = sum(recent_teus) / len(recent_teus) if recent_teus else overall_avg

    # CM1/TEU: 線形回帰で直近トレンドを延長予測
    if len(recent_cm1s) >= 3:
        # 最小二乗法 (y = a*x + b)
        n = len(recent_cm1s)
        xs = [c[0] for c in recent_cm1s]
        ys = [c[1] for c in recent_cm1s]
        x_mean = sum(xs) / n
        y_mean = sum(ys) / n
        ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
        ss_xx = sum((x - x_mean) ** 2 for x in xs)
        slope = ss_xy / ss_xx if ss_xx > 0 else 0
        intercept = y_mean - slope * x_mean
        # 予測月のオフセット (直近月の次 = len(recent_months))
        base_offset = len(recent_months)
    else:
        slope = 0
        intercept = sum(c[1] for c in recent_cm1s) / len(recent_cm1s) if recent_cm1s else 0
        base_offset = 0

    # ── 月間予測 ──────────────────────────────────────
    predict_months = _cal_months(ref.year, ref.month, 0, 1)
    monthly_pred = {}
    _cm1_by_month_idx = {}  # 週間CM1補間用に月indexと値を記録
    for i, (y, m) in enumerate(predict_months):
        ym_str = f"{y}-{m:02d}"
        si = seasonal_idx.get(m, 1.0)
        pred_teu_raw = base_teu * si
        # CM1/TEU: トレンド延長
        pred_cm1_raw = slope * (base_offset + i) + intercept
        if pred_cm1_raw < 0:
            pred_cm1_raw = intercept
        monthly_pred[ym_str] = {
            "teu": round(pred_teu_raw),
            "cm1_per_teu": round(pred_cm1_raw),
        }
        _cm1_by_month_idx[ym_str] = pred_cm1_raw

    # ── 週間予測 (季節別・均等セグメント配分、4年分フル活用) ────
    # 会社カレンダー不要: 各月の日数をN等分してTEU_lpaの配分比率を学習
    # 季節区分: 冬(12,1,2,3)=船遅延/月初膨張, 夏(6,7,8,9)=台風遅延, 通常(4,5,10,11)
    import calendar as _cal

    def _predict_season(cal_month: int) -> str:
        if cal_month in (12, 1, 2, 3):
            return "winter"
        elif cal_month in (6, 7, 8, 9):
            return "summer"
        return "normal"

    def _assign_segment(day: int, days_in_month: int, n_segments: int) -> int:
        seg_size = days_in_month / n_segments
        return min(int((day - 1) / seg_size), n_segments - 1)

    # 当月以前のデータで学習
    df_train = df_area[df_area["ETD"] < pd.Timestamp(ref.year, ref.month, 1)].copy()
    df_train["_day"] = df_train["ETD"].dt.day
    df_train["_year"] = df_train["ETD"].dt.year
    df_train["_cal_month"] = df_train["ETD"].dt.month
    df_train["_days_in_month"] = df_train.apply(
        lambda r: _cal.monthrange(int(r["_year"]), int(r["_cal_month"]))[1], axis=1)

    # 4分割・5分割の両方でセグメント配分を学習
    seg_ratios = {}     # {(n_seg, season): {pos: ratio}}
    seg_ratios_all = {} # {n_seg: {pos: ratio}}
    for n_seg in [4, 5]:
        df_s = df_train.copy()
        df_s["_seg"] = df_s.apply(
            lambda r: _assign_segment(int(r["_day"]), int(r["_days_in_month"]), n_seg), axis=1)
        seg_agg = df_s.groupby(["_ym", "_seg", "_cal_month"]).agg(
            TEU_lpa=("TEU_lpa", "sum")).reset_index()
        month_tots = seg_agg.groupby("_ym")["TEU_lpa"].sum()
        seg_agg["month_total"] = seg_agg["_ym"].map(month_tots)
        seg_agg = seg_agg[seg_agg["month_total"] > 0]
        seg_agg["ratio"] = seg_agg["TEU_lpa"] / seg_agg["month_total"]
        seg_agg["season"] = seg_agg["_cal_month"].apply(_predict_season)

        # 全体 (非季節)
        seg_ratios_all[n_seg] = seg_agg.groupby("_seg")["ratio"].mean().to_dict()
        # 季節別
        for sn in ["winter", "summer", "normal"]:
            sub = seg_agg[seg_agg["season"] == sn]
            if len(sub) > 0:
                seg_ratios[(n_seg, sn)] = sub.groupby("_seg")["ratio"].mean().to_dict()

    # 週間予測: 各将来月の週に配分
    weeks_3m = get_3month_weeks(ref)
    weekly_pred = {}
    for ym_str in set(w["ym"] for w in weeks_3m):
        m_pred = monthly_pred.get(ym_str)
        if not m_pred:
            continue
        month_weeks = [w for w in weeks_3m if w["ym"] == ym_str]
        n_weeks = len(month_weeks)
        cal_m = int(ym_str.split("-")[1])
        season = _predict_season(cal_m)

        # 季節別比率を優先、なければ全体比率
        ratios = seg_ratios.get((n_weeks, season)) or seg_ratios_all.get(n_weeks) or {}
        if not ratios:
            ratios = {i: 1.0 / n_weeks for i in range(n_weeks)}

        raw_shares = [ratios.get(i, 1.0 / n_weeks) for i in range(n_weeks)]
        total_r = sum(raw_shares)
        for pos_idx, w in enumerate(month_weeks):
            share = raw_shares[pos_idx] / total_r if total_r > 0 else 1.0 / n_weeks
            weekly_pred[w["week_key"]] = {
                "teu": int(m_pred["teu"] * share + 0.5),
                "cm1_per_teu": m_pred["cm1_per_teu"],
            }

    # ── 週間 CM1/TEU を線形補間 (月をまたいで滑らかに変化) ──
    # 全週をソートして、月の中央位置に月間CM1値を配置 → 週ごとに補間
    sorted_weeks = sorted(weekly_pred.keys())
    if len(sorted_weeks) >= 2:
        # 各週の月間CM1値と月内位置を取得
        week_cm1_anchors = []  # [(week_idx, cm1_value)]
        for ym_str, cm1_val in _cm1_by_month_idx.items():
            # この月の週のindexを取得
            month_week_idxs = [
                i for i, wk in enumerate(sorted_weeks)
                if any(w["ym"] == ym_str and w["week_key"] == wk
                       for w in weeks_3m)
            ]
            if month_week_idxs:
                mid_idx = month_week_idxs[len(month_week_idxs) // 2]
                week_cm1_anchors.append((mid_idx, cm1_val))

        if len(week_cm1_anchors) >= 2:
            week_cm1_anchors.sort(key=lambda x: x[0])
            for i, wk in enumerate(sorted_weeks):
                # アンカー間で線形補間
                if i <= week_cm1_anchors[0][0]:
                    cm1_v = week_cm1_anchors[0][1]
                elif i >= week_cm1_anchors[-1][0]:
                    cm1_v = week_cm1_anchors[-1][1]
                else:
                    # 前後のアンカーを見つけて補間
                    for j in range(len(week_cm1_anchors) - 1):
                        a_idx, a_val = week_cm1_anchors[j]
                        b_idx, b_val = week_cm1_anchors[j + 1]
                        if a_idx <= i <= b_idx:
                            t = (i - a_idx) / (b_idx - a_idx) if b_idx != a_idx else 0
                            cm1_v = a_val + t * (b_val - a_val)
                            break
                    else:
                        cm1_v = weekly_pred[wk]["cm1_per_teu"]
                weekly_pred[wk]["cm1_per_teu"] = round(cm1_v)

    return {"monthly": monthly_pred, "weekly": weekly_pred}


@app.route("/api/predict")
@require_login
def api_predict():
    """4年分BQデータの季節性分析に基づく将来予測値を返す"""
    today = date.today()
    area = request.args.get("area", "ALL")
    meeting_week = request.args.get("meeting_week", "")
    try:
        result = _build_prediction(area, today, meeting_week)
        return jsonify(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── テンプレートデータ API ──────────────────────────────────
# 荷主履歴クエリ (②New Customer / ③Regain 判定用: 過去18か月の荷主別TEU)
SHIPPER_HISTORY_QUERY = """
WITH raw01 AS (
  SELECT Booking_No_, ETD, Booking_Shipper,
    CASE
      WHEN POL IN ("YOK","TYO","CHB","SMZ","NGO","THS","YKK","OSA","UKB") AND CTR = "KR" THEN "JPC_KR"
      WHEN POL NOT IN ("YOK","TYO","CHB","SMZ","NGO","THS","YKK","OSA","UKB") AND CTR = "KR" THEN "JPN_KR"
      ELSE CTR
    END AS AREA,
    SUM(TEU) AS TEU
  FROM `updated_tables.score_dailybooking`
  WHERE ETD >= DATE_SUB(CURRENT_DATE(), INTERVAL 18 MONTH)
  GROUP BY 1,2,3,4
),
raw02 AS (
  SELECT DISTINCT BKG_No, BL_No
  FROM `updated_tables.lifting_detail`
  WHERE FORMAT_DATE('%Y-%m', DATE(Year, Month, 1)) >= FORMAT_DATE('%Y-%m', DATE_SUB(CURRENT_DATE(), INTERVAL 18 MONTH))
),
raw03 AS (
  SELECT DISTINCT FORMAT_DATE('%Y-%m', DATE(Year, MON, 1)) AS YearMonth,
    B_L_No_ AS BL_No, TEU, CM1
  FROM `updated_tables.lpa_revised_monthly`
)
SELECT FORMAT_DATE('%Y-%m', raw01.ETD) AS YearMonth,
  raw01.AREA, raw01.Booking_Shipper,
  SUM(COALESCE(raw03.TEU, raw01.TEU)) AS TEU
FROM raw01
LEFT JOIN raw02 ON raw01.Booking_No_ = raw02.BKG_No
LEFT JOIN raw03 ON raw02.BL_No = raw03.BL_No
GROUP BY 1,2,3
ORDER BY YearMonth
"""

_shipper_hist_df: pd.DataFrame | None = None
_shipper_hist_loaded_at: float = 0
_shipper_hist_lock = threading.Lock()
_SHIPPER_HIST_CACHE_SEC = 3600  # 1時間

def _fetch_shipper_history() -> pd.DataFrame:
    """荷主履歴データをBQから取得 (キャッシュ付き)"""
    global _shipper_hist_df, _shipper_hist_loaded_at
    import time
    now = time.time()
    with _shipper_hist_lock:
        if _shipper_hist_df is not None and (now - _shipper_hist_loaded_at) < _SHIPPER_HIST_CACHE_SEC:
            return _shipper_hist_df
    df = bq_client.query(SHIPPER_HISTORY_QUERY).to_dataframe()
    df["TEU"] = pd.to_numeric(df["TEU"], errors="coerce").fillna(0)
    print(f"Shipper History BQ: {len(df):,} rows")
    with _shipper_hist_lock:
        _shipper_hist_df = df
        _shipper_hist_loaded_at = now
    return df


def _filter_area(df: pd.DataFrame, area: str) -> pd.DataFrame:
    """共通エリアフィルタ (PODベースのサブエリア対応)"""
    if area in SUB_AREA_DEFS:
        parent, pods, include = SUB_AREA_DEFS[area]
        sub = df[df["AREA"] == parent].copy()
        if "POD" in sub.columns:
            if include:
                return sub[sub["POD"].isin(pods)]
            else:
                return sub[~sub["POD"].isin(pods)]
        return sub  # POD列がない場合は親エリア全体
    if area == "KR":
        return df[df["AREA"].isin(["JPC_KR", "JPN_KR"])].copy()
    elif area != "ALL":
        return df[df["AREA"] == area].copy()
    return df.copy()

def _filter_area_no_pod(df: pd.DataFrame, area: str) -> pd.DataFrame:
    """POD列がないDF用フィルタ (サブエリアは親エリアにフォールバック)"""
    parent = _sub_area_parent(area)
    if parent:
        area = parent
    if area == "KR":
        return df[df["AREA"].isin(["JPC_KR", "JPN_KR"])].copy()
    elif area != "ALL":
        return df[df["AREA"] == area].copy()
    return df.copy()


def build_template_data(area: str, df: pd.DataFrame, today: date,
                        meeting_week: str = "") -> dict:
    """プレビュー用テンプレートデータを全種類まとめて算出"""
    ref = _ref_date_from_meeting_week(meeting_week, today)
    df_area = _filter_area(df, area)

    if df_area.empty:
        return {}

    ref_ym = f"{ref.year}-{ref.month:02d}"

    # ── 共通: 月別荷主TEU集計 ──────────────────────────
    # 過去5か月 + 当月 + 来月
    months_7 = _cal_months(ref.year, ref.month, 5, 1)
    yms_7 = [f"{y}-{m:02d}" for y, m in months_7]
    df_range = df_area[df_area["bq_ym"].isin(yms_7)]

    # 荷主 × 月別 TEU/CM1
    shipper_monthly = df_range.groupby(["Booking_Shipper", "bq_ym"]).agg(
        TEU=("TEU", "sum"), CM1=("CM1", "sum")
    ).reset_index()

    result = {}

    # ──────────────────────────────────────────────────
    # ① 増減荷主 TOP3 (当月/翌月 × 増加/減少 = 4ブロック)
    # ──────────────────────────────────────────────────
    try:
        import calendar

        # 過去3か月 (当月除く) の月平均 TEU
        months_avg3 = _cal_months(ref.year, ref.month, 3, 0)[:-1]
        yms_avg3 = [f"{y}-{m:02d}" for y, m in months_avg3]
        curr_ym = ref_ym
        next_m = _cal_months(ref.year, ref.month, 0, 1)[-1]
        next_ym = f"{next_m[0]}-{next_m[1]:02d}"

        df_avg3 = shipper_monthly[shipper_monthly["bq_ym"].isin(yms_avg3)]
        # 常に3で割る（データが0〜2か月分でも分母は3固定）
        avg3 = (df_avg3.groupby("Booking_Shipper")["TEU"].sum() / 3).rename("avg3_teu")

        def _ym_label(ym_str):
            y, m = ym_str.split("-")
            return f"{y} {calendar.month_abbr[int(m)]}"

        avg3_labels = [_ym_label(ym) for ym in yms_avg3]
        avg3_range = f"{avg3_labels[0]} - {avg3_labels[-1]}" if avg3_labels else ""
        df_detail_avg3 = df_area[df_area["bq_ym"].isin(yms_avg3)]

        def _top_pol_dly(shipper_name, target_ym):
            """最も差異に貢献した POL-DLY 組み合わせを1つ返す"""
            sub_r = df_area[(df_area["Booking_Shipper"] == shipper_name) & (df_area["bq_ym"] == target_ym)]
            sub_a = df_detail_avg3[df_detail_avg3["Booking_Shipper"] == shipper_name]
            recent_combo = sub_r.groupby(["POL", "DLY"])["TEU"].sum()
            avg3_combo = sub_a.groupby(["POL", "DLY"])["TEU"].sum() / 3
            all_combos = set(recent_combo.index) | set(avg3_combo.index)
            if not all_combos:
                return None
            best = None
            best_diff = 0
            for combo in all_combos:
                r = float(recent_combo.get(combo, 0))
                a = float(avg3_combo.get(combo, 0))
                d = abs(r - a)
                if d > best_diff:
                    best_diff = d
                    best = {"pol": combo[0], "dly": combo[1],
                            "avg3_teu": round(a), "recent_teu": round(r)}
            return best

        def _build_month_block(target_ym):
            """1か月分の荷主TEU vs 3M平均を算出し、増加/減少TOP3を返す"""
            df_target = shipper_monthly[shipper_monthly["bq_ym"] == target_ym]
            target_teu = df_target.groupby("Booking_Shipper")["TEU"].sum().rename("recent_teu")
            merged = pd.DataFrame({"avg3_teu": avg3, "recent_teu": target_teu}).fillna(0)
            merged["diff"] = merged["recent_teu"] - merged["avg3_teu"]

            top_inc = merged.nlargest(3, "diff")
            top_dec = merged.nsmallest(3, "diff")
            top_dec = top_dec[top_dec["diff"] < 0]

            def _rows(top_df):
                rows = []
                for s, row in top_df.iterrows():
                    rows.append({
                        "shipper": s,
                        "avg3_teu": round(float(row["avg3_teu"])),
                        "recent_teu": round(float(row["recent_teu"])),
                        "diff": round(float(row["diff"])),
                        "top_combo": _top_pol_dly(s, target_ym),
                    })
                return rows

            meta = {
                "base_months": yms_avg3,
                "target_month": target_ym,
                "recent_label": _ym_label(target_ym),
                "avg3_range": avg3_range,
            }
            return {"items": _rows(top_inc), **meta}, {"items": _rows(top_dec), **meta}

        inc_curr, dec_curr = _build_month_block(curr_ym)
        inc_next, dec_next = _build_month_block(next_ym)

        result["shipper_increase_curr"] = inc_curr
        result["shipper_increase_next"] = inc_next
        result["shipper_decrease_curr"] = dec_curr
        result["shipper_decrease_next"] = dec_next
    except Exception as e:
        print(f"Template shipper_change error: {e}")
        result["shipper_increase_curr"] = {"items": []}
        result["shipper_increase_next"] = {"items": []}
        result["shipper_decrease_curr"] = {"items": []}
        result["shipper_decrease_next"] = {"items": []}

    # ──────────────────────────────────────────────────
    # ② New Customer / ③ Regain Customer
    # ──────────────────────────────────────────────────
    try:
        hist_df = _fetch_shipper_history()
        hist_area = _filter_area(hist_df, area)

        # 月リスト作成
        months_12_ago = _cal_months(ref.year, ref.month, 12, 0)[:-1]  # 当月除く過去12か月
        months_6_ago = _cal_months(ref.year, ref.month, 6, 0)[:-1]   # 当月除く過去6か月
        months_7to12 = [m for m in months_12_ago if m not in months_6_ago]
        yms_12 = [f"{y}-{m:02d}" for y, m in months_12_ago]
        yms_6 = [f"{y}-{m:02d}" for y, m in months_6_ago]
        yms_7to12 = [f"{y}-{m:02d}" for y, m in months_7to12]
        yms_recent = [curr_ym, next_ym] if next_ym in hist_area["YearMonth"].values else [curr_ym]
        # BASE_QUERY の当月・来月荷主
        recent_shippers = df_area[df_area["bq_ym"].isin([curr_ym, next_ym])]
        recent_shipper_teu = recent_shippers.groupby("Booking_Shipper")["TEU"].sum()
        active_now = set(recent_shipper_teu[recent_shipper_teu > 0].index)

        # 過去12か月の荷主TEU (履歴クエリから)
        hist_12 = hist_area[hist_area["YearMonth"].isin(yms_12)]
        shippers_12 = set(hist_12.groupby("Booking_Shipper")["TEU"].sum()
                         .pipe(lambda s: s[s > 0]).index)

        # 過去6か月の荷主TEU
        hist_6 = hist_area[hist_area["YearMonth"].isin(yms_6)]
        shippers_6 = set(hist_6.groupby("Booking_Shipper")["TEU"].sum()
                        .pipe(lambda s: s[s > 0]).index)

        # 7-12か月前の荷主TEU
        hist_7to12 = hist_area[hist_area["YearMonth"].isin(yms_7to12)]
        shippers_7to12 = set(hist_7to12.groupby("Booking_Shipper")["TEU"].sum()
                            .pipe(lambda s: s[s > 0]).index)

        # ② New Customer: 過去12か月TEU=0 かつ 今活動中
        new_customers_set = active_now - shippers_12
        new_cust_list = []
        for s in new_customers_set:
            teu = float(recent_shipper_teu.get(s, 0))
            new_cust_list.append({"shipper": s, "teu": round(teu)})
        new_cust_list.sort(key=lambda x: -x["teu"])
        overflow_new = len(new_cust_list) - 3 if len(new_cust_list) > 3 else 0
        overflow_new_teu = sum(x["teu"] for x in new_cust_list[3:]) if overflow_new > 0 else 0

        result["new_customer"] = {
            "customers": new_cust_list[:3],
            "overflow_count": overflow_new,
            "overflow_teu": round(overflow_new_teu),
            "total_count": len(new_cust_list),
        }

        # ③ Regain: 7-12か月前に活動, 過去6か月は0, 今活動中
        regain_set = (active_now & shippers_7to12) - shippers_6
        regain_list = []
        for s in regain_set:
            teu = float(recent_shipper_teu.get(s, 0))
            regain_list.append({"shipper": s, "teu": round(teu)})
        regain_list.sort(key=lambda x: -x["teu"])
        overflow_regain = len(regain_list) - 3 if len(regain_list) > 3 else 0
        overflow_regain_teu = sum(x["teu"] for x in regain_list[3:]) if overflow_regain > 0 else 0

        result["regain_customer"] = {
            "customers": regain_list[:3],
            "overflow_count": overflow_regain,
            "overflow_teu": round(overflow_regain_teu),
            "total_count": len(regain_list),
        }
    except Exception as e:
        print(f"Template new/regain error: {e}")
        import traceback; traceback.print_exc()
        result["new_customer"] = {"customers": [], "overflow_count": 0, "overflow_teu": 0, "total_count": 0}
        result["regain_customer"] = {"customers": [], "overflow_count": 0, "overflow_teu": 0, "total_count": 0}

    # ──────────────────────────────────────────────────
    # ④ POL数 (Monthly)
    # ──────────────────────────────────────────────────
    try:
        months_6 = _cal_months(ref.year, ref.month, 5, 0)
        yms_6_list = [f"{y}-{m:02d}" for y, m in months_6]
        pol_data = []
        for ym in yms_6_list:
            sub = df_area[df_area["bq_ym"] == ym]
            pol_count = int(sub["POL"].nunique())
            pol_data.append({"ym": ym, "pol_count": pol_count})
        result["pol_count"] = pol_data
    except Exception as e:
        print(f"Template pol_count error: {e}")
        result["pol_count"] = []

    # ──────────────────────────────────────────────────
    # ⑤ Booking件数 (Monthly & Weekly)
    # ──────────────────────────────────────────────────
    try:
        # Monthly
        months_6 = _cal_months(ref.year, ref.month, 5, 0)
        yms_6_list = [f"{y}-{m:02d}" for y, m in months_6]
        bkg_monthly = []
        for ym in yms_6_list:
            sub = df_area[df_area["bq_ym"] == ym]
            bkg_count = int(sub["Booking_No_"].nunique())
            bkg_monthly.append({"ym": ym, "count": bkg_count})

        # Weekly (3か月分)
        weeks_3m = get_3month_weeks(ref)
        bkg_weekly = []
        for w in weeks_3m:
            sub = df_area[df_area["week_key"] == w["week_key"]]
            bkg_count = int(sub["Booking_No_"].nunique())
            bkg_weekly.append({
                "week_key": w["week_key"],
                "week_label": f"W{w['week']}",
                "ym": w["ym"],
                "count": bkg_count,
            })
        result["booking_count"] = {"monthly": bkg_monthly, "weekly": bkg_weekly}
    except Exception as e:
        print(f"Template booking_count error: {e}")
        result["booking_count"] = {"monthly": [], "weekly": []}

    # ──────────────────────────────────────────────────
    # ⑥ 営業マン寄与度
    # ──────────────────────────────────────────────────
    try:
        months_3 = _cal_months(ref.year, ref.month, 2, 0)
        sales_data = {}
        for y, m in months_3:
            ym = f"{y}-{m:02d}"
            sub = df_area[df_area["bq_ym"] == ym]
            total_teu = float(sub["TEU"].sum())
            if total_teu <= 0:
                sales_data[ym] = {"items": [], "total_teu": 0}
                continue
            by_sales = sub.groupby("POL_Sales")["TEU"].sum().sort_values(ascending=False)
            items = []
            for sales, teu in by_sales.items():
                items.append({
                    "sales": sales,
                    "teu": round(float(teu)),
                    "pct": round(float(teu) / total_teu * 100, 1),
                })
            sales_data[ym] = {"items": items, "total_teu": round(total_teu)}
        result["sales_contribution"] = sales_data
    except Exception as e:
        print(f"Template sales_contribution error: {e}")
        result["sales_contribution"] = {}

    # ──────────────────────────────────────────────────
    # ⑦ CM1レンジ分析 (Profitability Segmentation)
    # ──────────────────────────────────────────────────
    try:
        # 直近3か月の荷主別CM1/TEU
        months_3_range = _cal_months(ref.year, ref.month, 2, 0)
        yms_3 = [f"{y}-{m:02d}" for y, m in months_3_range]

        cm1_range_data = {}
        for ym in yms_3:
            sub = df_area[df_area["bq_ym"] == ym]
            shipper_agg = sub.groupby("Booking_Shipper").agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum")
            ).reset_index()
            shipper_agg = shipper_agg[shipper_agg["TEU"] > 0]
            shipper_agg["CM1_per_TEU"] = shipper_agg["CM1"] / shipper_agg["TEU"]

            if shipper_agg.empty:
                cm1_range_data[ym] = {"high": {}, "mid": {}, "low": {}}
                continue

            # 四分位でHigh/Mid/Low分類
            q75 = float(shipper_agg["CM1_per_TEU"].quantile(0.75))
            q25 = float(shipper_agg["CM1_per_TEU"].quantile(0.25))

            high = shipper_agg[shipper_agg["CM1_per_TEU"] >= q75]
            mid = shipper_agg[(shipper_agg["CM1_per_TEU"] >= q25) & (shipper_agg["CM1_per_TEU"] < q75)]
            low = shipper_agg[shipper_agg["CM1_per_TEU"] < q25]

            total_teu = float(shipper_agg["TEU"].sum())

            def _seg_info(seg_df):
                teu = float(seg_df["TEU"].sum())
                cm1 = float(seg_df["CM1"].sum())
                return {
                    "teu": round(teu),
                    "pct": round(teu / total_teu * 100, 1) if total_teu > 0 else 0,
                    "shipper_count": len(seg_df),
                    "cm1_per_teu": round(cm1 / teu) if teu > 0 else 0,
                }

            cm1_range_data[ym] = {
                "high": _seg_info(high),
                "mid": _seg_info(mid),
                "low": _seg_info(low),
                "q75": round(q75),
                "q25": round(q25),
            }
        result["cm1_range"] = cm1_range_data
    except Exception as e:
        print(f"Template cm1_range error: {e}")
        result["cm1_range"] = {}

    # ──────────────────────────────────────────────────
    # ⑧ Trade Lane ヒートマップ
    # ──────────────────────────────────────────────────
    try:
        months_6 = _cal_months(ref.year, ref.month, 5, 0)
        yms_6_list = [f"{y}-{m:02d}" for y, m in months_6]

        # ALL → CTR列(国コード2文字), エリア別 → DLY列(港コード3文字)
        group_col = "CTR" if area == "ALL" else "DLY"

        df_6m = df_area[df_area["bq_ym"].isin(yms_6_list)]

        # グループ × 月別集計
        lane_agg = df_6m.groupby([group_col, "bq_ym"]).agg(
            TEU=("TEU", "sum"), CM1=("CM1", "sum")
        ).reset_index()

        # 上位10仕向地/国を選定
        top_lanes = (df_6m.groupby(group_col)["TEU"].sum()
                    .sort_values(ascending=False).head(10).index.tolist())

        heatmap = []
        for lane in top_lanes:
            row = {"lane": lane, "months": {}}
            for ym in yms_6_list:
                sub = lane_agg[(lane_agg[group_col] == lane) & (lane_agg["bq_ym"] == ym)]
                if not sub.empty:
                    teu = float(sub["TEU"].iloc[0])
                    cm1 = float(sub["CM1"].iloc[0])
                    row["months"][ym] = {
                        "teu": round(teu),
                        "cm1_per_teu": round(cm1 / teu) if teu > 0 else 0,
                    }
                else:
                    row["months"][ym] = {"teu": 0, "cm1_per_teu": 0}
            heatmap.append(row)

        result["trade_lane"] = {
            "group_by": "CTR" if area == "ALL" else "DLY",
            "months": yms_6_list,
            "data": heatmap,
        }
    except Exception as e:
        print(f"Template trade_lane error: {e}")
        result["trade_lane"] = {"group_by": "", "months": [], "data": []}

    # ──────────────────────────────────────────────────
    # ⑪ CM1/TEU ウォーターフォール (前月比要因分解)
    # ──────────────────────────────────────────────────
    try:
        prev_m = _cal_months(ref.year, ref.month, 1, 0)[0]
        prev_ym = f"{prev_m[0]}-{prev_m[1]:02d}"

        df_prev = df_area[df_area["bq_ym"] == prev_ym]
        df_curr = df_area[df_area["bq_ym"] == ref_ym]

        # 荷主別集計
        prev_agg = df_prev.groupby("Booking_Shipper").agg(
            TEU=("TEU", "sum"), CM1=("CM1", "sum")).reset_index()
        curr_agg = df_curr.groupby("Booking_Shipper").agg(
            TEU=("TEU", "sum"), CM1=("CM1", "sum")).reset_index()

        prev_total_teu = float(prev_agg["TEU"].sum())
        prev_total_cm1 = float(prev_agg["CM1"].sum())
        curr_total_teu = float(curr_agg["TEU"].sum())
        curr_total_cm1 = float(curr_agg["CM1"].sum())

        prev_cm1t = round(prev_total_cm1 / prev_total_teu) if prev_total_teu > 0 else 0
        curr_cm1t = round(curr_total_cm1 / curr_total_teu) if curr_total_teu > 0 else 0

        # Mix効果: 前月の単価 × (当月構成比 - 前月構成比) の荷主合計
        # Rate効果: 当月構成比 × (当月単価 - 前月単価) の荷主合計
        all_shippers = set(prev_agg["Booking_Shipper"].tolist() + curr_agg["Booking_Shipper"].tolist())

        mix_effect = 0
        rate_effect = 0
        for s in all_shippers:
            p = prev_agg[prev_agg["Booking_Shipper"] == s]
            c = curr_agg[curr_agg["Booking_Shipper"] == s]

            p_teu = float(p["TEU"].iloc[0]) if len(p) > 0 else 0
            p_cm1 = float(p["CM1"].iloc[0]) if len(p) > 0 else 0
            c_teu = float(c["TEU"].iloc[0]) if len(c) > 0 else 0
            c_cm1 = float(c["CM1"].iloc[0]) if len(c) > 0 else 0

            p_share = p_teu / prev_total_teu if prev_total_teu > 0 else 0
            c_share = c_teu / curr_total_teu if curr_total_teu > 0 else 0
            p_rate = p_cm1 / p_teu if p_teu > 0 else 0
            c_rate = c_cm1 / c_teu if c_teu > 0 else 0

            # Mix = 前月単価 × (当月構成比 - 前月構成比)
            mix_effect += p_rate * (c_share - p_share)
            # Rate = 当月構成比 × (当月単価 - 前月単価)
            rate_effect += c_share * (c_rate - p_rate)

        # Volume効果 (残差)
        total_change = curr_cm1t - prev_cm1t
        volume_effect = total_change - mix_effect - rate_effect

        result["cm1_waterfall"] = {
            "prev_ym": prev_ym,
            "curr_ym": ref_ym,
            "prev_cm1t": prev_cm1t,
            "curr_cm1t": curr_cm1t,
            "mix_effect": round(mix_effect),
            "rate_effect": round(rate_effect),
            "volume_effect": round(volume_effect),
            "total_change": curr_cm1t - prev_cm1t,
        }
    except Exception as e:
        print(f"Template cm1_waterfall error: {e}")
        result["cm1_waterfall"] = {}

    return result


@app.route("/api/template-data")
@require_login
def api_template_data():
    """プレビュー用テンプレートデータを返す ?area=KR&meeting_week=2026-W14"""
    today = date.today()
    df = get_bq_df()
    area = request.args.get("area", "ALL")
    meeting_week = request.args.get("meeting_week", "")
    try:
        result = build_template_data(area, df, today, meeting_week)
        return jsonify(result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── テンプレート設定 API ─────────────────────────────────
@app.route("/api/template-definitions")
@require_login
def api_template_definitions():
    """利用可能なテンプレート定義一覧を返す"""
    return jsonify(TEMPLATE_DEFINITIONS)



def _get_default_template_config() -> list:
    """デフォルトのテンプレート設定を生成"""
    return [
        {"id": t["id"], "enabled": t["default_on"],
         "col_span": t["col_span"], "height": 0, "order": i}
        for i, t in enumerate(TEMPLATE_DEFINITIONS)
    ]


@app.route("/api/template-config")
@require_login
def api_get_template_config():
    """テンプレート設定を取得 ?week_key=...&area=..."""
    week_key = request.args.get("week_key", "")
    area = request.args.get("area", "ALL")
    doc_id = f"{week_key}_{area}" if week_key else f"default_{area}"

    doc = db.collection(FS_TEMPLATE_CONFIG).document(doc_id).get()
    if doc.exists:
        d = doc.to_dict()
        return jsonify({
            "exists": True,
            "blocks": d.get("blocks", []),
            "updated": d.get("updated"),
            "updated_by": d.get("updated_by"),
        })

    # Area固定スタイルがあればそれを返す
    fixed_doc = db.collection(FS_AREA_FIXED_STYLE).document(area).get()
    if fixed_doc.exists:
        fd = fixed_doc.to_dict()
        return jsonify({
            "exists": False,
            "from_fixed": True,
            "blocks": fd.get("blocks", []),
        })

    # デフォルトテンプレート (★マーク付き) があればそれを返す
    default_blocks = _get_default_style_template_blocks()
    if default_blocks is not None:
        return jsonify({
            "exists": False,
            "from_default_tpl": True,
            "blocks": default_blocks,
        })

    # コード上のデフォルト設定
    return jsonify({
        "exists": False,
        "blocks": _get_default_template_config(),
    })


@app.route("/api/template-config", methods=["POST"])
@require_editor
def api_save_template_config():
    """テンプレート設定を保存"""
    data = request.json or {}
    week_key = data.get("week_key", "")
    area = data.get("area", "ALL")
    blocks = data.get("blocks", [])
    user = get_current_user()

    doc_id = f"{week_key}_{area}" if week_key else f"default_{area}"
    db.collection(FS_TEMPLATE_CONFIG).document(doc_id).set({
        "week_key": week_key,
        "area": area,
        "blocks": blocks,
        "updated": datetime.now(tz=JST).isoformat(),
        "updated_by": user["email"] if user else "unknown",
    })
    return jsonify({"ok": True})


@app.route("/api/template-config/propagate", methods=["POST"])
@require_editor
def api_propagate_template_config():
    """テンプレート設定を他のArea/週に適用
    mode: "area_one" | "area_all" | "week_same_area" | "week_all"
    """
    data = request.json or {}
    source_week = data.get("week_key", "")
    source_area = data.get("area", "ALL")
    blocks = data.get("blocks", [])
    mode = data.get("mode", "")
    target_area = data.get("target_area", "")
    user = get_current_user()

    if not blocks or not mode:
        return jsonify({"error": "blocks and mode required"}), 400

    now_jst = datetime.now(tz=JST).isoformat()

    # 既存の設定がある週/エリアは上書きしない
    existing_docs = set()
    for doc in db.collection(FS_TEMPLATE_CONFIG).stream():
        existing_docs.add(doc.id)

    # 対象一覧を決定
    targets = []
    df = get_bq_df()
    all_areas = get_all_areas(df)

    if mode == "area_one" and target_area:
        # 同じ週の指定エリアに適用
        doc_id = f"{source_week}_{target_area}"
        if doc_id not in existing_docs:
            targets.append((source_week, target_area))

    elif mode == "area_all":
        # 同じ週の全エリアに適用
        for a in all_areas:
            doc_id = f"{source_week}_{a}"
            if doc_id not in existing_docs and a != source_area:
                targets.append((source_week, a))

    elif mode == "week_same_area":
        # 全週の同じエリアに適用 (既存設定がない週のみ)
        # スナップショット一覧から週を取得
        snap_docs = db.collection(FS_SNAPSHOTS).stream()
        for sd in snap_docs:
            wk = sd.to_dict().get("week_key", sd.id)
            doc_id = f"{wk}_{source_area}"
            if doc_id not in existing_docs and wk != source_week:
                targets.append((wk, source_area))

    elif mode == "week_all":
        # 全週の全エリアに適用 (既存設定がない組み合わせのみ)
        snap_docs = db.collection(FS_SNAPSHOTS).stream()
        week_keys = set()
        for sd in snap_docs:
            week_keys.add(sd.to_dict().get("week_key", sd.id))
        for wk in week_keys:
            for a in all_areas:
                doc_id = f"{wk}_{a}"
                if doc_id not in existing_docs and not (wk == source_week and a == source_area):
                    targets.append((wk, a))

    # バッチ書き込み
    applied = 0
    batch = db.batch()
    for wk, a in targets:
        doc_id = f"{wk}_{a}"
        ref = db.collection(FS_TEMPLATE_CONFIG).document(doc_id)
        batch.set(ref, {
            "week_key": wk,
            "area": a,
            "blocks": blocks,
            "updated": now_jst,
            "updated_by": user["email"] if user else "unknown",
            "propagated_from": f"{source_week}_{source_area}",
        })
        applied += 1
        # Firestore batch limit: 500
        if applied % 450 == 0:
            batch.commit()
            batch = db.batch()
    if applied > 0:
        batch.commit()

    return jsonify({"ok": True, "applied": applied})


# ── スタイルテンプレート (名前付き保存/呼び出し) ───────────
FS_STYLE_TEMPLATES = "meeting_style_templates"

@app.route("/api/style-templates")
@require_login
def api_list_style_templates():
    """保存済みスタイルテンプレート一覧"""
    try:
        docs = db.collection(FS_STYLE_TEMPLATES).stream()
        result = []
        for d in docs:
            data = d.to_dict()
            result.append({
                "id": d.id,
                "name": data.get("name", d.id),
                "created": data.get("created"),
                "created_by": data.get("created_by"),
                "block_count": len(data.get("blocks", [])),
                "is_default": data.get("is_default", False),
            })
        result.sort(key=lambda x: x.get("created") or "", reverse=True)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/style-templates", methods=["POST"])
@require_editor
def api_save_style_template():
    """現在のスタイルをテンプレートとして保存"""
    data = request.json or {}
    name = data.get("name", "").strip()
    blocks = data.get("blocks", [])
    user = get_current_user()
    if not name:
        return jsonify({"error": "name required"}), 400

    doc_ref = db.collection(FS_STYLE_TEMPLATES).document()
    doc_ref.set({
        "name": name,
        "blocks": blocks,
        "created": datetime.now(tz=JST).isoformat(),
        "created_by": user["email"] if user else "unknown",
    })
    return jsonify({"ok": True, "id": doc_ref.id})

@app.route("/api/style-templates/<tpl_id>")
@require_login
def api_get_style_template(tpl_id):
    """テンプレートの内容を取得"""
    doc = db.collection(FS_STYLE_TEMPLATES).document(tpl_id).get()
    if not doc.exists:
        return jsonify({"error": "not found"}), 404
    data = doc.to_dict()
    return jsonify({"id": doc.id, "name": data.get("name"), "blocks": data.get("blocks", [])})

@app.route("/api/style-templates/<tpl_id>", methods=["DELETE"])
@require_editor
def api_delete_style_template(tpl_id):
    """テンプレートを削除（★DEFAULTは削除不可）"""
    doc = db.collection(FS_STYLE_TEMPLATES).document(tpl_id).get()
    if not doc.exists:
        return jsonify({"error": "not found"}), 404
    data = doc.to_dict()
    if data.get("is_default"):
        return jsonify({"error": "デフォルトテンプレートは削除できません"}), 403
    # 作成者のみ削除可能
    user = get_current_user()
    if data.get("created_by") != (user or {}).get("email"):
        return jsonify({"error": "自分のテンプレートのみ削除できます"}), 403
    db.collection(FS_STYLE_TEMPLATES).document(tpl_id).delete()
    return jsonify({"ok": True})

@app.route("/api/style-templates/<tpl_id>/set-default", methods=["POST"])
@require_editor
def api_set_default_style_template(tpl_id):
    """テンプレートをデフォルトに設定（既存のデフォルトは解除）。作成者のみ"""
    doc = db.collection(FS_STYLE_TEMPLATES).document(tpl_id).get()
    if not doc.exists:
        return jsonify({"error": "not found"}), 404
    user = get_current_user()
    if doc.to_dict().get("created_by") != (user or {}).get("email"):
        return jsonify({"error": "自分のテンプレートのみ設定できます"}), 403
    # 全テンプレートの is_default を解除
    for d in db.collection(FS_STYLE_TEMPLATES).stream():
        if d.to_dict().get("is_default"):
            db.collection(FS_STYLE_TEMPLATES).document(d.id).update({"is_default": False})
    # 指定テンプレートをデフォルトに設定
    db.collection(FS_STYLE_TEMPLATES).document(tpl_id).update({"is_default": True})
    return jsonify({"ok": True})

@app.route("/api/style-templates/<tpl_id>/unset-default", methods=["POST"])
@require_editor
def api_unset_default_style_template(tpl_id):
    """デフォルト設定を解除。作成者のみ"""
    doc = db.collection(FS_STYLE_TEMPLATES).document(tpl_id).get()
    if not doc.exists:
        return jsonify({"error": "not found"}), 404
    user = get_current_user()
    if doc.to_dict().get("created_by") != (user or {}).get("email"):
        return jsonify({"error": "自分のテンプレートのみ変更できます"}), 403
    db.collection(FS_STYLE_TEMPLATES).document(tpl_id).update({"is_default": False})
    return jsonify({"ok": True})

def _get_default_style_template_blocks():
    """is_default=True のスタイルテンプレートの blocks を返す (なければ None)"""
    try:
        for d in db.collection(FS_STYLE_TEMPLATES).stream():
            data = d.to_dict()
            if data.get("is_default"):
                return data.get("blocks", [])
    except Exception:
        pass
    return None


# ── Area固定スタイル ───────────────────────────────────
FS_AREA_FIXED_STYLE = "meeting_area_fixed_style"

@app.route("/api/area-fixed-style")
@require_login
def api_get_area_fixed_style():
    """Areaの固定スタイルを取得 ?area=..."""
    area = request.args.get("area", "")
    if not area:
        return jsonify({"fixed": False})
    doc = db.collection(FS_AREA_FIXED_STYLE).document(area).get()
    if doc.exists:
        data = doc.to_dict()
        return jsonify({"fixed": True, "blocks": data.get("blocks", []), "set_by": data.get("set_by")})
    return jsonify({"fixed": False})

@app.route("/api/area-fixed-style", methods=["POST"])
@require_editor
def api_set_area_fixed_style():
    """Areaの固定スタイルを設定/解除"""
    data = request.json or {}
    area = data.get("area", "")
    blocks = data.get("blocks")  # None = 解除
    user = get_current_user()
    if not area:
        return jsonify({"error": "area required"}), 400

    if blocks is None:
        # 解除
        db.collection(FS_AREA_FIXED_STYLE).document(area).delete()
        return jsonify({"ok": True, "fixed": False})

    db.collection(FS_AREA_FIXED_STYLE).document(area).set({
        "area": area,
        "blocks": blocks,
        "set_by": user["email"] if user else "unknown",
        "updated": datetime.now(tz=JST).isoformat(),
    })
    return jsonify({"ok": True, "fixed": True})


# ── テンプレート設定取得: Area固定スタイルのフォールバック対応 ──
# (既存の api_get_template_config を修正)


# ── スナップショット API ─────────────────────────────────
@app.route("/api/snapshot", methods=["POST"])
@require_editor
def api_save_snapshot():
    """選択週のスナップショットを保存（BQ再取得 + 全エリア分を凍結）"""
    data = request.json or {}
    week_key = data.get("week_key")
    if not week_key:
        return jsonify({"error": "week_key is required"}), 400

    user = get_current_user()

    # BQ データ再取得
    ok = do_refresh_bq(update_firestore=True, refreshed_by=user["email"])
    if not ok:
        return jsonify({"error": "BigQuery更新に失敗しました"}), 500

    df = get_bq_df()
    today = date.today()
    areas = get_all_areas(df)

    # 全エリア分のサマリーを構築（meeting_week で見込みスコープ）
    areas_data = {}
    for a in areas:
        areas_data[a] = build_summary_for_area(a, df, today, meeting_week=week_key)

    now_jst = datetime.now(tz=JST).isoformat()
    snapshot_doc = {
        "week_key": week_key,
        "created_at": now_jst,
        "created_by": user["email"],
        "areas": areas_data,
    }

    # Firestore に保存
    db.collection(FS_SNAPSHOTS).document(week_key).set(snapshot_doc)
    print(f"Snapshot saved: {week_key} by {user['email']} ({len(areas)} areas)")

    info = get_last_refresh()
    return jsonify({
        "ok": True,
        "week_key": week_key,
        "last_refresh": info.get("last_refresh") if info else now_jst,
        "refreshed_by": user["email"],
        "created_at": now_jst,
    })


@app.route("/api/snapshot")
@require_login
def api_get_snapshot():
    """保存済みスナップショットを取得 ?week_key=2026-W14&area=KR"""
    week_key = request.args.get("week_key")
    area = request.args.get("area", "ALL")
    if not week_key:
        return jsonify({"error": "week_key is required"}), 400

    doc = db.collection(FS_SNAPSHOTS).document(week_key).get()
    if not doc.exists:
        return jsonify({"exists": False})

    snap = doc.to_dict()
    area_data = snap.get("areas", {}).get(area, {})
    # サブエリアが古いスナップショットにない場合 → ライブデータで補完
    if not area_data and area in SUB_AREA_DEFS:
        try:
            df = get_bq_df()
            today = date.today()
            area_data = build_summary_for_area(area, df, today, meeting_week=week_key)
        except Exception as e:
            print(f"Sub-area live fallback error: {e}")
            area_data = {}
    return jsonify({
        "exists": True,
        "week_key": week_key,
        "created_at": snap.get("created_at"),
        "created_by": snap.get("created_by"),
        **area_data,
    })


@app.route("/api/snapshot/list")
@require_login
def api_snapshot_list():
    """スナップショットが存在する週一覧を返す"""
    docs = db.collection(FS_SNAPSHOTS).stream()
    snapshots = []
    for doc in docs:
        d = doc.to_dict()
        snapshots.append({
            "week_key": d.get("week_key", doc.id),
            "created_at": d.get("created_at"),
            "created_by": d.get("created_by"),
        })
    snapshots.sort(key=lambda x: x["week_key"])
    return jsonify({"snapshots": snapshots})


@app.route("/api/prospect", methods=["POST"])
@require_editor
def api_save_prospect():
    """見込みデータを Firestore に保存（meeting_week でスコープ）"""
    data = request.json
    week_key = data.get("week_key")
    area = data.get("area")
    meeting_week = data.get("meeting_week", "")
    teu = data.get("teu")
    cm1 = data.get("cm1")

    if not week_key or not area:
        return jsonify({"error": "week_key and area required"}), 400

    # meeting_week 付きの doc_id で会議週ごとに独立保存
    doc_id = f"{meeting_week}_{week_key}_{area}" if meeting_week else f"{week_key}_{area}"
    db.collection(FS_PROSPECTS).document(doc_id).set({
        "meeting_week": meeting_week,
        "week_key": week_key,
        "area": area,
        "teu": teu,
        "cm1": cm1,
        "updated": datetime.now(tz=JST).isoformat(),
    })
    return jsonify({"ok": True})


@app.route("/api/note", methods=["GET", "POST"])
@require_login
def api_note():
    """エリアメモを取得/保存"""
    week_key = request.args.get("week_key") or (request.json or {}).get("week_key")
    area = request.args.get("area") or (request.json or {}).get("area")

    if request.method == "GET":
        notes = load_notes(week_key)
        return jsonify(notes)

    # POST
    note = (request.json or {}).get("note", "")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        INSERT INTO notes (week_key, area, note, updated)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(week_key, area) DO UPDATE SET
            note=excluded.note, updated=excluded.updated
    """, (week_key, area, note))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/image", methods=["GET", "POST", "DELETE"])
@require_login
def api_image():
    """画像アップロード / 取得 / 削除"""
    if request.method == "GET":
        week_key = request.args.get("week_key")
        area = request.args.get("area")
        return jsonify(load_images(week_key, area))

    if request.method == "POST":
        user = get_current_user()
        if not user or user["role"] != "editor":
            return jsonify({"error": "editor role required"}), 403
        week_key = request.form.get("week_key")
        area = request.form.get("area")
        caption = request.form.get("caption", "")
        file = request.files.get("image")
        if not file or not week_key or not area:
            return jsonify({"error": "missing params"}), 400

        import uuid
        ext = Path(file.filename).suffix
        fname = f"{uuid.uuid4().hex}{ext}"
        file.save(UPLOAD_DIR / fname)

        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("""
            INSERT INTO images (week_key, area, filename, caption, uploaded)
            VALUES (?, ?, ?, ?, datetime('now'))
        """, (week_key, area, fname, caption))
        conn.commit()
        img_id = c.lastrowid
        conn.close()
        return jsonify({"id": img_id, "filename": fname, "caption": caption})

    if request.method == "DELETE":
        user = get_current_user()
        if not user or user["role"] != "editor":
            return jsonify({"error": "editor role required"}), 403
        img_id = request.args.get("id")
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        row = c.execute("SELECT filename FROM images WHERE id=?", (img_id,)).fetchone()
        if row:
            try:
                (UPLOAD_DIR / row[0]).unlink(missing_ok=True)
            except Exception:
                pass
            c.execute("DELETE FROM images WHERE id=?", (img_id,))
            conn.commit()
        conn.close()
        return jsonify({"ok": True})


@app.route("/api/monthly_prospect", methods=["GET", "POST"])
@require_login
def api_monthly_prospect():
    """月間見込み (TEU / CM1/T) を Firestore で取得・保存"""
    if request.method == "GET":
        ym   = request.args.get("ym")
        area = request.args.get("area")
        doc_id = f"{ym}_{area}"
        doc = db.collection(FS_MONTHLY_PROSPECTS).document(doc_id).get()
        if doc.exists:
            d = doc.to_dict()
            return jsonify({"teu": d.get("teu"), "cm1_per_teu": d.get("cm1_per_teu")})
        return jsonify({"teu": None, "cm1_per_teu": None})

    # POST - editor only
    user = get_current_user()
    if not user or user["role"] != "editor":
        return jsonify({"error": "editor required"}), 403
    data = request.json or {}
    ym   = data.get("ym")
    area = data.get("area")
    meeting_week = data.get("meeting_week", "")
    if not ym or not area:
        return jsonify({"error": "ym and area required"}), 400
    doc_id = f"{meeting_week}_{ym}_{area}" if meeting_week else f"{ym}_{area}"
    db.collection(FS_MONTHLY_PROSPECTS).document(doc_id).set({
        "meeting_week": meeting_week,
        "ym": ym,
        "area": area,
        "teu": data.get("teu"),
        "cm1_per_teu": data.get("cm1_per_teu"),
        "updated": datetime.now(tz=JST).isoformat(),
    })
    return jsonify({"ok": True})


# ── ブロックエディター API (Firestore + GCS) ────────────

def _upload_image(file) -> str:
    """画像をGCS（利用可能時）またはローカルに保存し、ファイル名を返す"""
    ext = Path(file.filename).suffix
    fname = f"{uuid.uuid4().hex}{ext}"
    if _gcs_available:
        blob = gcs_bucket.blob(f"meeting-uploads/{fname}")
        blob.upload_from_file(file, content_type=file.content_type)
    else:
        file.save(UPLOAD_DIR / fname)
    return fname


def _delete_image(filename: str):
    """画像をGCSまたはローカルから削除"""
    if not filename:
        return
    if _gcs_available:
        try:
            gcs_bucket.blob(f"meeting-uploads/{filename}").delete()
        except Exception:
            pass
    else:
        try:
            (UPLOAD_DIR / filename).unlink(missing_ok=True)
        except Exception:
            pass


@app.route("/api/blocks", methods=["GET"])
@require_login
def api_blocks_get():
    week_key = request.args.get("week_key")
    area     = request.args.get("area")
    if not week_key or not area:
        return jsonify([])
    try:
        docs = (db.collection(FS_BLOCKS)
                .where("week_key", "==", week_key)
                .where("area", "==", area)
                .stream())
        blocks = []
        for doc in docs:
            d = doc.to_dict()
            blocks.append({
                "id": doc.id,
                "block_type": d.get("block_type"),
                "content": d.get("content", ""),
                "filename": d.get("filename"),
                "img_width": d.get("img_width", 200),
                "block_order": d.get("block_order", 0),
            })
        blocks.sort(key=lambda b: b["block_order"])
        return jsonify(blocks)
    except Exception as e:
        # 複合インデックスが未作成の場合、エラーメッセージにURL含む
        print(f"blocks GET error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/blocks", methods=["POST"])
@require_editor
def api_blocks_post():
    """新規ブロック作成 (JSON: text / multipart: image)"""
    if request.is_json:
        data       = request.json or {}
        block_type = data.get("block_type")
        week_key   = data.get("week_key")
        area       = data.get("area")
        content    = data.get("content", "")
        filename   = None
    else:
        block_type = request.form.get("block_type")
        week_key   = request.form.get("week_key")
        area       = request.form.get("area")
        content    = request.form.get("content", "")
        filename   = None
        if block_type == "image":
            file = request.files.get("image")
            if not file:
                return jsonify({"error": "no image file"}), 400
            filename = _upload_image(file)

    if not week_key or not area or block_type not in ("text", "markdown", "image", "ai"):
        return jsonify({"error": "invalid params"}), 400

    # 最大 block_order を取得 (複合インデックス不要: Python側で算出)
    max_order = -1
    existing = (db.collection(FS_BLOCKS)
                .where("week_key", "==", week_key)
                .where("area", "==", area)
                .stream())
    for doc in existing:
        order = doc.to_dict().get("block_order", -1)
        if order > max_order:
            max_order = order

    new_ref = db.collection(FS_BLOCKS).document()
    new_ref.set({
        "week_key": week_key,
        "area": area,
        "block_order": max_order + 1,
        "block_type": block_type,
        "content": content,
        "filename": filename,
        "img_width": 200,
        "updated": datetime.now(tz=JST).isoformat(),
    })
    return jsonify({"id": new_ref.id, "ok": True})


@app.route("/api/blocks/<block_id>", methods=["PATCH"])
@require_editor
def api_blocks_patch(block_id):
    data = request.json or {}
    update = {"updated": datetime.now(tz=JST).isoformat()}
    if "content" in data:
        update["content"] = data["content"]
    if "img_width" in data:
        update["img_width"] = data["img_width"]
    db.collection(FS_BLOCKS).document(block_id).update(update)
    return jsonify({"ok": True})


@app.route("/api/blocks/<block_id>", methods=["DELETE"])
@require_editor
def api_blocks_delete(block_id):
    doc = db.collection(FS_BLOCKS).document(block_id).get()
    if doc.exists:
        d = doc.to_dict()
        _delete_image(d.get("filename"))
        db.collection(FS_BLOCKS).document(block_id).delete()
    return jsonify({"ok": True})


@app.route("/api/blocks/reorder", methods=["POST"])
@require_editor
def api_blocks_reorder():
    order_list = (request.json or {}).get("order", [])  # [{id, order}, ...]
    batch = db.batch()
    for item in order_list:
        ref = db.collection(FS_BLOCKS).document(str(item["id"]))
        batch.update(ref, {"block_order": item["order"]})
    batch.commit()
    return jsonify({"ok": True})


@app.route("/api/ai-analyze", methods=["POST"])
@require_editor
def api_ai_analyze():
    """Gemini AI によるデータ分析。プロンプトとエリアを受け取り、HTML を返す"""
    if not _gemini_client:
        return jsonify({"error": "Gemini AI が利用できません"}), 503

    data = request.json or {}
    prompt = data.get("prompt", "").strip()
    area = data.get("area", "ALL")
    history = data.get("history", [])  # [{role: "user"|"ai", text: "..."}]

    if not prompt:
        return jsonify({"error": "プロンプトが空です"}), 400

    try:
        df = get_bq_df()
        df_area = _filter_area(df, area)

        # エリア別かALLかでデータ提供方法を変える
        raw_cols = ["bq_ym", "week_key", "Booking_Shipper", "POL", "POD", "DLY", "AREA", "TEU", "CM1"]
        use_raw = (area != "ALL")  # 個別エリアは生データを渡す

        if use_raw:
            # 生データCSV（Geminiが自由に集計可能）
            raw_csv = df_area[raw_cols].to_csv(index=False)
            data_section = f"""## 生データ (CSV形式 - 自由に集計してください)
列: bq_ym(年月), week_key(週), Booking_Shipper(荷主), POL(積港), POD(揚港), DLY(最終仕向地), AREA(エリア), TEU, CM1(粗利益)

{raw_csv}"""
        else:
            # ALL: データが大きいため集約サマリーを提供
            monthly = df_area.groupby("bq_ym").agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum"),
                Shipments=("Booking_No_", "nunique"),
            ).reset_index()
            monthly["CM1_per_TEU"] = (monthly["CM1"] / monthly["TEU"].replace(0, float("nan"))).round(0)

            weekly = df_area.groupby("week_key").agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum"),
            ).reset_index()
            weekly["CM1_per_TEU"] = (weekly["CM1"] / weekly["TEU"].replace(0, float("nan"))).round(0)

            shipper = df_area.groupby("Booking_Shipper").agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum"),
            ).reset_index().sort_values("TEU", ascending=False).head(30)
            shipper["CM1_per_TEU"] = (shipper["CM1"] / shipper["TEU"].replace(0, float("nan"))).round(0)

            by_area = df.groupby("AREA").agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum"),
            ).reset_index().sort_values("TEU", ascending=False)
            by_area["CM1_per_TEU"] = (by_area["CM1"] / by_area["TEU"].replace(0, float("nan"))).round(0)

            top_shippers = shipper["Booking_Shipper"].head(20).tolist()
            detail = df_area[df_area["Booking_Shipper"].isin(top_shippers)].groupby(
                ["Booking_Shipper", "bq_ym"]
            ).agg(TEU=("TEU", "sum"), CM1=("CM1", "sum")).reset_index()

            route_summary = df_area.groupby(["POL", "POD"]).agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum"),
            ).reset_index().sort_values("TEU", ascending=False).head(30)
            route_summary["CM1_per_TEU"] = (route_summary["CM1"] / route_summary["TEU"].replace(0, float("nan"))).round(0)

            shipper_route = df_area.groupby(["Booking_Shipper", "POL", "POD", "DLY"]).agg(
                TEU=("TEU", "sum"), CM1=("CM1", "sum"),
            ).reset_index().sort_values("TEU", ascending=False).head(50)
            shipper_route["CM1_per_TEU"] = (shipper_route["CM1"] / shipper_route["TEU"].replace(0, float("nan"))).round(0)

            data_section = f"""## 月別サマリー
{monthly.to_csv(index=False)}

## 週別サマリー
{weekly.to_csv(index=False)}

## Shipper別 TEU上位30社
{shipper.to_csv(index=False)}

## エリア別サマリー
{by_area.to_csv(index=False)}

## 上位20社 × 月別明細
{detail.to_csv(index=False)}

## ルート別サマリー (POL→POD) 上位30
{route_summary.to_csv(index=False)}

## Shipper×ルート明細 上位50
{shipper_route.to_csv(index=False)}"""

        # グラフリクエストかどうか判定（現在のプロンプト＋会話履歴も考慮）
        chart_keywords = ["グラフ", "チャート", "chart", "graph"]
        all_texts = prompt.lower() + " " + " ".join(m.get("text", "").lower() for m in history)
        is_chart_request = any(kw in all_texts for kw in chart_keywords)

        if is_chart_request:
            system_prompt = f"""あなたは海運会社 KMTC Japan の Weekly Meeting 用データアナリストです。
提供されるデータに基づき、Chart.js 用のJSONデータを返してください。

## 出力ルール（厳守）
- 必ず有効な JSON のみを返してください。説明文やマークダウンは一切不要です。
- ```json タグも不要。純粋な JSON のみ。
- 以下の形式で返してください:
{{
  "title": "グラフのタイトル",
  "type": "bar" または "line" または "bar+line",
  "labels": ["ラベル1", "ラベル2", ...],
  "datasets": [
    {{
      "label": "データセット名",
      "data": [数値1, 数値2, ...],
      "type": "bar" または "line" (bar+lineの場合),
      "backgroundColor": "#色コード" (barの場合),
      "borderColor": "#色コード" (lineの場合),
      "yAxisID": "y" (左軸) または "y1" (右軸)
    }}
  ],
  "y_label": "左軸ラベル",
  "y1_label": "右軸ラベル (あれば)"
}}
- 棒グラフの色: "#3f51b5" (青), "#ff9800" (オレンジ), "#4caf50" (緑), "#e91e63" (ピンク), "#9c27b0" (紫)
- 折れ線グラフの色: "#c62828" (赤), "#2e7d32" (緑), "#1565c0" (青)
- TEUは左軸(y), CM1/TEUは右軸(y1)
- 数値は整数
- 生データが提供されている場合は、自分で集計してからグラフデータを作成してください

## データ
対象エリア: {area}

{data_section}
"""
        else:
            system_prompt = f"""あなたは海運会社 KMTC Japan の Weekly Meeting 用データアナリストです。
提供されるデータに基づき、正確で簡潔な分析をHTMLで返してください。

## 出力ルール
- HTML のみ返してください（```html タグ不要、<html><body>も不要）
- <table>, <ul>, <ol>, <p>, <strong> 等を使った見やすいフォーマット
- テーブルには必ず style="border-collapse:collapse; width:100%" を付与
- th には style="background:#1a237e; color:#fff; padding:6px 10px; text-align:center; font-size:13px"
- td には style="border:1px solid #ddd; padding:5px 8px; text-align:right; font-size:13px"
- 左揃えにすべき列（Shipper名等）は text-align:left
- 数値はカンマ区切り (例: 1,234)
- CM1/TEU は整数の$表記 (例: $342)
- 説明文は簡潔に日本語で
- 生データが提供されている場合は、自分で集計してから分析結果を作成してください

## データ
対象エリア: {area}

{data_section}
"""

        # 会話履歴をcontentsに変換
        contents = []
        for msg in history:
            role = "user" if msg.get("role") == "user" else "model"
            contents.append(genai.types.Content(
                role=role,
                parts=[genai.types.Part.from_text(text=msg.get("text", ""))]
            ))
        # 最新のユーザーメッセージ
        contents.append(genai.types.Content(
            role="user",
            parts=[genai.types.Part.from_text(text=prompt)]
        ))

        response = _gemini_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=contents,
            config=genai.types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.3,
                max_output_tokens=4096,
            ),
        )

        result_text = (response.text or "").strip()
        # コードブロックのマーカーを除去
        if result_text.startswith("```json"):
            result_text = result_text[7:]
        if result_text.startswith("```html"):
            result_text = result_text[7:]
        if result_text.startswith("```"):
            result_text = result_text[3:]
        if result_text.endswith("```"):
            result_text = result_text[:-3]
        result_text = result_text.strip()

        # レスポンスの自動判定: JSONならチャート、それ以外はHTML
        if result_text.startswith("{"):
            try:
                chart_data = json.loads(result_text)
                # chart データに必要なキーがあるか確認
                if "datasets" in chart_data or "labels" in chart_data:
                    return jsonify({"ok": True, "chart": chart_data})
            except json.JSONDecodeError:
                pass
        return jsonify({"ok": True, "html": result_text})

    except Exception as e:
        print(f"Gemini AI error: {e}")
        return jsonify({"error": f"AI分析エラー: {str(e)}"}), 500


@app.route("/api/refresh-status")
@require_login
def api_refresh_status():
    """最終BQ更新日時を返す"""
    info = get_last_refresh()
    if info:
        return jsonify({
            "last_refresh": info.get("last_refresh"),
            "refreshed_by": info.get("refreshed_by", ""),
        })
    return jsonify({"last_refresh": None, "refreshed_by": ""})


@app.route("/api/refresh", methods=["POST"])
@require_editor
def api_refresh():
    """BQデータを手動更新する（編集者のみ）"""
    user = get_current_user()
    ok = do_refresh_bq(update_firestore=True, refreshed_by=user["email"])
    if ok:
        info = get_last_refresh()
        return jsonify({
            "ok": True,
            "last_refresh": info.get("last_refresh") if info else None,
            "refreshed_by": user["email"],
        })
    else:
        return jsonify({"error": "BigQuery更新に失敗しました"}), 500


@app.route("/api/debug-routes")
def debug_routes():
    routes = [str(r) for r in app.url_map.iter_rules()]
    return jsonify(sorted(routes))

# ── 木曜自動アーカイブ (毎週木曜10:00 JST) ──────────────
def auto_archive_current_week():
    """今週のアーカイブを自動保存"""
    with app.app_context():
        try:
            today = date.today()
            week_info = get_week_info(today)
            week_key = week_info["week_key"]

            # BQ データ再取得
            ok = do_refresh_bq(update_firestore=True, refreshed_by="auto-archive")
            if not ok:
                print(f"Auto-archive: BQ refresh failed for {week_key}")
                return

            df = get_bq_df()
            areas = get_all_areas(df)
            areas_data = {}
            for a in areas:
                areas_data[a] = build_summary_for_area(a, df, today, meeting_week=week_key)

            now_jst = datetime.now(tz=JST).isoformat()
            snapshot_doc = {
                "week_key": week_key,
                "created_at": now_jst,
                "created_by": "auto-archive (木曜自動)",
                "areas": areas_data,
            }
            db.collection(FS_SNAPSHOTS).document(week_key).set(snapshot_doc)
            print(f"Auto-archive: {week_key} saved at {now_jst}")
        except Exception as e:
            print(f"Auto-archive error: {e}")

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    _scheduler = BackgroundScheduler(timezone="Asia/Tokyo")
    _scheduler.add_job(
        auto_archive_current_week,
        trigger="cron",
        day_of_week="thu",
        hour=10,
        minute=0,
        id="auto_archive_weekly",
        replace_existing=True,
    )
    _scheduler.start()
    print("スケジューラー: 毎週木曜10:00 自動アーカイブ 有効")
except Exception as _sched_e:
    print(f"スケジューラー起動エラー: {_sched_e}")


if __name__ == "__main__":
    print("=" * 50)
    print("会議資料ダッシュボード 起動中")
    print("http://localhost:5050")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5050, debug=False)
