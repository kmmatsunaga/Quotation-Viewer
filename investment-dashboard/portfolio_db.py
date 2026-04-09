"""ポートフォリオ管理（SQLite）

手入力で保有銘柄を登録・更新・削除する。
"""
import sqlite3
from datetime import datetime

import pandas as pd

from config import DB_PATH


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """テーブルを作成する（初回のみ）。"""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS holdings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            shares REAL NOT NULL DEFAULT 0,
            avg_cost REAL NOT NULL DEFAULT 0,
            market TEXT NOT NULL DEFAULT 'TSE',
            memo TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '',
            market TEXT NOT NULL DEFAULT 'TSE',
            added_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS price_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            condition TEXT NOT NULL DEFAULT 'above',
            target_price REAL NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            triggered INTEGER NOT NULL DEFAULT 0,
            triggered_at TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    """)
    conn.close()


# ---- Holdings (保有銘柄) ----

def add_holding(ticker: str, name: str, shares: float, avg_cost: float,
                market: str = "TSE", memo: str = "") -> int:
    """保有銘柄を追加する。"""
    now = datetime.now().isoformat()
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO holdings (ticker, name, shares, avg_cost, market, memo, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ticker, name, shares, avg_cost, market, memo, now, now),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def update_holding(holding_id: int, shares: float | None = None,
                   avg_cost: float | None = None, memo: str | None = None):
    """保有銘柄を更新する。"""
    conn = _get_conn()
    now = datetime.now().isoformat()
    if shares is not None:
        conn.execute("UPDATE holdings SET shares=?, updated_at=? WHERE id=?",
                     (shares, now, holding_id))
    if avg_cost is not None:
        conn.execute("UPDATE holdings SET avg_cost=?, updated_at=? WHERE id=?",
                     (avg_cost, now, holding_id))
    if memo is not None:
        conn.execute("UPDATE holdings SET memo=?, updated_at=? WHERE id=?",
                     (memo, now, holding_id))
    conn.commit()
    conn.close()


def delete_holding(holding_id: int):
    """保有銘柄を削除する。"""
    conn = _get_conn()
    conn.execute("DELETE FROM holdings WHERE id=?", (holding_id,))
    conn.commit()
    conn.close()


def get_all_holdings() -> pd.DataFrame:
    """全保有銘柄を取得する。"""
    conn = _get_conn()
    df = pd.read_sql_query("SELECT * FROM holdings ORDER BY market, ticker", conn)
    conn.close()
    return df


# ---- Watchlist (ウォッチリスト) ----

def add_to_watchlist(ticker: str, name: str = "", market: str = "TSE"):
    """ウォッチリストに銘柄を追加する。"""
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO watchlist (ticker, name, market, added_at) "
        "VALUES (?, ?, ?, ?)",
        (ticker, name, market, now),
    )
    conn.commit()
    conn.close()


def remove_from_watchlist(ticker: str):
    """ウォッチリストから銘柄を削除する。"""
    conn = _get_conn()
    conn.execute("DELETE FROM watchlist WHERE ticker=?", (ticker,))
    conn.commit()
    conn.close()


def get_watchlist() -> pd.DataFrame:
    """ウォッチリストの全銘柄を取得する。"""
    conn = _get_conn()
    df = pd.read_sql_query("SELECT * FROM watchlist ORDER BY market, ticker", conn)
    conn.close()
    return df


# ---- Price Alerts (価格アラート) ----

def add_alert(ticker: str, name: str, condition: str, target_price: float) -> int:
    """価格アラートを追加する。condition: 'above' or 'below'"""
    now = datetime.now().isoformat()
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO price_alerts (ticker, name, condition, target_price, active, triggered, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
        (ticker, name, condition, target_price, now, now),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def get_all_alerts(active_only: bool = False) -> pd.DataFrame:
    """全アラートを取得する。"""
    conn = _get_conn()
    query = "SELECT * FROM price_alerts"
    if active_only:
        query += " WHERE active = 1"
    query += " ORDER BY created_at DESC"
    df = pd.read_sql_query(query, conn)
    conn.close()
    return df


def update_alert_triggered(alert_id: int):
    """アラートを発火済みにする。"""
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        "UPDATE price_alerts SET triggered=1, active=0, triggered_at=?, updated_at=? WHERE id=?",
        (now, now, alert_id),
    )
    conn.commit()
    conn.close()


def toggle_alert_active(alert_id: int, active: bool):
    """アラートの有効/無効を切り替える。"""
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        "UPDATE price_alerts SET active=?, updated_at=? WHERE id=?",
        (1 if active else 0, now, alert_id),
    )
    conn.commit()
    conn.close()


def delete_alert(alert_id: int):
    """アラートを削除する。"""
    conn = _get_conn()
    conn.execute("DELETE FROM price_alerts WHERE id=?", (alert_id,))
    conn.commit()
    conn.close()


def get_holding_by_id(holding_id: int) -> dict | None:
    """IDで保有銘柄を1件取得する。"""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM holdings WHERE id=?", (holding_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    cols = ["id", "ticker", "name", "shares", "avg_cost", "market", "memo", "created_at", "updated_at"]
    return dict(zip(cols, row))


# 起動時にDB初期化
init_db()
