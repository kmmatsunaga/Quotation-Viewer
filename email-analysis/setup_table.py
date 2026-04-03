"""
BigQueryにcsmail_categoryテーブルを作成するスクリプト
（既に存在する場合はスキップ）

実行: python setup_table.py
"""

from google.cloud import bigquery
from google.oauth2 import service_account
from config import PROJECT_ID, DATASET_ID, TABLE_CATEGORY, BQ_KEY_PATH


CATEGORY_SCHEMA = [
    bigquery.SchemaField("message_id",    "STRING",    mode="REQUIRED",  description="元テーブルのmessage_id"),
    bigquery.SchemaField("source_table",  "STRING",    mode="REQUIRED",  description="csmail_receive または csmail_send"),
    bigquery.SchemaField("category_l1",   "STRING",    mode="NULLABLE",  description="大カテゴリ（例: ブッキング）"),
    bigquery.SchemaField("category_l2",   "STRING",    mode="NULLABLE",  description="小カテゴリ（例: 新規依頼）"),
    bigquery.SchemaField("confidence",    "FLOAT64",   mode="NULLABLE",  description="分類の信頼度 0.0〜1.0"),
    bigquery.SchemaField("notes",         "STRING",    mode="NULLABLE",  description="分類理由・補足"),
    bigquery.SchemaField("categorized_at","TIMESTAMP", mode="NULLABLE",  description="分類日時"),
    bigquery.SchemaField("method",        "STRING",    mode="NULLABLE",  description="分類方法 (claude_api / manual)"),
    bigquery.SchemaField("model",         "STRING",    mode="NULLABLE",  description="使用したモデル名"),
]


def main():
    creds = service_account.Credentials.from_service_account_file(BQ_KEY_PATH)
    client = bigquery.Client(project=PROJECT_ID, credentials=creds)

    table_ref = f"{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}"
    table = bigquery.Table(table_ref, schema=CATEGORY_SCHEMA)

    try:
        client.create_table(table)
        print(f"✓ テーブル作成完了: {table_ref}")
    except Exception as e:
        if "Already Exists" in str(e):
            print(f"✓ テーブルは既に存在します: {table_ref}")
        else:
            raise

    # 現在の件数確認
    q = f"SELECT COUNT(*) as cnt FROM `{table_ref}`"
    for row in client.query(q).result():
        print(f"  現在のカテゴリ登録件数: {row.cnt:,}")


if __name__ == "__main__":
    main()
