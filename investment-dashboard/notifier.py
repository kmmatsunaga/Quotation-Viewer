"""通知モジュール - LINE Messaging API によるプッシュ通知

使い方:
1. LINE Developers (https://developers.line.biz/) でプロバイダー・チャネルを作成
2. Messaging API チャネルの「チャネルアクセストークン（長期）」を発行
3. ボットと友達になり、ユーザーIDを取得
4. 環境変数に設定:
   - LINE_CHANNEL_ACCESS_TOKEN=<チャネルアクセストークン>
   - LINE_USER_ID=<あなたのユーザーID>
"""
import json
import logging
from datetime import datetime

import requests

from config import LINE_API

logger = logging.getLogger(__name__)


def send_line_push(message: str) -> bool:
    """LINE にプッシュ通知を送信する。

    Returns:
        True: 送信成功, False: 送信失敗（トークン未設定含む）
    """
    token = LINE_API["channel_access_token"]
    user_id = LINE_API["user_id"]

    if not token or not user_id:
        logger.warning("LINE API のトークンまたはユーザーIDが設定されていません。")
        return False

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    payload = {
        "to": user_id,
        "messages": [
            {
                "type": "text",
                "text": message,
            }
        ],
    }

    try:
        resp = requests.post(LINE_API["push_url"], headers=headers,
                             data=json.dumps(payload), timeout=10)
        if resp.status_code == 200:
            logger.info("LINE 通知送信成功")
            return True
        else:
            logger.error(f"LINE 通知送信失敗: {resp.status_code} {resp.text}")
            return False
    except Exception as e:
        logger.error(f"LINE 通知送信エラー: {e}")
        return False


def format_alert_message(ticker: str, name: str, condition: str,
                         target_price: float, current_price: float) -> str:
    """アラート通知メッセージを整形する。"""
    cond_text = "以上に到達" if condition == "above" else "以下に到達"
    now = datetime.now().strftime("%Y/%m/%d %H:%M")

    return (
        f"📈 価格アラート通知\n"
        f"━━━━━━━━━━━━━━\n"
        f"銘柄: {name} ({ticker})\n"
        f"条件: {target_price:,.0f}円 {cond_text}\n"
        f"現在値: {current_price:,.0f}円\n"
        f"時刻: {now}\n"
        f"━━━━━━━━━━━━━━\n"
        f"投資ダッシュボードで確認"
    )


def check_and_notify_alerts():
    """有効なアラートをチェックし、条件を満たしたら通知する。

    Returns:
        list[dict]: 発火したアラートのリスト
    """
    from data_fetcher import fetch_stock_info
    from portfolio_db import get_all_alerts, update_alert_triggered

    alerts = get_all_alerts(active_only=True)
    if alerts.empty:
        return []

    triggered = []
    for _, alert in alerts.iterrows():
        try:
            info = fetch_stock_info(alert["ticker"])
            current_price = info.get("current_price") or info.get("previous_close") or 0
            if current_price <= 0:
                continue

            condition_met = False
            if alert["condition"] == "above" and current_price >= alert["target_price"]:
                condition_met = True
            elif alert["condition"] == "below" and current_price <= alert["target_price"]:
                condition_met = True

            if condition_met:
                msg = format_alert_message(
                    alert["ticker"], alert["name"], alert["condition"],
                    alert["target_price"], current_price
                )
                sent = send_line_push(msg)
                update_alert_triggered(alert["id"])
                triggered.append({
                    "id": alert["id"],
                    "ticker": alert["ticker"],
                    "name": alert["name"],
                    "condition": alert["condition"],
                    "target_price": alert["target_price"],
                    "current_price": current_price,
                    "line_sent": sent,
                })
                logger.info(f"アラート発火: {alert['ticker']} {alert['condition']} {alert['target_price']} (現在値: {current_price})")

        except Exception as e:
            logger.error(f"アラートチェックエラー ({alert['ticker']}): {e}")
            continue

    return triggered
