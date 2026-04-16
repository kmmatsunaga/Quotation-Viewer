"""テクニカル分析・おすすめ銘柄スコアリング

判定ロジック:
- ゴールデンクロス / デッドクロス（SMA）
- RSI（売られすぎ / 買われすぎ）
- MACD シグナルクロス
- 出来高急増

これらを総合スコア化して「おすすめ度」を算出する。
"""
import pandas as pd
import ta as ta_lib

from config import TECHNICAL


def add_technical_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """DataFrame にテクニカル指標を追加する。"""
    if df.empty or len(df) < TECHNICAL["sma_long"]:
        return df

    cfg = TECHNICAL
    close = df["Close"]
    volume = df["Volume"]

    # 移動平均線
    df["SMA_short"] = ta_lib.trend.sma_indicator(close, window=cfg["sma_short"])
    df["SMA_mid"] = ta_lib.trend.sma_indicator(close, window=cfg["sma_mid"])
    df["SMA_long"] = ta_lib.trend.sma_indicator(close, window=cfg["sma_long"])

    # RSI
    df["RSI"] = ta_lib.momentum.rsi(close, window=cfg["rsi_period"])

    # MACD
    macd = ta_lib.trend.MACD(close,
                             window_fast=cfg["macd_fast"],
                             window_slow=cfg["macd_slow"],
                             window_sign=cfg["macd_signal"])
    df["MACD"] = macd.macd()
    df["MACD_signal"] = macd.macd_signal()
    df["MACD_hist"] = macd.macd_diff()

    # ボリンジャーバンド
    bb = ta_lib.volatility.BollingerBands(close, window=20, window_dev=2)
    df["BB_upper"] = bb.bollinger_hband()
    df["BB_lower"] = bb.bollinger_lband()

    # 出来高移動平均
    df["Volume_SMA20"] = ta_lib.trend.sma_indicator(volume.astype(float), window=20)

    return df


