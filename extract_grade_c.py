"""
BigQuery × Google Sheets を結合して等級Cの荷主をCSV出力するスクリプト
"""
import sys
import os
import json
import pandas as pd
import gspread
from google.cloud import bigquery
from google.oauth2 import service_account

# ---- 設定 ----
SPREADSHEET_ID = "11G4ginOqHbkNPoaJGhcjmwDTTjtfLW2GsD86DraQ-hg"
SHEET_NAME = "顧客等級"
OUTPUT_CSV = "grade_c_shipper_list.csv"
KEY_PATH = r"C:\Users\matsunaga\Documents\key\booking-data-388605@appspot.gserviceaccount.com\booking-data-388605-ec9e7af2c0e1.json"
ADC_PATH = r"C:\Users\matsunaga\AppData\Roaming\gcloud\application_default_credentials.json"

BQ_QUERY = """
select format_date("%Y-%m", ETD) as YearMonth,
  Booking_Shipper,
  BKG_Shipper_Code,
  POL_Sales,
  POL,
  CTR,
  POD,
  DLY,
  sum(TEU) as TEU
from `updated_tables.score_dailybooking`
where format_date("%Y-%m", ETD) >= format_date("%Y-%m", date_sub(current_date, interval 12 month))
group by 1,2,3,4,5,6,7,8
order by YearMonth, POL_Sales, BKG_Shipper_Code
"""

def main():
    print("=== Step 1: BigQuery クエリ実行中 ===")
    bq_creds = service_account.Credentials.from_service_account_file(KEY_PATH)
    bq_client = bigquery.Client(project="booking-data-388605", credentials=bq_creds)
    bq_df = bq_client.query(BQ_QUERY).to_dataframe()
    print(f"  → {len(bq_df):,} 行取得")

    print("=== Step 2: Google Sheets「顧客等級」シート読み込み中 ===")
    # gcloud ADC (authorized_user) でSheetsにアクセス
    from google.oauth2.credentials import Credentials as OAuthCreds
    from google.auth.transport.requests import Request
    with open(ADC_PATH, encoding="utf-8") as f:
        adc = json.load(f)
    sheets_creds = OAuthCreds(
        token=None,
        refresh_token=adc["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=adc["client_id"],
        client_secret=adc["client_secret"],
        quota_project_id="booking-data-388605",
    )
    sheets_creds.refresh(Request())
    gc = gspread.authorize(sheets_creds)
    sh = gc.open_by_key(SPREADSHEET_ID)
    ws = sh.worksheet(SHEET_NAME)
    sheet_data = ws.get_all_records()
    sheet_df = pd.DataFrame(sheet_data)
    print(f"  → シート列: {list(sheet_df.columns)}")
    print(f"  → {len(sheet_df):,} 行取得")

    # 「会社名」「等級」列のみ使用
    if "会社名" not in sheet_df.columns or "等級" not in sheet_df.columns:
        print(f"[ERROR] 「会社名」または「等級」列が見つかりません。実際の列: {list(sheet_df.columns)}")
        sys.exit(1)
    grade_df = sheet_df[["会社名", "等級"]].rename(columns={"会社名": "Booking_Shipper"})

    print("=== Step 3: 結合・等級C フィルタ ===")
    merged = bq_df.merge(grade_df, on="Booking_Shipper", how="left")
    grade_c = merged[merged["等級"] == "C"].copy()
    print(f"  → 等級Cの荷主レコード数: {len(grade_c):,} 行")
    print(f"  → 等級Cのユニーク荷主数: {grade_c['Booking_Shipper'].nunique():,} 社")

    print(f"=== Step 4: CSV出力 → {OUTPUT_CSV} ===")
    grade_c.to_csv(OUTPUT_CSV, index=False, encoding="utf-8-sig")
    print("  → 完了!")

    print("\n【等級Cのユニーク荷主一覧（参考）】")
    print(grade_c["Booking_Shipper"].drop_duplicates().sort_values().to_string())

if __name__ == "__main__":
    main()
