"""Investment Dashboard FastAPI Backend

Wraps the existing investment-dashboard Python modules
(config, data_fetcher, portfolio_db, analysis, notifier)
and exposes them as a REST API.
"""

import os
import time
import logging
from typing import Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Import modules (co-located in the same directory)
# ---------------------------------------------------------------------------
import config as cfg
cfg.DB_PATH = os.path.join(os.path.dirname(__file__), "portfolio.db")

import data_fetcher as fetcher
import portfolio_db as db
import analysis
from notifier import check_and_notify_alerts

logger = logging.getLogger("investment-api")

# ---------------------------------------------------------------------------
# Simple TTL cache helper
# ---------------------------------------------------------------------------
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl: int, fn, *args, **kwargs):
    """Return cached value if within TTL, otherwise call fn and store."""
    now = time.time()
    if key in _cache:
        ts, val = _cache[key]
        if now - ts < ttl:
            return val
    val = fn(*args, **kwargs)
    _cache[key] = (now, val)
    return val


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class HoldingCreate(BaseModel):
    ticker: str
    name: str = ""
    shares: float = 0
    avg_cost: float = 0
    market: str = "TSE"
    memo: str = ""


class HoldingUpdate(BaseModel):
    shares: Optional[float] = None
    avg_cost: Optional[float] = None
    memo: Optional[str] = None


class WatchlistAdd(BaseModel):
    ticker: str
    name: str = ""
    market: str = "TSE"


class AlertCreate(BaseModel):
    ticker: str
    name: str = ""
    condition: str = "above"
    target_price: float


class SettingUpdate(BaseModel):
    value: str


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Investment Dashboard API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helper: DataFrame -> list[dict] safe for JSON
# ---------------------------------------------------------------------------
def _df_to_records(df: pd.DataFrame) -> list[dict]:
    if df.empty:
        return []
    return df.where(df.notna(), None).to_dict(orient="records")


def _add_jp_name(records: list[dict]) -> list[dict]:
    """Attach name_jp from TICKER_NAME_JP if available."""
    for r in records:
        ticker = r.get("ticker", "")
        r["name_jp"] = cfg.TICKER_NAME_JP.get(ticker, "")
    return records


# ---------------------------------------------------------------------------
# Indices
# ---------------------------------------------------------------------------

@app.get("/api/indices")
def get_indices(timeframe: str = "1d"):
    """Top 4 index data with chart data. timeframe: 1d/5d/1mo/3mo/6mo/1y."""
    period_map = {
        "1d": ("1d", "5m"),
        "5d": ("5d", "15m"),
        "1mo": ("1mo", "1d"),
        "3mo": ("3mo", "1d"),
        "6mo": ("6mo", "1d"),
        "1y": ("1y", "1d"),
    }
    period, interval = period_map.get(timeframe, ("1mo", "1d"))

    def _fetch():
        tickers = cfg.DEFAULT_TOP_INDICES
        results = []
        for t in tickers:
            info = fetcher.fetch_stock_info(t)
            price = info.get("current_price") or info.get("previous_close") or 0
            prev = info.get("previous_close") or 0
            change_pct = ((price - prev) / prev * 100) if prev else 0

            chart_df = fetcher.fetch_index_chart_data(t, interval=interval, period=period)
            chart_data = []
            if not chart_df.empty:
                for idx, row in chart_df.iterrows():
                    chart_data.append({
                        "time": idx.isoformat(),
                        "open": row.get("Open"),
                        "high": row.get("High"),
                        "low": row.get("Low"),
                        "close": row.get("Close"),
                        "volume": row.get("Volume"),
                    })

            results.append({
                "ticker": t,
                "name": cfg.AVAILABLE_INDICES.get(t, info.get("name", t)),
                "price": price,
                "change_pct": round(change_pct, 2),
                "chart": chart_data,
            })
        return results

    cache_key = f"indices:{timeframe}"
    return _cached(cache_key, 120, _fetch)


