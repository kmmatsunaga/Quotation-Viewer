import { getAdminDb } from "./firebase-admin";

export interface JpStockMaster {
  ticker: string;
  name: string;
}

// メモリキャッシュ (Vercel serverless 単一インスタンス内のみ有効)
let memCache: { stocks: JpStockMaster[]; loadedAt: number } | null = null;
const MEM_TTL = 60 * 60 * 1000; // 1時間

/**
 * Firestore の meta/jpStockMaster から全銘柄リストを取得。
 * メモリキャッシュも併用。
 */
export async function getCachedJpStocks(): Promise<JpStockMaster[]> {
  if (memCache && Date.now() - memCache.loadedAt < MEM_TTL) {
    return memCache.stocks;
  }
  try {
    const db = getAdminDb();
    const snap = await db.collection("meta").doc("jpStockMaster").get();
    if (!snap.exists) return [];
    const data = snap.data();
    const stocks = (data?.stocks ?? []) as JpStockMaster[];
    memCache = { stocks, loadedAt: Date.now() };
    return stocks;
  } catch (err) {
    console.error("Failed to load cached JP stocks:", err);
    return [];
  }
}
