import { NextRequest, NextResponse } from "next/server";
import { tachibanaLogin, tachibanaLogout, getNewsHeaders } from "@/lib/tachibana";

/**
 * GET /api/market/news?limit=10
 *
 * 市場全体ニュース。立花APIから取得。認証不要。
 * （立花の認証ID/秘密鍵はサーバ側で持っているため）
 */
export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "10"), 50);

  // 過去7日
  const fmtJst = (d: Date) => {
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
  };
  const today = new Date();
  const past = new Date();
  past.setDate(past.getDate() - 7);

  let session = null;
  try {
    session = await tachibanaLogin();
    const result = await getNewsHeaders(session, {
      dateFrom: fmtJst(past),
      dateTo: fmtJst(today),
      limit,
    });

    // 旧API形式に揃える
    const items = result.items.map((n) => ({
      title: n.headline,
      url: "#",
      publisher: extractPublisher(n.headline),
      published: formatPublishedDate(n.date, n.time),
    }));

    return NextResponse.json(items);
  } catch (err) {
    console.error("Market news error:", err);
    return NextResponse.json([], { status: 500 });
  } finally {
    if (session) await tachibanaLogout(session).catch(() => {});
  }
}

function extractPublisher(headline: string): string {
  const m = headline.match(/^<([^>]+)>/);
  return m ? m[1] : "立花配信";
}

function formatPublishedDate(date: string, time: string): string {
  // YYYYMMDD + HHMM → ISO
  if (date.length !== 8 || time.length !== 4) return new Date().toISOString();
  const y = date.slice(0, 4);
  const m = date.slice(4, 6);
  const d = date.slice(6, 8);
  const h = time.slice(0, 2);
  const mn = time.slice(2, 4);
  // JSTとして扱う
  return `${y}-${m}-${d}T${h}:${mn}:00+09:00`;
}
