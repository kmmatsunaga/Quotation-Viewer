import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/stocks/volume-anomaly?tickers=7203,6501,...
 *
 * 各銘柄について、当日出来高 vs 過去20営業日平均 を計算して
 * 「いつもと違う」動きをスコア化する。
 *
 * 異常スコア = 当日出来高 / 過去20営業日平均
 *   - 1.0 = 平均通り
 *   - 2.0 = 普段の2倍
 *   - 5.0+ = 異常に多い (大材料発表等の可能性)
 *
 * 価格モメンタムも併記:
 *   - ROC5 (5日変化率) : 短期勢い
 *   - changePct: 当日変化率
 */

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export interface VolumeAnomalyEntry {
  ticker: string;
  name: string;
  currentPrice: number;
  changePct: number;
  todayVolume: number;
  avgVolume20d: number;
  volumeRatio: number;          // 当日 / 過去20日平均
  roc5: number;                  // 5日価格変化率 %
  roc20: number;                 // 20日価格変化率 %
  // ヒートレベル: 0=normal, 1=elevated, 2=high, 3=extreme
  heatLevel: 0 | 1 | 2 | 3;
  // 解釈タグ
  signals: string[];
}

function calcHeatLevel(volRatio: number, changePct: number): 0 | 1 | 2 | 3 {
  if (volRatio >= 5 || (volRatio >= 3 && Math.abs(changePct) >= 5)) return 3;
  if (volRatio >= 3 || (volRatio >= 2 && Math.abs(changePct) >= 3)) return 2;
  if (volRatio >= 2 || (volRatio >= 1.5 && Math.abs(changePct) >= 2)) return 1;
  return 0;
}

function buildSignals(e: Omit<VolumeAnomalyEntry, "signals">): string[] {
  const signals: string[] = [];
  if (e.volumeRatio >= 5) signals.push("🔥 出来高急増");
  else if (e.volumeRatio >= 3) signals.push("📈 出来高増");
  else if (e.volumeRatio >= 2) signals.push("やや出来高増");

  if (e.changePct >= 5) signals.push("🚀 急騰");
  else if (e.changePct >= 3) signals.push("上昇");
  else if (e.changePct <= -5) signals.push("📉 急落");
  else if (e.changePct <= -3) signals.push("下落");

  // 出来高増 × 値動きあり → 注目
  if (e.volumeRatio >= 2 && e.changePct >= 3) signals.push("⚡ 上昇に出来高伴う");
  if (e.volumeRatio >= 2 && e.changePct <= -3) signals.push("⚡ 下落に出来高伴う");

  // 出来高あるのに価格動かない → セリクラ / 仕込み？
  if (e.volumeRatio >= 3 && Math.abs(e.changePct) < 1) {
    signals.push("🤔 出来高あるが値動き乏しい (大口の仕込み?)");
  }

  // 中長期モメンタム
  if (e.roc20 >= 10 && e.roc5 >= 5) signals.push("中期上昇加速中");
  if (e.roc20 <= -10 && e.roc5 <= -5) signals.push("中期下降加速中");
  if (e.roc20 >= 10 && e.roc5 <= -3) signals.push("利食い? (中期上だが短期下)");
  if (e.roc20 <= -10 && e.roc5 >= 3) signals.push("反発? (中期下だが短期上)");

  return signals;
}

export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers") ?? "";
  const tickers = tickersParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 30);

  if (tickers.length === 0) {
    return NextResponse.json({ anomalies: [] });
  }

  try {
    const results = await Promise.allSettled(
      tickers.map(async (ticker) => {
        const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
        const yfTicker = isJP ? `${ticker}.T` : ticker;

        // 30営業日分のデータを取得
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          yfTicker
        )}?range=2mo&interval=1d`;
        const res = await fetch(url, {
          headers: YF_HEADERS,
          next: { revalidate: 60 },
        });
        if (!res.ok) return null;
        const json = await res.json();
        const result = json.chart?.result?.[0];
        if (!result) return null;

        const meta = result.meta;
        const closes = (result.indicators?.quote?.[0]?.close ?? []) as (number | null)[];
        const volumes = (result.indicators?.quote?.[0]?.volume ?? []) as (number | null)[];

        // 有効データのみ
        const validData: { close: number; volume: number }[] = [];
        for (let i = 0; i < closes.length; i++) {
          if (closes[i] != null && volumes[i] != null) {
            validData.push({ close: closes[i] as number, volume: volumes[i] as number });
          }
        }
        if (validData.length < 6) return null;

        const today = validData[validData.length - 1];
        const yesterday = validData[validData.length - 2];

        // 過去20営業日の平均出来高 (当日除く)
        const past20 = validData.slice(-21, -1);
        const avgVolume20d = past20.length > 0
          ? past20.reduce((s, d) => s + d.volume, 0) / past20.length
          : today.volume;

        const todayVolume = today.volume;
        const volumeRatio = avgVolume20d > 0 ? todayVolume / avgVolume20d : 0;

        const currentPrice = today.close;
        const prevClose = yesterday.close;
        const changePct = prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0;

        // ROC計算
        const close5 = validData[validData.length - 6]?.close ?? currentPrice;
        const close20 = validData[validData.length - 21]?.close ?? currentPrice;
        const roc5 = close5 > 0 ? ((currentPrice - close5) / close5) * 100 : 0;
        const roc20 = close20 > 0 ? ((currentPrice - close20) / close20) * 100 : 0;

        const base = {
          ticker,
          name: (meta.shortName ?? meta.longName ?? ticker) as string,
          currentPrice: Math.round(currentPrice * 100) / 100,
          changePct: Math.round(changePct * 100) / 100,
          todayVolume,
          avgVolume20d: Math.round(avgVolume20d),
          volumeRatio: Math.round(volumeRatio * 100) / 100,
          roc5: Math.round(roc5 * 100) / 100,
          roc20: Math.round(roc20 * 100) / 100,
          heatLevel: calcHeatLevel(volumeRatio, changePct),
        };

        const entry: VolumeAnomalyEntry = {
          ...base,
          signals: buildSignals(base),
        };
        return entry;
      })
    );

    const anomalies = results
      .filter((r): r is PromiseFulfilledResult<VolumeAnomalyEntry> => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value)
      .sort((a, b) => b.volumeRatio - a.volumeRatio);

    return NextResponse.json({ anomalies });
  } catch (err) {
    console.error("Volume anomaly error:", err);
    return NextResponse.json({ anomalies: [], error: "Failed" }, { status: 500 });
  }
}
