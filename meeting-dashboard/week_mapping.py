"""
週/月マッピングモジュール
会社独自カレンダー: 日曜始まりの週番号、四半期末が5週

データソース優先順位:
  1. Firestore キャッシュ (起動時に即座にロード)
  2. GAS Web App 経由でスプレッドシートから取得 (週1回自動更新)
  3. ハードコード フォールバック値
"""
from collections import defaultdict
from datetime import date, datetime, timedelta

# ── スプレッドシート設定 ──────────────────────────────────
WEEK_SPREADSHEET_ID = "1LffPrGCW-hcGxsAq3lTPNe0g2SnDw17eBtv5OzRcz2E"
WEEK_SHEET_GID = "2038639737"

# GAS Web App URL (デプロイ後に設定)
GAS_WEEK_URL = ""

# Firestore コレクション/ドキュメント
FS_CONFIG_COLLECTION = "meeting_config"
FS_WEEK_DOC_ID = "week_mapping"

# ── ハードコード フォールバック値 ─────────────────────────
_FALLBACK_YEAR_FIRST_SUNDAY = {
    2024: date(2024, 1, 7),
    2025: date(2025, 1, 5),
    2026: date(2026, 1, 4),
    2027: date(2027, 1, 3),
}

_FALLBACK_MONTH_WEEK_MAP = {
    2025: {
        1:  list(range(1,  6)),
        2:  list(range(6,  10)),
        3:  list(range(10, 15)),
        4:  list(range(15, 19)),
        5:  list(range(19, 23)),
        6:  list(range(23, 28)),
        7:  list(range(28, 32)),
        8:  list(range(32, 36)),
        9:  list(range(36, 41)),
        10: list(range(41, 45)),
        11: list(range(45, 49)),
        12: list(range(49, 54)),
    },
    2026: {
        1:  list(range(1,  5)),
        2:  list(range(5,  9)),
        3:  list(range(9,  14)),
        4:  list(range(14, 18)),
        5:  list(range(18, 22)),
        6:  list(range(22, 27)),
        7:  list(range(27, 31)),
        8:  list(range(31, 35)),
        9:  list(range(35, 40)),
        10: list(range(40, 44)),
        11: list(range(44, 48)),
        12: list(range(48, 53)),
    },
}

# ── 実際に使われるグローバル変数 ─────────────────────────
YEAR_FIRST_SUNDAY = dict(_FALLBACK_YEAR_FIRST_SUNDAY)
MONTH_WEEK_MAP = {y: dict(m) for y, m in _FALLBACK_MONTH_WEEK_MAP.items()}
WEEK_TO_MONTH = {}


def _rebuild_week_to_month():
    """MONTH_WEEK_MAP から WEEK_TO_MONTH を再構築"""
    global WEEK_TO_MONTH
    WEEK_TO_MONTH = {}
    for yr, months in MONTH_WEEK_MAP.items():
        for mo, weeks in months.items():
            for wk in weeks:
                WEEK_TO_MONTH[(yr, wk)] = mo


_rebuild_week_to_month()


