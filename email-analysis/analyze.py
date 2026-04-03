"""
分析レポート生成スクリプト

実行: python analyze.py [--report all|category|user|trend]
"""

import argparse
from google.cloud import bigquery
from google.oauth2 import service_account
from config import PROJECT_ID, DATASET_ID, TABLE_RECEIVE, TABLE_SEND, TABLE_CATEGORY, BQ_KEY_PATH


def get_bq_client():
    creds = service_account.Credentials.from_service_account_file(BQ_KEY_PATH)
    return bigquery.Client(project=PROJECT_ID, credentials=creds)


# ─────────────────────────────────────────────
# 分析クエリ集
# ─────────────────────────────────────────────

def report_category_summary(client):
    """カテゴリ別件数（受信）"""
    print("\n" + "="*50)
    print("📊 カテゴリ別 件数（受信メール）")
    print("="*50)

    q = f"""
        SELECT
            c.category_l1,
            c.category_l2,
            COUNT(*) AS cnt,
            ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) AS pct
        FROM `{PROJECT_ID}.{DATASET_ID}.{TABLE_RECEIVE}` m
        JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
          ON m.message_id = c.message_id AND c.source_table = '{TABLE_RECEIVE}'
        GROUP BY 1, 2
        ORDER BY cnt DESC
    """
    rows = list(client.query(q).result())
    print(f"{'カテゴリL1':<15} {'カテゴリL2':<20} {'件数':>8} {'割合':>7}")
    print("-"*55)
    for r in rows:
        print(f"{r.category_l1:<15} {r.category_l2:<20} {r.cnt:>8,} {r.pct:>6.1f}%")


def report_user_summary(client):
    """担当者別カテゴリ件数（受信）"""
    print("\n" + "="*50)
    print("👤 担当者別 カテゴリ件数（受信メール）")
    print("="*50)

    q = f"""
        SELECT
            m.User,
            c.category_l1,
            COUNT(*) AS cnt
        FROM `{PROJECT_ID}.{DATASET_ID}.{TABLE_RECEIVE}` m
        JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
          ON m.message_id = c.message_id AND c.source_table = '{TABLE_RECEIVE}'
        GROUP BY 1, 2
        ORDER BY m.User, cnt DESC
    """
    current_user = None
    for r in client.query(q).result():
        if r.User != current_user:
            print(f"\n  [{r.User}]")
            current_user = r.User
        print(f"    {r.category_l1:<15} {r.cnt:>6,} 件")


def report_monthly_trend(client):
    """月別カテゴリ件数トレンド（受信）"""
    print("\n" + "="*50)
    print("📈 月別トレンド（受信メール）")
    print("="*50)

    q = f"""
        SELECT
            FORMAT_TIMESTAMP('%Y-%m', m.Datetime) AS month,
            c.category_l1,
            COUNT(*) AS cnt
        FROM `{PROJECT_ID}.{DATASET_ID}.{TABLE_RECEIVE}` m
        JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
          ON m.message_id = c.message_id AND c.source_table = '{TABLE_RECEIVE}'
        GROUP BY 1, 2
        ORDER BY 1, cnt DESC
    """
    current_month = None
    for r in client.query(q).result():
        if r.month != current_month:
            print(f"\n  {r.month}")
            current_month = r.month
        print(f"    {r.category_l1:<15} {r.cnt:>6,} 件")


def report_uncategorized_count(client):
    """未分類件数の確認"""
    print("\n" + "="*50)
    print("⏳ 分類状況")
    print("="*50)

    for source_table in (TABLE_RECEIVE, TABLE_SEND):
        q = f"""
            SELECT
                COUNT(*) AS total,
                COUNTIF(c.message_id IS NOT NULL) AS categorized,
                COUNTIF(c.message_id IS NULL) AS uncategorized
            FROM `{PROJECT_ID}.{DATASET_ID}.{source_table}` m
            LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.{TABLE_CATEGORY}` c
              ON m.message_id = c.message_id AND c.source_table = '{source_table}'
        """
        for r in client.query(q).result():
            pct = r.categorized * 100 / r.total if r.total else 0
            print(f"  {source_table}: 全{r.total:,}件 | 分類済{r.categorized:,}件({pct:.1f}%) | 未分類{r.uncategorized:,}件")


def main():
    parser = argparse.ArgumentParser(description="メール分析レポート")
    parser.add_argument("--report", choices=["all", "category", "user", "trend", "status"],
                        default="status", help="レポート種類 (デフォルト: status)")
    args = parser.parse_args()

    client = get_bq_client()

    report_uncategorized_count(client)

    if args.report in ("all", "category"):
        report_category_summary(client)

    if args.report in ("all", "user"):
        report_user_summary(client)

    if args.report in ("all", "trend"):
        report_monthly_trend(client)


if __name__ == "__main__":
    main()