def calculate_score(df: pd.DataFrame) -> dict:
    """テクニカル指標からおすすめスコアを算出する。

    Returns:
        {
            "score": 0-100,
            "signals": [{"name": str, "value": str, "bullish": bool}, ...],
            "recommendation": "強い買い" | "買い" | "中立" | "売り" | "強い売り"
        }
    """
    if df.empty or len(df) < TECHNICAL["sma_long"]:
        return {"score": 50, "signals": [], "recommendation": "データ不足"}

    cfg = TECHNICAL
    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) >= 2 else latest

    score = 50  # 中立スタート
    signals = []

    # --- 1. ゴールデンクロス / デッドクロス ---
    if pd.notna(latest.get("SMA_short")) and pd.notna(latest.get("SMA_mid")):
        short_now = latest["SMA_short"]
        mid_now = latest["SMA_mid"]
        short_prev = prev.get("SMA_short", short_now)
        mid_prev = prev.get("SMA_mid", mid_now)

        if short_prev <= mid_prev and short_now > mid_now:
            score += 15
            signals.append({"name": "ゴールデンクロス", "value": "SMA5 > SMA25", "bullish": True})
        elif short_prev >= mid_prev and short_now < mid_now:
            score -= 15
            signals.append({"name": "デッドクロス", "value": "SMA5 < SMA25", "bullish": False})
        elif short_now > mid_now:
            score += 5
            signals.append({"name": "短期上昇トレンド", "value": f"SMA5={short_now:.0f}", "bullish": True})
        else:
            score -= 5
            signals.append({"name": "短期下降トレンド", "value": f"SMA5={short_now:.0f}", "bullish": False})

    # --- 2. RSI ---
    rsi = latest.get("RSI")
    if pd.notna(rsi):
        if rsi < cfg["rsi_oversold"]:
            score += 15
            signals.append({"name": "RSI 売られすぎ", "value": f"{rsi:.1f}", "bullish": True})
        elif rsi > cfg["rsi_overbought"]:
            score -= 15
            signals.append({"name": "RSI 買われすぎ", "value": f"{rsi:.1f}", "bullish": False})
        elif rsi < 45:
            score += 5
            signals.append({"name": "RSI やや低め", "value": f"{rsi:.1f}", "bullish": True})
        elif rsi > 55:
            score -= 5
            signals.append({"name": "RSI やや高め", "value": f"{rsi:.1f}", "bullish": False})
        else:
            signals.append({"name": "RSI 中立", "value": f"{rsi:.1f}", "bullish": True})

    # --- 3. MACD ---
    if "MACD" in latest.index and "MACD_signal" in latest.index:
        macd_val = latest["MACD"]
        signal_val = latest["MACD_signal"]
        macd_prev = prev.get("MACD", macd_val)
        signal_prev = prev.get("MACD_signal", signal_val)

        if pd.notna(macd_val) and pd.notna(signal_val):
            if macd_prev <= signal_prev and macd_val > signal_val:
                score += 15
                signals.append({"name": "MACD 買いシグナル", "value": "クロス上抜け", "bullish": True})
            elif macd_prev >= signal_prev and macd_val < signal_val:
                score -= 15
                signals.append({"name": "MACD 売りシグナル", "value": "クロス下抜け", "bullish": False})
            elif macd_val > signal_val:
                score += 5
                signals.append({"name": "MACD 上位", "value": f"{macd_val:.2f}", "bullish": True})
            else:
                score -= 5
                signals.append({"name": "MACD 下位", "value": f"{macd_val:.2f}", "bullish": False})

    # --- 4. 出来高急増 ---
    vol = latest.get("Volume", 0)
    vol_avg = latest.get("Volume_SMA20", 0)
    if vol_avg and vol_avg > 0:
        vol_ratio = vol / vol_avg
        if vol_ratio > 2.0:
            score += 10
            signals.append({"name": "出来高急増", "value": f"{vol_ratio:.1f}倍", "bullish": True})
        elif vol_ratio > 1.5:
            score += 5
            signals.append({"name": "出来高増加", "value": f"{vol_ratio:.1f}倍", "bullish": True})

    # --- 5. トレンド位置 ---
    if pd.notna(latest.get("SMA_long")):
        if latest["Close"] > latest["SMA_long"]:
            score += 5
            signals.append({"name": "長期上昇トレンド", "value": "75日線の上", "bullish": True})
        else:
            score -= 5
            signals.append({"name": "長期下降トレンド", "value": "75日線の下", "bullish": False})

    # スコアを 0-100 に制限
    score = max(0, min(100, score))

    # レコメンデーション
    if score >= 80:
        rec = "強い買い"
    elif score >= 60:
        rec = "買い"
    elif score >= 40:
        rec = "中立"
    elif score >= 20:
        rec = "売り"
    else:
        rec = "強い売り"

    return {"score": score, "signals": signals, "recommendation": rec}


def screen_stocks(tickers: list[str]) -> pd.DataFrame:
    """複数銘柄をスクリーニングしておすすめ度でソートする。"""
    from data_fetcher import fetch_stock_history, fetch_stock_info

    results = []
    for ticker in tickers:
        try:
            info = fetch_stock_info(ticker)
            df = fetch_stock_history(ticker, period="6mo")
            if df.empty:
                continue
            df = add_technical_indicators(df)
            scoring = calculate_score(df)
            results.append({
                "ticker": ticker,
                "name": info.get("name", ticker),
                "price": info.get("current_price", 0),
                "score": scoring["score"],
                "recommendation": scoring["recommendation"],
                "signals_count_bull": sum(1 for s in scoring["signals"] if s["bullish"]),
                "signals_count_bear": sum(1 for s in scoring["signals"] if not s["bullish"]),
            })
        except Exception:
            continue

    df_result = pd.DataFrame(results)
    if not df_result.empty:
        df_result = df_result.sort_values("score", ascending=False).reset_index(drop=True)
    return df_result
