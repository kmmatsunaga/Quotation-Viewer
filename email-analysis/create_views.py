"""
分析用BigQuery VIEWを作成するスクリプト

実行: python create_views.py
"""

from google.cloud import bigquery
from google.oauth2 import service_account
from config import PROJECT_ID, DATASET_ID, TABLE_RECEIVE, TABLE_SEND, TABLE_CATEGORY, BQ_KEY_PATH


VIEWS = {
    # 受信メール + カテゴリ
    "v_receive_with_category": f"""
        SELECT
            m.*,
            c.category_l1,
            c.category_l2,
            c.confidence,
            c.notes AS category_notes
        FROM `{PROJECT_ID}.{DATASET_ID}.{TABLE_RECEIVE}` m
        LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
          ON m.message_id = c.message_id AND c.source_table = '{TABLE_RECEIVE}'
    """,

    # 送信メール + カテゴリ
    "v_send_with_category": f"""
        SELECT
            m.*,
            c.category_l1,
            c.category_l2,
            c.confidence,
            c.notes AS category_notes
        FROM `{PROJECT_ID}.{DATASET_ID}.{TABLE_SEND}` m
        LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
          ON m.message_id = c.message_id AND c.source_table = '{TABLE_SEND}'
    """,

    # カテゴリ別・担当者別 月次集計
    "v_category_monthly": f"""
        SELECT
            FORMAT_TIMESTAMP('%Y-%m', m.Datetime) AS month,
            m.User,
            c.category_l1,
            c.category_l2,
            COUNT(*) AS email_count
        FROM `{PROJECT_ID}.{DATASET_ID}.{TABLE_RECEIVE}` m
        JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
          ON m.message_id = c.message_id AND c.source_table = '{TABLE_RECEIVE}'
        GROUP BY 1, 2, 3, 4
    """,
}


def main():
    creds = service_account.Credentials.from_service_account_file(BQ_KEY_PATH)
    client = bigquery.Client(project=PROJECT_ID, credentials=creds)

    for view_name, query in VIEWS.items():
        view_ref = f"{PROJECT_ID}.{DATASET_ID}.{view_name}"
        view = bigquery.Table(view_ref)
        view.view_query = query.strip()

        try:
            client.delete_table(view_ref, not_found_ok=True)
            client.create_table(view)
            print(f"✓ VIEW作成: {view_name}")
        except Exception as e:
            print(f"✗ エラー ({view_name}): {e}")

    print("\n完了。BigQueryコンソールで確認できます。")


if __name__ == "__main__":
    main()
