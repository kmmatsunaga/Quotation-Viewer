"""株価データ取得モジュール

データソース:
- yfinance: 東証（15分遅延）・米国市場（15分遅延）
- JNX公開CSV: 夜間PTS取引データ
- 立花証券 e支店 API: 東証リアルタイム（要口座開設）
"""
import io
import re
import unicodedata
from datetime import datetime, timedelta

import pandas as pd
import requests
import yfinance as yf

from config import JNX_CSV_URL, TACHIBANA_API


# ============================================================
# yfinance: 東証 + 米国市場
# ============================================================

def fetch_stock_history(ticker: str, period: str = "6mo", interval: str = "1d") -> pd.DataFrame:
    """yfinance で株価履歴を取得する。

    Args:
        ticker: 銘柄コード（例: "7203.T", "AAPL"）
        period: 取得期間（"1mo", "3mo", "6mo", "1y", "5y" など）
        interval: 足の間隔（"1d", "1wk", "1mo" など）

    Returns:
        OHLCV の DataFrame
    """
    stock = yf.Ticker(ticker)
    df = stock.history(period=period, interval=interval)
    if df.empty:
        return pd.DataFrame()
    df.index = df.index.tz_localize(None)
    return df


def fetch_stock_info(ticker: str) -> dict:
    """yfinance で銘柄の基本情報を取得する。"""
    stock = yf.Ticker(ticker)
    try:
        info = stock.info
    except Exception:
        info = {}
    return {
        "ticker": ticker,
        "name": info.get("shortName", info.get("longName", ticker)),
        "currency": info.get("currency", ""),
        "market_cap": info.get("marketCap", 0),
        "pe_ratio": info.get("trailingPE", None),
        "dividend_yield": info.get("dividendYield", None),
        "sector": info.get("sector", ""),
        "current_price": info.get("currentPrice", info.get("regularMarketPrice", 0)),
        "previous_close": info.get("previousClose", 0),
    }


def fetch_multiple_prices(tickers: list[str]) -> pd.DataFrame:
    """複数銘柄の最新価格をまとめて取得する。"""
    rows = []
    for t in tickers:
        try:
            info = fetch_stock_info(t)
            price = info["current_price"] or 0
            prev = info["previous_close"] or 0
            change = ((price - prev) / prev * 100) if prev else 0
            rows.append({
                "ticker": t,
                "name": info["name"],
                "price": price,
                "change_pct": round(change, 2),
                "currency": info["currency"],
            })
        except Exception:
            rows.append({
                "ticker": t,
                "name": t,
                "price": 0,
                "change_pct": 0,
                "currency": "",
            })
    return pd.DataFrame(rows)


# ============================================================
# ニュース取得
# ============================================================

_JP_RE = re.compile(r'[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]')

def _is_japanese(text: str) -> bool:
    """テキストに日本語文字が含まれていれば True。"""
    return bool(_JP_RE.search(text))


def _parse_news_item(item: dict) -> dict:
    """yfinance のニュースアイテムを統一形式に変換する。"""
    content = item.get("content", {})
    thumbnail_url = ""
    thumbnail = content.get("thumbnail")
    if thumbnail and isinstance(thumbnail, dict):
        resolutions = thumbnail.get("resolutions", [])
        if resolutions:
            thumbnail_url = resolutions[0].get("url", "")
    pub_time = content.get("pubDate", "")
    return {
        "title": content.get("title", "No title"),
        "publisher": content.get("provider", {}).get("displayName", ""),
        "link": content.get("canonicalUrl", {}).get("url", ""),
        "published": pub_time,
        "thumbnail": thumbnail_url,
    }


def fetch_ticker_news(ticker: str, max_items: int = 5,
                       japanese_only: bool = False) -> list[dict]:
    """yfinance でティッカーのニュースを取得する。

    Args:
        japanese_only: True の場合、日本語タイトルのニュースのみ返す
    """
    try:
        stock = yf.Ticker(ticker)
        news = stock.news or []
        results = []
        for item in news:
            parsed = _parse_news_item(item)
            if japanese_only and not _is_japanese(parsed["title"]):
                continue
            results.append(parsed)
            if len(results) >= max_items:
                break
        return results
    except Exception:
        return []


