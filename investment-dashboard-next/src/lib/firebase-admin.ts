import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth as fbGetAuth, Auth } from "firebase-admin/auth";

let adminApp: App | undefined;
let adminDb: Firestore | undefined;
let adminAuth: Auth | undefined;

export function getAdminApp(): App {
  if (adminApp) return adminApp;
  const apps = getApps();
  if (apps.length > 0) {
    adminApp = apps[0];
  } else {
    // Vercel環境変数から service account credentials を取得
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccount) {
      try {
        const parsed = JSON.parse(serviceAccount);
        adminApp = initializeApp({
          credential: cert(parsed),
          projectId: parsed.project_id,
        });
      } catch (e) {
        console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:", e);
        adminApp = initializeApp({
          projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        });
      }
    } else {
      // Fallback: Application Default Credentials
      adminApp = initializeApp({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      });
    }
  }
  return adminApp;
}

export function getAdminDb(): Firestore {
  if (adminDb) return adminDb;
  const app = getAdminApp();
  adminDb = getFirestore(app);
  return adminDb;
}

/**
 * 初期化済みの app に紐づいた Auth を返す。
 * `getAuth()` を直接呼ぶと初期化前だとエラーになるのでこっちを使う。
 */
export function getAdminAuth(): Auth {
  if (adminAuth) return adminAuth;
  const app = getAdminApp();
  adminAuth = fbGetAuth(app);
  return adminAuth;
}

/**
 * email から uid を解決する (Firebase Auth 経由)。
 *
 * 注意: users/{uid} ドキュメントには email フィールドが存在しない
 * (サブコレクションのみでドキュメント本体は空) ため、
 * `collection("users").where("email", "==", ...)` は常に 0 件になる。
 * cron 等でユーザーを特定する時は必ずこちらを使うこと。
 */
export async function resolveUidByEmail(email: string): Promise<string | null> {
  try {
    const user = await getAdminAuth().getUserByEmail(email);
    return user.uid;
  } catch {
    return null;
  }
}

/** ユーザーの監視対象ティッカーを収集 (お気に入り=watchlist + 保有=holdings) */
export async function collectUserTickers(uid: string): Promise<string[]> {
  const db = getAdminDb();
  const tickers = new Set<string>();
  // watchlist=お気に入り, holdings=保有。favorites/portfolio は旧名の保険
  for (const col of ["watchlist", "holdings", "favorites", "portfolio"]) {
    try {
      const snap = await db.collection("users").doc(uid).collection(col).get();
      for (const d of snap.docs) {
        const t = (d.data() as Record<string, unknown>).ticker;
        if (typeof t === "string" && (/^\d{3,4}[A-Z]?$/.test(t) || /^[A-Z]{1,5}$/.test(t))) {
          tickers.add(t);
        }
      }
    } catch {}
  }
  return Array.from(tickers);
}
