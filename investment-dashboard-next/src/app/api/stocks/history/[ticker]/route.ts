import { NextRequest, NextResponse } from "next/server";
import { yfQuoteSummary } from "@/lib/yahoo-finance";

/**
 * GET /api/stocks/history/[ticker]
 *
 * Yahoo Finance v10 quoteSummary の以下モジュールから年次/四半期業績推移を取得:
 *   - incomeStatementHistory       : 過去4年の年次損益計算書
 *   - incomeStatementHistoryQuarterly : 過去4四半期の損益計算書
 *   - balanceSheetHistory          : 過去4年のB/S
 *   - cashflowStatementHistory     : 過去4年のキャッシュフロー
 *   - earnings                     : 年次/四半期 EPS と収益
 *   - earningsHistory              : 過去4四半期の EPS 実績/予想
 *
 * Yahoo は無料枠で 4-5年が上限。本格的な10年データは要 J-Quants / 立花 / 別ソース。
 *
 * 出力: 時系列の財務指標 (年次 + 四半期)
 */

interface YfNumeric {
  raw?: number | null;
  fmt?: string;
}

function n(v: YfNumeric | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "raw" in v && typeof v.raw === "number") {
    return Number.isFinite(v.raw) ? v.raw : null;
  }
  return null;
}

interface AnnualFinancials {
  fiscalYearEnd: string;          // "2024-03-31" など
  revenue: number | null;          // 売上
  operatingIncome: number | null;  // 営業利益
  netIncome: number | null;        // 純利益
  eps: number | null;              // EPS
  grossProfit: number | null;      // 売上総利益
  ebitda: number | null;
  // B/S
  totalAssets: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  cash: number | null;
  // CF
  operatingCashflow: number | null;
  freeCashflow: number | null;
  capex: number | null;
  // 派生指標
  grossMargin: number | null;      // %
  operatingMargin: number | null;  // %
  netMargin: number | null;        // %
  equityRatio: number | null;      // 自己資本比率 %
  roe: number | null;              // %
  roa: number | null;              // %
}

interface QuarterlyFinancials {
  quarter: string;                 // "2024 Q4" など
  date: string;                    // "2024-03-31"
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  epsEstimate: number | null;
  surprise: number | null;         // %
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const isJP = /^\d{3,4}[A-Z]?$/.test(ticker);
  const yfTicker = isJP ? `${ticker}.T` : ticker;