def fetch_market_news() -> list[dict]:
    """マーケット全般のニュースを取得する（日本語ニュース優先）。"""
    seen_titles = set()
    all_news = []

    # まず日本語ニュースを優先取得
    for ticker in ["^N225", "^GSPC", "^IXIC"]:
        for item in fetch_ticker_news(ticker, max_items=8, japanese_only=True):
            if item["title"] not in seen_titles:
                seen_titles.add(item["title"])
                all_news.append(item)

    # 日本語ニュースが少なければ英語ニュースも追加
    if len(all_news) < 3:
        for ticker in ["^N225", "^GSPC", "^IXIC"]:
            for item in fetch_ticker_news(ticker, max_items=5):
                if item["title"] not in seen_titles:
                    seen_titles.add(item["title"])
                    all_news.append(item)

    return all_news[:8]


def fetch_index_chart_data(ticker: str, interval: str = "1d",
                           period: str = "1mo") -> pd.DataFrame:
    """指数のバーチャート用OHLCVデータを取得する。

    interval: "1m","5m","15m","1d","1wk","1mo"
    """
    stock = yf.Ticker(ticker)
    try:
        df = stock.history(period=period, interval=interval)
        if df.empty:
            return pd.DataFrame()
        df.index = df.index.tz_localize(None)
        return df
    except Exception:
        return pd.DataFrame()


# ============================================================
# JNX 夜間PTS: 公開CSV
# ============================================================

def fetch_jnx_night(date: str | None = None) -> pd.DataFrame:
    """JNX 夜間セッションの株価データを公開CSVから取得する。

    Args:
        date: 日付文字列 "YYYY-MM-DD"（省略時は前営業日）

    Returns:
        JNX 夜間取引データの DataFrame
    """
    if date is None:
        # 前営業日を推定（土日を飛ばす簡易版）
        today = datetime.now()
        if today.weekday() == 0:  # 月曜
            target = today - timedelta(days=3)
        elif today.weekday() == 6:  # 日曜
            target = today - timedelta(days=2)
        else:
            target = today - timedelta(days=1)
        date = target.strftime("%Y-%m-%d")

    url = JNX_CSV_URL.format(date=date)
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        df = pd.read_csv(io.StringIO(resp.text))
        return df
    except requests.HTTPError:
        return pd.DataFrame()
    except Exception:
        return pd.DataFrame()


# ============================================================
# 立花証券 e支店 API（将来実装用インターフェース）
# ============================================================

class TachibanaAPI:
    """立花証券 e支店 API のラッパー。

    利用するには立花証券の口座開設が必要です。
    デモ環境 → 本番環境の切り替えは config.py で行います。

    公式ドキュメント: https://www.e-shiten.jp/api/
    GitHub サンプル:  https://github.com/e-shiten-jp
    """

    def __init__(self, user_id: str = "", password: str = ""):
        self.user_id = user_id
        self.password = password
        cfg = TACHIBANA_API
        self.base_url = cfg["demo_url"] if cfg["use_demo"] else cfg["prod_url"]
        self.token = None

    def login(self) -> bool:
        """API ログイン（トークン取得）。

        本実装は立花証券の口座開設後に有効になります。
        現時点ではスタブとして False を返します。
        """
        if not self.user_id or not self.password:
            return False

        try:
            payload = {
                "sCLMID": "CLMAuthLoginRequest",
                "sUserId": self.user_id,
                "sPassword": self.password,
            }
            resp = requests.post(
                self.base_url,
                json=payload,
                timeout=10,
            )
            data = resp.json()
            if data.get("sResultCode") == "0":
                self.token = data.get("sApiKey", "")
                return True
        except Exception:
            pass
        return False

    def is_available(self) -> bool:
        """API が利用可能かどうかを返す。"""
        return self.token is not None

    def fetch_realtime_price(self, stock_code: str) -> dict | None:
        """リアルタイム株価を取得する（要ログイン）。"""
        if not self.is_available():
            return None
        # 本番実装時はここで REST API を呼ぶ
        return None
