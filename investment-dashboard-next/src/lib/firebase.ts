import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider, browserLocalPersistence, setPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// authDomain は自分のドメインを使う（iOS ITP対策）
// ブラウザは window.location.host を見るので、相対パス `/__/auth/*` でも動く
const authDomain =
  typeof window !== "undefined"
    ? window.location.host
    : process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// 多重初期化防止
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
// 毎回アカウント選択画面を表示（前回のアカウントを勝手に使わない）
googleProvider.setCustomParameters({ prompt: "select_account" });

// ログイン状態を永続化 (ブラウザ閉じても保持)
// → 一度ログインしたら、ホーム画面アイコンから起動するだけで自動ログイン状態に
if (typeof window !== "undefined") {
  setPersistence(auth, browserLocalPersistence).catch(() => {});
}
