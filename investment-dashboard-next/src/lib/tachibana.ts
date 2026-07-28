/**
 * 立花証券 e支店 API (v4r9) クライアント
 *
 * 仕様:
 *   - HTTPS GET, JSON, ShiftJIS
 *   - 認証はRSA-2048 + OAEP/SHA-256 で仮想URLが暗号化される
 *   - 認証成功後、4種類の仮想URLが返る (REQUEST/MASTER/PRICE/EVENT)
 *
 * 環境変数:
 *   TACHIBANA_ENV          - "demo" or "prod" (default: "demo")
 *   TACHIBANA_AUTH_ID      - 認証ID (e_api_authid.txt の中身)
 *   TACHIBANA_PRIVATE_KEY  - PEM形式の秘密鍵 (改行は \\n でエスケープ可)
 *   TACHIBANA_SECOND_PASSWORD - 第二暗証番号 (発注機能を使うなら、現在は未使用)
 */

import crypto from "crypto";
import iconv from "iconv-lite";
import { COLUMNS } from "./tachibana-columns";

/**
 * 立花APIのレスポンスは圧縮形式（カラム名が数値IDに変換されている）。
 * JSONキー（1-based）→ COLUMNS[key-1] のカラム名 に逆変換する。
 */
function uncompress<T = Record<string, unknown>>(raw: unknown): T {
  if (Array.isArray(raw)) {
    return raw.map((v) => uncompress(v)) as T;
  }
  if (raw && typeof raw === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const numKey = Number(k);
      const name =
        !Number.isNaN(numKey) && numKey >= 1 && numKey <= COLUMNS.length
          ? COLUMNS[numKey - 1]
          : k;
      result[name] = uncompress(v);
    }
    return result as T;
  }
  return raw as T;
}

const ENV = process.env.TACHIBANA_ENV ?? "demo";
const BASE_URL =
  ENV === "prod"
    ? "https://kabuka.e-shiten.jp/e_api_v4r9"
    : "https://demo-kabuka.e-shiten.jp/e_api_v4r9";

const AUTH_ID = process.env.TACHIBANA_AUTH_ID ?? "";
const PRIVATE_KEY_RAW = process.env.TACHIBANA_PRIVATE_KEY ?? "";

function getPrivateKey(): crypto.KeyObject {
  // Vercel等の環境変数では改行が \n で来ることが多いので両方対応
  const pem = PRIVATE_KEY_RAW.includes("\\n")
    ? PRIVATE_KEY_RAW.replace(/\\n/g, "\n")
    : PRIVATE_KEY_RAW;
  return crypto.createPrivateKey(pem);
}

/**
 * 仮想URL（暗号化文字列）を秘密鍵で復号する。
 *
 * 立花の仮想URL は base64-encoded RSA-OAEP/SHA-256 暗号文として配信される。
 */
function decryptVirtualUrl(encrypted: string): string {
  const privateKey = getPrivateKey();
  const buf = Buffer.from(encrypted, "base64");
  const decrypted = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    buf
  );
  // trim trailing whitespace/newlines (Tachibana adds these to the plaintext)
  return decrypted.toString("utf8").trim();
}

/**
 * 立花API用のタイムスタンプ形式 (JST固定)
 *   "yyyy.mm.dd-hh:mn:ss.ttt"
 *   立花サーバはJSTで時刻チェックするのでサーバ実行環境(UTC等)に依存させない
 */
function formatSdDate(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  // JST = UTC + 9h
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return (
    `${jst.getUTCFullYear()}.${pad(jst.getUTCMonth() + 1)}.${pad(jst.getUTCDate())}-` +
    `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}.` +
    pad(jst.getUTCMilliseconds(), 3)
  );
}

/**
 * 立花APIリクエスト送信（共通）
 *   URLパラメータに JSON文字列を直接埋め込む
 *   応答は ShiftJIS なので utf-8 に変換
 */
