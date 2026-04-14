import {
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ユーザーごとのコレクションパスを返す
function userCol(uid: string, name: string) {
  return collection(db, "users", uid, name);
}

// ============================================================
// Holdings（保有銘柄）
// ============================================================
export interface Holding {
  id?: string;
  ticker: string;
  name: string;
  shares: number;
  avgCost: number;
  market: string;
  memo: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export async function getHoldings(uid: string): Promise<Holding[]> {
  const q = query(userCol(uid, "holdings"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Holding));
}

export async function addHolding(uid: string, data: Omit<Holding, "id" | "createdAt" | "updatedAt">) {
  return addDoc(userCol(uid, "holdings"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateHolding(uid: string, id: string, data: Partial<Holding>) {
  const ref = doc(db, "users", uid, "holdings", id);
  return updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

export async function deleteHolding(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "holdings", id));
}

// ============================================================
// Watchlist（お気に入り）
// ============================================================
export interface WatchlistItem {
  id?: string;
  ticker: string;
  name: string;
  market: string;
  addedAt?: Timestamp;
}

export async function getWatchlist(uid: string): Promise<WatchlistItem[]> {
  const q = query(userCol(uid, "watchlist"), orderBy("addedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as WatchlistItem));
}

export async function addToWatchlist(uid: string, data: Omit<WatchlistItem, "id" | "addedAt">) {
  return addDoc(userCol(uid, "watchlist"), {
    ...data,
    addedAt: serverTimestamp(),
  });
}

export async function removeFromWatchlist(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "watchlist", id));
}

// ============================================================
// Alerts（価格アラート）
// ============================================================
export interface PriceAlert {
  id?: string;
  ticker: string;
  name: string;
  condition: "above" | "below";
  targetPrice: number;
  active: boolean;
  triggered: boolean;
  triggeredAt?: Timestamp | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export async function getAlerts(uid: string): Promise<PriceAlert[]> {
  const q = query(userCol(uid, "alerts"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as PriceAlert));
}

export async function addAlert(uid: string, data: Omit<PriceAlert, "id" | "active" | "triggered" | "createdAt" | "updatedAt">) {
  return addDoc(userCol(uid, "alerts"), {
    ...data,
    active: true,
    triggered: false,
    triggeredAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function toggleAlert(uid: string, id: string, active: boolean) {
  return updateDoc(doc(db, "users", uid, "alerts", id), {
    active,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteAlert(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "alerts", id));
}

// ============================================================
// Settings（ユーザー設定）
// ============================================================
export async function getSetting(uid: string, key: string): Promise<string | null> {
  const ref = doc(db, "users", uid, "settings", key);
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data().value as string) : null;
}

export async function setSetting(uid: string, key: string, value: string) {
  const ref = doc(db, "users", uid, "settings", key);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return updateDoc(ref, { value, updatedAt: serverTimestamp() });
  } else {
    // setDoc で作成
    const { setDoc } = await import("firebase/firestore");
    return setDoc(ref, { value, updatedAt: serverTimestamp() });
  }
}