@app.get("/api/indices/bar")
def get_indices_bar():
    """All 6 key indices for the top bar display."""
    bar_tickers = ["^N225", "NKD=F", "^GSPC", "^IXIC", "^DJI", "USDJPY=X"]

    def _fetch():
        results = []
        for t in bar_tickers:
            try:
                info = fetcher.fetch_stock_info(t)
                price = info.get("current_price") or info.get("previous_close") or 0
                prev = info.get("previous_close") or 0
                change_pct = ((price - prev) / prev * 100) if prev else 0
                results.append({
                    "ticker": t,
                    "name": cfg.AVAILABLE_INDICES.get(t, info.get("name", t)),
                    "price": price,
                    "change_pct": round(change_pct, 2),
                })
            except Exception:
                results.append({
                    "ticker": t,
                    "name": cfg.AVAILABLE_INDICES.get(t, t),
                    "price": 0,
                    "change_pct": 0,
                })
        return results

    return _cached("indices_bar", 60, _fetch)


# ---------------------------------------------------------------------------
# Stocks
# ---------------------------------------------------------------------------

@app.get("/api/stocks/jp")
def get_jp_stocks():
    """Japanese stock prices with JP names."""
    def _fetch():
        tickers = cfg.DEFAULT_WATCHLIST_JP
        df = fetcher.fetch_multiple_prices(tickers)
        records = _df_to_records(df)
        return _add_jp_name(records)

    return _cached("stocks_jp", 120, _fetch)


@app.get("/api/stocks/us")
def get_us_stocks():
    """US stock prices with JP names."""
    def _fetch():
        tickers = cfg.DEFAULT_WATCHLIST_US
        df = fetcher.fetch_multiple_prices(tickers)
        records = _df_to_records(df)
        return _add_jp_name(records)

    return _cached("stocks_us", 120, _fetch)


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------

@app.get("/api/news/market")
def get_market_news():
    """Market news (Japanese priority)."""
    return _cached("news_market", 300, fetcher.fetch_market_news)


@app.get("/api/news/portfolio")
def get_portfolio_news():
    """News for portfolio holdings."""
    def _fetch():
        holdings = db.get_all_holdings()
        if holdings.empty:
            return []
        seen = set()
        all_news = []
        for ticker in holdings["ticker"].tolist():
            for item in fetcher.fetch_ticker_news(ticker, max_items=3):
                if item["title"] not in seen:
                    seen.add(item["title"])
                    item["ticker"] = ticker
                    item["name_jp"] = cfg.TICKER_NAME_JP.get(ticker, "")
                    all_news.append(item)
        return all_news[:15]

    return _cached("news_portfolio", 300, _fetch)


# ---------------------------------------------------------------------------
# Single stock
# ---------------------------------------------------------------------------

@app.get("/api/stock/{ticker}")
def get_stock_detail(ticker: str):
    """Single stock detail + technical analysis."""
    try:
        info = fetcher.fetch_stock_info(ticker)
        df = fetcher.fetch_stock_history(ticker, period="6mo")
        scoring = {"score": 50, "signals": [], "recommendation": "データ不足"}
        if not df.empty:
            df = analysis.add_technical_indicators(df)
            scoring = analysis.calculate_score(df)

        info["name_jp"] = cfg.TICKER_NAME_JP.get(ticker, "")
        info["analysis"] = scoring
        return info
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stock/{ticker}/history")
def get_stock_history(
    ticker: str,
    period: str = Query("6mo", description="1mo,3mo,6mo,1y,5y"),
    interval: str = Query("1d", description="1d,1wk,1mo"),
):
    """OHLCV history."""
    try:
        df = fetcher.fetch_stock_history(ticker, period=period, interval=interval)
        if df.empty:
            return []
        records = []
        for idx, row in df.iterrows():
            records.append({
                "time": idx.isoformat(),
                "open": row.get("Open"),
                "high": row.get("High"),
                "low": row.get("Low"),
                "close": row.get("Close"),
                "volume": row.get("Volume"),
            })
        return records
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stock/{ticker}/news")
def get_stock_news(ticker: str):
    """News for a specific stock."""
    try:
        news = fetcher.fetch_ticker_news(ticker, max_items=8)
        for item in news:
            item["name_jp"] = cfg.TICKER_NAME_JP.get(ticker, "")
        return news
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Holdings (CRUD)
# ---------------------------------------------------------------------------

@app.get("/api/holdings")
def list_holdings():
    """List all holdings."""
    df = db.get_all_holdings()
    records = _df_to_records(df)
    return _add_jp_name(records)


@app.post("/api/holdings", status_code=201)
def create_holding(body: HoldingCreate):
    """Add a holding."""
    name = body.name or cfg.TICKER_NAME_JP.get(body.ticker, body.ticker)
    row_id = db.add_holding(
        ticker=body.ticker,
        name=name,
        shares=body.shares,
        avg_cost=body.avg_cost,
        market=body.market,
        memo=body.memo,
    )
    return {"id": row_id}


