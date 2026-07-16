/**
 * EDINET API v2 ヘルパー
 *
 * 認証: Subscription-Key (環境変数 EDINET_API_KEY)
 * 仕様書: https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf
 *
 * 主要書類タイプコード:
 *   030: 有価証券届出書
 *   120: 有価証券報告書
 *   140: 四半期報告書
 *   150: 半期報告書
 *   160: 自己株券買付状況報告書
 *   170: 親会社等状況報告書
 *   180: 大量保有報告書 (5%ルール)
 *   220: 変更報告書 (大量保有)
 *
 * secCode の仕様:
 *   - 5桁形式 (4桁ティッカー + "0")
 *   - 例: 7203 → "72030"
 */

const EDINET_BASE = "https://api.edinet-fsa.go.jp/api/v2";

export interface EdinetDocument {
  seqNumber: number;
  docID: string;
  edinetCode: string | null;
  secCode: string | null;        // 5桁形式 (ある場合)
  JCN: string | null;            // 法人番号
  filerName: string | null;      // 提出者名 (法人/個人)
  fundCode: string | null;
  ordinanceCode: string | null;
  formCode: string | null;
  docTypeCode: string | null;     // "180" = 大量保有, "220" = 変更報告
  periodStart: string | null;
  periodEnd: string | null;
  submitDateTime: string | null;  // YYYY-MM-DD HH:MM
  docDescription: string | null;  // 書類概要
  issuerEdinetCode: string | null;
  subjectEdinetCode: string | null;
  subsidiaryEdinetCode: string | null;
  currentReportReason: string | null;
  parentDocID: string | null;
  opeDateTime: string | null;
  withdrawalStatus: string | null;
  docInfoEditStatus: string | null;
  disclosureStatus: string | null;
  xbrlFlag: string | null;
  pdfFlag: string | null;
  attachDocFlag: string | null;
  englishDocFlag: string | null;
  csvFlag: string | null;
  legalStatus: string | null;
}

export interface EdinetDocListResponse {
  metadata: {
    title: string;
    parameter: Record<string, string>;
    resultset: { count: number };
    processDateTime: string;
    status: string;
    message: string;
  };
  results: EdinetDocument[];
}

/**
 * 指定日付の EDINET 提出書類一覧を取得。
 *
 * @param date - YYYY-MM-DD 形式
 * @param type - 1=メタデータのみ, 2=メタデータ+書類リスト (デフォルト 2)
 */