async function tachibanaRequest<T = Record<string, unknown>>(
  url: string,
  payload: Record<string, string>,
  sequence: number = 1
): Promise<T> {
  const fullPayload = {
    p_no: String(sequence),
    p_sd_date: formatSdDate(),
    ...payload,
  };

  // URLエンコード（JSON文字列をクエリパラメータとして渡す）
  const jsonStr = JSON.stringify(fullPayload);
  const requestUrl = `${url}?${encodeURIComponent(jsonStr)}`;

  const res = await fetch(requestUrl, {
    headers: {
      "User-Agent": "Cavka/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Tachibana API error: ${res.status} ${res.statusText} — ${requestUrl}`
    );
  }

  // ShiftJIS -> UTF-8 変換
  const arrayBuffer = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  const text = iconv.decode(buf, "Shift_JIS");
  const compressed = JSON.parse(text);
  return uncompress<T>(compressed);
}

// ── 型定義 ──────────────────────────────────────────────
export interface TachibanaLoginResponse {
  sCLMID: string;
  sResultCode: string;
  sResultText: string;
  sUrlRequest: string;
  sUrlMaster: string;
  sUrlPrice: string;
  sUrlEvent: string;
  sUrlEventWebSocket: string;
  sLastLoginDate: string;
  sKinsyouhouMidokuFlg: string;
  [key: string]: unknown;
}

export interface TachibanaSession {
  urlRequest: string;
  urlMaster: string;
  urlPrice: string;
  urlEvent: string;
  urlEventWebSocket: string;
  lastLoginDate: string;
  raw: TachibanaLoginResponse;
  /** 送信通番カウンタ（前回より大きい値を送る必要がある） */
  sequence: { value: number };
}

export interface TachibanaHolding {
  ticker: string;          // sUriOrderIssueCode
  zyoutoekiKazei: string;  // 譲渡益課税区分 1:特定 3:一般 5:NISA
  shares: number;          // 残高株数
  saleableShares: number;  // 売付可能株数
  avgCost: number;         // 概算簿価単価
  evalPrice: number;       // 評価単価
  evalAmount: number;      // 評価金額
  pnl: number;             // 評価損益
  pnlRate: number;         // 評価損益率(%)
  prevClose: number | null;
  prevDiff: number | null;
  prevDiffPct: number | null;
}

export interface TachibanaHoldingsResponse {
  holdings: TachibanaHolding[];
  totalEvalAmount: number;
  totalPnl: number;
  raw: Record<string, unknown>;
}

// ── 認証 ──────────────────────────────────────────────
/**
 * 立花APIにログインして仮想URLを取得する。
 */
export async function tachibanaLogin(): Promise<TachibanaSession> {
  if (!AUTH_ID) {
    throw new Error("TACHIBANA_AUTH_ID is not set");
  }
  if (!PRIVATE_KEY_RAW) {
    throw new Error("TACHIBANA_PRIVATE_KEY is not set");
  }

  const sequence = { value: 1 };
  const res = await tachibanaRequest<TachibanaLoginResponse>(
    `${BASE_URL}/auth/`,
    {
      sCLMID: "CLMAuthLoginRequest",
      sAuthId: AUTH_ID,
    },
    sequence.value
  );

  if (res.sResultCode !== "0") {
    throw new Error(
      `Tachibana login failed: ${res.sResultCode} - ${res.sResultText} (p_errno=${res.p_errno} p_err=${res.p_err})`
    );
  }

  if (res.sKinsyouhouMidokuFlg === "1") {
    throw new Error(
      "金商法交付書面が未読です。標準Webで既読操作を行ってください。"
    );
  }

  // 仮想URLは暗号化されているので復号
  return {
    urlRequest: decryptVirtualUrl(res.sUrlRequest),
    urlMaster: decryptVirtualUrl(res.sUrlMaster),
    urlPrice: decryptVirtualUrl(res.sUrlPrice),
    urlEvent: decryptVirtualUrl(res.sUrlEvent),
    urlEventWebSocket: res.sUrlEventWebSocket
      ? decryptVirtualUrl(res.sUrlEventWebSocket)
      : "",
    lastLoginDate: res.sLastLoginDate,
    raw: res,
    sequence,
  };
}

/**
 * ログアウト。仮想URLが無効化される。
 */
export async function tachibanaLogout(session: TachibanaSession): Promise<void> {
  session.sequence.value++;
  await tachibanaRequest(
    session.urlRequest,
    { sCLMID: "CLMAuthLogoutRequest" },
    session.sequence.value
  );
}

// ── 業務機能 ──────────────────────────────────────────
/**
 * 現物保有銘柄一覧を取得する。
 */
export async function getHoldings(
  session: TachibanaSession,
  ticker?: string
): Promise<TachibanaHoldingsResponse> {
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlRequest,
    {
      sCLMID: "CLMGenbutuKabuList",
      sIssueCode: ticker ?? "",
    },
    session.sequence.value
  );

  if (res.sResultCode !== "0") {
    throw new Error(
      `Failed to get holdings: ${res.sResultCode} - ${res.sResultText}`
    );
  }

  const list = (res.aGenbutuKabuList ?? []) as Array<Record<string, string>>;
  const holdings: TachibanaHolding[] = list.map((h) => ({
    ticker: h.sUriOrderIssueCode,
    zyoutoekiKazei: h.sUriOrderZyoutoekiKazeiC,
    shares: Number(h.sUriOrderZanKabuSuryou ?? 0),
    saleableShares: Number(h.sUriOrderUritukeKanouSuryou ?? 0),
    avgCost: Number(h.sUriOrderGaisanBokaTanka ?? 0),
    evalPrice: Number(h.sUriOrderHyoukaTanka ?? 0),
    evalAmount: Number(h.sUriOrderGaisanHyoukagaku ?? 0),
    pnl: Number(h.sUriOrderGaisanHyoukaSoneki ?? 0),
    pnlRate: Number(h.sUriOrderGaisanHyoukaSonekiRitu ?? 0),
    prevClose: h.sSyuzituOwarine ? Number(h.sSyuzituOwarine) : null,
    prevDiff: h.sZenzituHi ? Number(h.sZenzituHi) : null,
    prevDiffPct: h.sZenzituHiPer ? Number(h.sZenzituHiPer) : null,
  }));

  return {
    holdings,
    totalEvalAmount: Number(res.sTotalGaisanHyoukagakuGoukei ?? 0),
    totalPnl: Number(res.sTotalGaisanHyoukaSonekiGoukei ?? 0),
    raw: res,
  };
}