@app.put("/api/holdings/{holding_id}")
def update_holding(holding_id: int, body: HoldingUpdate):
    """Update a holding."""
    existing = db.get_holding_by_id(holding_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Holding not found")
    db.update_holding(
        holding_id,
        shares=body.shares,
        avg_cost=body.avg_cost,
        memo=body.memo,
    )
    return {"ok": True}


@app.delete("/api/holdings/{holding_id}")
def delete_holding(holding_id: int):
    """Delete a holding."""
    existing = db.get_holding_by_id(holding_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Holding not found")
    db.delete_holding(holding_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------

@app.get("/api/watchlist")
def get_watchlist():
    """Get watchlist."""
    df = db.get_watchlist()
    records = _df_to_records(df)
    return _add_jp_name(records)


@app.post("/api/watchlist", status_code=201)
def add_watchlist(body: WatchlistAdd):
    """Add to watchlist."""
    name = body.name or cfg.TICKER_NAME_JP.get(body.ticker, body.ticker)
    db.add_to_watchlist(ticker=body.ticker, name=name, market=body.market)
    return {"ok": True}


@app.delete("/api/watchlist/{ticker}")
def remove_watchlist(ticker: str):
    """Remove from watchlist."""
    db.remove_from_watchlist(ticker)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

@app.get("/api/alerts")
def list_alerts(active_only: bool = False):
    """Get all alerts."""
    df = db.get_all_alerts(active_only=active_only)
    records = _df_to_records(df)
    return _add_jp_name(records)


@app.post("/api/alerts", status_code=201)
def create_alert(body: AlertCreate):
    """Add an alert."""
    name = body.name or cfg.TICKER_NAME_JP.get(body.ticker, body.ticker)
    row_id = db.add_alert(
        ticker=body.ticker,
        name=name,
        condition=body.condition,
        target_price=body.target_price,
    )
    return {"id": row_id}


@app.put("/api/alerts/{alert_id}/toggle")
def toggle_alert(alert_id: int):
    """Toggle alert active/inactive."""
    alerts_df = db.get_all_alerts()
    match = alerts_df[alerts_df["id"] == alert_id]
    if match.empty:
        raise HTTPException(status_code=404, detail="Alert not found")
    current_active = bool(match.iloc[0]["active"])
    db.toggle_alert_active(alert_id, not current_active)
    return {"ok": True, "active": not current_active}


@app.delete("/api/alerts/{alert_id}")
def delete_alert(alert_id: int):
    """Delete an alert."""
    db.delete_alert(alert_id)
    return {"ok": True}


@app.post("/api/alerts/check")
def check_alerts():
    """Manually check all active alerts and send notifications."""
    try:
        triggered = check_and_notify_alerts()
        return {"triggered": triggered, "count": len(triggered)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.get("/api/settings/{key}")
def get_setting(key: str):
    """Get a setting value."""
    value = db.get_setting(key, default="")
    return {"key": key, "value": value}


@app.put("/api/settings/{key}")
def update_setting(key: str, body: SettingUpdate):
    """Set a setting value."""
    db.set_setting(key, body.value)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Screening
# ---------------------------------------------------------------------------

@app.get("/api/screening/{market}")
def run_screening(market: str):
    """Run stock screening. market: jp or us."""
    if market == "jp":
        tickers = cfg.DEFAULT_WATCHLIST_JP
    elif market == "us":
        tickers = cfg.DEFAULT_WATCHLIST_US
    else:
        raise HTTPException(status_code=400, detail="market must be 'jp' or 'us'")

    cache_key = f"screening:{market}"

    def _fetch():
        df = analysis.screen_stocks(tickers)
        records = _df_to_records(df)
        return _add_jp_name(records)

    return _cached(cache_key, 600, _fetch)


# ---------------------------------------------------------------------------
# Config / metadata endpoints
# ---------------------------------------------------------------------------

@app.get("/api/config/indices")
def get_available_indices():
    """Return all available indices."""
    return cfg.AVAILABLE_INDICES


@app.get("/api/config/tickers")
def get_ticker_names():
    """Return ticker -> JP name mapping."""
    return cfg.TICKER_NAME_JP


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
