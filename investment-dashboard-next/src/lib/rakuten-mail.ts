/**
 * 楽天証券「国内株式の注文が約定しました」メールのパーサー。
 *
 * 対象は現物のみ (信用・投資信託は除外)。1通=1約定 (部分約定は同一注文番号で複数通)。
 * HTML メール本文からテーブルの値を正規表現で抜く。純関数なのでサーバ/テスト双方で使える。
 *
 * 実データで検証済みのフィールド:
 *   銘柄名：日本航空(92010)   ← 5桁は末尾0を落として4桁 ticker (9201)
 *   市場：東証 / 取引：現物 / 売買：買付 or 売付
 *   約定単価：3,139円 / 約定数量：100株（口） / 約定日時：2026/7/7 9:07
 *   口座区分：特定 / 注文番号：0871
 */

export interface RakutenFill {
  ticker: string;          // 4桁 (末尾英字含む場合あり)
  name: string;
  side: "buy" | "sell";    // 買付 / 売付
  price: number;           // 約定単価 (円)
  qty: number;             // 約定数量 (株)
  executedAt: string;      // ISO datetime (JST)
  orderNo: string;         // 注文番号 (部分約定は共通)
  account: string;         // 口座区分 (特定/一般/NISA…)
  msgId: string;           // Gmail Message-ID
  fillKey: string;         // 重複排除キー (msgId 単位で一意)
}

/** HTML からタグを剥がしてプレーンテキスト化 */
function stripTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t　]+/g, " ")
    .replace(/\s*\n\s*/g, "\n");
}

function field(text: string, label: string): string | null {
  const m = text.match(new RegExp(`${label}\\s*[:：]?\\s*([^\\n]+)`));
  return m ? m[1].trim() : null;
}

/** 5桁銘柄コード (末尾0) を4桁 ticker に。末尾英字コード (例 130A0) も考慮 */
function normalizeTicker(code: string): string {
  if (code.length === 5) return code.slice(0, 4);
  return code;
}

/**
 * 約定メール HTML を1件パース。現物約定でなければ null。
 * @param dateHeaderMs メールの Date ヘッダ (約定日時が取れない時のフォールバック用, epoch ms)
 */
export function parseRakutenFill(
  html: string,
  msgId: string,
  dateHeaderMs?: number,
): RakutenFill | null {
  const text = stripTags(html);

  // 約定通知でなければ弾く (投信・入出金など)
  if (!/国内株式の注文が約定しました/.test(text)) return null;

  const torihiki = field(text, "取引");
  if (torihiki && !/現物/.test(torihiki)) return null; // 信用は現状スコープ外

  // 楽天は末尾に検証桁を付けた5文字コードを使う: 92010→9201, 285A0→285A (キオクシア等の英字コード)。
  // 3〜4桁数字 + 英数字0〜2文字 を捕捉し、normalizeTicker で4文字に正規化する。
  const nameMatch = text.match(/銘柄名\s*[:：]\s*(.+?)\((\d{3,4}[0-9A-Z]{0,2})\)/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  const ticker = normalizeTicker(nameMatch[2]);

  const baibai = field(text, "売買");
  const side: "buy" | "sell" | null = baibai
    ? /売付/.test(baibai)
      ? "sell"
      : /買付/.test(baibai)
        ? "buy"
        : null
    : null;
  if (!side) return null;

  const priceRaw = field(text, "約定単価");
  const price = priceRaw ? parseFloat(priceRaw.replace(/[^\d.]/g, "")) : NaN;
  const qtyRaw = field(text, "約定数量");
  const qty = qtyRaw ? parseInt(qtyRaw.replace(/[^\d]/g, ""), 10) : NaN;
  if (!isFinite(price) || !isFinite(qty) || qty <= 0) return null;

  const dtRaw = field(text, "約定日時"); // "2026/7/7 9:07"
  const executedAt = parseJstDatetime(dtRaw, dateHeaderMs);

  const orderNo = (field(text, "注文番号") || "").replace(/[^\dA-Za-z]/g, "") || "?";
  const account = field(text, "口座区分") || "";

  return {
    ticker,
    name,
    side,
    price,
    qty,
    executedAt,
    orderNo,
    account,
    msgId,
    fillKey: `rk:${msgId}`,
  };
}

/** "2026/7/7 9:07" (JST) を ISO 文字列に。失敗時は Date ヘッダにフォールバック */
function parseJstDatetime(raw: string | null, fallbackMs?: number): string {
  if (raw) {
    const m = raw.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    if (m) {
      const [, y, mo, d, h, mi] = m;
      const pad = (s: string) => s.padStart(2, "0");
      // JST 固定 (+09:00)
      return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+09:00`;
    }
  }
  if (fallbackMs) return new Date(fallbackMs).toISOString();
  return new Date(0).toISOString();
}
