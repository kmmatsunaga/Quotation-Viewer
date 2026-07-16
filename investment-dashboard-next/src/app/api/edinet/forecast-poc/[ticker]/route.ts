import { NextRequest, NextResponse } from "next/server";
import {
  fetchRecentReportDocs,
  fetchEdinetCsv,
  parseForecastRowsFromCsv,
} from "@/lib/edinet";

/**
 * GET /api/edinet/forecast-poc/{ticker}?days=120
 *
 * PoC: 指定 ticker の最近の有報/四半期報を検索し、最新の CSV から「予想」要素を抽出。
 * 段階的検証用 — 何が取れるか可視化する。
 *
 * - days: 検索範囲 (デフォルト 120日)
 * - debug=1: docList の中身もまるごと返す
 */

export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const days = Number(req.nextUrl.searchParams.get("days") ?? "120");
  const debug = req.nextUrl.searchParams.get("debug") === "1";

  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const startedAt = Date.now();

  try {
    // 1. 過去 days 日の 120/140 書類を検索
    const docs = await fetchRecentReportDocs(ticker, days);
    if (docs.length === 0) {
      return NextResponse.json({
        ok: false,
        ticker,
        days,
        message: `過去${days}日に有報/四半期報の提出記録なし`,
        elapsedMs: Date.now() - startedAt,
      });
    }

    // 2. 最新の書類を選択
    const latest = docs[0];
    if (!latest.docID) {
      return NextResponse.json({ ok: false, error: "no docID in latest doc", latest }, { status: 500 });
    }

    // 3. CSV (XBRL→CSV変換版) をダウンロード + デコード
    const csvText = await fetchEdinetCsv(latest.docID);
    if (!csvText) {
      return NextResponse.json({
        ok: false,
        ticker,
        latest,
        message: "CSV ダウンロードまたはデコード失敗",
        elapsedMs: Date.now() - startedAt,
      });
    }

    // 4. 「予想」を含む行を抽出
    const forecastRows = parseForecastRowsFromCsv(csvText);

    // デバッグ: CSV の最初の数行とユニークelementID
    const lines = csvText.split(/\r?\n/);
    const firstLines = lines.slice(0, 8);
    // ざっとどんな elementId があるか調査
    const allElementIds = new Set<string>();
    for (const line of lines) {
      const cols = line.split("\t");
      if (cols.length >= 3 && cols[0]) allElementIds.add(cols[0]);
    }
    const elementIdSample = Array.from(allElementIds).slice(0, 30);
    // "Forecast" or "予想" を含む生 elementId / 項目名
    const matchingLines = lines
      .filter(
        (l) =>
          /Forecast|forecast|予想|見通し/i.test(l)
      )
      .slice(0, 20);

    return NextResponse.json({
      ok: true,
      ticker,
      days,
      docsFound: docs.length,
      latest: {
        docID: latest.docID,
        docTypeCode: latest.docTypeCode,
        docDescription: latest.docDescription,
        submitDateTime: latest.submitDateTime,
        periodStart: latest.periodStart,
        periodEnd: latest.periodEnd,
        filerName: latest.filerName,
      },
      csvSize: csvText.length,
      totalLines: lines.length,
      firstLines,                  // CSV 構造の確認
      elementIdSample,             // 適当な elementId 30個
      forecastRowsCount: forecastRows.length,
      forecastSample: forecastRows.slice(0, 30),
      matchingLinesCount: matchingLines.length,
      matchingLines,               // "予想"/"Forecast" を含む生行 (タブ区切りそのまま)
      ...(debug && { allDocs: docs }),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, ticker, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
