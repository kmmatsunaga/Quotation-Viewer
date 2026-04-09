"""投資ダッシュボード - メインアプリ（楽天証券風レイアウト）

起動方法: streamlit run app.py
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from datetime import datetime

from config import DEFAULT_WATCHLIST_JP, DEFAULT_WATCHLIST_US, TECHNICAL
from data_fetcher import (
    fetch_stock_history, fetch_stock_info, fetch_multiple_prices, fetch_jnx_night,
)
from portfolio_db import (
    add_holding, update_holding, delete_holding, get_all_holdings,
    get_holding_by_id,
    add_to_watchlist, remove_from_watchlist, get_watchlist,
    add_alert, get_all_alerts, delete_alert, toggle_alert_active,
)
from analysis import add_technical_indicators, calculate_score, screen_stocks
from notifier import check_and_notify_alerts, send_line_push

# ============================================================
# ページ設定
# ============================================================
st.set_page_config(page_title="投資ダッシュボード", page_icon="$", layout="wide", initial_sidebar_state="expanded")

# ============================================================
# 楽天証券風CSS
# ============================================================
st.markdown("""
<style>
    /* === ベース === */
    .stApp { background-color: #f5f5f5; }

    /* === ヘッダーバー（楽天風: 白背景 + 赤アクセント） === */
    .top-bar {
        background: #ffffff; border-bottom: 3px solid #bf0000;
        padding: 10px 20px; margin: -20px -20px 16px -20px;
        display: flex; align-items: center; gap: 16px;
    }
    .top-bar .logo { font-size: 20px; font-weight: 800; color: #bf0000; }
    .top-bar .nav-item { font-size: 13px; color: #333; padding: 6px 12px; cursor: pointer; border-radius: 4px; }
    .top-bar .nav-item:hover { background: #f0f0f0; }

    /* === 資産サマリー（楽天風: 白カード + 赤/緑損益） === */
    .asset-summary {
        background: #ffffff; border: 1px solid #ddd; border-radius: 4px;
        padding: 20px; margin-bottom: 16px;
    }
    .asset-summary .summary-title {
        font-size: 13px; color: #666; border-bottom: 2px solid #bf0000;
        padding-bottom: 6px; margin-bottom: 12px; font-weight: 600;
    }
    .asset-row { display: flex; gap: 24px; flex-wrap: wrap; }
    .asset-item { flex: 1; min-width: 150px; }
    .asset-item .a-label { font-size: 11px; color: #888; margin-bottom: 2px; }
    .asset-item .a-value { font-size: 22px; font-weight: 700; color: #333; }
    .asset-item .a-value.plus { color: #d32f2f; }
    .asset-item .a-value.minus { color: #1565c0; }
    .asset-item .a-sub { font-size: 12px; color: #888; }

    /* === 指数バー（楽天風: 横並びコンパクト） === */
    .index-bar {
        background: #ffffff; border: 1px solid #ddd; border-radius: 4px;
        padding: 10px 16px; margin-bottom: 16px;
        display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    }
    .index-item { display: flex; align-items: baseline; gap: 8px; }
    .index-item .i-name { font-size: 11px; color: #666; font-weight: 600; }
    .index-item .i-price { font-size: 14px; font-weight: 700; color: #333; }
    .index-item .i-change { font-size: 11px; font-weight: 600; }
    .index-item .i-change.up { color: #d32f2f; }
    .index-item .i-change.down { color: #1565c0; }

    /* === 保有銘柄テーブル（楽天風） === */
    .holdings-table {
        background: #ffffff; border: 1px solid #ddd; border-radius: 4px;
        margin-bottom: 16px; overflow-x: auto;
    }
    .holdings-table .table-title {
        font-size: 13px; color: #333; font-weight: 600;
        padding: 10px 16px; border-bottom: 2px solid #bf0000;
        background: #fafafa;
    }
    .ht-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .ht-table thead th {
        background: #f7f7f7; color: #666; font-weight: 600; font-size: 11px;
        padding: 8px 12px; text-align: right; border-bottom: 1px solid #ddd;
        white-space: nowrap;
    }
    .ht-table thead th:first-child { text-align: left; }
    .ht-table thead th:nth-child(2) { text-align: left; }
    .ht-table tbody td {
        padding: 10px 12px; text-align: right; border-bottom: 1px solid #eee;
        color: #333;
    }
    .ht-table tbody td:first-child { text-align: left; color: #1565c0; font-weight: 600; }
    .ht-table tbody td:nth-child(2) { text-align: left; }
    .ht-table tbody tr:hover { background: #f0f7ff; }
    .ht-table .plus { color: #d32f2f; }
    .ht-table .minus { color: #1565c0; }
    .ht-table tfoot td {
        padding: 10px 12px; text-align: right; border-top: 2px solid #ddd;
        font-weight: 700; background: #fafafa; color: #333;
    }

    /* === 銘柄カード（マーケット概況） === */
    .market-card {
        background: #ffffff; border: 1px solid #ddd; border-radius: 4px;
        margin-bottom: 16px;
    }
    .market-card .mc-title {
        font-size: 13px; color: #333; font-weight: 600;
        padding: 10px 16px; border-bottom: 2px solid #bf0000;
        background: #fafafa;
    }
    .mc-row {
        display: flex; align-items: center;
        padding: 8px 16px; border-bottom: 1px solid #f0f0f0;
    }
    .mc-row:last-child { border-bottom: none; }
    .mc-row:hover { background: #f0f7ff; }
    .mc-row .mc-code { width: 70px; font-size: 12px; color: #1565c0; font-weight: 600; }
    .mc-row .mc-name { flex: 1; font-size: 12px; color: #333; }
    .mc-row .mc-price { width: 100px; text-align: right; font-size: 13px; font-weight: 600; color: #333; }
    .mc-row .mc-change { width: 70px; text-align: right; font-size: 12px; font-weight: 600; }
    .mc-row .mc-change.up { color: #d32f2f; }
    .mc-row .mc-change.down { color: #1565c0; }

    /* === スコアバッジ === */
    .score-badge { display: inline-block; padding: 3px 12px; border-radius: 4px; font-weight: 700; font-size: 13px; }
    .score-high { background: #e8f5e9; color: #2e7d32; border: 1px solid #a5d6a7; }
    .score-mid { background: #fff8e1; color: #f57f17; border: 1px solid #ffe082; }
    .score-low { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }

    /* === おすすめカード === */
    .rec-row {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 16px; border-bottom: 1px solid #f0f0f0;
    }
    .rec-row:hover { background: #f0f7ff; }
    .rec-score-circle {
        width: 44px; height: 44px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 15px; flex-shrink: 0;
    }
    .rec-score-circle.high { background: #e8f5e9; color: #2e7d32; }
    .rec-score-circle.mid { background: #fff8e1; color: #f57f17; }
    .rec-score-circle.low { background: #ffebee; color: #c62828; }
    .rec-info { flex: 1; }
    .rec-info .rec-name { font-size: 13px; font-weight: 600; color: #333; }
    .rec-info .rec-ticker { font-size: 11px; color: #1565c0; }
    .rec-label { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 4px; }
    .rec-label.buy { background: #e8f5e9; color: #2e7d32; }
    .rec-label.hold { background: #fff8e1; color: #f57f17; }
    .rec-label.sell { background: #ffebee; color: #c62828; }

    /* === セクションヘッダー === */
    .section-hdr {
        font-size: 13px; font-weight: 600; color: #333;
        border-bottom: 2px solid #bf0000; padding-bottom: 6px;
        margin: 16px 0 10px;
    }

    /* === サイドバー（楽天風: 白背景） === */
    section[data-testid="stSidebar"] { background: #ffffff; border-right: 1px solid #ddd; }
    section[data-testid="stSidebar"] * { color: #333 !important; }
    section[data-testid="stSidebar"] h1 { color: #bf0000 !important; font-size: 18px !important; }
    section[data-testid="stSidebar"] button {
        background: #bf0000 !important; color: #ffffff !important;
        border: none !important; border-radius: 4px !important;
    }
    section[data-testid="stSidebar"] button:hover { background: #a00000 !important; }

    /* フォーム内ボタン */
    .stFormSubmitButton button {
        background: #bf0000 !important; color: #ffffff !important; border: none !important;
    }
    .stFormSubmitButton button:hover { background: #a00000 !important; }

    /* === メモカード === */
    .memo-card {
        background: #fffde7; border: 1px solid #fff59d; border-radius: 4px;
        padding: 12px 16px; margin: 8px 0; font-size: 13px;
    }
    .memo-card .memo-ticker { font-weight: 700; color: #1565c0; font-size: 12px; }
    .memo-card .memo-text { color: #333; margin-top: 4px; line-height: 1.5; }
    .memo-card .memo-date { color: #999; font-size: 10px; margin-top: 4px; }

    /* === アラートテーブル === */
    .alert-row {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 16px; border-bottom: 1px solid #f0f0f0;
    }
    .alert-row:hover { background: #f0f7ff; }
    .alert-icon { font-size: 20px; flex-shrink: 0; }
    .alert-info { flex: 1; }
    .alert-info .alert-name { font-size: 13px; font-weight: 600; color: #333; }
    .alert-info .alert-cond { font-size: 11px; color: #666; }
    .alert-status { font-size: 11px; padding: 3px 10px; border-radius: 12px; font-weight: 600; }
    .alert-status.active { background: #e8f5e9; color: #2e7d32; }
    .alert-status.triggered { background: #fff8e1; color: #f57f17; }
    .alert-status.inactive { background: #f5f5f5; color: #999; }

    /* === LINE設定 === */
    .line-status {
        background: #ffffff; border: 1px solid #ddd; border-radius: 4px;
        padding: 12px 16px; margin-bottom: 16px;
    }
    .line-status .line-ok { color: #2e7d32; font-weight: 600; }
    .line-status .line-ng { color: #c62828; font-weight: 600; }

    /* === お気に入りギャラリー (Notion風) === */
    .fav-gallery {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px; margin-top: 12px;
    }
    .fav-card {
        background: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px;
        overflow: hidden; transition: box-shadow 0.2s, transform 0.15s;
        cursor: default;
    }
    .fav-card:hover {
        box-shadow: 0 4px 16px rgba(0,0,0,0.10);
        transform: translateY(-2px);
    }
    .fav-card .fav-chart-area {
        width: 100%; height: 140px; background: #fafafa;
        border-bottom: 1px solid #f0f0f0; position: relative; overflow: hidden;
    }
    .fav-card .fav-chart-area svg { width: 100%; height: 100%; }
    .fav-card .fav-body { padding: 12px 14px; }
    .fav-card .fav-ticker {
        font-size: 11px; color: #1565c0; font-weight: 700;
        letter-spacing: 0.5px;
    }
    .fav-card .fav-name {
        font-size: 14px; font-weight: 600; color: #222;
        margin: 2px 0 8px; line-height: 1.3;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fav-card .fav-row {
        display: flex; justify-content: space-between; align-items: baseline;
    }
    .fav-card .fav-price {
        font-size: 20px; font-weight: 700; color: #333;
    }
    .fav-card .fav-change {
        font-size: 13px; font-weight: 700; padding: 2px 8px;
        border-radius: 4px;
    }
    .fav-card .fav-change.up { background: #fce4ec; color: #c62828; }
    .fav-card .fav-change.down { background: #e3f2fd; color: #1565c0; }
    .fav-card .fav-meta {
        margin-top: 8px; display: flex; gap: 12px; font-size: 11px; color: #999;
    }
    .fav-card .fav-score-bar {
        margin-top: 8px; height: 4px; border-radius: 2px;
        background: #eee; overflow: hidden;
    }
    .fav-card .fav-score-fill {
        height: 100%; border-radius: 2px; transition: width 0.3s;
    }
    .fav-empty {
        text-align: center; padding: 60px 20px; color: #999;
        background: #fff; border: 2px dashed #ddd; border-radius: 8px;
    }
    .fav-empty .fav-empty-icon { font-size: 40px; margin-bottom: 12px; }
    .fav-empty .fav-empty-text { font-size: 14px; }
</style>
""", unsafe_allow_html=True)


# ============================================================
# サイドバー
# ============================================================
st.sidebar.title("投資ダッシュボード")
now = datetime.now()
st.sidebar.caption(f"最終更新: {now.strftime('%Y-%m-%d %H:%M')}")

page = st.sidebar.radio(
    "ページ",
    ["マーケット概況", "お気に入り", "銘柄分析", "ポートフォリオ", "価格アラート", "おすすめ銘柄", "JNX 夜間取引"],
    index=0,
)

st.sidebar.markdown("---")
st.sidebar.markdown("**データソース**")
st.sidebar.caption("yfinance (東証 / NYSE / NASDAQ)")
st.sidebar.caption("JNX 公開CSV (夜間PTS)")
st.sidebar.caption("立花証券API (準備中)")

if st.sidebar.button("データ更新", use_container_width=True):
    st.cache_data.clear()
    st.rerun()


# ============================================================
# キャッシュ
# ============================================================
@st.cache_data(ttl=300)
def cached_prices(tickers: tuple) -> pd.DataFrame:
    return fetch_multiple_prices(list(tickers))

@st.cache_data(ttl=300)
def cached_history(ticker: str, period: str) -> pd.DataFrame:
    return fetch_stock_history(ticker, period=period)

@st.cache_data(ttl=600)
def cached_screening(tickers: tuple) -> pd.DataFrame:
    return screen_stocks(list(tickers))

@st.cache_data(ttl=3600)
def cached_jnx(date: str | None) -> pd.DataFrame:
    return fetch_jnx_night(date)

@st.cache_data(ttl=300)
def cached_index_prices() -> dict:
    indices = {"^N225": "日経平均", "1306.T": "TOPIX ETF", "^GSPC": "S&P 500",
               "^IXIC": "NASDAQ", "^DJI": "NYダウ", "USDJPY=X": "ドル円"}
    result = {}
    for ticker, name in indices.items():
        try:
            info = fetch_stock_info(ticker)
            price = info.get("current_price") or info.get("previous_close") or 0
            prev = info.get("previous_close") or 0
            change = ((price - prev) / prev * 100) if prev else 0
            result[name] = {"price": price, "change": change}
        except Exception:
            result[name] = {"price": 0, "change": 0}
    return result


# ============================================================
# ヘルパー: 指数バー（横並び）
# ============================================================
def _render_index_bar():
    indices = cached_index_prices()
    items_html = ""
    for name, data in indices.items():
        price = data["price"]
        change = data["change"]
        val = f"{price:,.2f}" if name == "ドル円" else (f"{price:,.0f}" if price >= 10000 else f"{price:,.2f}")
        cls = "up" if change >= 0 else "down"
        arrow = "+" if change >= 0 else ""
        items_html += f"""
        <div class="index-item">
            <span class="i-name">{name}</span>
            <span class="i-price">{val}</span>
            <span class="i-change {cls}">{arrow}{change:.2f}%</span>
        </div>"""
    st.markdown(f'<div class="index-bar">{items_html}</div>', unsafe_allow_html=True)


# ============================================================
# チャート描画
# ============================================================
def draw_candlestick_chart(df: pd.DataFrame, ticker: str, show_indicators: bool = True):
    if df.empty:
        st.warning("データがありません。")
        return
    if show_indicators:
        df = add_technical_indicators(df)

    fig = make_subplots(rows=3, cols=1, shared_xaxes=True, vertical_spacing=0.03,
        row_heights=[0.6, 0.2, 0.2], subplot_titles=[f"{ticker}", "出来高", "RSI"])

    fig.add_trace(go.Candlestick(
        x=df.index, open=df["Open"], high=df["High"], low=df["Low"], close=df["Close"],
        name="OHLC", increasing_line_color="#d32f2f", decreasing_line_color="#1565c0",
        increasing_fillcolor="#d32f2f", decreasing_fillcolor="#1565c0",
    ), row=1, col=1)

    if show_indicators:
        for col_name, label, color in [
            ("SMA_short", f"SMA{TECHNICAL['sma_short']}", "#ff9800"),
            ("SMA_mid", f"SMA{TECHNICAL['sma_mid']}", "#4caf50"),
            ("SMA_long", f"SMA{TECHNICAL['sma_long']}", "#9c27b0"),
        ]:
            if col_name in df.columns:
                fig.add_trace(go.Scatter(x=df.index, y=df[col_name], name=label,
                    line=dict(color=color, width=1.2)), row=1, col=1)
        for c in ["BB_upper", "BB_lower"]:
            if c in df.columns:
                fig.add_trace(go.Scatter(x=df.index, y=df[c], name=c,
                    line=dict(color="#bdbdbd", width=0.8, dash="dot")), row=1, col=1)

    vol_colors = ["#1565c0" if df["Close"].iloc[i] < df["Open"].iloc[i]
                  else "#d32f2f" for i in range(len(df))]
    fig.add_trace(go.Bar(x=df.index, y=df["Volume"], name="出来高",
        marker_color=vol_colors, opacity=0.6), row=2, col=1)

    if "RSI" in df.columns:
        fig.add_trace(go.Scatter(x=df.index, y=df["RSI"], name="RSI",
            line=dict(color="#7b1fa2", width=1.5)), row=3, col=1)
        fig.add_hline(y=TECHNICAL["rsi_oversold"], line_dash="dash", line_color="#4caf50", line_width=0.8, row=3, col=1)
        fig.add_hline(y=TECHNICAL["rsi_overbought"], line_dash="dash", line_color="#d32f2f", line_width=0.8, row=3, col=1)

    fig.update_layout(height=600, xaxis_rangeslider_visible=False, template="plotly_white",
        paper_bgcolor="#ffffff", plot_bgcolor="#ffffff", showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1, font=dict(size=10)),
        margin=dict(l=50, r=20, t=40, b=20))
    fig.update_xaxes(rangebreaks=[dict(bounds=["sat", "mon"])], gridcolor="#f0f0f0")
    fig.update_yaxes(gridcolor="#f0f0f0")
    st.plotly_chart(fig, use_container_width=True)


# ============================================================
# ページ: マーケット概況
# ============================================================
def page_market_overview():
    with st.spinner("指数を取得中..."):
        _render_index_bar()

    col_jp, col_us = st.columns(2)
    with col_jp:
        with st.spinner("東証データ取得中..."):
            jp_prices = cached_prices(tuple(DEFAULT_WATCHLIST_JP))
        if not jp_prices.empty:
            rows = ""
            for _, row in jp_prices.iterrows():
                t = row["ticker"].replace(".T", "")
                p = f"¥{row['price']:,.0f}" if row['currency'] == 'JPY' else f"{row['price']:,.2f}"
                c = row["change_pct"]
                cls = "up" if c >= 0 else "down"
                arr = "+" if c >= 0 else ""
                rows += f'<div class="mc-row"><span class="mc-code">{t}</span><span class="mc-name">{row["name"]}</span><span class="mc-price">{p}</span><span class="mc-change {cls}">{arr}{c:.2f}%</span></div>'
            st.markdown(f'<div class="market-card"><div class="mc-title">日本株式 (東証)</div>{rows}</div>', unsafe_allow_html=True)

    with col_us:
        with st.spinner("米国市場データ取得中..."):
            us_prices = cached_prices(tuple(DEFAULT_WATCHLIST_US))
        if not us_prices.empty:
            rows = ""
            for _, row in us_prices.iterrows():
                c = row["change_pct"]
                cls = "up" if c >= 0 else "down"
                arr = "+" if c >= 0 else ""
                rows += f'<div class="mc-row"><span class="mc-code">{row["ticker"]}</span><span class="mc-name">{row["name"]}</span><span class="mc-price">${row["price"]:,.2f}</span><span class="mc-change {cls}">{arr}{c:.2f}%</span></div>'
            st.markdown(f'<div class="market-card"><div class="mc-title">米国株式 (NYSE / NASDAQ)</div>{rows}</div>', unsafe_allow_html=True)


# ============================================================
# ページ: お気に入り（Notionギャラリー風）
# ============================================================
def _make_sparkline_svg(prices: list[float], width: int = 280, height: int = 140) -> str:
    """終値リストからSVGスパークラインを生成する。"""
    if not prices or len(prices) < 2:
        return ""
    mn, mx = min(prices), max(prices)
    rng = mx - mn if mx != mn else 1
    n = len(prices)
    padding_x, padding_y = 0, 10

    points = []
    for i, p in enumerate(prices):
        x = padding_x + (width - 2 * padding_x) * i / (n - 1)
        y = padding_y + (height - 2 * padding_y) * (1 - (p - mn) / rng)
        points.append(f"{x:.1f},{y:.1f}")

    polyline = " ".join(points)
    # 上昇なら赤系、下降なら青系
    is_up = prices[-1] >= prices[0]
    stroke = "#d32f2f" if is_up else "#1565c0"
    fill_color = "#d32f2f" if is_up else "#1565c0"

    # グラデーション塗りつぶし用のポリゴン
    fill_points = f"0,{height} " + polyline + f" {width},{height}"

    return f"""<svg viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="grad_{id(prices)}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="{fill_color}" stop-opacity="0.15"/>
                <stop offset="100%" stop-color="{fill_color}" stop-opacity="0.02"/>
            </linearGradient>
        </defs>
        <polygon points="{fill_points}" fill="url(#grad_{id(prices)})"/>
        <polyline points="{polyline}" fill="none" stroke="{stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>"""


def page_favorites():
    _render_index_bar()

    watchlist = get_watchlist()

    # --- 登録フォーム ---
    with st.expander("お気に入り銘柄を追加する", expanded=False):
        with st.form("add_fav_form", clear_on_submit=True):
            fc1, fc2, fc3 = st.columns([2, 2, 1])
            with fc1:
                fav_ticker = st.text_input("銘柄コード *", placeholder="7203.T / AAPL",
                    help="東証: 7203.T / 米国: AAPL")
            with fc2:
                fav_name = st.text_input("銘柄名", placeholder="空欄で自動取得")
            with fc3:
                fav_market = st.selectbox("市場", ["東証", "NYSE", "NASDAQ"])
            fav_submitted = st.form_submit_button("追加する", use_container_width=True, type="primary")
            if fav_submitted:
                if not fav_ticker:
                    st.error("銘柄コードは必須です。")
                else:
                    name = fav_name
                    if not name:
                        try:
                            name = fetch_stock_info(fav_ticker).get("name", fav_ticker)
                        except Exception:
                            name = fav_ticker
                    market_map = {"東証": "TSE", "NYSE": "NYSE", "NASDAQ": "NASDAQ"}
                    add_to_watchlist(fav_ticker, name, market_map[fav_market])
                    st.success(f"{name} ({fav_ticker}) をお気に入りに追加しました。")
                    st.cache_data.clear()
                    st.rerun()

    if watchlist.empty:
        st.markdown("""
        <div class="fav-empty">
            <div class="fav-empty-icon">&#9734;</div>
            <div class="fav-empty-text">お気に入り銘柄がまだありません。<br>上のフォームから追加してください。</div>
        </div>""", unsafe_allow_html=True)
        return

    # --- データ取得 ---
    tickers = watchlist["ticker"].tolist()
    with st.spinner("お気に入り銘柄のデータを取得中..."):
        prices_df = cached_prices(tuple(tickers))

    # 各銘柄の3ヶ月チャートデータをキャッシュ取得
    @st.cache_data(ttl=600)
    def _get_sparkline_data(ticker: str) -> list[float]:
        try:
            df = fetch_stock_history(ticker, period="3mo")
            if df.empty:
                return []
            return df["Close"].dropna().tolist()
        except Exception:
            return []

    # --- ギャラリーHTML生成 ---
    cards_html = ""
    for _, w in watchlist.iterrows():
        ticker = w["ticker"]
        name = w["name"] or ticker

        # 価格データ
        price_row = prices_df[prices_df["ticker"] == ticker] if not prices_df.empty else pd.DataFrame()
        current_price = price_row["price"].iloc[0] if not price_row.empty else 0
        change_pct = price_row["change_pct"].iloc[0] if not price_row.empty else 0
        currency = price_row["currency"].iloc[0] if not price_row.empty and "currency" in price_row.columns else "JPY"

        # 価格フォーマット
        if currency == "JPY":
            price_str = f"&yen;{current_price:,.0f}"
        else:
            price_str = f"${current_price:,.2f}"

        chg_cls = "up" if change_pct >= 0 else "down"
        chg_sign = "+" if change_pct >= 0 else ""

        # スパークライン
        spark_data = _get_sparkline_data(ticker)
        svg = _make_sparkline_svg(spark_data)

        # テクニカルスコア（簡易）
        try:
            df_hist = cached_history(ticker, "6mo")
            if not df_hist.empty:
                df_ta = add_technical_indicators(df_hist.copy())
                scoring = calculate_score(df_ta)
                score = scoring["score"]
                rec = scoring["recommendation"]
            else:
                score, rec = 50, "-"
        except Exception:
            score, rec = 50, "-"

        if score >= 60:
            bar_color = "#4caf50"
        elif score >= 40:
            bar_color = "#ff9800"
        else:
            bar_color = "#f44336"

        cards_html += f"""
        <div class="fav-card">
            <div class="fav-chart-area">{svg}</div>
            <div class="fav-body">
                <div class="fav-ticker">{ticker}</div>
                <div class="fav-name" title="{name}">{name}</div>
                <div class="fav-row">
                    <span class="fav-price">{price_str}</span>
                    <span class="fav-change {chg_cls}">{chg_sign}{change_pct:.2f}%</span>
                </div>
                <div class="fav-meta">
                    <span>スコア: {score}/100</span>
                    <span>{rec}</span>
                </div>
                <div class="fav-score-bar">
                    <div class="fav-score-fill" style="width:{score}%;background:{bar_color};"></div>
                </div>
            </div>
        </div>"""

    st.markdown(f'<div class="fav-gallery">{cards_html}</div>', unsafe_allow_html=True)

    # --- 削除UI ---
    with st.expander("お気に入りを管理"):
        fav_options = {f"{w['ticker']} - {w['name']}": w['ticker'] for _, w in watchlist.iterrows()}
        selected_fav = st.selectbox("削除する銘柄", list(fav_options.keys()), key="sel_fav_del")
        if st.button("お気に入りから削除", key="btn_fav_del"):
            remove_from_watchlist(fav_options[selected_fav])
            st.success(f"{selected_fav} を削除しました。")
            st.cache_data.clear()
            st.rerun()


# ============================================================
# ページ: 銘柄分析
# ============================================================
def page_stock_analysis():
    _render_index_bar()
    col1, col2 = st.columns([3, 1])
    with col1:
        ticker = st.text_input("銘柄コード", value="7203.T", help="例: 7203.T (トヨタ), AAPL (Apple)")
    with col2:
        period = st.selectbox("期間", ["1ヶ月", "3ヶ月", "6ヶ月", "1年", "2年", "5年"], index=2)

    period_map = {"1ヶ月": "1mo", "3ヶ月": "3mo", "6ヶ月": "6mo", "1年": "1y", "2年": "2y", "5年": "5y"}
    if not ticker:
        return

    with st.spinner(f"{ticker} のデータを取得中..."):
        df = cached_history(ticker, period_map[period])
    if df.empty:
        st.error(f"{ticker} のデータが見つかりません。")
        return

    df_with_ta = add_technical_indicators(df.copy())
    scoring = calculate_score(df_with_ta)
    score = scoring["score"]

    # 銘柄情報サマリー
    info = fetch_stock_info(ticker)
    pe = info.get("pe_ratio")
    dy = info.get("dividend_yield")
    style = "score-high" if score >= 60 else ("score-mid" if score >= 40 else "score-low")

    summary_html = f"""
    <div class="asset-summary">
        <div class="summary-title">銘柄分析: {info.get('name', ticker)} ({ticker})</div>
        <div class="asset-row">
            <div class="asset-item"><div class="a-label">テクニカルスコア</div><div><span class="score-badge {style}">{score}/100</span></div></div>
            <div class="asset-item"><div class="a-label">判定</div><div class="a-value">{scoring['recommendation']}</div></div>
            <div class="asset-item"><div class="a-label">PER</div><div class="a-value">{f'{pe:.1f}倍' if pe else 'N/A'}</div></div>
            <div class="asset-item"><div class="a-label">配当利回り</div><div class="a-value">{f'{dy*100:.2f}%' if dy else 'N/A'}</div></div>
        </div>
    </div>"""
    st.markdown(summary_html, unsafe_allow_html=True)

    if scoring["signals"]:
        with st.expander("テクニカルシグナル", expanded=True):
            sig_cols = st.columns(3)
            for i, sig in enumerate(scoring["signals"]):
                with sig_cols[i % 3]:
                    icon = "+" if sig["bullish"] else "-"
                    color = "green" if sig["bullish"] else "red"
                    st.markdown(f":{color}[{icon} {sig['name']}]  \n`{sig['value']}`")

    draw_candlestick_chart(df, ticker)


# ============================================================
# ページ: ポートフォリオ（楽天証券風）
# ============================================================
def page_portfolio():
    _render_index_bar()

    # --- 保有銘柄の登録フォーム ---
    with st.expander("保有銘柄を登録する", expanded=False):
        with st.form("add_holding_form", clear_on_submit=True):
            row1 = st.columns([2, 3, 1])
            with row1[0]:
                h_ticker = st.text_input("銘柄コード *", placeholder="7203.T",
                    help="東証: 銘柄番号.T（例: 7203.T）、米国: ティッカー（例: AAPL）")
            with row1[1]:
                h_name = st.text_input("銘柄名", placeholder="トヨタ自動車（空欄で自動取得）")
            with row1[2]:
                h_market = st.selectbox("市場", ["東証", "NYSE", "NASDAQ"])

            row2 = st.columns([1, 1, 1])
            with row2[0]:
                h_shares = st.number_input("保有株数 *", min_value=0.0, step=100.0, value=0.0)
            with row2[1]:
                h_cost = st.number_input("取得単価（円） *", min_value=0.0, step=1.0, value=0.0)
            with row2[2]:
                h_memo = st.text_input("メモ", placeholder="NISA / 特定口座 など")

            submitted = st.form_submit_button("登録する", use_container_width=True, type="primary")
            if submitted:
                if not h_ticker or h_shares <= 0 or h_cost <= 0:
                    st.error("銘柄コード・保有株数・取得単価は必須です。")
                else:
                    name = h_name
                    if not name:
                        try:
                            name = fetch_stock_info(h_ticker).get("name", h_ticker)
                        except Exception:
                            name = h_ticker
                    market_map = {"東証": "TSE", "NYSE": "NYSE", "NASDAQ": "NASDAQ"}
                    add_holding(h_ticker, name, h_shares, h_cost, market_map[h_market], h_memo)
                    st.success(f"{name} ({h_ticker}) {h_shares:.0f}株 x ¥{h_cost:,.0f} を登録しました。")
                    st.cache_data.clear()
                    st.rerun()

    # --- 保有銘柄一覧 ---
    holdings = get_all_holdings()
    if holdings.empty:
        st.info("保有銘柄がまだ登録されていません。上のフォームから追加してください。")
        return

    tickers = holdings["ticker"].tolist()
    with st.spinner("現在価格を取得中..."):
        current_prices = cached_prices(tuple(tickers))

    total_cost = 0
    total_value = 0
    table_rows_html = ""

    for _, h in holdings.iterrows():
        price_row = current_prices[current_prices["ticker"] == h["ticker"]]
        current_price = price_row["price"].iloc[0] if not price_row.empty else 0
        change_pct = price_row["change_pct"].iloc[0] if not price_row.empty else 0
        market_value = current_price * h["shares"]
        cost_basis = h["avg_cost"] * h["shares"]
        pnl = market_value - cost_basis
        pnl_pct = (pnl / cost_basis * 100) if cost_basis > 0 else 0
        total_cost += cost_basis
        total_value += market_value

        pnl_cls = "plus" if pnl >= 0 else "minus"
        chg_cls = "plus" if change_pct >= 0 else "minus"
        pnl_sign = "+" if pnl >= 0 else ""
        chg_sign = "+" if change_pct >= 0 else ""
        memo_str = f' <span style="color:#999;font-size:10px;">({h["memo"]})</span>' if h.get("memo") else ""

        table_rows_html += f"""<tr>
            <td>{h['ticker']}</td>
            <td>{h['name']}{memo_str}</td>
            <td>{h['shares']:,.0f}</td>
            <td>¥{h['avg_cost']:,.0f}</td>
            <td>¥{current_price:,.0f}</td>
            <td class="{chg_cls}">{chg_sign}{change_pct:.2f}%</td>
            <td>¥{market_value:,.0f}</td>
            <td class="{pnl_cls}">{pnl_sign}¥{pnl:,.0f}</td>
            <td class="{pnl_cls}">{pnl_sign}{pnl_pct:.2f}%</td>
        </tr>"""

    total_pnl = total_value - total_cost
    total_pnl_pct = (total_pnl / total_cost * 100) if total_cost > 0 else 0
    total_pnl_cls = "plus" if total_pnl >= 0 else "minus"
    total_sign = "+" if total_pnl >= 0 else ""

    # 資産サマリー（楽天風）
    summary_html = f"""
    <div class="asset-summary">
        <div class="summary-title">資産状況</div>
        <div class="asset-row">
            <div class="asset-item">
                <div class="a-label">投資額合計</div>
                <div class="a-value">¥{total_cost:,.0f}</div>
            </div>
            <div class="asset-item">
                <div class="a-label">時価評価額合計</div>
                <div class="a-value">¥{total_value:,.0f}</div>
            </div>
            <div class="asset-item">
                <div class="a-label">評価損益額</div>
                <div class="a-value {total_pnl_cls}">{total_sign}¥{total_pnl:,.0f}</div>
                <div class="a-sub">{total_sign}{total_pnl_pct:.2f}%</div>
            </div>
            <div class="asset-item">
                <div class="a-label">保有銘柄数</div>
                <div class="a-value">{len(holdings)}</div>
            </div>
        </div>
    </div>"""
    st.markdown(summary_html, unsafe_allow_html=True)

    # 保有銘柄テーブル（楽天風）
    table_html = f"""
    <div class="holdings-table">
        <div class="table-title">保有商品一覧</div>
        <table class="ht-table">
            <thead>
                <tr>
                    <th>銘柄コード</th>
                    <th>銘柄名</th>
                    <th>保有数量</th>
                    <th>平均取得価額</th>
                    <th>時価</th>
                    <th>前日比</th>
                    <th>時価評価額</th>
                    <th>評価損益額</th>
                    <th>損益率</th>
                </tr>
            </thead>
            <tbody>
                {table_rows_html}
            </tbody>
            <tfoot>
                <tr>
                    <td colspan="3">合計 ({len(holdings)}銘柄)</td>
                    <td>¥{total_cost:,.0f}</td>
                    <td></td>
                    <td></td>
                    <td>¥{total_value:,.0f}</td>
                    <td class="{total_pnl_cls}">{total_sign}¥{total_pnl:,.0f}</td>
                    <td class="{total_pnl_cls}">{total_sign}{total_pnl_pct:.2f}%</td>
                </tr>
            </tfoot>
        </table>
    </div>"""
    st.markdown(table_html, unsafe_allow_html=True)

    # --- メモ一覧（メモがある銘柄だけ表示） ---
    memos = holdings[holdings["memo"].astype(str).str.strip() != ""]
    if not memos.empty:
        st.markdown('<div class="section-hdr">銘柄メモ</div>', unsafe_allow_html=True)
        for _, m in memos.iterrows():
            st.markdown(f"""
            <div class="memo-card">
                <span class="memo-ticker">{m['ticker']} {m['name']}</span>
                <div class="memo-text">{m['memo']}</div>
                <div class="memo-date">更新: {m['updated_at'][:10]}</div>
            </div>""", unsafe_allow_html=True)

    # --- 編集・削除・メモ編集 ---
    with st.expander("保有銘柄を編集・削除"):
        # 銘柄選択用リスト作成
        holding_options = {f"[ID:{h['id']}] {h['ticker']} {h['name']}": h['id']
                          for _, h in holdings.iterrows()}

        tab_edit, tab_memo, tab_delete = st.tabs(["株数・単価変更", "メモ編集", "銘柄削除"])

        with tab_edit:
            selected_edit = st.selectbox("編集する銘柄", list(holding_options.keys()), key="sel_edit")
            edit_id = holding_options.get(selected_edit, 0)
            if edit_id:
                current = get_holding_by_id(edit_id)
                if current:
                    st.caption(f"現在: {current['shares']:,.0f}株 x ¥{current['avg_cost']:,.0f}")
                    new_shares = st.number_input("新しい株数", min_value=0.0, step=100.0,
                                                  value=current["shares"], key="esh")
                    new_cost = st.number_input("新しい取得単価", min_value=0.0, step=1.0,
                                               value=current["avg_cost"], key="eco")
                    if st.button("更新する", key="btn_update"):
                        update_holding(edit_id, shares=new_shares, avg_cost=new_cost)
                        st.success("更新しました。")
                        st.cache_data.clear()
                        st.rerun()

        with tab_memo:
            selected_memo = st.selectbox("銘柄を選択", list(holding_options.keys()), key="sel_memo")
            memo_id = holding_options.get(selected_memo, 0)
            if memo_id:
                current = get_holding_by_id(memo_id)
                if current:
                    current_memo = current.get("memo", "") or ""
                    new_memo = st.text_area("メモ", value=current_memo,
                                            placeholder="NISA口座 / 配当狙い / 決算後に検討 など",
                                            height=120, key="memo_area")
                    if st.button("メモを保存", key="btn_memo"):
                        update_holding(memo_id, memo=new_memo)
                        st.success("メモを保存しました。")
                        st.cache_data.clear()
                        st.rerun()

        with tab_delete:
            selected_del = st.selectbox("削除する銘柄", list(holding_options.keys()), key="sel_del")
            del_id = holding_options.get(selected_del, 0)
            if del_id:
                current = get_holding_by_id(del_id)
                if current:
                    st.warning(f"⚠️ {current['ticker']} {current['name']} ({current['shares']:,.0f}株) を削除します。")
                    if st.button("削除する", key="btn_delete"):
                        delete_holding(del_id)
                        st.success("削除しました。")
                        st.cache_data.clear()
                        st.rerun()


# ============================================================
# ページ: おすすめ銘柄
# ============================================================
def page_recommendations():
    _render_index_bar()
    st.caption("SMA / RSI / MACD / 出来高 によるテクニカルスコアリング。投資判断は自己責任でお願いします。")

    tab_jp, tab_us = st.tabs(["日本株", "米国株"])
    with tab_jp:
        with st.spinner("日本株をスクリーニング中..."):
            df_jp = cached_screening(tuple(DEFAULT_WATCHLIST_JP))
        if not df_jp.empty: _display_recommendations(df_jp)
        else: st.warning("データ取得に失敗しました。")
    with tab_us:
        with st.spinner("米国株をスクリーニング中..."):
            df_us = cached_screening(tuple(DEFAULT_WATCHLIST_US))
        if not df_us.empty: _display_recommendations(df_us)
        else: st.warning("データ取得に失敗しました。")

def _display_recommendations(df: pd.DataFrame):
    html = '<div class="market-card"><div class="mc-title">スクリーニング結果</div>'
    for _, row in df.iterrows():
        score = row["score"]
        if score >= 60: sc, lc, lt = "high", "buy", "買い"
        elif score >= 40: sc, lc, lt = "mid", "hold", "様子見"
        else: sc, lc, lt = "low", "sell", "売り"
        bull, bear = row.get("signals_count_bull", 0), row.get("signals_count_bear", 0)
        html += f"""<div class="rec-row">
            <div class="rec-score-circle {sc}">{score}</div>
            <div class="rec-info"><div class="rec-name">{row['name']}</div><div class="rec-ticker">{row['ticker']}</div></div>
            <div style="font-size:12px;color:#666;">+{bull} / -{bear}</div>
            <div class="rec-label {lc}">{lt}</div>
        </div>"""
    html += '</div>'
    st.markdown(html, unsafe_allow_html=True)


# ============================================================
# ページ: 価格アラート
# ============================================================
def page_alerts():
    _render_index_bar()

    from config import LINE_API

    # --- LINE 接続状況 ---
    token_ok = bool(LINE_API["channel_access_token"])
    uid_ok = bool(LINE_API["user_id"])
    if token_ok and uid_ok:
        line_html = '<span class="line-ok">✅ LINE 通知: 設定済み</span>'
    else:
        missing = []
        if not token_ok: missing.append("チャネルアクセストークン")
        if not uid_ok: missing.append("ユーザーID")
        line_html = f'<span class="line-ng">❌ LINE 通知: 未設定（{", ".join(missing)}）</span>'
    st.markdown(f'<div class="line-status">{line_html}</div>', unsafe_allow_html=True)

    if not (token_ok and uid_ok):
        with st.expander("LINE 通知の設定方法"):
            st.markdown("""
1. [LINE Developers](https://developers.line.biz/) にログイン
2. **プロバイダー** → **Messaging API チャネル** を作成
3. チャネル設定画面で **チャネルアクセストークン（長期）** を発行
4. ボットのQRコードを読み取り **友だち追加**
5. 環境変数に設定:
```
LINE_CHANNEL_ACCESS_TOKEN=<トークン>
LINE_USER_ID=<ユーザーID>
```
6. ユーザーIDは LINE Developers のチャネル基本設定 > 「あなたのユーザーID」で確認

`.env` ファイルに記述して `python-dotenv` で読み込むか、システム環境変数に設定してください。
            """)

    # --- テスト送信 ---
    if token_ok and uid_ok:
        if st.button("📬 LINE テスト送信"):
            ok = send_line_push("🔔 投資ダッシュボードからのテスト通知です。\nアラート機能が正常に動作しています。")
            if ok:
                st.success("LINE にテスト通知を送信しました！")
            else:
                st.error("送信に失敗しました。トークンとユーザーIDを確認してください。")

    st.markdown("---")

    # --- アラート登録フォーム ---
    with st.expander("新しいアラートを設定する", expanded=False):
        with st.form("add_alert_form", clear_on_submit=True):
            col1, col2, col3 = st.columns([2, 1, 1])
            with col1:
                a_ticker = st.text_input("銘柄コード *", placeholder="7203.T",
                    help="東証: 7203.T / 米国: AAPL")
            with col2:
                a_condition = st.selectbox("条件", ["以上になったら", "以下になったら"])
            with col3:
                a_price = st.number_input("目標価格 *", min_value=0.0, step=1.0, value=0.0)

            submitted = st.form_submit_button("アラートを設定", use_container_width=True, type="primary")
            if submitted:
                if not a_ticker or a_price <= 0:
                    st.error("銘柄コードと目標価格は必須です。")
                else:
                    try:
                        name = fetch_stock_info(a_ticker).get("name", a_ticker)
                    except Exception:
                        name = a_ticker
                    cond = "above" if "以上" in a_condition else "below"
                    add_alert(a_ticker, name, cond, a_price)
                    cond_text = "以上" if cond == "above" else "以下"
                    st.success(f"✅ {name} ({a_ticker}) が ¥{a_price:,.0f} {cond_text}でアラートを設定しました。")
                    st.rerun()

    # --- アラート手動チェック ---
    col_check, col_spacer = st.columns([1, 2])
    with col_check:
        if st.button("🔍 今すぐアラートチェック", use_container_width=True):
            with st.spinner("アラートをチェック中..."):
                triggered = check_and_notify_alerts()
            if triggered:
                for t in triggered:
                    cond_text = "以上" if t["condition"] == "above" else "以下"
                    line_str = "（LINE送信済み）" if t["line_sent"] else "（LINE未設定）"
                    st.success(f"🔔 {t['name']} ({t['ticker']}) が ¥{t['current_price']:,.0f} に到達！"
                               f"（条件: ¥{t['target_price']:,.0f} {cond_text}）{line_str}")
            else:
                st.info("現在、条件を満たしたアラートはありません。")

    # --- アラート一覧 ---
    alerts = get_all_alerts()
    if alerts.empty:
        st.info("アラートがまだ設定されていません。上のフォームから追加してください。")
        return

    # 有効なアラート
    active_alerts = alerts[alerts["active"] == 1]
    triggered_alerts = alerts[alerts["triggered"] == 1]
    inactive_alerts = alerts[(alerts["active"] == 0) & (alerts["triggered"] == 0)]

    if not active_alerts.empty:
        html = '<div class="market-card"><div class="mc-title">🔔 有効なアラート</div>'
        for _, a in active_alerts.iterrows():
            cond_text = f"¥{a['target_price']:,.0f} 以上" if a["condition"] == "above" else f"¥{a['target_price']:,.0f} 以下"
            html += f"""<div class="alert-row">
                <div class="alert-icon">🔔</div>
                <div class="alert-info">
                    <div class="alert-name">{a['name']} ({a['ticker']})</div>
                    <div class="alert-cond">条件: {cond_text}</div>
                </div>
                <span class="alert-status active">監視中</span>
            </div>"""
        html += '</div>'
        st.markdown(html, unsafe_allow_html=True)

    if not triggered_alerts.empty:
        html = '<div class="market-card"><div class="mc-title">✅ 発火済みアラート</div>'
        for _, a in triggered_alerts.iterrows():
            cond_text = f"¥{a['target_price']:,.0f} 以上" if a["condition"] == "above" else f"¥{a['target_price']:,.0f} 以下"
            t_at = a["triggered_at"][:16] if a["triggered_at"] else "不明"
            html += f"""<div class="alert-row">
                <div class="alert-icon">✅</div>
                <div class="alert-info">
                    <div class="alert-name">{a['name']} ({a['ticker']})</div>
                    <div class="alert-cond">条件: {cond_text} → 発火: {t_at}</div>
                </div>
                <span class="alert-status triggered">通知済み</span>
            </div>"""
        html += '</div>'
        st.markdown(html, unsafe_allow_html=True)

    # アラート削除
    with st.expander("アラートを管理"):
        alert_options = {f"[ID:{a['id']}] {a['ticker']} {a['name']} ({'監視中' if a['active'] else '停止'})": a['id']
                        for _, a in alerts.iterrows()}
        selected_alert = st.selectbox("アラートを選択", list(alert_options.keys()))
        alert_id = alert_options.get(selected_alert, 0)
        col_a, col_b = st.columns(2)
        with col_a:
            if st.button("🗑️ 削除", key="btn_del_alert"):
                delete_alert(alert_id)
                st.success("アラートを削除しました。")
                st.rerun()
        with col_b:
            alert_row = alerts[alerts["id"] == alert_id]
            if not alert_row.empty:
                is_active = alert_row.iloc[0]["active"] == 1
                btn_label = "⏸️ 停止する" if is_active else "▶️ 再開する"
                if st.button(btn_label, key="btn_toggle_alert"):
                    toggle_alert_active(alert_id, not is_active)
                    st.success("更新しました。")
                    st.rerun()


# ============================================================
# ページ: JNX 夜間取引
# ============================================================
def page_jnx_night():
    _render_index_bar()
    st.caption("ジャパンネクスト証券 夜間PTS 公開CSVデータ")
    date_input = st.date_input("日付", value=None, help="空欄 = 前営業日を自動推定")
    date_str = date_input.strftime("%Y-%m-%d") if date_input else None

    with st.spinner("JNX データ取得中..."):
        df_jnx = cached_jnx(date_str)
    if df_jnx.empty:
        st.warning("データなし。日付を変更してください（休場日・祝日はデータがありません）。")
    else:
        st.success(f"{len(df_jnx)} 件のデータを取得しました。")
        search = st.text_input("銘柄で絞り込み", placeholder="例: 7203")
        if search:
            mask = df_jnx.apply(lambda r: r.astype(str).str.contains(search, case=False).any(), axis=1)
            df_jnx = df_jnx[mask]
        st.dataframe(df_jnx, use_container_width=True, hide_index=True)


# ============================================================
# ルーティング
# ============================================================
{"マーケット概況": page_market_overview, "お気に入り": page_favorites,
 "銘柄分析": page_stock_analysis, "ポートフォリオ": page_portfolio,
 "価格アラート": page_alerts, "おすすめ銘柄": page_recommendations,
 "JNX 夜間取引": page_jnx_night}[page]()