export async function fetchEdinetDocList(
  date: string,
  type: 1 | 2 = 2
): Promise<EdinetDocListResponse | null> {
  const apiKey = process.env.EDINET_API_KEY;
  if (!apiKey) {
    throw new Error("EDINET_API_KEY is not set");
  }

  const url = new URL(`${EDINET_BASE}/documents.json`);
  url.searchParams.set("date", date);
  url.searchParams.set("type", String(type));
  url.searchParams.set("Subscription-Key", apiKey);

  try {
    const res = await fetch(url.toString(), {
      next: { revalidate: 3600 },  // 1時間キャッシュ
    });
    if (!res.ok) {
      console.error(`EDINET docList ${date} HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as EdinetDocListResponse;
    if (json.metadata?.status !== "200") {
      console.warn(`EDINET docList ${date} status: ${json.metadata?.status} ${json.metadata?.message}`);
    }
    return json;
  } catch (err) {
    console.error("EDINET fetch error:", err);
    return null;
  }
}

/**
 * 4桁ティッカーから EDINET の secCode (5桁形式) に変換
 * 7203 → "72030"
 */
export function tickerToSecCode(ticker: string): string {
  // 4桁数字 → "72030" (末尾0付加)
  // 3-4桁+英字 (例 "543A", "137A") → "543A0" (EDINET 形式に合わせる)
  if (/^\d{4}$/.test(ticker)) return `${ticker}0`;
  if (/^\d{3,4}[A-Z]$/.test(ticker)) return `${ticker}0`;
  return ticker;
}

/**
 * EDINET の secCode (5桁) を 4桁ティッカーに変換
 * "72030" → "7203"
 */
export function secCodeToTicker(secCode: string | null): string | null {
  if (!secCode) return null;
  if (/^\d{5}$/.test(secCode) && secCode.endsWith("0")) {
    return secCode.slice(0, 4);
  }
  return secCode;
}

/**
 * 大量保有報告書を分類
 *   docTypeCode "180" = 新規大量保有報告書 (新たに 5% を超えた)
 *   docTypeCode "220" = 変更報告書 (1% 以上の保有比率変動)
 */
export type LargeHoldingType = "initial" | "change" | "other";

export function classifyLargeHolding(doc: EdinetDocument): LargeHoldingType {
  if (doc.docTypeCode === "180") return "initial";
  if (doc.docTypeCode === "220") return "change";
  return "other";
}

/**
 * 書類タイトル例:
 *   "大量保有報告書（特例対象株券等）"
 *   "変更報告書（特例対象株券等）"
 * から保有者名、変動内容を雑に抽出
 */
export function parseLargeHoldingDescription(desc: string | null): {
  isReduce: boolean;        // 「売却」「減少」のキーワード
  isIncrease: boolean;      // 「取得」「増加」のキーワード
} {
  if (!desc) return { isReduce: false, isIncrease: false };
  const isReduce = /売却|減少|処分|譲渡/.test(desc);
  const isIncrease = /取得|増加|買付|追加/.test(desc);
  return { isReduce, isIncrease };
}

/**
 * 直近 N 日分の大量保有報告書を ticker でフィルタ取得
 * (EDINET は日付別にしか取れないので、N 日分を並列取得して filter)
 *
 * @param ticker - 4桁ティッカー
 * @param days - 過去何日分 (デフォルト 30)
 */
export async function fetchRecentLargeHoldings(
  ticker: string,
  days: number = 30
): Promise<EdinetDocument[]> {
  const secCode = tickerToSecCode(ticker);
  const targetCodes = [secCode];

  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() - i * 24 * 3600 * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }

  // 5並列で取得 (EDINETはレート制限あり、控えめに)
  const PARALLEL = 5;
  const allDocs: EdinetDocument[] = [];
  for (let i = 0; i < dates.length; i += PARALLEL) {
    const batch = dates.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map((d) => fetchEdinetDocList(d, 2)));
    for (const r of results) {
      if (!r?.results) continue;
      for (const doc of r.results) {
        if (
          doc.secCode &&
          targetCodes.includes(doc.secCode) &&
          (doc.docTypeCode === "180" || doc.docTypeCode === "220")
        ) {
          allDocs.push(doc);
        }
      }
    }
  }

  // 提出日時で降順ソート
  allDocs.sort((a, b) =>
    (b.submitDateTime ?? "").localeCompare(a.submitDateTime ?? "")
  );
  return allDocs;
}

/**
 * 一日分のドキュメントから大量保有関連だけを抽出 (cron用)
 * 全銘柄横断で取得し、Firestore にキャッシュする想定
 */
export async function fetchAllLargeHoldingsForDate(
  date: string
): Promise<EdinetDocument[]> {
  const r = await fetchEdinetDocList(date, 2);
  if (!r?.results) return [];
  return r.results.filter(
    (d) => d.docTypeCode === "180" || d.docTypeCode === "220"
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 業績予想 (会社ガイダンス) 抽出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 業績予想を含む書類タイプ: 120=有報, 140=四半期報告 */
const FORECAST_DOC_TYPES = ["120", "140"];

/**
 * 指定 ticker について、過去 N 日分の有報/四半期報を検索
 * (EDINET は日付別取得しかできないので、N 日並列取得)
 */
export async function fetchRecentReportDocs(
  ticker: string,
  days: number = 120
): Promise<EdinetDocument[]> {
  const secCode = tickerToSecCode(ticker);
  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() - i * 24 * 3600 * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }

  const PARALLEL = 8;
  const allDocs: EdinetDocument[] = [];
  for (let i = 0; i < dates.length; i += PARALLEL) {
    const batch = dates.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map((d) => fetchEdinetDocList(d, 2)));
    for (const r of results) {
      if (!r?.results) continue;
      for (const doc of r.results) {
        if (
          doc.secCode === secCode &&
          doc.docTypeCode &&
          FORECAST_DOC_TYPES.includes(doc.docTypeCode)
        ) {
          allDocs.push(doc);
        }
      }
    }
  }

  allDocs.sort((a, b) =>
    (b.submitDateTime ?? "").localeCompare(a.submitDateTime ?? "")
  );
  return allDocs;
}

/**
 * EDINET 書類の CSV (type=5) を取得。
 * 返り値は zip 内の主要 CSV を UTF-16 LE → string にデコードしたテキスト。
 * 失敗時は null。
 */
export async function fetchEdinetCsv(docID: string): Promise<string | null> {
  const apiKey = process.env.EDINET_API_KEY;
  if (!apiKey) throw new Error("EDINET_API_KEY is not set");

  const url = `${EDINET_BASE}/documents/${encodeURIComponent(docID)}?type=5&Subscription-Key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`EDINET CSV ${docID} HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // jszip + iconv-lite を遅延 import (cold start 軽減)
    const [{ default: JSZip }, iconv] = await Promise.all([
      import("jszip"),
      import("iconv-lite"),
    ]);
    const zip = await JSZip.loadAsync(buf);
    // メインの XBRL_TO_CSV 配下を結合 (複数 CSV があるので main らしきもの = 最大サイズ)
    const csvFiles = Object.values(zip.files).filter(
      (f) => !f.dir && /XBRL_TO_CSV\/.*\.csv$/i.test(f.name)
    );
    if (csvFiles.length === 0) return null;
    // 全ファイルを連結 (元素ID単位で行が分かれているので、行レベルなら問題ない)
    const parts: string[] = [];
    for (const f of csvFiles) {
      const raw = await f.async("nodebuffer");
      // EDINET CSV は UTF-16 LE + BOM
      parts.push(iconv.decode(raw, "utf16-le"));
    }
    return parts.join("\n");
  } catch (err) {
    console.error("EDINET CSV fetch/parse error:", err);
    return null;
  }
}

export interface ForecastRow {
  elementId: string;          // 要素ID (例: jpcrp_cor:ForecastNetSales)
  contextRef: string;         // コンテキスト (期間 + 連結/個別 + 当期/来期 など)
  value: string;              // 生の値 (数値文字列、∞など)
  unit: string;               // 単位 (JPY / shares / pure 等)
  itemName: string;           // 項目名 (日本語ラベル)
}

/**
 * EDINET CSV テキストから「予想」を含む行だけを抽出。
 * CSV ヘッダ (UTF-16 LE 想定): 要素ID, 項目名, コンテキストID, 相対年度, 連結・個別, 期間・時点, ユニットID, 単位, 値
 */
export function parseForecastRowsFromCsv(csvText: string): ForecastRow[] {
  if (!csvText) return [];
  const lines = csvText.split(/\r?\n/);
  const rows: ForecastRow[] = [];
  // ヘッダ行 (最初の "要素ID" を含む行) を見つけてスキップ
  let headerSkipped = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!headerSkipped) {
      if (line.includes("要素ID") || line.toLowerCase().includes("element")) {
        headerSkipped = true;
        continue;
      }
    }
    // タブ区切り (EDINET CSV は実体はTSV)
    const cols = line.split("\t");
    if (cols.length < 9) continue;
    const elementId = cols[0]?.trim();
    const itemName = cols[1]?.trim();
    const contextRef = cols[2]?.trim();
    const unit = cols[7]?.trim();
    const value = cols[8]?.trim();
    // 「予想」「Forecast」を含む elementId or itemName だけ拾う
    const isForecast =
      /Forecast|forecast/i.test(elementId) ||
      /予想/.test(itemName) ||
      /Forecast/i.test(contextRef);
    if (!isForecast) continue;
    rows.push({ elementId, contextRef, value, unit, itemName });
  }
  return rows;
}