/**
 * 買余力（取引可能額）を取得する。
 */
export async function getBuyingPower(
  session: TachibanaSession
): Promise<Record<string, unknown>> {
  session.sequence.value++;
  return tachibanaRequest(
    session.urlRequest,
    { sCLMID: "CLMZanKaiKanougaku" },
    session.sequence.value
  );
}

// ── 時価情報（板情報含む） ───────────────────────────
export interface OrderBookLevel {
  price: number | null;
  quantity: number | null;
}

export interface TachibanaMarketQuote {
  ticker: string;
  currentPrice: number | null;
  priceTime: string | null;       // "HH:MM"
  prevClose: number | null;
  changeAbs: number | null;       // 前日比 ¥
  changePct: number | null;       // 前日比 %
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  vwap: number | null;
  volume: number | null;          // 累計出来高
  turnover: number | null;        // 売買代金
  marketStatus: string | null;    // 現値前値比較フラグ (0057: ↑, 0058: ↓ など)
  // 板情報 (1=最良気配, 10=最深)
  bids: OrderBookLevel[];         // 買い気配 [1..10]
  asks: OrderBookLevel[];         // 売り気配 [1..10]
  // 成行
  marketBidQty: number | null;    // 買い成行数量
  marketAskQty: number | null;    // 売り成行数量
  // 板の外側 (10段より上/下の総数量)。OVERが減らないブレイクはダマシ、の検証用
  overQty: number | null;         // OVER (上値の潜在売り総量)
  underQty: number | null;        // UNDER (下値の潜在買い総量)
}

/**
 * 時価情報（板情報含む）を取得。最大120銘柄。
 * 立花の PRICE I/F (urlPrice) を使う。
 */