# ── コア: rows から YEAR_FIRST_SUNDAY / MONTH_WEEK_MAP を構築 ──
def _apply_rows(rows: list[dict]) -> bool:
    """
    [{"date": "2025-06-29", "year": 25, "week": 27}, ...] 形式のデータから
    グローバル変数を再構築する。
    """
    global YEAR_FIRST_SUNDAY, MONTH_WEEK_MAP
    if not rows:
        return False

    sundays: dict[tuple[int, int], date] = {}
    for r in rows:
        try:
            d_str = str(r["date"]).strip().replace("/", "-")
            d = date.fromisoformat(d_str)
            yr = int(r["year"])
            if yr < 100:
                yr += 2000
            wk = int(r["week"])
        except (ValueError, KeyError):
            continue
        key = (yr, wk)
        if key not in sundays or d < sundays[key]:
            sundays[key] = d

    if not sundays:
        return False

    # YEAR_FIRST_SUNDAY
    new_yfs = {}
    for (yr, wk), sunday in sundays.items():
        if wk == 1:
            if yr not in new_yfs or sunday < new_yfs[yr]:
                new_yfs[yr] = sunday

    # MONTH_WEEK_MAP: 週の日曜日の月 = 会社月
    new_mwm: dict[int, dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
    for (yr, wk), sunday in sorted(sundays.items()):
        new_mwm[yr][sunday.month].append(wk)

    new_mwm_dict = {}
    for yr in sorted(new_mwm):
        new_mwm_dict[yr] = {}
        for mo in sorted(new_mwm[yr]):
            new_mwm_dict[yr][mo] = sorted(new_mwm[yr][mo])

    # グローバル更新
    YEAR_FIRST_SUNDAY.update(new_yfs)
    MONTH_WEEK_MAP.clear()
    MONTH_WEEK_MAP.update(new_mwm_dict)
    _rebuild_week_to_month()

    total = sum(len(wks) for m in MONTH_WEEK_MAP.values() for wks in m.values())
    years_str = ", ".join(str(y) for y in sorted(MONTH_WEEK_MAP.keys()))
    print(f"[OK] week_mapping: ロード完了 (年: {years_str}, 合計 {total} 週)")
    for yr in sorted(MONTH_WEEK_MAP.keys()):
        for mo in sorted(MONTH_WEEK_MAP[yr]):
            wks = MONTH_WEEK_MAP[yr][mo]
            print(f"  {yr}/{mo:02d}: W{wks[0]}-W{wks[-1]} ({len(wks)}週)")
    return True


# ── Firestore からロード / 保存 ──────────────────────────
def load_from_firestore(db) -> bool:
    """Firestore キャッシュから週マッピングを読み込む"""
    try:
        doc = db.collection(FS_CONFIG_COLLECTION).document(FS_WEEK_DOC_ID).get()
        if not doc.exists:
            print("[INFO] week_mapping: Firestore にキャッシュなし")
            return False
        data = doc.to_dict()
        rows = data.get("rows", [])
        updated_at = data.get("updated_at", "?")
        if _apply_rows(rows):
            print(f"[OK] week_mapping: Firestore キャッシュから読み込み (更新日: {updated_at})")
            return True
        return False
    except Exception as e:
        print(f"[WARN] week_mapping: Firestore 読み込み失敗 ({e})")
        return False


def save_to_firestore(db, rows: list[dict]) -> bool:
    """週マッピングデータを Firestore に保存"""
    try:
        db.collection(FS_CONFIG_COLLECTION).document(FS_WEEK_DOC_ID).set({
            "rows": rows,
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "source": "spreadsheet_via_gas",
        })
        print(f"[OK] week_mapping: Firestore に保存完了 ({len(rows)} 行)")
        return True
    except Exception as e:
        print(f"[WARN] week_mapping: Firestore 保存失敗 ({e})")
        return False


# ── GAS Web App から取得 ─────────────────────────────────
def fetch_from_gas(gas_url: str = "") -> list[dict] | None:
    """GAS Web App から週データ (JSON) を取得"""
    url = gas_url or GAS_WEEK_URL
    if not url:
        print("[INFO] week_mapping: GAS URL 未設定、スキップ")
        return None
    try:
        import requests as _req
        resp = _req.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        rows = data.get("rows", [])
        if rows:
            print(f"[OK] week_mapping: GAS から {len(rows)} 行取得")
        return rows
    except Exception as e:
        print(f"[WARN] week_mapping: GAS 取得失敗 ({e})")
        return None


def refresh_from_gas(db=None, gas_url: str = "") -> bool:
    """GAS から取得 → メモリ更新 → Firestore 保存"""
    rows = fetch_from_gas(gas_url)
    if not rows:
        return False
    ok = _apply_rows(rows)
    if ok and db:
        save_to_firestore(db, rows)
    return ok


# ── CSV テキストからロード (直接アクセス用) ───────────────
def reload_from_csv(csv_text: str) -> bool:
    """CSV テキスト (A-F列) をパースして再構築"""
    import csv, io
    reader = csv.reader(io.StringIO(csv_text))
    next(reader, None)  # header skip
    rows = []
    for row in reader:
        if len(row) < 3 or not row[0].strip():
            continue
        rows.append({
            "date": row[0].strip().replace("/", "-"),
            "year": int(row[1].strip()),
            "week": int(row[2].strip()),
        })
    return _apply_rows(rows)


# ── サービスアカウント直接アクセス (ドメイン制限なしの場合) ──
def reload_from_spreadsheet(sa_key_path=None, is_cloud_run=False):
    """直接スプレッドシートからCSVエクスポートで取得 (ドメイン制限がない場合のみ動作)"""
    try:
        import csv, io
        import requests as _requests
        from google.auth.transport.requests import Request

        scopes = [
            "https://www.googleapis.com/auth/spreadsheets.readonly",
            "https://www.googleapis.com/auth/drive.readonly",
        ]
        if is_cloud_run:
            from google.auth import default as _default
            creds, _ = _default(scopes=scopes)
        else:
            from google.oauth2 import service_account as _sa
            creds = _sa.Credentials.from_service_account_file(
                str(sa_key_path), scopes=scopes
            )
        creds.refresh(Request())

        url = (
            f"https://docs.google.com/spreadsheets/d/{WEEK_SPREADSHEET_ID}"
            f"/export?format=csv&gid={WEEK_SHEET_GID}"
        )
        resp = _requests.get(url, headers={"Authorization": f"Bearer {creds.token}"}, timeout=15)
        resp.raise_for_status()
        resp.encoding = "utf-8"
        return reload_from_csv(resp.text)
    except Exception as e:
        print(f"[WARN] week_mapping: スプレッドシート直接アクセス失敗 ({e})")
        return False


# ── 以下、公開関数 ───────────────────────────────────────

def get_week_info(d: date) -> dict:
    for yr in sorted(YEAR_FIRST_SUNDAY.keys(), reverse=True):
        first_sunday = YEAR_FIRST_SUNDAY[yr]
        if d >= first_sunday:
            delta = (d - first_sunday).days
            week_no = delta // 7 + 1
            week_start = first_sunday + timedelta(weeks=week_no - 1)
            week_end = week_start + timedelta(days=6)
            month = WEEK_TO_MONTH.get((yr, week_no))
            return {
                "year": yr,
                "week": week_no,
                "month": month,
                "week_start": week_start,
                "week_end": week_end,
                "week_label": f"W{week_no} ({week_start.strftime('%m/%d')}~{week_end.strftime('%m/%d')})",
                "week_key": f"{yr}-W{week_no:02d}",
                "ym": f"{yr}-{month:02d}" if month else None,
            }
    return {"year": None, "week": None, "month": None,
            "week_start": d, "week_end": d, "week_label": "?", "week_key": "?", "ym": None}


def get_weeks_for_month(year: int, month: int) -> list:
    return MONTH_WEEK_MAP.get(year, {}).get(month, [])


def get_week_date_range(year: int, week_no: int) -> tuple:
    first_sunday = YEAR_FIRST_SUNDAY.get(year)
    if not first_sunday:
        return None, None
    week_start = first_sunday + timedelta(weeks=week_no - 1)
    week_end = week_start + timedelta(days=6)
    return week_start, week_end


def get_months_range(center_date: date, past_months: int = 4, future_months: int = 1) -> list:
    results = []
    wi = get_week_info(center_date)
    cy, cm = wi["year"] or center_date.year, wi["month"] or center_date.month
    y, m = cy, cm
    past_list = []
    for _ in range(past_months):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        past_list.append((y, m))
    past_list.reverse()
    results.extend(past_list)
    results.append((cy, cm))
    y, m = cy, cm
    for _ in range(future_months):
        m += 1
        if m == 13:
            m = 1
            y += 1
        results.append((y, m))
    return results


def month_label(year: int, month: int) -> str:
    return f"{year}/{month:02d}"


def get_3month_weeks(center_date: date) -> list:
    months = get_months_range(center_date, past_months=1, future_months=1)
    result = []
    for y, m in months:
        for wk in get_weeks_for_month(y, m):
            ws, we = get_week_date_range(y, wk)
            result.append({
                "year": y, "month": m, "week": wk,
                "week_label": f"W{wk}",
                "week_start": ws.isoformat() if ws else None,
                "week_end": we.isoformat() if we else None,
                "week_key": f"{y}-W{wk:02d}",
                "ym": f"{y}-{m:02d}",
                "month_label": month_label(y, m),
            })
    return result


def get_2month_weeks(center_date: date) -> list:
    meeting_tue = center_date + timedelta(days=2)
    if meeting_tue.day <= 14:
        months = get_months_range(center_date, past_months=1, future_months=0)
    else:
        months = get_months_range(center_date, past_months=0, future_months=1)
    result = []
    for y, m in months:
        for wk in get_weeks_for_month(y, m):
            ws, we = get_week_date_range(y, wk)
            result.append({
                "year": y, "month": m, "week": wk,
                "week_label": f"W{wk}",
                "week_start": ws.isoformat() if ws else None,
                "week_end": we.isoformat() if we else None,
                "week_key": f"{y}-W{wk:02d}",
                "ym": f"{y}-{m:02d}",
                "month_label": month_label(y, m),
            })
    return result
