"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";

function isMobile(): boolean {
  if (typeof window === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

// 許可するユーザー（メールアドレス）
const ALLOWED_USERS = [
  "make.some.noise6984@gmail.com",
];

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  error: null,
  signInWithGoogle: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // リダイレクトログインの結果を処理（スマホ向け）
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user && !ALLOWED_USERS.includes(result.user.email ?? "")) {
          firebaseSignOut(auth);
          setUser(null);
          setError("このアカウントはアクセスが許可されていません");
        }
      })
      .catch((err) => {
        setError(`ログインに失敗しました: ${err.code ?? err.message}`);
      });

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser && !ALLOWED_USERS.includes(firebaseUser.email ?? "")) {
        firebaseSignOut(auth);
        setUser(null);
        setError("このアカウントはアクセスが許可されていません");
      } else {
        setUser(firebaseUser);
        setError(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    setError(null);
    try {
      if (isMobile()) {
        // スマホ: リダイレクト方式（ポップアップがブロックされるため）
        await signInWithRedirect(auth, googleProvider);
      } else {
        // PC: ポップアップ方式
        const result = await signInWithPopup(auth, googleProvider);
        if (!ALLOWED_USERS.includes(result.user.email ?? "")) {
          await firebaseSignOut(auth);
          setUser(null);
          setError("このアカウントはアクセスが許可されていません");
        }
      }
    } catch (err: unknown) {
      const firebaseErr = err as { code?: string; message?: string };
      setError(`ログインに失敗しました: ${firebaseErr.code ?? firebaseErr.message}`);
    }
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
    setError(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, error, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