export async function getMarketQuotes(
  session: TachibanaSession,
  tickers: string[]
): Promise<TachibanaMarketQuote[]> {
  if (tickers.length === 0) return [];

  // 取得する情報コード（型+コード）一覧
  // p=価格, t=時刻
  const cols: string[] = [
    "pDPP",        // 現在値
    "tDPP:T",      // 現在値時刻
    "pPRP",        // 前日終値
    "pDYWP",       // 前日比
    "pDYRP",       // 騰落率
    "pDOP",        // 始値
    "pDHP",        // 高値
    "pDLP",        // 安値
    "pDV",         // 出来高
    "pDJ",         // 売買代金
    "pVWAP",       // VWAP
    "pDPG",        // 現値前値比較
    "pAAV",        // 売数量(成行)
    "pAV",         // 買数量(成行)
    "pQOV",        // OVER (板10段より上の売り総量)
    "pQUV",        // UNDER (板10段より下の買い総量)
  ];
  // 板10段
  for (let i = 1; i <= 10; i++) {
    cols.push(`pGAP${i}`, `pGAV${i}`, `pGBP${i}`, `pGBV${i}`);
  }

  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlPrice,
    {
      sCLMID: "CLMMfdsGetMarketPrice",
      sTargetIssueCode: tickers.slice(0, 120).join(","),
      sTargetColumn: cols.join(","),
    },
    session.sequence.value
  );

  if (res.p_err) {
    throw new Error(`getMarketQuotes failed: ${res.p_err}`);
  }

  const arr = (res.aCLMMfdsMarketPrice ?? []) as Array<Record<string, string>>;

  const num = (v: string | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return arr.map((r) => {
    const bids: OrderBookLevel[] = [];
    const asks: OrderBookLevel[] = [];
    for (let i = 1; i <= 10; i++) {
      bids.push({
        price: num(r[`pGBP${i}`]),
        quantity: num(r[`pGBV${i}`]),
      });
      asks.push({
        price: num(r[`pGAP${i}`]),
        quantity: num(r[`pGAV${i}`]),
      });
    }

    return {
      ticker: r.sIssueCode,
      currentPrice: num(r.pDPP),
      priceTime: r["tDPP:T"] ?? null,
      prevClose: num(r.pPRP),
      changeAbs: num(r.pDYWP),
      changePct: num(r.pDYRP),
      openPrice: num(r.pDOP),
      highPrice: num(r.pDHP),
      lowPrice: num(r.pDLP),
      vwap: num(r.pVWAP),
      volume: num(r.pDV),
      turnover: num(r.pDJ),
      marketStatus: r.pDPG ?? null,
      bids,
      asks,
      marketBidQty: num(r.pAV),
      marketAskQty: num(r.pAAV),
      overQty: num(r.pQOV),
      underQty: num(r.pQUV),
    };
  });
}

// ── 全銘柄マスタ ────────────────────────────────────
export interface JpStockMaster {
  ticker: string;
  name: string;
}

/**
 * 全上場銘柄マスタを取得 (MASTER I/F)
 *  - 国内株式: CLMIssueMstKabu (約4000銘柄)
 *  - 指数: CLMIssueMstIndex
 *  - その他: CLMIssueMstOther
 */
export async function getAllJpStocks(
  session: TachibanaSession
): Promise<JpStockMaster[]> {
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlMaster,
    {
      sCLMID: "CLMMfdsGetMasterData",
      sTargetCLMID: "CLMIssueMstKabu",
      sTargetColumn: "sIssueCode,sIssueName",
    },
    session.sequence.value
  );

  if (res.p_err) throw new Error(`getAllJpStocks failed: ${res.p_err}`);

  const arr = (res.CLMIssueMstKabu ?? []) as Array<Record<string, string>>;
  return arr
    .filter((r) => r.sIssueCode && r.sIssueName)
    .map((r) => ({ ticker: r.sIssueCode, name: r.sIssueName }));
}

// ── 信用残・証金残・逆日歩 ────────────────────────
export interface MarginBalance {
  ticker: string;
  date: string;             // YYYY/MM/DD
  // 買残 (一般/制度/合算)
  longGeneral: number | null;
  longRegulated: number | null;
  longTotal: number | null;
  // 売残 (一般/制度/合算)
  shortGeneral: number | null;
  shortRegulated: number | null;
  shortTotal: number | null;
  // 前週比
  longChangeGeneral: number | null;
  longChangeRegulated: number | null;
  longChangeTotal: number | null;
  shortChangeGeneral: number | null;
  shortChangeRegulated: number | null;
  shortChangeTotal: number | null;
  // 信用倍率 = 買残/売残
  ratioGeneral: number | null;
  ratioRegulated: number | null;
  ratioTotal: number | null;
}

/**
 * 信用残情報取得 (週次更新、毎週金曜時点)
 *  - 買残 (long): 信用買いで保有中の残高
 *  - 売残 (short): 信用売りで保有中の残高
 *  - 信用倍率 = 買残/売残: 高いほど買い偏重、低いと売り偏重
 *  - 取り組み妙味: 売残>買残 (倍率<1) で踏み上げ候補
 */
