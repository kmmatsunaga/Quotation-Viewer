#!/usr/bin/env node
/**
 * Cavka MCP Server — Neo Tokyo Trading Terminal
 *
 * Claude Desktop / Claude Code から投資データにアクセスするための MCP サーバー。
 * Cavka (Vercel) の API をラップして以下のツールを提供:
 *
 *   1. get_stock_prices     — 複数銘柄の現在価格・前日比を取得
 *   2. get_stock_detail     — 個別銘柄の詳細（テクニカル指標付き）
 *   3. get_fundamentals     — ファンダメンタル指標（PER/PBR/ROE等）
 *   4. search_stocks        — 銘柄名・ティッカーで検索
 *   5. detect_patterns      — チャートパターン検出（日足・週足・月足）
 *   6. screen_stocks        — 5軸ファンダメンタルスクリーニング
 *   7. list_nikkei225       — 日経225構成銘柄一覧
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// ── Config ──────────────────────────────────────────────
const BASE_URL = process.env.CAVKA_BASE_URL ?? "https://quotation-viewer.vercel.app";
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";
const PORTFOLIO_EMAIL = process.env.CAVKA_USER_EMAIL ?? "make.some.noise6984@gmail.com";
// ── Helpers ─────────────────────────────────────────────
async function cavkaFetch(path) {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
        headers: { "User-Agent": "CavkaMCP/1.0" },
    });
    if (!res.ok) {
        throw new Error(`Cavka API error: ${res.status} ${res.statusText} — ${url}`);
    }
    return res.json();
}
async function cavkaAuthFetch(path) {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
        headers: {
            "User-Agent": "CavkaMCP/1.0",
            "x-api-key": MCP_API_KEY,
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Cavka API error: ${res.status} — ${body}`);
    }
    return res.json();
}
function fmt(n, digits = 2) {
    if (n == null)
        return "N/A";
    return n.toFixed(digits);
}
function fmtPct(n) {
    if (n == null)
        return "N/A";
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
}
function fmtLarge(n) {
    if (n == null)
        return "N/A";
    if (Math.abs(n) >= 1e12)
        return `${(n / 1e12).toFixed(2)}兆`;
    if (Math.abs(n) >= 1e8)
        return `${(n / 1e8).toFixed(1)}億`;
    if (Math.abs(n) >= 1e4)
        return `${(n / 1e4).toFixed(1)}万`;
    return n.toLocaleString();
}
// ── Nikkei 225 (embedded subset for tool) ───────────────
// We fetch from the screener — but for listing, we embed it here
// This avoids needing a separate API endpoint.
const NIKKEI225_URL = `${BASE_URL}/api/stocks/fundamentals`;
// ── MCP Server ──────────────────────────────────────────
const server = new McpServer({
    name: "cavka",
    version: "1.0.0",
    description: "Cavka — Neo Tokyo Trading Terminal: 日本株・米国株のリアルタイム株価、ファンダメンタル、テクニカルパターン、スクリーニング機能を提供します。",
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 1: get_stock_prices
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_stock_prices", "複数銘柄の現在価格・前日比・変動率を一括取得。日本株はティッカー(例:7203)、米国株はシンボル(例:AAPL)で指定。USD/JPY為替レートも同時に返す。", {
    tickers: z
        .string()
        .describe("カンマ区切りのティッカーリスト。例: '7203,4502,AAPL,MSFT'"),
}, async ({ tickers }) => {
    const data = await cavkaFetch(`/api/stocks/prices?tickers=${encodeURIComponent(tickers)}`);
    const lines = ["【株価情報】"];
    for (const [ticker, p] of Object.entries(data.prices)) {
        const arrow = p.change >= 0 ? "▲" : "▼";
        lines.push(`${ticker}: ${fmt(p.price)} ${p.currency}  ${arrow}${fmt(Math.abs(p.change))} (${fmtPct(p.changePct)})  前日終値: ${fmt(p.prevClose)}`);
    }
    if (data.usdJpy) {
        lines.push(`\nUSD/JPY: ${fmt(data.usdJpy)}`);
    }
    const missing = tickers
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t && !data.prices[t]);
    if (missing.length > 0) {
        lines.push(`\n※ データ取得不可: ${missing.join(", ")}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 2: get_stock_detail
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_stock_detail", "個別銘柄の詳細情報を取得。現在値、出来高、テクニカル指標（RSI, MACD, SMA, ボリンジャーバンド）を含む。", {
    ticker: z.string().describe("ティッカー。例: '7203' or 'AAPL'"),
    range: z
        .string()
        .optional()
        .describe("チャート期間。'1mo','3mo','6mo','1y','2y','5y' (デフォルト: 6mo)"),
}, async ({ ticker, range }) => {
    const r = range ?? "6mo";
    const d = await cavkaFetch(`/api/stock/${encodeURIComponent(ticker)}?range=${r}&interval=1d`);
    const arrow = d.change >= 0 ? "▲" : "▼";
    const ind = d.indicators;
    const lines = [
        `【${d.name} (${d.ticker})】`,
        `取引所: ${d.exchange}  通貨: ${d.currency}`,
        ``,
        `現在値: ${fmt(d.price)}  ${arrow}${fmt(Math.abs(d.change))} (${fmtPct(d.changePct)})`,
        `前日終値: ${fmt(d.prevClose)}  高値: ${fmt(d.dayHigh)}  安値: ${fmt(d.dayLow)}`,
        `出来高: ${d.volume?.toLocaleString() ?? "N/A"}`,
        ``,
        `── テクニカル指標 ──`,
        `RSI(14): ${fmt(ind.rsi, 1)}`,
        `MACD: ${fmt(ind.macd)}  Signal: ${fmt(ind.signal)}`,
        `SMA20: ${fmt(ind.sma20)}  SMA50: ${fmt(ind.sma50)}  SMA200: ${fmt(ind.sma200)}`,
        `BB上: ${fmt(ind.bbUpper)}  BB下: ${fmt(ind.bbLower)}`,
    ];
    // Add simple signals
    const signals = [];
    if (ind.rsi !== null) {
        if (ind.rsi >= 70)
            signals.push("RSI過熱（買われすぎ）");
        else if (ind.rsi <= 30)
            signals.push("RSI冷却（売られすぎ）");
    }
    if (ind.macd !== null && ind.signal !== null) {
        if (ind.macd > ind.signal)
            signals.push("MACDゴールデンクロス圏");
        else
            signals.push("MACDデッドクロス圏");
    }
    if (ind.sma20 !== null && ind.sma50 !== null && ind.sma200 !== null) {
        if (d.price > ind.sma20 && ind.sma20 > ind.sma50 && ind.sma50 > ind.sma200) {
            signals.push("完全上昇トレンド（P>SMA20>50>200）");
        }
        else if (d.price < ind.sma20 && ind.sma20 < ind.sma50 && ind.sma50 < ind.sma200) {
            signals.push("完全下降トレンド（P<SMA20<50<200）");
        }
    }
    if (ind.bbUpper !== null && ind.bbLower !== null) {
        if (d.price >= ind.bbUpper)
            signals.push("ボリンジャー上限タッチ");
        else if (d.price <= ind.bbLower)
            signals.push("ボリンジャー下限タッチ");
    }
    if (signals.length > 0) {
        lines.push(``, `── シグナル ──`);
        signals.forEach((s) => lines.push(`• ${s}`));
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 3: get_fundamentals
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_fundamentals", "複数銘柄のファンダメンタル指標を取得。PER, PBR, PEG, EV/EBITDA, ROE, ROA, 営業利益率, 純利益率, D/Eレシオ, 流動比率, ネットキャッシュ, 売上/利益成長率, EPS, FCF, 配当利回り, 配当性向, セクター情報を含む。最大20銘柄。", {
    tickers: z
        .string()
        .describe("カンマ区切りのティッカーリスト（最大20）。例: '7203,4502,6758'"),
}, async ({ tickers }) => {
    const data = await cavkaFetch(`/api/stocks/fundamentals?tickers=${encodeURIComponent(tickers)}`);
    const lines = [];
    for (const [, f] of Object.entries(data.fundamentals)) {
        lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, `【${f.name} (${f.ticker})】 ${f.sector} / ${f.industry}`, `市場: ${f.market}  株価: ${fmt(f.price)}  時価総額: ${fmtLarge(f.marketCap)}`, ``, `① バリュエーション:`, `  PER(実績): ${fmt(f.trailingPE, 1)}  PER(予想): ${fmt(f.forwardPE, 1)}`, `  PBR: ${fmt(f.pbr, 2)}  PEG: ${fmt(f.pegRatio, 2)}  EV/EBITDA: ${fmt(f.evToEbitda, 1)}`, ``, `② 収益性:`, `  ROE: ${fmt(f.roe, 1)}%  ROA: ${fmt(f.roa, 1)}%`, `  営業利益率: ${fmt(f.operatingMargin, 1)}%  純利益率: ${fmt(f.profitMargin, 1)}%`, ``, `③ 財務健全性:`, `  D/Eレシオ: ${fmt(f.debtToEquity, 1)}  流動比率: ${fmt(f.currentRatio, 2)}`, `  総現金: ${fmtLarge(f.totalCash)}  総負債: ${fmtLarge(f.totalDebt)}  ネットキャッシュ: ${fmtLarge(f.netCash)}`, ``, `④ 成長性:`, `  売上成長率: ${fmt(f.revenueGrowth, 1)}%  利益成長率: ${fmt(f.earningsGrowth, 1)}%`, `  EPS(実績): ${fmt(f.epsTrailing)}  EPS(予想): ${fmt(f.epsForward)}`, `  FCF: ${fmtLarge(f.freeCashFlow)}`, ``, `⑤ 株主還元:`, `  配当利回り: ${fmt(f.dividendYield, 2)}%  配当性向: ${fmt(f.payoutRatio, 1)}%`, `  1株配当: ${fmt(f.dividendRate)}`);
    }
    const requested = tickers.split(",").map((t) => t.trim()).filter(Boolean);
    const missing = requested.filter((t) => !data.fundamentals[t]);
    if (missing.length > 0) {
        lines.push(`\n※ データ取得不可: ${missing.join(", ")}`);
    }
    if (lines.length === 0) {
        lines.push("該当データがありません。");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 4: search_stocks
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("search_stocks", "銘柄名・ティッカー・キーワードで株式・ETF・投資信託を検索。日本語の会社名（例: 'トヨタ'）でも検索可能。", {
    query: z.string().describe("検索キーワード。例: 'トヨタ', 'Apple', '半導体'"),
}, async ({ query }) => {
    const results = await cavkaFetch(`/api/stocks/search?q=${encodeURIComponent(query)}`);
    if (results.length === 0) {
        return {
            content: [{ type: "text", text: `「${query}」に該当する銘柄が見つかりませんでした。` }],
        };
    }
    const typeLabel = {
        EQUITY: "株式",
        ETF: "ETF",
        MUTUALFUND: "投資信託",
    };
    const lines = [`【検索結果: "${query}"】`, ``];
    for (const r of results) {
        lines.push(`${r.ticker}  ${r.name}  [${r.market}] ${typeLabel[r.type] ?? r.type}  (${r.exchange})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 5: detect_patterns
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("detect_patterns", "複数銘柄のチャートパターンを検出。日足・週足・月足それぞれで移動平均線の配列、トレンド方向、パターン名（ゴールデンクロス、デッドクロス、三角持ち合い等）を判定。最大20銘柄。", {
    tickers: z
        .string()
        .describe("カンマ区切りのティッカーリスト（最大20）。例: '7203,6758,4502'"),
}, async ({ tickers }) => {
    const data = await cavkaFetch(`/api/stocks/patterns?tickers=${encodeURIComponent(tickers)}`);
    const lines = [];
    for (const [ticker, result] of Object.entries(data.patterns)) {
        lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【${result.name} (${ticker})】`);
        for (const tf of ["daily", "weekly", "monthly"]) {
            const tfLabel = { daily: "日足", weekly: "週足", monthly: "月足" }[tf];
            const pats = result.patterns[tf];
            if (pats.length === 0) {
                lines.push(`  ${tfLabel}: パターン未検出`);
            }
            else {
                for (const p of pats) {
                    const signalEmoji = p.signal === "buy" ? "🟢" : p.signal === "sell" ? "🔴" : "🟡";
                    lines.push(`  ${tfLabel}: ${signalEmoji} ${p.label} (${p.labelEn})  信頼度: ${(p.confidence * 100).toFixed(0)}%  強度: ${p.strength}/5`);
                    lines.push(`         方向: ${p.direction}  フェーズ: ${p.phase}`);
                    lines.push(`         ${p.description}`);
                }
            }
        }
        // Transitions
        if (result.transitions && result.transitions.length > 0) {
            lines.push(`  ── 遷移候補 ──`);
            for (const t of result.transitions) {
                lines.push(`  → ${t.label}  近接度: ${(t.proximity * 100).toFixed(0)}%`);
            }
        }
    }
    const requested = tickers.split(",").map((t) => t.trim()).filter(Boolean);
    const missing = requested.filter((t) => !data.patterns[t]);
    if (missing.length > 0) {
        lines.push(`\n※ データ取得不可: ${missing.join(", ")}`);
    }
    if (lines.length === 0) {
        lines.push("該当データがありません。");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 6: screen_stocks
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("screen_stocks", `ファンダメンタル条件で銘柄をスクリーニング。指定したティッカーリストに対してフィルタを適用し、条件を満たす銘柄を返す。
プリセット名を指定すると定型条件で検索可能:
  - "バフェット流バリュー": PER≤15, PBR≤1.5, ROE≥10%, 配当≥3%
  - "高配当・財務健全": 配当≥3.5%, 配当性向30-60%, D/E≤100
  - "成長株(GARP)": PEG≤1, 利益成長≥10%, ROE≥12%
  - "割安＋高収益": PER≤12, ROE≥12%, 営業利益率≥10%
  - "ネットキャッシュ割安": PBR≤1, ネットキャッシュ>0, PER≤15`, {
    tickers: z
        .string()
        .describe("スクリーニング対象のティッカーリスト（カンマ区切り、最大20）。例: '7203,4502,6758,8306,9984'"),
    preset: z
        .string()
        .optional()
        .describe("プリセット名。'バフェット流バリュー','高配当・財務健全','成長株(GARP)','割安＋高収益','ネットキャッシュ割安' のいずれか。個別条件と併用可。"),
    perMax: z.number().optional().describe("PER上限"),
    pbrMax: z.number().optional().describe("PBR上限"),
    pegMax: z.number().optional().describe("PEGレシオ上限"),
    evEbitdaMax: z.number().optional().describe("EV/EBITDA上限"),
    roeMin: z.number().optional().describe("ROE下限(%)"),
    operatingMarginMin: z.number().optional().describe("営業利益率下限(%)"),
    debtToEquityMax: z.number().optional().describe("D/Eレシオ上限"),
    currentRatioMin: z.number().optional().describe("流動比率下限"),
    netCashOnly: z.boolean().optional().describe("ネットキャッシュ企業のみ (true)"),
    revenueGrowthMin: z.number().optional().describe("売上成長率下限(%)"),
    earningsGrowthMin: z.number().optional().describe("利益成長率下限(%)"),
    dividendYieldMin: z.number().optional().describe("配当利回り下限(%)"),
    payoutRatioMin: z.number().optional().describe("配当性向下限(%)"),
    payoutRatioMax: z.number().optional().describe("配当性向上限(%)"),
}, async (params) => {
    // Resolve preset
    const presets = {
        "バフェット流バリュー": { perMax: 15, pbrMax: 1.5, roeMin: 10, dividendYieldMin: 3 },
        "高配当・財務健全": { dividendYieldMin: 3.5, payoutRatioMin: 30, payoutRatioMax: 60, debtToEquityMax: 100 },
        "成長株(GARP)": { pegMax: 1, earningsGrowthMin: 10, roeMin: 12 },
        "割安＋高収益": { perMax: 12, roeMin: 12, operatingMarginMin: 10 },
        "ネットキャッシュ割安": { pbrMax: 1, netCashOnly: true, perMax: 15 },
    };
    // Merge preset + explicit params
    const presetValues = params.preset ? presets[params.preset] ?? {} : {};
    const filters = { ...presetValues };
    const filterKeys = [
        "perMax", "pbrMax", "pegMax", "evEbitdaMax",
        "roeMin", "operatingMarginMin",
        "debtToEquityMax", "currentRatioMin", "netCashOnly",
        "revenueGrowthMin", "earningsGrowthMin",
        "dividendYieldMin", "payoutRatioMin", "payoutRatioMax",
    ];
    for (const k of filterKeys) {
        if (params[k] != null) {
            filters[k] = params[k];
        }
    }
    // Fetch fundamentals
    const data = await cavkaFetch(`/api/stocks/fundamentals?tickers=${encodeURIComponent(params.tickers)}`);
    // Apply filters
    const passing = [];
    for (const f of Object.values(data.fundamentals)) {
        let pass = true;
        if (filters.perMax != null && (f.trailingPE == null || f.trailingPE > filters.perMax))
            pass = false;
        if (filters.pbrMax != null && (f.pbr == null || f.pbr > filters.pbrMax))
            pass = false;
        if (filters.pegMax != null && (f.pegRatio == null || f.pegRatio > filters.pegMax))
            pass = false;
        if (filters.evEbitdaMax != null && (f.evToEbitda == null || f.evToEbitda > filters.evEbitdaMax))
            pass = false;
        if (filters.roeMin != null && (f.roe == null || f.roe < filters.roeMin))
            pass = false;
        if (filters.operatingMarginMin != null && (f.operatingMargin == null || f.operatingMargin < filters.operatingMarginMin))
            pass = false;
        if (filters.debtToEquityMax != null && (f.debtToEquity == null || f.debtToEquity > filters.debtToEquityMax))
            pass = false;
        if (filters.currentRatioMin != null && (f.currentRatio == null || f.currentRatio < filters.currentRatioMin))
            pass = false;
        if (filters.netCashOnly === true && (f.netCash == null || f.netCash <= 0))
            pass = false;
        if (filters.revenueGrowthMin != null && (f.revenueGrowth == null || f.revenueGrowth < filters.revenueGrowthMin))
            pass = false;
        if (filters.earningsGrowthMin != null && (f.earningsGrowth == null || f.earningsGrowth < filters.earningsGrowthMin))
            pass = false;
        if (filters.dividendYieldMin != null && (f.dividendYield == null || f.dividendYield < filters.dividendYieldMin))
            pass = false;
        if (filters.payoutRatioMin != null && (f.payoutRatio == null || f.payoutRatio < filters.payoutRatioMin))
            pass = false;
        if (filters.payoutRatioMax != null && (f.payoutRatio == null || f.payoutRatio > filters.payoutRatioMax))
            pass = false;
        if (pass)
            passing.push(f);
    }
    // Build output
    const lines = [];
    const activeFilters = [];
    if (params.preset)
        activeFilters.push(`プリセット: ${params.preset}`);
    if (filters.perMax != null)
        activeFilters.push(`PER≤${filters.perMax}`);
    if (filters.pbrMax != null)
        activeFilters.push(`PBR≤${filters.pbrMax}`);
    if (filters.pegMax != null)
        activeFilters.push(`PEG≤${filters.pegMax}`);
    if (filters.evEbitdaMax != null)
        activeFilters.push(`EV/EBITDA≤${filters.evEbitdaMax}`);
    if (filters.roeMin != null)
        activeFilters.push(`ROE≥${filters.roeMin}%`);
    if (filters.operatingMarginMin != null)
        activeFilters.push(`営業利益率≥${filters.operatingMarginMin}%`);
    if (filters.debtToEquityMax != null)
        activeFilters.push(`D/E≤${filters.debtToEquityMax}`);
    if (filters.currentRatioMin != null)
        activeFilters.push(`流動比率≥${filters.currentRatioMin}`);
    if (filters.netCashOnly)
        activeFilters.push(`ネットキャッシュのみ`);
    if (filters.revenueGrowthMin != null)
        activeFilters.push(`売上成長≥${filters.revenueGrowthMin}%`);
    if (filters.earningsGrowthMin != null)
        activeFilters.push(`利益成長≥${filters.earningsGrowthMin}%`);
    if (filters.dividendYieldMin != null)
        activeFilters.push(`配当利回り≥${filters.dividendYieldMin}%`);
    if (filters.payoutRatioMin != null)
        activeFilters.push(`配当性向≥${filters.payoutRatioMin}%`);
    if (filters.payoutRatioMax != null)
        activeFilters.push(`配当性向≤${filters.payoutRatioMax}%`);
    lines.push(`【スクリーニング結果】`);
    lines.push(`条件: ${activeFilters.join(", ")}`);
    lines.push(`対象: ${Object.keys(data.fundamentals).length}銘柄 → 該当: ${passing.length}銘柄`);
    if (passing.length === 0) {
        lines.push(`\n条件を満たす銘柄はありませんでした。条件を緩和してお試しください。`);
    }
    else {
        for (const f of passing) {
            lines.push(`\n──────────────────────────────`);
            lines.push(`${f.ticker} ${f.name}  [${f.sector}]`);
            lines.push(`  株価: ${fmt(f.price)}  時価総額: ${fmtLarge(f.marketCap)}`);
            lines.push(`  PER: ${fmt(f.trailingPE, 1)}  PBR: ${fmt(f.pbr, 2)}  PEG: ${fmt(f.pegRatio, 2)}  EV/EBITDA: ${fmt(f.evToEbitda, 1)}`);
            lines.push(`  ROE: ${fmt(f.roe, 1)}%  営業利益率: ${fmt(f.operatingMargin, 1)}%  D/E: ${fmt(f.debtToEquity, 1)}`);
            lines.push(`  売上成長: ${fmt(f.revenueGrowth, 1)}%  利益成長: ${fmt(f.earningsGrowth, 1)}%  FCF: ${fmtLarge(f.freeCashFlow)}`);
            lines.push(`  配当利回り: ${fmt(f.dividendYield, 2)}%  配当性向: ${fmt(f.payoutRatio, 1)}%`);
            lines.push(`  ネットキャッシュ: ${fmtLarge(f.netCash)}`);
        }
    }
    lines.push(`\n※ スクリーニング結果は買い推奨ではありません。投資判断は自己責任でお願いします。`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool 7: list_nikkei225
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Nikkei 225 tickers embedded for quick listing
const NIKKEI225_TICKERS = [
    { t: "4151", n: "協和キリン" }, { t: "4502", n: "武田薬品工業" }, { t: "4503", n: "アステラス製薬" },
    { t: "4506", n: "住友ファーマ" }, { t: "4507", n: "塩野義製薬" }, { t: "4519", n: "中外製薬" },
    { t: "4523", n: "エーザイ" }, { t: "4568", n: "第一三共" }, { t: "4578", n: "大塚ホールディングス" },
    { t: "285A", n: "キオクシアホールディングス" }, { t: "4062", n: "イビデン" }, { t: "6479", n: "ミネベアミツミ" },
    { t: "6501", n: "日立製作所" }, { t: "6503", n: "三菱電機" }, { t: "6504", n: "富士電機" },
    { t: "6506", n: "安川電機" }, { t: "6526", n: "ソシオネクスト" }, { t: "6645", n: "オムロン" },
    { t: "6701", n: "日本電気" }, { t: "6702", n: "富士通" }, { t: "6723", n: "ルネサスエレクトロニクス" },
    { t: "6724", n: "セイコーエプソン" }, { t: "6752", n: "パナソニック ホールディングス" },
    { t: "6758", n: "ソニーグループ" }, { t: "6762", n: "TDK" }, { t: "6770", n: "アルプスアルパイン" },
    { t: "6857", n: "アドバンテスト" }, { t: "6861", n: "キーエンス" }, { t: "6902", n: "デンソー" },
    { t: "6920", n: "レーザーテック" }, { t: "6952", n: "カシオ計算機" }, { t: "6954", n: "ファナック" },
    { t: "6971", n: "京セラ" }, { t: "6976", n: "太陽誘電" }, { t: "6981", n: "村田製作所" },
    { t: "7735", n: "SCREENホールディングス" }, { t: "7751", n: "キヤノン" }, { t: "7752", n: "リコー" },
    { t: "8035", n: "東京エレクトロン" }, { t: "6146", n: "ディスコ" },
    { t: "3382", n: "セブン&アイ・ホールディングス" }, { t: "8233", n: "高島屋" }, { t: "8252", n: "丸井グループ" },
    { t: "8267", n: "イオン" }, { t: "9983", n: "ファーストリテイリング" },
    { t: "2002", n: "日清製粉グループ本社" }, { t: "2269", n: "明治ホールディングス" },
    { t: "2282", n: "日本ハム" }, { t: "2501", n: "サッポロホールディングス" },
    { t: "2502", n: "アサヒグループホールディングス" }, { t: "2503", n: "キリンホールディングス" },
    { t: "2801", n: "キッコーマン" }, { t: "2802", n: "味の素" }, { t: "2871", n: "ニチレイ" },
    { t: "2914", n: "日本たばこ産業" },
    { t: "3086", n: "J.フロント リテイリング" }, { t: "3092", n: "ZOZO" }, { t: "3099", n: "三越伊勢丹ホールディングス" },
    { t: "3101", n: "東洋紡" }, { t: "3103", n: "ユニチカ" }, { t: "3105", n: "日清紡ホールディングス" },
    { t: "3401", n: "帝人" }, { t: "3402", n: "東レ" }, { t: "3407", n: "旭化成" },
    { t: "3436", n: "SUMCO" },
    { t: "3861", n: "王子ホールディングス" }, { t: "3863", n: "日本製紙" },
    { t: "4004", n: "レゾナック・ホールディングス" }, { t: "4005", n: "住友化学" },
    { t: "4021", n: "日産化学" }, { t: "4042", n: "東ソー" }, { t: "4043", n: "トクヤマ" },
    { t: "4061", n: "デンカ" }, { t: "4063", n: "信越化学工業" }, { t: "4183", n: "三井化学" },
    { t: "4188", n: "三菱ケミカルグループ" }, { t: "4208", n: "UBE" },
    { t: "4452", n: "花王" }, { t: "4631", n: "DIC" }, { t: "4901", n: "富士フイルムホールディングス" },
    { t: "4911", n: "資生堂" }, { t: "6988", n: "日東電工" },
    { t: "5019", n: "出光興産" }, { t: "5020", n: "ENEOSホールディングス" },
    { t: "5101", n: "横浜ゴム" }, { t: "5108", n: "ブリヂストン" },
    { t: "5201", n: "AGC" }, { t: "5202", n: "日本板硝子" }, { t: "5214", n: "日本電気硝子" },
    { t: "5233", n: "太平洋セメント" }, { t: "5301", n: "東海カーボン" }, { t: "5332", n: "TOTO" },
    { t: "5333", n: "日本ガイシ" }, { t: "5401", n: "日本製鉄" }, { t: "5406", n: "神戸製鋼所" },
    { t: "5411", n: "JFEホールディングス" }, { t: "3436", n: "SUMCO" },
    { t: "5541", n: "大平洋金属" }, { t: "5631", n: "日本製鋼所" },
    { t: "5703", n: "日本軽金属ホールディングス" }, { t: "5706", n: "三井金属鉱業" },
    { t: "5707", n: "東邦亜鉛" }, { t: "5711", n: "三菱マテリアル" },
    { t: "5713", n: "住友金属鉱山" }, { t: "5714", n: "DOWAホールディングス" },
    { t: "5801", n: "古河電気工業" }, { t: "5802", n: "住友電気工業" }, { t: "5803", n: "フジクラ" },
    { t: "5901", n: "東洋製罐グループホールディングス" },
    { t: "7004", n: "日立造船" }, { t: "7011", n: "三菱重工業" }, { t: "7012", n: "川崎重工業" },
    { t: "7013", n: "IHI" },
    { t: "7186", n: "コンコルディア・フィナンシャルグループ" },
    { t: "7201", n: "日産自動車" }, { t: "7202", n: "いすゞ自動車" }, { t: "7203", n: "トヨタ自動車" },
    { t: "7205", n: "日野自動車" }, { t: "7211", n: "三菱自動車工業" }, { t: "7261", n: "マツダ" },
    { t: "7267", n: "本田技研工業" }, { t: "7269", n: "スズキ" }, { t: "7270", n: "SUBARU" },
    { t: "7272", n: "ヤマハ発動機" },
    { t: "7731", n: "ニコン" }, { t: "7733", n: "オリンパス" }, { t: "7741", n: "HOYA" },
    { t: "7762", n: "シチズン時計" },
    { t: "7832", n: "バンダイナムコホールディングス" }, { t: "7911", n: "凸版印刷" },
    { t: "7912", n: "大日本印刷" }, { t: "7951", n: "ヤマハ" },
    { t: "1332", n: "ニッスイ" }, { t: "1333", n: "マルハニチロ" },
    { t: "1605", n: "INPEX" }, { t: "1721", n: "コムシスホールディングス" },
    { t: "1801", n: "大成建設" }, { t: "1802", n: "大林組" }, { t: "1803", n: "清水建設" },
    { t: "1808", n: "長谷工コーポレーション" }, { t: "1812", n: "鹿島建設" },
    { t: "1925", n: "大和ハウス工業" }, { t: "1928", n: "積水ハウス" },
    { t: "1963", n: "日揮ホールディングス" },
    { t: "2413", n: "エムスリー" },
    { t: "2432", n: "ディー・エヌ・エー" },
    { t: "3659", n: "ネクソン" },
    { t: "4324", n: "電通グループ" }, { t: "4385", n: "メルカリ" },
    { t: "4661", n: "オリエンタルランド" }, { t: "4689", n: "Zホールディングス" },
    { t: "4704", n: "トレンドマイクロ" }, { t: "4751", n: "サイバーエージェント" },
    { t: "4755", n: "楽天グループ" },
    { t: "6098", n: "リクルートホールディングス" }, { t: "6178", n: "日本郵政" },
    { t: "6301", n: "小松製作所" }, { t: "6302", n: "住友重機械工業" },
    { t: "6305", n: "日立建機" }, { t: "6326", n: "クボタ" },
    { t: "6361", n: "荏原製作所" }, { t: "6367", n: "ダイキン工業" },
    { t: "6471", n: "日本精工" }, { t: "6472", n: "NTN" },
    { t: "6473", n: "ジェイテクト" },
    { t: "7003", n: "三井E&S" },
    { t: "7014", n: "名村造船所" },
    { t: "8001", n: "伊藤忠商事" }, { t: "8002", n: "丸紅" },
    { t: "8015", n: "豊田通商" }, { t: "8031", n: "三井物産" },
    { t: "8053", n: "住友商事" }, { t: "8058", n: "三菱商事" },
    { t: "8303", n: "新生銀行" }, { t: "8306", n: "三菱UFJフィナンシャル・グループ" },
    { t: "8308", n: "りそなホールディングス" }, { t: "8309", n: "三井住友トラスト・ホールディングス" },
    { t: "8316", n: "三井住友フィナンシャルグループ" }, { t: "8331", n: "千葉銀行" },
    { t: "8354", n: "ふくおかフィナンシャルグループ" },
    { t: "8411", n: "みずほフィナンシャルグループ" },
    { t: "8601", n: "大和証券グループ本社" }, { t: "8604", n: "野村ホールディングス" },
    { t: "8628", n: "松井証券" },
    { t: "8630", n: "SOMPOホールディングス" }, { t: "8725", n: "MS&ADインシュアランスグループホールディングス" },
    { t: "8750", n: "第一生命ホールディングス" }, { t: "8766", n: "東京海上ホールディングス" },
    { t: "8795", n: "T&Dホールディングス" },
    { t: "8801", n: "三井不動産" }, { t: "8802", n: "三菱地所" },
    { t: "8804", n: "東京建物" }, { t: "8830", n: "住友不動産" },
    { t: "9001", n: "東武鉄道" }, { t: "9005", n: "東急" },
    { t: "9007", n: "小田急電鉄" }, { t: "9008", n: "京王電鉄" },
    { t: "9009", n: "京成電鉄" }, { t: "9020", n: "東日本旅客鉄道" },
    { t: "9021", n: "西日本旅客鉄道" }, { t: "9022", n: "東海旅客鉄道" },
    { t: "9064", n: "ヤマトホールディングス" }, { t: "9101", n: "日本郵船" },
    { t: "9104", n: "商船三井" }, { t: "9107", n: "川崎汽船" },
    { t: "9201", n: "日本航空" }, { t: "9202", n: "ANAホールディングス" },
    { t: "9301", n: "三菱倉庫" },
    { t: "9432", n: "日本電信電話" }, { t: "9433", n: "KDDI" },
    { t: "9434", n: "ソフトバンク" }, { t: "9501", n: "東京電力ホールディングス" },
    { t: "9502", n: "中部電力" }, { t: "9503", n: "関西電力" },
    { t: "9531", n: "東京ガス" }, { t: "9532", n: "大阪ガス" },
    { t: "9602", n: "東宝" },
    { t: "9613", n: "NTTデータグループ" },
    { t: "9735", n: "セコム" },
    { t: "9766", n: "コナミグループ" },
    { t: "9843", n: "ニトリホールディングス" },
    { t: "9984", n: "ソフトバンクグループ" },
];
server.tool("list_nikkei225", "日経225構成銘柄の一覧を表示。セクター名で絞り込みも可能。screen_stocks と組み合わせてスクリーニング対象を指定する際に便利。", {
    filter: z
        .string()
        .optional()
        .describe("銘柄名やティッカーで絞り込み。例: '自動車', '銀行', '7203'"),
}, async ({ filter }) => {
    let list = NIKKEI225_TICKERS;
    if (filter) {
        const lower = filter.toLowerCase();
        list = list.filter((s) => s.t.toLowerCase().includes(lower) ||
            s.n.toLowerCase().includes(lower));
    }
    const lines = [
        `【日経225構成銘柄】${filter ? ` (フィルタ: "${filter}")` : ""}`,
        `該当: ${list.length}銘柄`,
        ``,
    ];
    for (const s of list) {
        lines.push(`${s.t}  ${s.n}`);
    }
    lines.push(``, `※ screen_stocks の tickers パラメータにカンマ区切りで渡すことでスクリーニングできます。`, `※ 一度に最大20銘柄のファンダメンタルを取得可能です。`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Resources (optional context for Claude)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.resource("screener-presets", "cavka://screener/presets", async () => ({
    contents: [
        {
            uri: "cavka://screener/presets",
            mimeType: "text/plain",
            text: `Cavka スクリーナー プリセット条件:

1. バフェット流バリュー
   PER ≤ 15, PBR ≤ 1.5, ROE ≥ 10%, 配当利回り ≥ 3%
   割安で稼ぐ力があり配当も出す安定企業向け。

2. 高配当・財務健全
   配当利回り ≥ 3.5%, 配当性向 30-60%, D/E ≤ 100
   高配当かつ無理のない配当を出す企業。

3. 成長株 (GARP)
   PEG ≤ 1, 利益成長率 ≥ 10%, ROE ≥ 12%
   成長に見合った割安さがある成長企業。

4. 割安＋高収益
   PER ≤ 12, ROE ≥ 12%, 営業利益率 ≥ 10%
   低PERで高収益、見直し買い候補。

5. ネットキャッシュ割安
   PBR ≤ 1, ネットキャッシュ > 0, PER ≤ 15
   実質的に現金が溢れている割安企業。`,
        },
    ],
}));
server.resource("nikkei225-tickers", "cavka://nikkei225/tickers", async () => ({
    contents: [
        {
            uri: "cavka://nikkei225/tickers",
            mimeType: "text/plain",
            text: NIKKEI225_TICKERS.map((s) => `${s.t},${s.n}`).join("\n"),
        },
    ],
}));
server.tool("get_portfolio", `保有銘柄・口座残高・投資信託・外貨預金などのポートフォリオ情報を取得。現在の株価と合わせて評価損益を計算する。
取得可能なセクション: holdings(保有銘柄), balance(口座残高), transactions(取引履歴), otherAssets(投資信託・外貨), watchlist(お気に入り), alerts(アラート)`, {
    section: z
        .string()
        .optional()
        .describe("取得セクション: 'all','holdings','balance','transactions','otherAssets','watchlist','alerts' (デフォルト: all)"),
    withPrices: z
        .boolean()
        .optional()
        .describe("true にすると現在株価を取得して評価損益も計算する (デフォルト: true)"),
}, async ({ section, withPrices }) => {
    if (!MCP_API_KEY) {
        return {
            content: [{
                    type: "text",
                    text: "⚠️ MCP_API_KEY が設定されていません。環境変数 MCP_API_KEY を設定してください。",
                }],
        };
    }
    const sec = section ?? "all";
    const data = await cavkaAuthFetch(`/api/portfolio?email=${encodeURIComponent(PORTFOLIO_EMAIL)}&section=${sec}`);
    const lines = [];
    // Holdings
    if (data.holdings && data.holdings.length > 0) {
        lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【保有銘柄】 ${data.holdings.length}銘柄`);
        // 現在株価を取得して損益計算
        const shouldFetchPrices = withPrices !== false;
        let priceMap = {};
        let usdJpy = null;
        if (shouldFetchPrices) {
            const tickers = [...new Set(data.holdings.map((h) => h.ticker))];
            try {
                const priceData = await cavkaFetch(`/api/stocks/prices?tickers=${tickers.join(",")}`);
                priceMap = priceData.prices;
                usdJpy = priceData.usdJpy;
            }
            catch {
                lines.push(`  ※ 株価取得に失敗しました`);
            }
        }
        let totalCostJpy = 0;
        let totalValueJpy = 0;
        for (const h of data.holdings) {
            const price = priceMap[h.ticker];
            const currentPrice = price?.price ?? 0;
            const cost = h.shares * h.avgCost;
            const value = h.shares * currentPrice;
            const pnl = value - cost;
            const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
            const isUS = h.market === "US";
            const rate = isUS && usdJpy ? usdJpy : 1;
            const ccy = isUS ? "USD" : "JPY";
            totalCostJpy += cost * rate;
            totalValueJpy += value * rate;
            const arrow = pnl >= 0 ? "▲" : "▼";
            lines.push(``);
            lines.push(`  ${h.ticker} ${h.name}  [${h.market}]  ${h.shares}株`);
            lines.push(`    取得単価: ${fmt(h.avgCost)} ${ccy}  現在値: ${fmt(currentPrice)} ${ccy}`);
            lines.push(`    評価額: ${fmtLarge(value)}  取得額: ${fmtLarge(cost)}`);
            if (currentPrice > 0) {
                lines.push(`    損益: ${arrow}${fmtLarge(Math.abs(pnl))} (${fmtPct(pnlPct)})`);
            }
            if (h.memo)
                lines.push(`    メモ: ${h.memo}`);
        }
        if (shouldFetchPrices && totalCostJpy > 0) {
            const totalPnl = totalValueJpy - totalCostJpy;
            const totalPnlPct = (totalPnl / totalCostJpy) * 100;
            const arrow = totalPnl >= 0 ? "▲" : "▼";
            lines.push(``);
            lines.push(`  ── 株式合計（円換算） ──`);
            lines.push(`  評価額: ${fmtLarge(totalValueJpy)}  取得額: ${fmtLarge(totalCostJpy)}`);
            lines.push(`  損益: ${arrow}${fmtLarge(Math.abs(totalPnl))} (${fmtPct(totalPnlPct)})`);
            if (usdJpy)
                lines.push(`  (USD/JPY: ${fmt(usdJpy)})`);
        }
    }
    // Balance
    if (data.balance) {
        lines.push(``);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【口座残高】`);
        lines.push(`  円預り金: ¥${data.balance.cashJpy?.toLocaleString() ?? 0}`);
        lines.push(`  ドル預り金: $${fmt(data.balance.cashUsd ?? 0)}`);
    }
    // Other Assets
    if (data.otherAssets && data.otherAssets.length > 0) {
        lines.push(``);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【その他資産】`);
        const trusts = data.otherAssets.filter((a) => a.type === "investment_trust");
        const deposits = data.otherAssets.filter((a) => a.type === "foreign_deposit");
        if (trusts.length > 0) {
            lines.push(`  ── 投資信託 ──`);
            for (const t of trusts) {
                const pnl = t.currentValue - t.costBasis;
                const pnlPct = t.costBasis > 0 ? (pnl / t.costBasis) * 100 : 0;
                lines.push(`  ${t.name}${t.ticker ? ` (${t.ticker})` : ""}`);
                lines.push(`    評価額: ${fmtLarge(t.currentValue)}  取得額: ${fmtLarge(t.costBasis)}  損益: ${fmtPct(pnlPct)}`);
            }
        }
        if (deposits.length > 0) {
            lines.push(`  ── 外貨預金 ──`);
            for (const d of deposits) {
                lines.push(`  ${d.name}  ${d.currency} ${fmtLarge(d.currentValue)}`);
            }
        }
    }
    // Transactions
    if (data.transactions && data.transactions.length > 0) {
        lines.push(``);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【最近の取引】 直近${data.transactions.length}件`);
        const typeLabels = {
            buy: "買付", sell: "売却", deposit: "入金",
            withdraw: "出金", dividend: "配当",
        };
        for (const tx of data.transactions.slice(0, 20)) {
            const label = typeLabels[tx.type] ?? tx.type;
            const ticker = tx.ticker ? `${tx.ticker} ${tx.name ?? ""}` : "";
            const detail = tx.shares ? `${tx.shares}株 @${fmt(tx.price ?? 0)}` : "";
            const pnl = tx.realizedPnl ? ` 実現損益: ${fmtLarge(tx.realizedPnl)}` : "";
            lines.push(`  ${tx.date}  [${label}] ${ticker} ${detail}  ${tx.currency} ${fmtLarge(tx.amount)}${pnl}`);
        }
    }
    // Watchlist
    if (data.watchlist && data.watchlist.length > 0) {
        lines.push(``);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【お気に入り】 ${data.watchlist.length}銘柄`);
        const groups = data.watchlistGroups ?? [];
        const groupMap = new Map(groups.map((g) => [g.id, g.name]));
        for (const w of data.watchlist) {
            const groupName = groupMap.get(w.groupId) ?? "";
            lines.push(`  ${w.ticker} ${w.name} [${w.market}]${groupName ? ` — ${groupName}` : ""}`);
        }
    }
    // Alerts
    if (data.alerts && data.alerts.length > 0) {
        lines.push(``);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【価格アラート】 ${data.alerts.length}件`);
        for (const a of data.alerts) {
            const status = a.triggered ? "🔔発動済" : a.active ? "✅有効" : "⏸無効";
            const cond = a.condition === "above" ? "以上" : "以下";
            lines.push(`  ${status} ${a.ticker} ${a.name}  ${a.targetPrice}${cond}`);
        }
    }
    if (lines.length === 0) {
        lines.push("ポートフォリオデータがありません。");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("get_tachibana_holdings", "立花証券 e支店APIから実際の保有銘柄情報を取得する。Cavkaに手動登録した保有銘柄とは別に、証券会社が保有する正確なデータ（株数、取得単価、評価額、損益）を確認できる。現在はデモ環境に接続している。", {}, async () => {
    if (!MCP_API_KEY) {
        return {
            content: [{
                    type: "text",
                    text: "⚠️ MCP_API_KEY が設定されていません。",
                }],
        };
    }
    const data = await cavkaAuthFetch("/api/tachibana/portfolio");
    if (!data.ok) {
        return {
            content: [{
                    type: "text",
                    text: `❌ 立花API エラー: ${data.error}`,
                }],
        };
    }
    const lines = [];
    lines.push(`【立花証券 e支店 保有銘柄】 (${data.env === "prod" ? "本番" : "デモ"}環境)`);
    lines.push(`最終ログイン: ${data.lastLoginDate ?? "N/A"}`);
    lines.push(``);
    lines.push(`評価額合計: ¥${(data.totalEvalAmount ?? 0).toLocaleString()}`);
    const totalPnl = data.totalPnl ?? 0;
    const totalSign = totalPnl >= 0 ? "▲" : "▼";
    lines.push(`評価損益: ${totalSign} ¥${Math.abs(totalPnl).toLocaleString()}`);
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    for (const h of data.holdings ?? []) {
        const arrow = h.pnl >= 0 ? "▲" : "▼";
        lines.push(``);
        lines.push(`${h.ticker}  ${h.shares}株`);
        lines.push(`  取得単価: ¥${fmt(h.avgCost)}  評価単価: ¥${fmt(h.evalPrice)}`);
        lines.push(`  評価額: ¥${h.evalAmount.toLocaleString()}  損益: ${arrow}¥${Math.abs(h.pnl).toLocaleString()} (${fmtPct(h.pnlRate)})`);
        if (h.prevDiff !== null) {
            const da = h.prevDiff >= 0 ? "▲" : "▼";
            lines.push(`  前日比: ${da}¥${fmt(Math.abs(h.prevDiff))} (${fmtPct(h.prevDiffPct ?? 0)})`);
        }
    }
    lines.push(`\n※ ${data.env === "demo" ? "デモ環境のテストデータです。" : "本番口座の実データです。"}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("analyze_stock", `指定銘柄の「買うべきか・買わないべきか」の意思決定に必要なデータを総合的に取得する。
取得内容:
  ① 価格・出来高・テクニカル指標 (RSI/MACD/SMA/BB)
  ② 6か月レンジでの現在位置
  ③ ファンダメンタル (PER/PBR/ROE/成長率/配当等)
  ④ チャートパターン (日足・週足・月足)
  ⑤ ユーザーのコンテキスト (既保有か / お気に入りか / 既存シナリオ / セクター集中度)

このツールを呼んだ後、Claudeがすべてを統合して「買う理由3つ」「買わない理由3つ」「推奨アクション」を提示すること。`, {
    ticker: z.string().describe("ティッカーコード。例: '7203' or 'AAPL'"),
}, async ({ ticker }) => {
    const data = await cavkaAuthFetch(`/api/stocks/full-analysis?ticker=${encodeURIComponent(ticker)}`);
    const lines = [];
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`【${data.name} (${data.ticker}) 総合分析】`);
    lines.push(`取得時刻: ${data.fetchedAt}`);
    lines.push(``);
    // ① 価格
    if (data.price) {
        const p = data.price;
        const arrow = p.change >= 0 ? "▲" : "▼";
        lines.push(`■ 価格`);
        lines.push(`  現在値: ${fmt(p.current)} ${p.currency} ${arrow}${fmt(Math.abs(p.change))} (${fmtPct(p.changePct)})`);
        lines.push(`  本日: 高 ${fmt(p.dayHigh)} / 安 ${fmt(p.dayLow)} / 出来高 ${p.volume?.toLocaleString() ?? "N/A"}`);
    }
    // ② レンジ位置
    if (data.priceContext) {
        const pc = data.priceContext;
        lines.push(``);
        lines.push(`■ 6か月レンジ位置`);
        lines.push(`  高値: ${fmt(pc.high6m)} / 安値: ${fmt(pc.low6m)}`);
        lines.push(`  現在位置: ${pc.positionInRange}/100 (0=底, 100=天井)`);
        lines.push(`  高値から ${fmtPct(pc.fromHigh)} / 安値から ${fmtPct(pc.fromLow)}`);
    }
    // ③ テクニカル指標
    if (data.indicators) {
        const ind = data.indicators;
        lines.push(``);
        lines.push(`■ テクニカル指標`);
        lines.push(`  RSI(14): ${fmt(ind.rsi, 1)}`);
        lines.push(`  MACD: ${fmt(ind.macd)} / Signal: ${fmt(ind.signal)}`);
        lines.push(`  SMA20: ${fmt(ind.sma20)} / SMA50: ${fmt(ind.sma50)} / SMA200: ${fmt(ind.sma200)}`);
        lines.push(`  BB上: ${fmt(ind.bbUpper)} / BB下: ${fmt(ind.bbLower)}`);
    }
    // ④ ファンダメンタル
    if (data.fundamentals) {
        const f = data.fundamentals;
        lines.push(``);
        lines.push(`■ ファンダメンタル`);
        lines.push(`  業種: ${f.sector ?? "?"} / ${f.industry ?? "?"}`);
        lines.push(`  時価総額: ${fmtLarge(Number(f.marketCap) || 0)}`);
        lines.push(`  PER: ${fmt(Number(f.trailingPE), 1)} / PBR: ${fmt(Number(f.pbr), 2)} / PEG: ${fmt(Number(f.pegRatio), 2)}`);
        lines.push(`  ROE: ${fmt(Number(f.roe), 1)}% / 営業利益率: ${fmt(Number(f.operatingMargin), 1)}%`);
        lines.push(`  D/E: ${fmt(Number(f.debtToEquity), 1)} / 流動比率: ${fmt(Number(f.currentRatio), 2)}`);
        lines.push(`  売上成長率: ${fmt(Number(f.revenueGrowth), 1)}% / 利益成長率: ${fmt(Number(f.earningsGrowth), 1)}%`);
        lines.push(`  配当利回り: ${fmt(Number(f.dividendYield), 2)}% / 配当性向: ${fmt(Number(f.payoutRatio), 1)}%`);
        lines.push(`  ネットキャッシュ: ${fmtLarge(Number(f.netCash) || 0)}`);
    }
    else {
        lines.push(``);
        lines.push(`■ ファンダメンタル: 取得できず`);
    }
    // ⑤ チャートパターン
    if (data.patterns) {
        lines.push(``);
        lines.push(`■ チャートパターン`);
        for (const tf of ["daily", "weekly", "monthly"]) {
            const tfLabel = { daily: "日足", weekly: "週足", monthly: "月足" }[tf];
            const pats = data.patterns[tf] ?? [];
            if (pats.length === 0) {
                lines.push(`  ${tfLabel}: なし`);
                continue;
            }
            const top = pats[0];
            const signal = String(top.signal);
            const emoji = signal === "buy" ? "🟢" : signal === "sell" ? "🔴" : "🟡";
            lines.push(`  ${tfLabel}: ${emoji} ${top.label} (信頼度${top.confidence}%, 強度${top.strength}/5)`);
            lines.push(`         ${top.description}`);
        }
        if (data.patternTransitions && data.patternTransitions.length > 0) {
            lines.push(`  ▸ 遷移候補:`);
            for (const t of data.patternTransitions.slice(0, 3)) {
                const proxRaw = t.proximity;
                const prox = typeof proxRaw === "number" ? proxRaw : 0;
                lines.push(`     → ${t.label}  近接度: ${(prox * 100).toFixed(0)}%`);
            }
        }
    }
    // ⑥ ユーザーコンテキスト
    lines.push(``);
    lines.push(`■ あなたのコンテキスト`);
    const uc = data.userContext;
    if (uc.ownsThisStock) {
        const h = uc.ownsThisStock;
        lines.push(`  ✅ 既に保有中: ${h.shares}株 @ 取得単価 ¥${h.avgCost}`);
    }
    else {
        lines.push(`  ◯ 未保有`);
    }
    lines.push(`  お気に入り登録: ${uc.inWatchlist ? "✅ 登録済み" : "◯ 未登録"}`);
    if (uc.existingScenarios.length > 0) {
        lines.push(`  📋 既存シナリオ: ${uc.existingScenarios.length}件`);
        for (const s of uc.existingScenarios) {
            const sc = s;
            lines.push(`     - ${sc.direction} ¥${sc.entryPrice} → 目標¥${sc.targetPrices[0]} / 損切り¥${sc.stopLossPrice} (${sc.status})`);
        }
    }
    else {
        lines.push(`  📋 既存シナリオ: なし`);
    }
    if (uc.sectorConcentration) {
        lines.push(`  セクター: ${uc.sectorConcentration.thisSector} / 全保有銘柄: ${uc.sectorConcentration.totalHoldings}件`);
    }
    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`☆ Claudeへの依頼:`);
    lines.push(`  上記データを総合して、以下を簡潔に提示してください:`);
    lines.push(`  1. 買う理由 (3つまで)`);
    lines.push(`  2. 買わない / 待つ理由 (3つまで)`);
    lines.push(`  3. 推奨アクション (買い / 様子見 / 見送り)`);
    lines.push(`  4. シナリオを作るなら: エントリー / 目標 / 損切り の推奨値`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("get_my_scenarios", `ユーザーの投資シナリオを一覧取得する。各シナリオには「買う前に何を期待していたか / どんな根拠で / どんなリスクを想定していたか」が記録されている。
ユーザーの投資判断の質、バイアス傾向、過去のシナリオ vs 実際の比較分析、改善点の提案などに使用できる。`, {
    status: z
        .string()
        .optional()
        .describe("ステータスフィルタ: 'active'(監視中), 'achieved'(目標達成), 'stopped'(損切り), 'expired'(期間超過), 'manually_closed'(手動終了). 省略すると全て"),
}, async ({ status }) => {
    const portfolioData = await cavkaAuthFetch(`/api/portfolio?email=${encodeURIComponent(PORTFOLIO_EMAIL)}&section=scenarios`);
    let scenarios = portfolioData.scenarios ?? [];
    if (status) {
        scenarios = scenarios.filter((s) => s.status === status);
    }
    if (scenarios.length === 0) {
        return {
            content: [{
                    type: "text",
                    text: `シナリオが見つかりません${status ? ` (フィルタ: ${status})` : ""}。`,
                }],
        };
    }
    const lines = [`【投資シナリオ一覧】 ${scenarios.length}件`];
    const dirLabels = {
        buy: "▲ 買い", sell: "▼ 売り", watch: "◆ 様子見",
    };
    const statusLabels = {
        active: "監視中", achieved: "目標達成", stopped: "損切り",
        expired: "期間超過", manually_closed: "手動終了",
    };
    for (const s of scenarios) {
        lines.push(``);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`${s.ticker} ${s.name} - ${dirLabels[s.direction] ?? s.direction} [${statusLabels[s.status] ?? s.status}]`);
        lines.push(`  エントリー: ¥${s.entryPrice.toLocaleString()}`);
        lines.push(`  目標: ${s.targetPrices.map((p) => `¥${p.toLocaleString()}`).join(", ")}`);
        lines.push(`  損切り: ¥${s.stopLossPrice.toLocaleString()}`);
        lines.push(`  保有期間: ${s.holdingPeriod} / 確信度: ${"★".repeat(s.confidence)}${"☆".repeat(5 - s.confidence)}`);
        if (s.rationaleTags?.length > 0) {
            lines.push(`  根拠タグ: ${s.rationaleTags.join(", ")}`);
        }
        if (s.rationale) {
            lines.push(`  根拠: ${s.rationale}`);
        }
        if (s.risks) {
            lines.push(`  想定リスク: ${s.risks}`);
        }
        // 終了済み
        if (s.closePrice !== undefined && s.closePrice !== null) {
            const isBuy = s.direction === "buy";
            const pnlPct = isBuy
                ? ((s.closePrice - s.entryPrice) / s.entryPrice) * 100
                : ((s.entryPrice - s.closePrice) / s.entryPrice) * 100;
            lines.push(`  終値: ¥${s.closePrice.toLocaleString()} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);
            if (s.reflectionTags && s.reflectionTags.length > 0) {
                lines.push(`  振り返り: ${s.reflectionTags.join(", ")}`);
            }
            if (s.reflectionNote) {
                lines.push(`  メモ: "${s.reflectionNote}"`);
            }
        }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
function daysUntilFromIso(dateStr) {
    if (!dateStr)
        return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr);
    target.setHours(0, 0, 0, 0);
    return Math.floor((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}
server.tool("get_earnings_calendar", `指定銘柄の決算カレンダー情報を取得。次回決算日、予想EPS、前回サプライズ、配当権利落・支払日が含まれる。
決算前後は値動きが激しくなるため、ポジション調整の判断材料に使う。`, {
    tickers: z.string().describe("カンマ区切りのティッカー（最大20）。例: '7203,6501,AAPL'"),
}, async ({ tickers }) => {
    const data = await cavkaFetch(`/api/stocks/earnings?tickers=${encodeURIComponent(tickers)}`);
    const lines = ["【決算カレンダー】"];
    // 日付順にソート
    const sorted = Object.values(data.earnings ?? {}).sort((a, b) => {
        const aDays = daysUntilFromIso(a.nextEarningsDate);
        const bDays = daysUntilFromIso(b.nextEarningsDate);
        if (aDays === null && bDays === null)
            return 0;
        if (aDays === null)
            return 1;
        if (bDays === null)
            return -1;
        return aDays - bDays;
    });
    for (const e of sorted) {
        const days = daysUntilFromIso(e.nextEarningsDate);
        let urgency = "";
        if (days !== null) {
            if (days < 0)
                urgency = ` [${Math.abs(days)}日前に発表済]`;
            else if (days === 0)
                urgency = " 🚨 [本日!]";
            else if (days <= 3)
                urgency = ` 🔴 [あと${days}日!]`;
            else if (days <= 7)
                urgency = ` 🟡 [あと${days}日]`;
            else
                urgency = ` (あと${days}日)`;
        }
        lines.push(``);
        lines.push(`${e.ticker} ${e.name}`);
        lines.push(`  次回決算: ${e.nextEarningsDate ?? "未定"}${urgency}`);
        if (e.earningsAverage !== null) {
            lines.push(`  予想EPS: ${e.earningsAverage.toFixed(2)} ${e.currency}`);
        }
        if (e.lastEarningsSurprise !== null) {
            lines.push(`  前回サプライズ: ${e.lastEarningsSurprise >= 0 ? "+" : ""}${e.lastEarningsSurprise.toFixed(2)}% (実績 ${e.lastEarningsActual}/予想 ${e.lastEarningsEstimate})`);
        }
        if (e.exDividendDate) {
            lines.push(`  権利落: ${e.exDividendDate}`);
        }
        if (e.dividendDate) {
            lines.push(`  配当日: ${e.dividendDate}`);
        }
    }
    const requested = tickers.split(",").map((t) => t.trim()).filter(Boolean);
    const missing = requested.filter((t) => !data.earnings[t]);
    if (missing.length > 0) {
        lines.push(`\n※ データ取得不可: ${missing.join(", ")}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("get_news", `立花証券APIから日本株のリアルタイムニュースを取得する。銘柄絞り込み・期間絞り込み可。
ニュースソース: TDnet (適時開示), NQN (日経QUICK), QUICK 等。
取得後、Claudeがニュースを要約・好材料/悪材料判定・投資への影響を分析できる。`, {
    ticker: z
        .string()
        .optional()
        .describe("銘柄コード (1つのみ)。省略すると市場全体ニュース"),
    days: z
        .number()
        .optional()
        .describe("過去何日分か (デフォルト: 7)"),
    limit: z
        .number()
        .optional()
        .describe("取得件数 (デフォルト: 20, 最大: 100)"),
    fetchBody: z
        .boolean()
        .optional()
        .describe("ヘッドラインだけでなく本文も取得 (true 推奨だが時間かかる)"),
}, async ({ ticker, days, limit, fetchBody }) => {
    if (!MCP_API_KEY) {
        return {
            content: [{ type: "text", text: "⚠️ MCP_API_KEY が設定されていません。" }],
        };
    }
    const params = new URLSearchParams();
    if (ticker)
        params.set("ticker", ticker);
    params.set("limit", String(limit ?? 20));
    params.set("days", String(days ?? 7));
    const data = await cavkaAuthFetch(`/api/news?${params.toString()}`);
    if (!data.ok) {
        return {
            content: [{ type: "text", text: `❌ ニュース取得エラー: ${data.error}` }],
        };
    }
    if (data.items.length === 0) {
        return {
            content: [{
                    type: "text",
                    text: `該当ニュースなし${ticker ? ` (${ticker})` : ""}。期間: 過去${days ?? 7}日`,
                }],
        };
    }
    const lines = [];
    lines.push(`【立花証券 ニュース】 ${data.items.length}件 (全 ${data.total}件中)`);
    if (ticker)
        lines.push(`銘柄絞り込み: ${ticker}`);
    lines.push(``);
    // 本文取得モード
    if (fetchBody) {
        for (const n of data.items.slice(0, 10)) { // 本文取得は最大10件
            lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            lines.push(`${n.date.slice(4, 6)}/${n.date.slice(6)} ${n.time.slice(0, 2)}:${n.time.slice(2)}`);
            lines.push(`${n.headline}`);
            lines.push(`関連: ${n.relatedTickers.join(", ")}`);
            try {
                const body = await cavkaAuthFetch(`/api/news/${encodeURIComponent(n.id)}`);
                if (body.ok && body.news?.body) {
                    lines.push(``);
                    lines.push(body.news.body.slice(0, 800));
                    if (body.news.body.length > 800)
                        lines.push(`...(続く、合計${body.news.body.length}文字)`);
                }
            }
            catch {
                lines.push(`(本文取得失敗)`);
            }
            lines.push(``);
        }
        if (data.items.length > 10) {
            lines.push(`※ 本文取得は最大10件まで。残り${data.items.length - 10}件はヘッドラインのみ`);
        }
    }
    else {
        // ヘッドラインのみ
        for (const n of data.items) {
            const time = `${n.date.slice(4, 6)}/${n.date.slice(6)} ${n.time.slice(0, 2)}:${n.time.slice(2)}`;
            const tickers = n.relatedTickers.slice(0, 3).join(",") +
                (n.relatedTickers.length > 3 ? `+${n.relatedTickers.length - 3}` : "");
            lines.push(`[${time}] ${n.headline}`);
            lines.push(`         関連: ${tickers}`);
        }
        lines.push(``);
        lines.push(`※ 本文も読みたいなら fetchBody=true で再取得 (最大10件まで本文取得)`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("get_order_book", `立花APIから板情報(10段)とリアルタイム時価を取得する。
板の厚みから「買い圧力 vs 売り圧力」、大口の指値の有無などを分析できる。最大120銘柄。`, {
    tickers: z.string().describe("カンマ区切りティッカー(最大120)。例: '7203,6501'"),
}, async ({ tickers }) => {
    const data = await cavkaAuthFetch(`/api/tachibana/quotes?tickers=${encodeURIComponent(tickers)}`);
    if (!data.ok) {
        return { content: [{ type: "text", text: `❌ ${data.error}` }] };
    }
    const lines = [];
    for (const q of data.quotes ?? []) {
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【${q.ticker}】 ${q.priceTime ?? ""}`);
        const arrow = (q.changeAbs ?? 0) >= 0 ? "▲" : "▼";
        lines.push(`現在値: ¥${q.currentPrice?.toLocaleString()} ${arrow}${Math.abs(q.changeAbs ?? 0).toLocaleString()} (${(q.changePct ?? 0) >= 0 ? "+" : ""}${q.changePct?.toFixed(2)}%)`);
        lines.push(`始値¥${q.openPrice} / 高¥${q.highPrice} / 安¥${q.lowPrice} / VWAP¥${q.vwap?.toFixed(0)}`);
        lines.push(`出来高: ${q.volume?.toLocaleString()}株 / 売買代金: ¥${(q.turnover ?? 0).toLocaleString()}`);
        const totalBid = q.bids.reduce((s, b) => s + (b.quantity ?? 0), 0);
        const totalAsk = q.asks.reduce((s, a) => s + (a.quantity ?? 0), 0);
        const bidPct = totalBid + totalAsk > 0 ? (totalBid / (totalBid + totalAsk)) * 100 : 50;
        lines.push(``);
        lines.push(`■ 板厚み: 買${totalBid.toLocaleString()}株 vs 売${totalAsk.toLocaleString()}株 (買${bidPct.toFixed(0)}% : 売${(100 - bidPct).toFixed(0)}%)`);
        lines.push(``);
        lines.push(`■ 板情報 (上=売 売10→売1 / 現在値 / 買1→買10 下=買)`);
        // 売 (深い→浅い)
        for (let i = 9; i >= 0; i--) {
            const a = q.asks[i];
            lines.push(`  売${i + 1}: ¥${a.price?.toLocaleString() ?? "-"} × ${a.quantity?.toLocaleString() ?? "-"}株`);
        }
        lines.push(`  --- 現在値 ¥${q.currentPrice?.toLocaleString()} ---`);
        // 買 (浅い→深い)
        for (let i = 0; i < 10; i++) {
            const b = q.bids[i];
            lines.push(`  買${i + 1}: ¥${b.price?.toLocaleString() ?? "-"} × ${b.quantity?.toLocaleString() ?? "-"}株`);
        }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("find_volume_anomalies", `指定銘柄リストから「いつもと違う動き」をしている銘柄を検出する。
当日出来高 vs 過去20営業日平均出来高の比率(volumeRatio)を計算し、
価格変動と組み合わせて「材料発生」「仕手の兆候」「セリクラ」「仕込み」等を判定。
heatLevel: 3=異常, 2=高, 1=やや高, 0=通常`, {
    tickers: z.string().describe("カンマ区切りティッカー(最大30)。'auto' で日経225+保有+お気に入りを自動選択"),
    minVolumeRatio: z.number().optional().describe("この倍率以上のみ表示(デフォルト1.0=全件)"),
}, async ({ tickers, minVolumeRatio }) => {
    const data = await cavkaFetch(`/api/stocks/volume-anomaly?tickers=${encodeURIComponent(tickers)}`);
    const min = minVolumeRatio ?? 1.0;
    const filtered = (data.anomalies ?? []).filter((a) => a.volumeRatio >= min);
    if (filtered.length === 0) {
        return {
            content: [{
                    type: "text",
                    text: `条件を満たす銘柄はありません (volumeRatio >= ${min})`,
                }],
        };
    }
    const lines = [`【出来高異常検知】 ${filtered.length}件 (出来高比${min}倍以上)`];
    const heatEmoji = ["", "🟡", "🟠", "🔥"];
    const heatLabel = ["通常", "やや高", "高", "異常"];
    for (const a of filtered) {
        lines.push(``);
        lines.push(`${heatEmoji[a.heatLevel]} ${a.ticker} ${a.name} [${heatLabel[a.heatLevel]}]`);
        lines.push(`  ¥${a.currentPrice} (${a.changePct >= 0 ? "+" : ""}${a.changePct}%)  出来高 ×${a.volumeRatio.toFixed(1)} (当日${(a.todayVolume / 10000).toFixed(0)}万 / 平均${(a.avgVolume20d / 10000).toFixed(0)}万)`);
        lines.push(`  モメンタム: ROC5 ${a.roc5 >= 0 ? "+" : ""}${a.roc5}% / ROC20 ${a.roc20 >= 0 ? "+" : ""}${a.roc20}%`);
        if (a.signals.length > 0) {
            lines.push(`  シグナル: ${a.signals.join(", ")}`);
        }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
server.tool("get_margin_info", `日本株の信用残・証金残・逆日歩を取得する。
個人投資家にとって価値ある「需給情報」:
  - 信用倍率 (買残/売残): <1で売り偏重(踏み上げ候補), 高値圏で>20だと利食い圧力
  - 証金貸借倍率: <3で株不足の兆候
  - 逆日歩: 売り方が払うコスト, >0で踏み上げ警戒
  - 売残急増 / 買残急減 = トレンド転換のシグナル
最大120銘柄。`, {
    tickers: z.string().describe("カンマ区切りティッカー(最大120, 日本株のみ)"),
}, async ({ tickers }) => {
    const data = await cavkaAuthFetch(`/api/tachibana/margin?tickers=${encodeURIComponent(tickers)}`);
    if (!data.ok) {
        return { content: [{ type: "text", text: `❌ ${data.error}` }] };
    }
    const lines = [];
    for (const [ticker, info] of Object.entries(data.data ?? {})) {
        const m = info.margin;
        const h = info.hibu;
        const s = info.syoukin;
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        lines.push(`【${ticker}】 信用残: ${m?.date ?? "?"} / 証金: ${s?.date ?? "?"}`);
        if (m) {
            lines.push(``);
            lines.push(`■ 信用残 (合算)`);
            lines.push(`  買残: ${m.longTotal?.toLocaleString()}株 (前週比 ${m.longChangeTotal !== null && m.longChangeTotal >= 0 ? "+" : ""}${m.longChangeTotal?.toLocaleString()})`);
            lines.push(`  売残: ${m.shortTotal?.toLocaleString()}株 (前週比 ${m.shortChangeTotal !== null && m.shortChangeTotal >= 0 ? "+" : ""}${m.shortChangeTotal?.toLocaleString()})`);
            lines.push(`  信用倍率: ${m.ratioTotal?.toFixed(2)}倍`);
            // 解釈
            if (m.ratioTotal !== null) {
                if (m.ratioTotal < 1)
                    lines.push(`  → 🔥 売残>買残、踏み上げ候補`);
                else if (m.ratioTotal < 3)
                    lines.push(`  → ⚠ やや売り偏重`);
                else if (m.ratioTotal > 20)
                    lines.push(`  → 💰 買い偏重、利食い圧力`);
                else
                    lines.push(`  → ✓ バランスよし`);
            }
        }
        if (s) {
            lines.push(``);
            lines.push(`■ 証金残`);
            lines.push(`  融資残: ${s.loan?.toLocaleString()}株 (前日比 ${s.loanChangePrev !== null && s.loanChangePrev >= 0 ? "+" : ""}${s.loanChangePrev?.toLocaleString()})`);
            lines.push(`  貸株残: ${s.stockLent?.toLocaleString()}株 (前日比 ${s.stockLentChangePrev !== null && s.stockLentChangePrev >= 0 ? "+" : ""}${s.stockLentChangePrev?.toLocaleString()})`);
            lines.push(`  貸借倍率: ${s.ratio?.toFixed(2)} / 回転日数: ${s.rotationDays?.toFixed(1)}日`);
            if (s.ratio !== null && s.ratio > 0 && s.ratio < 3) {
                lines.push(`  → ⚠ 貸借倍率<3、株不足の兆候`);
            }
        }
        lines.push(``);
        const hibuRate = h?.rate ?? null;
        lines.push(`■ 逆日歩: ${hibuRate === null ? "なし" : `¥${hibuRate}/株/日 (踏み上げ警戒)`}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool: get_future_score (Phase 1-4 統合)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_future_score", "銘柄の将来性スコアを取得。5因子グレード (Value/Growth/Profitability/Momentum/EPS Revisions) + バリュートラップ警告 + アナリスト目標株価 + 適時開示イベント + Gemini ニュース感情を統合。「数値良いのに上がらない銘柄」を検出するための分析。", {
    ticker: z.string().describe("ティッカー。例: '7203' or 'AAPL'"),
}, async ({ ticker }) => {
    const d = await cavkaFetch(`/api/stocks/future-score/${encodeURIComponent(ticker)}`);
    const lines = [];
    lines.push(`【${d.name} (${d.ticker})】 ${d.price ? `現在 ${fmt(d.price)}` : ""}`);
    lines.push(``);
    lines.push(`━━ 総合判定 ━━`);
    lines.push(`${d.overall.label}  スコア ${d.overall.raw}/100 (素点 ${d.overall.rawUncapped})  グレード ${d.overall.grade}`);
    lines.push(d.overall.summary);
    lines.push(``);
    // 5因子
    lines.push(`━━ 5因子グレード ━━`);
    const factorLabels = {
        value: "Value (割安度)",
        growth: "Growth (成長性)",
        profitability: "Profit (収益力)",
        momentum: "Momentum (値動き)",
        epsRevisions: "EPS Revisions (業績修正)",
    };
    for (const [k, label] of Object.entries(factorLabels)) {
        const f = d.factors[k];
        lines.push(`  ${label}: ${f.grade} (${f.raw}/100)`);
        for (const r of f.reasons.slice(0, 3))
            lines.push(`    ▸ ${r}`);
    }
    lines.push(``);
    // フラグ
    const flagsList = [];
    if (d.flags.valueTrap)
        flagsList.push(`🚨 バリュートラップ: ${d.flags.valueTrapReason}`);
    if (d.flags.growthEmerging)
        flagsList.push(`🌱 グロース早期発見: ${d.flags.growthEmergingReason}`);
    if (d.flags.overhyped)
        flagsList.push(`🔥 過熱気味: ${d.flags.overhypedReason}`);
    if (d.flags.qualityGrowthRevoked)
        flagsList.push(`⚠ 高PEG/過熱により例外取消`);
    if (d.flags.cappedBy)
        flagsList.push(`⚠ 最弱因子 [${d.flags.cappedBy}] により減点`);
    if (flagsList.length > 0) {
        lines.push(`━━ 警告/フラグ ━━`);
        flagsList.forEach((f) => lines.push(`  ${f}`));
        lines.push(``);
    }
    // アナリスト
    if (d.analyst) {
        lines.push(`━━ アナリスト (${d.analyst.numberOfAnalysts ?? "?"}人) ━━`);
        if (d.analyst.targetMeanPrice !== null) {
            lines.push(`  目標株価: ${fmt(d.analyst.targetMeanPrice)}  Upside: ${fmtPct(d.analyst.upsidePct)}`);
        }
        if (d.analyst.recommendationKey) {
            lines.push(`  コンセンサス: ${d.analyst.recommendationKey} (${fmt(d.analyst.recommendationMean)} / 1=強買 5=強売)`);
        }
        if (d.analyst.netRevisions30d !== null) {
            lines.push(`  Net Revisions 30d: ${d.analyst.netRevisions30d > 0 ? "+" : ""}${d.analyst.netRevisions30d}`);
        }
        lines.push(``);
    }
    // 開示イベント
    if (d.disclosures && d.disclosures.eventCount > 0) {
        lines.push(`━━ 適時開示 (直近30日, スコア ${d.disclosures.score}) ━━`);
        const labels = {
            earnings_revision_up: "📈 上方修正", earnings_revision_down: "📉 下方修正",
            dividend_up: "💴 増配", dividend_down: "💸 減配",
            buyback: "🔄 自社株買い", split: "🪓 株式分割",
            alliance: "🤝 業務提携", ma_acquirer: "🏢 M&A", ma_target: "💎 被買収",
            scandal: "🚨 不祥事", lawsuit: "⚖ 訴訟",
        };
        for (const [type, n] of Object.entries(d.disclosures.counts)) {
            if (n > 0)
                lines.push(`  ${labels[type] ?? type} ×${n}`);
        }
        for (const e of d.disclosures.events.slice(0, 3)) {
            lines.push(`    [${e.date}] ${e.headline}`);
        }
        lines.push(``);
    }
    // ニュース感情
    if (d.sentiment && d.sentiment.articleCount > 0) {
        lines.push(`━━ ニュース感情 (Gemini) ━━`);
        lines.push(`  ${d.sentiment.articleCount}件 / ${d.sentiment.label} (score ${d.sentiment.finalScore})`);
        lines.push(`  平均感情 ${d.sentiment.avgSentiment > 0 ? "+" : ""}${fmt(d.sentiment.avgSentiment)} × 拡散係数 ${fmt(d.sentiment.diffusionCoef)}`);
        if (d.sentiment.stale)
            lines.push(`  ⚠ stale (36時間以上前)`);
        lines.push(``);
    }
    lines.push(`データ充足度: ${d.coverage.confidence}%  analyst:${d.coverage.hasAnalystData ? "✓" : "✗"} sentiment:${d.coverage.hasSentimentData ? "✓" : "✗"} disclosures:${d.coverage.hasDisclosureData ? "✓" : "✗"}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool: get_score_rankings (時間軸別 short/mid/long)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_score_rankings", "日経225+米国主要40銘柄の時間軸別スコアランキング (Cron で毎日更新)。短期/中期/長期/総合の各軸で並び替え、市場/最低スコアでフィルタ可能。", {
    timeframe: z
        .enum(["overall", "short", "mid", "long"])
        .optional()
        .describe("ソート対象の時間軸 (デフォルト overall)"),
    market: z.enum(["all", "JP", "US"]).optional().describe("市場 (デフォルト all)"),
    minScore: z.number().optional().describe("最低スコア (デフォルト 60)"),
    limit: z.number().optional().describe("最大件数 (デフォルト 20)"),
}, async ({ timeframe = "overall", market = "all", minScore = 60, limit = 20 }) => {
    const data = await cavkaFetch(`/api/rankings/score`);
    const filtered = (data.entries ?? [])
        .filter((e) => market === "all" || e.market === market)
        .filter((e) => e[timeframe] >= minScore)
        .sort((a, b) => b[timeframe] - a[timeframe])
        .slice(0, limit);
    const lines = [];
    lines.push(`【スコアランキング ${timeframe}】 ${data.date}  (${data.processed}銘柄, market=${market}, minScore=${minScore})`);
    lines.push(`計 ${filtered.length} 件:`);
    lines.push(``);
    for (let i = 0; i < filtered.length; i++) {
        const e = filtered[i];
        lines.push(`#${i + 1} ${e.market} ${e.ticker} ${e.name}  ` +
            `short=${e.short} mid=${e.mid} long=${e.long} overall=${e.overall}  ` +
            `${e.price ? fmt(e.price) : "—"}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool: get_intraday_signals (リアルタイム超短期)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_intraday_signals", "当日の超短期シグナルを取得 (リアルタイム)。リバウンド候補 (急落+反発材料) / 反落警戒 (急騰+過熱) / ニュース反応中 / 代乗り判定。日経225+米国主要40を ~1秒でスキャン。", {
    minScore: z.number().optional().describe("最低スコア閾値 (デフォルト 40)"),
    market: z.enum(["all", "JP", "US"]).optional().describe("市場 (デフォルト all)"),
    limit: z.number().optional().describe("各カテゴリの最大件数 (デフォルト 10)"),
}, async ({ minScore = 40, market = "all", limit = 10 }) => {
    const data = await cavkaFetch(`/api/intraday/scan?minScore=${minScore}`);
    const filter = (list) => list.filter((r) => market === "all" || r.market === market).slice(0, limit);
    const formatRow = (r, scoreField) => {
        const ch = r.changePct;
        const chs = ch !== null ? `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%` : "?";
        const symp = r.sympathy.detected ? ` 🌊${r.sympathy.direction}` : "";
        const pat = r.morningPattern !== "unknown" && r.morningPattern !== "flat" ? ` ${r.morningPattern}` : "";
        return `  ${r.market} ${r.ticker} ${r.name}  ${chs}  score=${r[scoreField]}${symp}${pat}`;
    };
    const lines = [];
    lines.push(`【超短期シグナル】 (${data.elapsedMs}ms scan)`);
    lines.push(`日経平均 ${fmtPct(data.marketAvg.jp)}  /  米国平均 ${fmtPct(data.marketAvg.us)}`);
    lines.push(``);
    const rebounds = filter(data.rebounds ?? []);
    if (rebounds.length > 0) {
        lines.push(`━━ 🟢 リバウンド候補 (${rebounds.length}/${data.counts.rebounds}) ━━`);
        rebounds.forEach((r) => lines.push(formatRow(r, "reboundScore")));
        lines.push(``);
    }
    const overheats = filter(data.overheats ?? []);
    if (overheats.length > 0) {
        lines.push(`━━ 🔥 反落警戒 (${overheats.length}/${data.counts.overheats}) ━━`);
        overheats.forEach((r) => lines.push(formatRow(r, "plungeScore")));
        lines.push(``);
    }
    const newsActive = filter(data.newsActive ?? []);
    if (newsActive.length > 0) {
        lines.push(`━━ 📰 ニュース反応中 (${newsActive.length}/${data.counts.newsActive}) ━━`);
        newsActive.forEach((r) => lines.push(formatRow(r, "newsReactionScore")));
        lines.push(``);
    }
    if (rebounds.length === 0 && overheats.length === 0 && newsActive.length === 0) {
        lines.push(`該当銘柄なし。`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool: analyze_intraday (個別超短期詳細)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("analyze_intraday", "個別日本株の超短期詳細分析。立花から VWAP・板情報・直近ニュースを取得し、リバウンド/反落の精密判定。日本株のみ対応。認証必要。", {
    ticker: z.string().describe("日本株ティッカー (4桁数字)。例: '7203'"),
}, async ({ ticker }) => {
    const d = await cavkaAuthFetch(`/api/intraday/analyze/${encodeURIComponent(ticker)}`);
    const r = d.raw;
    const lines = [];
    lines.push(`【超短期詳細分析 ${ticker}】 ${d.summary}`);
    lines.push(``);
    lines.push(`━━ 価格 ━━`);
    lines.push(`  現値 ${fmt(r.currentPrice)} (${fmtPct(r.changePct)})  VWAP ${fmt(r.vwap)}`);
    lines.push(`  始値 ${fmt(r.open)}  高値 ${fmt(r.dayHigh)}  安値 ${fmt(r.dayLow)}`);
    lines.push(`  出来高 ${r.volume?.toLocaleString() ?? "—"}`);
    lines.push(``);
    lines.push(`━━ 板情報 ━━`);
    const bidPct = r.bidAskRatio !== null ? (r.bidAskRatio * 100).toFixed(1) : "—";
    lines.push(`  買い ${r.bidVolume.toLocaleString()} / 売り ${r.askVolume.toLocaleString()}  (買厚み ${bidPct}%)`);
    lines.push(``);
    if (d.news.hasRecentNews !== null) {
        lines.push(`━━ ニュース ━━`);
        lines.push(`  直近: ${d.news.hasRecentNews ? `あり (${d.news.newsHoursAgo?.toFixed(1)}時間前)` : "なし"}`);
        lines.push(``);
    }
    lines.push(`━━ スコア ━━`);
    lines.push(`  リバウンド ${d.reboundScore}  反落警戒 ${d.plungeScore}  ニュース反応 ${d.newsReactionScore}`);
    lines.push(`  寄り付きパターン: ${d.morningPattern}`);
    if (d.sympathy.detected)
        lines.push(`  🌊 代乗り検出 (${d.sympathy.direction}): ${d.sympathy.reason}`);
    lines.push(``);
    lines.push(`━━ 検出シグナル ━━`);
    d.signals.forEach((s) => {
        const icon = s.direction === "bullish" ? "🟢" : s.direction === "bearish" ? "🔴" : "🟡";
        lines.push(`  ${icon} [w${s.weight}] ${s.source}: ${s.message}`);
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool: get_news_sentiment
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_news_sentiment", "銘柄の Gemini ニュース感情キャッシュを取得。直近14日のニュースを Gemini が個別分類し、時間減衰加重平均×拡散係数で finalScore (-100〜+100) を算出。日次 cron で自動更新。", {
    ticker: z.string().describe("ティッカー。例: '7203'"),
}, async ({ ticker }) => {
    try {
        const d = await cavkaFetch(`/api/stocks/sentiment/${encodeURIComponent(ticker)}`);
        const lines = [];
        lines.push(`【ニュース感情 ${ticker}】 ${d.label}  (score ${d.finalScore}/100)  ${d.stale ? "⚠ stale" : "fresh"}`);
        lines.push(``);
        lines.push(`記事数 ${d.articleCount} / 平均感情 ${d.avgSentiment > 0 ? "+" : ""}${fmt(d.avgSentiment)} × 拡散係数 ${fmt(d.diffusionCoef)}`);
        lines.push(`計算日時: ${d.computedAt}`);
        lines.push(``);
        if (d.articles && d.articles.length > 0) {
            lines.push(`━━ 記事分類 (Top 10) ━━`);
            d.articles.slice(0, 10).forEach((a) => {
                const s = a.sentiment >= 0 ? `+${a.sentiment.toFixed(2)}` : a.sentiment.toFixed(2);
                lines.push(`  [${a.date}] ${s}  ${a.headline}`);
                if (a.reason)
                    lines.push(`         理由: ${a.reason}`);
            });
        }
        if (d.disclosures && d.disclosures.eventCount > 0) {
            lines.push(``);
            lines.push(`━━ 同レコード内: 適時開示 (score ${d.disclosures.score}) ━━`);
            Object.entries(d.disclosures.counts).filter(([, n]) => n > 0).forEach(([t, n]) => {
                lines.push(`  ${t} ×${n}`);
            });
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `${ticker} のセンチメントキャッシュ未取得。POST /api/stocks/sentiment/${ticker} で生成可能。Error: ${err instanceof Error ? err.message : String(err)}`,
                },
            ],
        };
    }
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tool: get_disclosure_events
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
server.tool("get_disclosure_events", "銘柄の適時開示イベントを取得 (業績修正/配当/自社株買い/分割/M&A/不祥事/訴訟)。立花ニュースをキーワード分類で抽出、不祥事/訴訟は重大警告。", {
    ticker: z.string().describe("ティッカー。例: '7203'"),
}, async ({ ticker }) => {
    try {
        const d = await cavkaFetch(`/api/stocks/sentiment/${encodeURIComponent(ticker)}`);
        const disc = d.disclosures;
        if (!disc || disc.eventCount === 0) {
            return { content: [{ type: "text", text: `${ticker}: 直近30日に適時開示イベントなし。` }] };
        }
        const labels = {
            earnings_revision_up: "📈 上方修正", earnings_revision_down: "📉 下方修正",
            dividend_up: "💴 増配", dividend_down: "💸 減配",
            buyback: "🔄 自社株買い", split: "🪓 株式分割",
            alliance: "🤝 業務提携", ma_acquirer: "🏢 M&A", ma_target: "💎 被買収",
            scandal: "🚨 不祥事", lawsuit: "⚖ 訴訟",
        };
        const lines = [];
        lines.push(`【適時開示 ${ticker}】 score ${disc.score}  events ${disc.eventCount}件`);
        if (disc.hasCriticalNegative)
            lines.push(`🚨 重大開示警告: 不祥事/訴訟検出`);
        lines.push(``);
        lines.push(`━━ カテゴリ別 ━━`);
        for (const [type, n] of Object.entries(disc.counts)) {
            if (n > 0)
                lines.push(`  ${labels[type] ?? type} ×${n}`);
        }
        lines.push(``);
        if (disc.latestUpRevision)
            lines.push(`📈 最新上方修正 [${disc.latestUpRevision.date}]: ${disc.latestUpRevision.headline}`);
        if (disc.latestDownRevision)
            lines.push(`📉 最新下方修正 [${disc.latestDownRevision.date}]: ${disc.latestDownRevision.headline}`);
        lines.push(``);
        lines.push(`━━ 全イベント ━━`);
        for (const e of disc.events.slice(0, 15)) {
            lines.push(`  [${e.date}] ${labels[e.type] ?? e.type}: ${e.headline}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `エラー: ${err instanceof Error ? err.message : String(err)}` }],
        };
    }
});
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Cavka MCP Server running on stdio");
}
main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
