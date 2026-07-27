/**
 * ウォールームの監視リスト状態を Firestore で端末間同期する。
 *
 * バグの背景 (ユーザーメモ 2026-07): スマホで「ウォールームへ送る」しても
 * PC で見ると入っていない = watchlist が localStorage (端末ローカル) だったため。
 * これを Firestore users/{uid}/warroom/state に集約し、onSnapshot でライブ同期する。
 *
 * 建玉 (positions) は端末で取引する性質上ローカル維持。ここでは
 * watchlist / pinned / lastReset (日次リセット判定) のみ扱う。
 */

import { doc, onSnapshot, setDoc, getDoc } from "firebase/firestore";
import { db } from "./firebase";

export interface WarroomState {
  watchlist: string[];
  pinned: string[];
  lastReset: string | null; // JST YYYYMMDD
}

const EMPTY: WarroomState = { watchlist: [], pinned: [], lastReset: null };

function ref(uid: string) {
  return doc(db, "users", uid, "warroom", "state");
}

function normalize(data: unknown): WarroomState {
  const d = (data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    watchlist: arr(d.watchlist),
    pinned: arr(d.pinned),
    lastReset: typeof d.lastReset === "string" ? d.lastReset : null,
  };
}

/** 一度だけ読む */
export async function getWarroomState(uid: string): Promise<WarroomState> {
  try {
    const snap = await getDoc(ref(uid));
    return snap.exists() ? normalize(snap.data()) : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** ライブ購読 (他端末の変更が即反映)。unsubscribe を返す */
export function subscribeWarroomState(uid: string, cb: (s: WarroomState) => void): () => void {
  return onSnapshot(
    ref(uid),
    (snap) => cb(snap.exists() ? normalize(snap.data()) : { ...EMPTY }),
    () => cb({ ...EMPTY })
  );
}

/** 状態を丸ごと保存 (merge) */
export async function saveWarroomState(uid: string, state: Partial<WarroomState>): Promise<void> {
  try {
    await setDoc(ref(uid), { ...state, updatedAt: new Date().toISOString() }, { merge: true });
  } catch {}
}

/**
 * watchlist に1銘柄追加 (任意で pin)。TickerContextMenu の「ウォールームへ送る」用。
 * 現在値を読んでから足すので、他端末の内容を消さない。
 */
export async function addToWarroomWatchlist(uid: string, ticker: string, opts?: { pin?: boolean }): Promise<void> {
  const cur = await getWarroomState(uid);
  const watchlist = cur.watchlist.includes(ticker) ? cur.watchlist : [...cur.watchlist, ticker];
  const pinned = opts?.pin && !cur.pinned.includes(ticker) ? [...cur.pinned, ticker] : cur.pinned;
  await saveWarroomState(uid, { watchlist, pinned });
}
