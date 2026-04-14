"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  User,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";

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
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser && !ALLOWED_USERS.includes(firebaseUser.email ?? "")) {
        // 許可されていないユーザー → ログアウト
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
      const result = await signInWithPopup(auth, googleProvider);
      if (!ALLOWED_USERS.includes(result.user.email ?? "")) {
        await firebaseSignOut(auth);
        setUser(null);
        setError("このアカウントはアクセスが許可されていません");
      }
    } catch {
      setError("ログインに失敗しました");
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
