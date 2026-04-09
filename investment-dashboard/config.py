"""投資ダッシュボード設定"""
import os

# データベース
DB_PATH = os.path.join(os.path.dirname(__file__), "portfolio.db")

# JNX 公開CSV URL テンプレート
JNX_CSV_URL = (
    "https://www.japannext.co.jp/pub_data/fsa_daily_reports/"
    "jnx_daily_stock_quotation_NGHT_{date}.csv"
)

# 立花証券 e支店 API（デモ環境）
TACHIBANA_API = {
    "demo_url": "https://demo-kabuka.e-shiten.jp/e_api_v4r3/",
    "prod_url": "https://kabuka.e-shiten.jp/e_api_v4r3/",
    "use_demo": True,  # True=デモ環境, False=本番環境
}

# テクニカル分析パラメータ
TECHNICAL = {
    "sma_short": 5,
    "sma_mid": 25,
    "sma_long": 75,
    "rsi_period": 14,
    "rsi_oversold": 30,
    "rsi_overbought": 70,
    "macd_fast": 12,
    "macd_slow": 26,
    "macd_signal": 9,
}

# おすすめ銘柄スクリーニング対象（デフォルト）
DEFAULT_WATCHLIST_JP = [
    "7203.T",  # トヨタ
    "6758.T",  # ソニー
    "6861.T",  # キーエンス
    "9984.T",  # ソフトバンクG
    "8306.T",  # 三菱UFJ
    "6501.T",  # 日立製作所
    "7974.T",  # 任天堂
    "4063.T",  # 信越化学
    "6902.T",  # デンソー
    "9433.T",  # KDDI
]

DEFAULT_WATCHLIST_US = [
    "AAPL",   # Apple
    "MSFT",   # Microsoft
    "GOOGL",  # Alphabet
    "AMZN",   # Amazon
    "NVDA",   # NVIDIA
    "META",   # Meta
    "TSLA",   # Tesla
    "JPM",    # JPMorgan
    "V",      # Visa
    "AVGO",   # Broadcom
]

# 定期更新間隔（秒）
UPDATE_INTERVAL = 300  # 5分

# LINE Messaging API（プッシュ通知用）
LINE_API = {
    "channel_access_token": os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", ""),
    "user_id": os.environ.get("LINE_USER_ID", ""),
    "push_url": "https://api.line.me/v2/bot/message/push",
}

# 価格アラート設定
ALERT_CHECK_INTERVAL = 60  # アラートチェック間隔（秒）