export async function getMarginBalances(
  session: TachibanaSession,
  tickers: string[]
): Promise<MarginBalance[]> {
  if (tickers.length === 0) return [];
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlMaster,
    {
      sCLMID: "CLMMfdsGetShinyouZan",
      sTargetIssueCode: tickers.slice(0, 120).join(","),
    },
    session.sequence.value
  );
  if (res.p_err) throw new Error(`getMarginBalances failed: ${res.p_err}`);

  const arr = (res.aCLMMfdsShinyouZan ?? []) as Array<Record<string, string>>;
  const num = (v: string | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return arr.map((r) => ({
    ticker: r.sIssueCode,
    date: r.pMBD ?? "",
    longGeneral: num(r.pMBB3),
    longRegulated: num(r.pMBB6),
    longTotal: num(r.pMBBQ),
    shortGeneral: num(r.pMBS3),
    shortRegulated: num(r.pMBS6),
    shortTotal: num(r.pMBSQ),
    longChangeGeneral: num(r.pMBN3),
    longChangeRegulated: num(r.pMBN6),
    longChangeTotal: num(r.pMBNQ),
    shortChangeGeneral: num(r.pMBC3),
    shortChangeRegulated: num(r.pMBC6),
    shortChangeTotal: num(r.pMBCQ),
    ratioGeneral: num(r.pMBR3),
    ratioRegulated: num(r.pMBR6),
    ratioTotal: num(r.pMBRQ),
  }));
}

export interface NegativeInterest {
  ticker: string;
  rate: number | null;       // 逆日歩 (¥/株/日)
}

/**
 * 逆日歩情報 (日次)
 *  - 制度信用取引で空売りした株を借りるコスト
 *  - 値が大きい = 売り方が多く品薄 = 踏み上げ予兆
 *  - 0 = 逆日歩なし (通常)
 */
export async function getNegativeInterest(
  session: TachibanaSession,
  tickers: string[]
): Promise<NegativeInterest[]> {
  if (tickers.length === 0) return [];
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlMaster,
    {
      sCLMID: "CLMMfdsGetHibuInfo",
      sTargetIssueCode: tickers.slice(0, 120).join(","),
    },
    session.sequence.value
  );
  if (res.p_err) throw new Error(`getNegativeInterest failed: ${res.p_err}`);

  const arr = (res.aCLMMfdsHibuInfo ?? []) as Array<Record<string, string>>;
  const num = (v: string | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return arr.map((r) => ({
    ticker: r.sIssueCode,
    rate: num(r.pBWRQ),
  }));
}

export interface SyoukinBalance {
  ticker: string;
  date: string;                  // YYYY/MM/DD
  status: string | null;          // 1:速報, 2:確報
  loan: number | null;            // 証金融資残
  loanNew: number | null;
  loanReturn: number | null;
  loanChangePrev: number | null;  // 前日比
  stockLent: number | null;       // 証金貸株残
  stockLentNew: number | null;
  stockLentReturn: number | null;
  stockLentChangePrev: number | null;
  netBalance: number | null;      // 差引残
  netBalanceChangePrev: number | null;
  ratio: number | null;            // 貸借倍率
  rotationDays: number | null;    // 回転日数
}

/**
 * 証金残情報 (証券金融会社の融資・貸株状況)
 *  - 速報(1)/確報(2) ステータスあり
 *  - 貸株急増 = 売り方増加の兆候
 *  - 貸借倍率 = 融資/貸株: 低い (1未満) ほど踏み上げ警戒
 */
export async function getSyoukinBalances(
  session: TachibanaSession,
  tickers: string[]
): Promise<SyoukinBalance[]> {
  if (tickers.length === 0) return [];
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlMaster,
    {
      sCLMID: "CLMMfdsGetSyoukinZan",
      sTargetIssueCode: tickers.slice(0, 120).join(","),
    },
    session.sequence.value
  );
  if (res.p_err) throw new Error(`getSyoukinBalances failed: ${res.p_err}`);

  const arr = (res.aCLMMfdsSyoukinZan ?? []) as Array<Record<string, string>>;
  const num = (v: string | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return arr.map((r) => ({
    ticker: r.sIssueCode,
    date: r.pSFD ?? "",
    status: r.pSFKS ?? null,
    loan: num(r.pSFF6),
    loanNew: num(r.pSFL6),
    loanReturn: num(r.pSFP6),
    loanChangePrev: num(r.pSFG6),
    stockLent: num(r.pSFS6),
    stockLentNew: num(r.pSSL6),
    stockLentReturn: num(r.pSSP6),
    stockLentChangePrev: num(r.pSSG6),
    netBalance: num(r.pSFN6),
    netBalanceChangePrev: num(r.pSFC6),
    ratio: num(r.pSFR6),
    rotationDays: num(r.pSFD6),
  }));
}

// ── ニュース機能 ────────────────────────────────────
export interface TachibanaNewsHeader {
  id: string;          // ニュースID (例: "20230512153000_OBM9789")
  date: string;        // YYYYMMDD
  time: string;        // HHMM
  categories: string[];
  genres: string[];
  relatedTickers: string[];
  headline: string;    // デコード済み日本語タイトル
}

