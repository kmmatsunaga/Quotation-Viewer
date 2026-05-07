import {
  collection,
  doc,
  getDocs,
  setDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";

export interface PortfolioSnapshot {
  date: string; // YYYY-MM-DD
  totalValue: number;
  totalCost: number;
  holdingsCount: number;
}

/**
 * ポートフォリオのスナップショットを日次で保存
 * 同じ日付のものがあれば上書き
 */
export async function savePortfolioSnapshot(
  uid: string,
  snapshot: PortfolioSnapshot
): Promise<void> {
  const ref = doc(db, "users", uid, "portfolio_snapshots", snapshot.date);
  await setDoc(ref, {
    ...snapshot,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 直近 N 日分のスナップショットを取得（昇順 = 古い順）
 */
export async function getPortfolioSnapshots(
  uid: string,
  days: number = 90
): Promise<PortfolioSnapshot[]> {
  const col = collection(db, "users", uid, "portfolio_snapshots");
  const q = query(col, orderBy("date", "desc"), limit(days));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data() as PortfolioSnapshot)
    .reverse(); // 古い順に並べ替え
}