  try {
    const modules =
      "incomeStatementHistory,incomeStatementHistoryQuarterly,balanceSheetHistory,cashflowStatementHistory,earnings,earningsHistory,price,summaryDetail,defaultKeyStatistics";
    const result = await yfQuoteSummary(yfTicker, modules);
    if (!result) {
      return NextResponse.json({ ok: false, error: "Yahoo データ取得失敗" }, { status: 404 });
    }

    const ishHistory = ((result.incomeStatementHistory as Record<string, unknown>)?.incomeStatementHistory ?? []) as Record<string, unknown>[];
    const ishQ = ((result.incomeStatementHistoryQuarterly as Record<string, unknown>)?.incomeStatementHistory ?? []) as Record<string, unknown>[];
    const bsHistory = ((result.balanceSheetHistory as Record<string, unknown>)?.balanceSheetStatements ?? []) as Record<string, unknown>[];
    const cfHistory = ((result.cashflowStatementHistory as Record<string, unknown>)?.cashflowStatements ?? []) as Record<string, unknown>[];
    const earnings = (result.earnings as Record<string, unknown>) ?? {};
    const earningsHistory = ((result.earningsHistory as Record<string, unknown>)?.history ?? []) as Record<string, unknown>[];
    const price = (result.price as Record<string, unknown>) ?? {};
    const sd = (result.summaryDetail as Record<string, unknown>) ?? {};
    const ks = (result.defaultKeyStatistics as Record<string, unknown>) ?? {};

    // ── 年次データ構築 ──
    // 年次 IS と BS / CF を fiscalYearEnd でマッチング
    const bsByEnd = new Map<string, Record<string, unknown>>();
    for (const b of bsHistory) {
      const ed = n(b.endDate as YfNumeric);
      if (ed) bsByEnd.set(formatEpoch(ed).slice(0, 4), b);
    }
    const cfByEnd = new Map<string, Record<string, unknown>>();
    for (const c of cfHistory) {
      const ed = n(c.endDate as YfNumeric);
      if (ed) cfByEnd.set(formatEpoch(ed).slice(0, 4), c);
    }

    const annual: AnnualFinancials[] = [];
    for (const is of ishHistory) {
      const ed = n(is.endDate as YfNumeric);
      if (!ed) continue;
      const fiscalYearEnd = formatEpoch(ed);
      const year = fiscalYearEnd.slice(0, 4);

      const revenue = n(is.totalRevenue as YfNumeric);
      const grossProfit = n(is.grossProfit as YfNumeric);
      const operatingIncome = n(is.operatingIncome as YfNumeric);
      const netIncome = n(is.netIncome as YfNumeric);
      const ebitda = n(is.ebitda as YfNumeric);

      const bs = bsByEnd.get(year);
      const totalAssets = bs ? n(bs.totalAssets as YfNumeric) : null;
      const totalEquity = bs ? n(bs.totalStockholderEquity as YfNumeric) : null;
      const totalDebt = bs
        ? (n(bs.longTermDebt as YfNumeric) ?? 0) + (n(bs.shortLongTermDebt as YfNumeric) ?? 0)
        : null;
      const cash = bs ? n(bs.cash as YfNumeric) : null;

      const cf = cfByEnd.get(year);
      const operatingCashflow = cf ? n(cf.totalCashFromOperatingActivities as YfNumeric) : null;
      const capex = cf ? n(cf.capitalExpenditures as YfNumeric) : null;
      const freeCashflow = operatingCashflow !== null && capex !== null ? operatingCashflow + capex : null;

      // 派生指標
      const grossMargin = revenue && grossProfit ? Math.round((grossProfit / revenue) * 1000) / 10 : null;
      const operatingMargin = revenue && operatingIncome ? Math.round((operatingIncome / revenue) * 1000) / 10 : null;
      const netMargin = revenue && netIncome ? Math.round((netIncome / revenue) * 1000) / 10 : null;
      const equityRatio = totalAssets && totalEquity ? Math.round((totalEquity / totalAssets) * 1000) / 10 : null;
      const roe = totalEquity && netIncome ? Math.round((netIncome / totalEquity) * 1000) / 10 : null;
      const roa = totalAssets && netIncome ? Math.round((netIncome / totalAssets) * 1000) / 10 : null;

      annual.push({
        fiscalYearEnd,
        revenue,
        operatingIncome,
        netIncome,
        eps: null, // EPS は earnings から
        grossProfit,
        ebitda,
        totalAssets,
        totalEquity,
        totalDebt,
        cash,
        operatingCashflow,
        freeCashflow,
        capex,
        grossMargin,
        operatingMargin,
        netMargin,
        equityRatio,
        roe,
        roa,
      });
    }
    annual.sort((a, b) => a.fiscalYearEnd.localeCompare(b.fiscalYearEnd));

    // earnings から EPS を埋める
    const epsByYear = new Map<string, number>();
    const earningsYearly = ((earnings.financialsChart as Record<string, unknown>)?.yearly ?? []) as Record<string, unknown>[];
    for (const ey of earningsYearly) {
      const year = String(ey.date ?? "");
      const rev = n(ey.revenue as YfNumeric);
      const earn = n(ey.earnings as YfNumeric);
      if (year && earn !== null) {
        // EPS は totalRevenue から計算するのは難しいので、earnings.earnings/EPSで近似
        // 直接 EPS が無い場合、後で earningsHistory から推定
        epsByYear.set(year, earn);
      }
      // ついでに earnings.yearly の revenue が不足してたら埋める
      const idx = annual.findIndex((a) => a.fiscalYearEnd.startsWith(year));
      if (idx >= 0 && annual[idx].revenue === null && rev !== null) {
        annual[idx].revenue = rev;
      }
    }

    // ── 四半期データ構築 ──
    const quarterly: QuarterlyFinancials[] = [];

    // earnings.earningsChart.quarterly から先にとる (4Q分)
    const earningsQuarterly = ((earnings.earningsChart as Record<string, unknown>)?.quarterly ?? []) as Record<string, unknown>[];
    for (const eq of earningsQuarterly) {
      const date = String(eq.date ?? ""); // 例: "1Q2024"
      const actual = n(eq.actual as YfNumeric);
      const estimate = n(eq.estimate as YfNumeric);
      const surprise = actual !== null && estimate !== null && estimate !== 0
        ? Math.round(((actual - estimate) / Math.abs(estimate)) * 1000) / 10
        : null;
      quarterly.push({
        quarter: date,
        date: "",
        revenue: null,
        netIncome: null,
        eps: actual,
        epsEstimate: estimate,
        surprise,
      });
    }

    // 四半期 IS で revenue / netIncome を補完
    for (let i = 0; i < Math.min(ishQ.length, quarterly.length); i++) {
      const isQ = ishQ[i];
      const ed = n(isQ.endDate as YfNumeric);
      const date = ed ? formatEpoch(ed) : "";
      const rev = n(isQ.totalRevenue as YfNumeric);
      const ni = n(isQ.netIncome as YfNumeric);
      if (i < quarterly.length) {
        quarterly[i].date = date;
        quarterly[i].revenue = rev;
        quarterly[i].netIncome = ni;
      }
    }

    return NextResponse.json({
      ok: true,
      ticker,
      currency: (price.currency as string) ?? null,
      annual,
      quarterly,
      currentRatios: {
        trailingPE: n(sd.trailingPE as YfNumeric) ?? n(ks.trailingPE as YfNumeric),
        forwardPE: n(sd.forwardPE as YfNumeric) ?? n(ks.forwardPE as YfNumeric),
        pbr: n(sd.priceToBook as YfNumeric) ?? n(ks.priceToBook as YfNumeric),
        dividendYield: n(sd.dividendYield as YfNumeric),
      },
      _meta: {
        annualCount: annual.length,
        quarterlyCount: quarterly.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function formatEpoch(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toISOString().slice(0, 10);
}
