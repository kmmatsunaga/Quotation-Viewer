"""
BigQuery → Google Sheets エクスポートスクリプト
daily_booking_data の booking データをスプレッドシートに書き込む
"""

import sys
from datetime import date, datetime
from google.oauth2 import service_account
from google.cloud import bigquery
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ── 設定 ──────────────────────────────────────────────────────────
KEY_PATH = r"C:\Users\matsunaga\Documents\key\booking-data-388605@appspot.gserviceaccount.com\booking-data-388605-ec9e7af2c0e1.json"
PROJECT_ID = "booking-data-388605"
TARGET_SPREADSHEET_ID = "1ou_SV9UZA8HLttxB7-cSILMgVP_7Pzk1yus-Z9PZLqE"
TARGET_SHEET_GID = 0  # gid=0 のシート

SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",  # Sheets外部テーブルへのアクセスに必要
]

# ── SQL ───────────────────────────────────────────────────────────
SQL = """
select
  format_date("%Y-%m", date(Year, Month, 1)) as YearMonth,
  db.Booking_Shipper,
  db.BKG_Shipper_code,
  POL,
  CTR,
  POD,
  DLY,
  TEU,
  P_C,
  Route,
  BKG_Date,
  ETD
from (
  select year, month, Booking_Shipper, BKG_Shipper_code, POL, CTR, POD, DLY, TEU, P_C, Route, BKG_Date, ETD
  from daily_booking_data.daily_2025_1st_half where Status <> "Cancel"
  union all
  select year, month, Booking_Shipper, BKG_Shipper_code, POL, CTR, POD, DLY, TEU, P_C, Route, BKG_Date, ETD
  from daily_booking_data.daily_2025_2nd_half where Status <> "Cancel"
  union all
  select year, month, Booking_Shipper, BKG_Shipper_code, POL, CTR, POD, DLY, TEU, P_C, Route, BKG_Date, ETD
  from daily_booking_data.daily_2026_1st_half where Status <> "Cancel"
) as db
left join handover.handover_row as ho
  on db.BKG_Shipper_Code = ho.BKG_Shipper_code
"""


def convert_value(v):
    """BigQuery の型を Sheets API が受け付ける型に変換する"""
    if v is None:
        return ""
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, float) and v != v:  # NaN
        return ""
    return v


def get_sheet_name(service, spreadsheet_id, gid):
    """gid からシート名を取得する"""
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        if props.get("sheetId") == gid:
            return props.get("title", "Sheet1")
    # gid が見つからなければ最初のシートを返す
    first = meta["sheets"][0]["properties"]
    print(f"  ⚠ gid={gid} が見つからないため、'{first['title']}' を使用します")
    return first["title"]


def main():
    # ── 認証 ─────────────────────────────────────────────────────
    print("認証中...")
    try:
        creds = service_account.Credentials.from_service_account_file(
            KEY_PATH, scopes=SCOPES
        )
    except FileNotFoundError:
        print(f"❌ キーファイルが見つかりません: {KEY_PATH}")
        sys.exit(1)

    # ── BigQuery クエリ ──────────────────────────────────────────
    print("BigQuery クエリを実行中...")
    bq = bigquery.Client(project=PROJECT_ID, credentials=creds)
    job = bq.query(SQL)
    rows_iter = job.result()

    column_names = [f.name for f in rows_iter.schema]
    data_rows = [[convert_value(v) for v in row.values()] for row in rows_iter]

    print(f"  取得行数: {len(data_rows):,} 行  /  カラム数: {len(column_names)}")

    # ── Google Sheets 書き込み ────────────────────────────────────
    print("Google Sheets に書き込み中...")
    sheets = build("sheets", "v4", credentials=creds)

    # シート名取得
    try:
        sheet_name = get_sheet_name(sheets, TARGET_SPREADSHEET_ID, TARGET_SHEET_GID)
        print(f"  対象シート: '{sheet_name}'")
    except HttpError as e:
        if e.resp.status == 403:
            sa_email = creds.service_account_email
            print(f"\n❌ 権限エラー: スプレッドシートへのアクセス権がありません。")
            print(f"   以下のサービスアカウントに編集権限を付与してください:")
            print(f"   👉 {sa_email}")
            sys.exit(1)
        raise

    range_name = f"'{sheet_name}'!A1"
    clear_range = f"'{sheet_name}'!A:Z"

    # 既存データをクリア
    sheets.spreadsheets().values().clear(
        spreadsheetId=TARGET_SPREADSHEET_ID,
        range=clear_range,
    ).execute()

    # ヘッダー + データを書き込み
    all_data = [column_names] + data_rows
    sheets.spreadsheets().values().update(
        spreadsheetId=TARGET_SPREADSHEET_ID,
        range=range_name,
        valueInputOption="RAW",
        body={"values": all_data},
    ).execute()

    # ── ヘッダー行の書式設定（太字・背景色） ────────────────────
    print("  ヘッダー書式を設定中...")
    try:
        # シートのsheetIdを取得
        meta = sheets.spreadsheets().get(spreadsheetId=TARGET_SPREADSHEET_ID).execute()
        sheet_id = None
        for s in meta["sheets"]:
            if s["properties"]["title"] == sheet_name:
                sheet_id = s["properties"]["sheetId"]
                break

        if sheet_id is not None:
            requests = [
                # ヘッダー行: 太字 + 背景色（濃い青）
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 0,
                            "endRowIndex": 1,
                            "startColumnIndex": 0,
                            "endColumnIndex": len(column_names),
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "backgroundColor": {
                                    "red": 0.267,
                                    "green": 0.447,
                                    "blue": 0.769,
                                },
                                "textFormat": {
                                    "bold": True,
                                    "foregroundColor": {
                                        "red": 1.0,
                                        "green": 1.0,
                                        "blue": 1.0,
                                    },
                                },
                            }
                        },
                        "fields": "userEnteredFormat(backgroundColor,textFormat)",
                    }
                },
                # 先頭行を固定（フリーズ）
                {
                    "updateSheetProperties": {
                        "properties": {
                            "sheetId": sheet_id,
                            "gridProperties": {"frozenRowCount": 1},
                        },
                        "fields": "gridProperties.frozenRowCount",
                    }
                },
                # 列幅を自動調整
                {
                    "autoResizeDimensions": {
                        "dimensions": {
                            "sheetId": sheet_id,
                            "dimension": "COLUMNS",
                            "startIndex": 0,
                            "endIndex": len(column_names),
                        }
                    }
                },
            ]
            sheets.spreadsheets().batchUpdate(
                spreadsheetId=TARGET_SPREADSHEET_ID,
                body={"requests": requests},
            ).execute()
    except Exception as e:
        print(f"  ⚠ 書式設定をスキップしました: {e}")

    total = len(data_rows)
    print(f"\n✅ 完了！ {total:,} 行を '{sheet_name}' に書き込みました。")
    print(f"   https://docs.google.com/spreadsheets/d/{TARGET_SPREADSHEET_ID}/edit")


if __name__ == "__main__":
    main()
