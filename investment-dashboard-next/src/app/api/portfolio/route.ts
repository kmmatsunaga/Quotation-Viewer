import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { getAdminAuth } from "@/lib/firebase-admin";

/**
 * GET /api/portfolio?uid=xxx  (or ?email=xxx)
 * Header: x-api-key: <MCP_API_KEY>
 *
 * MCP連携用: 保有銘柄・口座残高・取引履歴・その他資産を一括取得。
 * email パラメータで指定した場合、Firebase Auth から UID を解決する。
 */

const API_KEY = process.env.MCP_API_KEY;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  // APIキー認証
  if (!API_KEY) {
    return NextResponse.json(
      { error: "MCP_API_KEY not configured on server" },
      { status: 500 }
    );
  }

  const providedKey = req.headers.get("x-api-key");
  if (!providedKey || providedKey !== API_KEY) {
    return unauthorized();
  }

  // UID (直接指定 or メールから解決)
  let uid = req.nextUrl.searchParams.get("uid");
  const email = req.nextUrl.searchParams.get("email");

  if (!uid && email) {
    try {
      const userRecord = await getAdminAuth().getUserByEmail(email);
      uid = userRecord.uid;
    } catch {
      return NextResponse.json(
        { error: `User not found for email: ${email}` },
        { status: 404 }
      );
    }
  }

  if (!uid) {
    return NextResponse.json(
      { error: "uid or email parameter required" },
      { status: 400 }
    );
  }

  const section = req.nextUrl.searchParams.get("section") ?? "all";

  try {
    const db = getAdminDb();
    const result: Record<string, unknown> = {};

    // Holdings（保有銘柄）
    if (section === "all" || section === "holdings") {
      const holdingsSnap = await db
        .collection("users")
        .doc(uid)
        .collection("holdings")
        .orderBy("createdAt", "desc")
        .get();

      result.holdings = holdingsSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
    }

    // Account Balance（口座残高）
    if (section === "all" || section === "balance") {
      const balanceSnap = await db
        .collection("users")
        .doc(uid)
        .collection("settings")
        .doc("accountBalance")
        .get();

      result.balance = balanceSnap.exists
        ? balanceSnap.data()
        : { cashJpy: 0, cashUsd: 0 };
    }

    // Transactions（取引履歴）
    if (section === "all" || section === "transactions") {
      const limit = parseInt(
        req.nextUrl.searchParams.get("limit") ?? "50",
        10
      );
      const txSnap = await db
        .collection("users")
        .doc(uid)
        .collection("transactions")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      result.transactions = txSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
    }

    // Other Assets（投資信託・外貨預金）
    if (section === "all" || section === "otherAssets") {
      const oaSnap = await db
        .collection("users")
        .doc(uid)
        .collection("otherAssets")
        .orderBy("createdAt", "desc")
        .get();

      result.otherAssets = oaSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
    }

    // Watchlist（お気に入り）
    if (section === "all" || section === "watchlist") {
      const wlSnap = await db
        .collection("users")
        .doc(uid)
        .collection("watchlist")
        .get();

      result.watchlist = wlSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      // Watchlist Groups
      const wgSnap = await db
        .collection("users")
        .doc(uid)
        .collection("watchlistGroups")
        .orderBy("order", "asc")
        .get();

      result.watchlistGroups = wgSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
    }

    // Alerts（価格アラート）
    if (section === "all" || section === "alerts") {
      const alertsSnap = await db
        .collection("users")
        .doc(uid)
        .collection("alerts")
        .orderBy("createdAt", "desc")
        .get();

      result.alerts = alertsSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
    }

    // Scenarios（投資シナリオ）
    if (section === "all" || section === "scenarios") {
      const scenariosSnap = await db
        .collection("users")
        .doc(uid)
        .collection("scenarios")
        .orderBy("createdAt", "desc")
        .get();

      result.scenarios = scenariosSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("Portfolio API error:", err);
    return NextResponse.json(
      { error: "Failed to fetch portfolio data" },
      { status: 500 }
    );
  }
}