export interface TachibanaNewsBody extends TachibanaNewsHeader {
  body: string;        // デコード済み日本語本文
}

/**
 * BASE64 文字列を Shift-JIS としてデコードして UTF-8 文字列に変換。
 * 立花のニュースは BASE64 -> URL Encoded (%XX) -> Shift-JIS の 2段エンコード。
 */
function decodeShiftJisBase64(b64: string): string {
  if (!b64) return "";
  const buf = Buffer.from(b64, "base64");
  // 結果は URL encoded された Shift-JIS バイト列の ASCII 表現
  const urlEncoded = buf.toString("latin1");
  // %XX を生バイトに戻す → Shift-JIS デコード
  try {
    const decodedBytes: number[] = [];
    let i = 0;
    while (i < urlEncoded.length) {
      const ch = urlEncoded[i];
      if (ch === "%" && i + 2 < urlEncoded.length) {
        const hex = urlEncoded.substr(i + 1, 2);
        decodedBytes.push(parseInt(hex, 16));
        i += 3;
      } else {
        decodedBytes.push(urlEncoded.charCodeAt(i));
        i++;
      }
    }
    return iconv.decode(Buffer.from(decodedBytes), "Shift_JIS");
  } catch {
    // フォールバック: 直接 Shift-JIS として読む
    return iconv.decode(buf, "Shift_JIS");
  }
}

/**
 * ニュースヘッダー一覧取得
 *  銘柄コード絞り込み・期間絞り込み可。最大100件。
 *  注意: MASTER I/F を使う (urlMaster)
 */
export async function getNewsHeaders(
  session: TachibanaSession,
  options: {
    issueCode?: string;       // 銘柄コード (1つのみ)
    dateFrom?: string;        // YYYYMMDD
    dateTo?: string;          // YYYYMMDD
    offset?: number;
    limit?: number;           // 最大100
  } = {}
): Promise<{ total: number; items: TachibanaNewsHeader[] }> {
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlMaster,
    {
      sCLMID: "CLMMfdsGetNewsHead",
      p_IS: options.issueCode ?? "",
      p_DT_FROM: options.dateFrom ?? "",
      p_DT_TO: options.dateTo ?? "",
      p_REC_OFST: String(options.offset ?? 0),
      p_REC_LIMT: String(options.limit ?? 30),
    },
    session.sequence.value
  );

  // 注意: このAPIには sResultCode が無い場合がある (圧縮形式の挙動)
  // 異常時は p_err が入る
  if (res.p_err) {
    throw new Error(`getNewsHeaders failed: ${res.p_err}`);
  }

  const list = (res.aCLMMfdsNewsHead ?? []) as Array<Record<string, string>>;
  const items: TachibanaNewsHeader[] = list.map((n) => ({
    id: n.p_ID,
    date: n.p_DT,
    time: n.p_TM,
    categories: (n.p_CGL ?? "").split("|").filter(Boolean),
    genres: (n.p_GNL ?? "").split("|").filter(Boolean),
    relatedTickers: (n.p_ISL ?? "").split("|").filter(Boolean),
    headline: decodeShiftJisBase64(n.p_HDL ?? ""),
  }));

  return {
    total: Number(res.p_REC_MAX ?? items.length),
    items,
  };
}

/**
 * ニュース本文取得 (1件)
 */
export async function getNewsBody(
  session: TachibanaSession,
  newsId: string
): Promise<TachibanaNewsBody | null> {
  session.sequence.value++;
  const res = await tachibanaRequest<Record<string, unknown>>(
    session.urlMaster,
    { sCLMID: "CLMMfdsGetNewsBody", p_ID: newsId },
    session.sequence.value
  );

  if (res.p_err) {
    throw new Error(`getNewsBody failed: ${res.p_err}`);
  }

  const arr = res.aCLMMfdsNewsBody as Array<Record<string, string>> | undefined;
  if (!arr || arr.length === 0) return null;
  const n = arr[0];
  return {
    id: n.p_ID,
    date: n.p_DT,
    time: n.p_TM,
    categories: (n.p_CGL ?? "").split("|").filter(Boolean),
    genres: (n.p_GNL ?? "").split("|").filter(Boolean),
    relatedTickers: (n.p_ISL ?? "").split("|").filter(Boolean),
    headline: decodeShiftJisBase64(n.p_HDL ?? ""),
    body: decodeShiftJisBase64(n.p_TX ?? ""),
  };
}
