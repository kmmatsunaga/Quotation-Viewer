"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import PortfolioHealthPanel from "./PortfolioHealthPanel";
import {
  getHoldings,
  addHolding,
  updateHolding,
  deleteHolding,
  getAccountBalance,
  setAccountBalance,
  addTransaction,
  getTransactions,
  getOtherAssets,
  addOtherAsset,
  updateOtherAsset,
  deleteOtherAsset,
  calcCommission,
  type Holding,
  type AccountBalance,
  type Transaction,
  type OtherAsset,
} from "@/lib/firestore";
import {
  getPortfolioSnapshots,
  savePortfolioSnapshot,
  type PortfolioSnapshot,
} from "@/lib/firestore-snapshots";
import {
  searchStocksAPI,
  type StockSearchResult,
} from "@/lib/stock-search";
import { PatternBadgeGroup, type PatternData } from "@/components/PatternBadge";
import HoldingChart from "./HoldingChart";

const MONO = { fontFamily: "'JetBrains Mono', monospace" };

// 価格情報の型
interface PriceInfo {
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  currency: string;
}

// 個別ロット（holding + 評価額情報）
interface HoldingWithValue extends Holding {
  currentPrice: number | null;
  marketValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  marketValueJpy: number | null;
  costBasisJpy: number;
}

// 銘柄グループ（同一ティッカーをまとめた集約行）
interface TickerGroup {
  ticker: string;
  name: string;
  market: string;
  totalShares: number;
  weightedAvgCost: number;
  totalCostBasis: number;
  currentPrice: number | null;
  totalMarketValue: number | null;
  totalPnl: number | null;
  totalPnlPct: number | null;
  totalMarketValueJpy: number | null;
  totalCostBasisJpy: number;
  lots: HoldingWithValue[];
}

type TabId = "holdings" | "account" | "history" | "others";

export default function PortfolioPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    ticker: "",
    name: "",
    shares: "100",
    avgCost: "",
    market: "JP",
    purchaseDate: new Date().toISOString().slice(0, 10),
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  // 編集
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ shares: "", avgCost: "", purchaseDate: "" });
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 削除確認モーダル
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; ticker: string; name: string; shares: number } | null>(null);

  // 展開中のグループ
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set());
  // チャート展開中の銘柄
  const [chartExpandedTickers, setChartExpandedTickers] = useState<Set<string>>(new Set());
  // 「全銘柄チャート表示」グローバル切替
  const [allChartsExpanded, setAllChartsExpanded] = useState(false);
  // グローバル既定タイムフレーム
  const [globalTimeframe, setGlobalTimeframe] = useState<string>("1d");

  const toggleChart = useCallback((ticker: string) => {
    setChartExpandedTickers((prev) => {
      const s = new Set(prev);
      if (s.has(ticker)) s.delete(ticker);
      else s.add(ticker);
      return s;
    });
  }, []);

  // 現在価格
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [usdJpy, setUsdJpy] = useState<number | null>(null);
  const [pricesLoading, setPricesLoading] = useState(false);

  // パターン検出
  const [tickerPatterns, setTickerPatterns] = useState<Record<string, Record<string, PatternData[]>>>({});
  const [patternsLoading, setPatternsLoading] = useState(false);

  // オートコンプリート
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<StockSearchResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // タブ
  const [activeTab, setActiveTab] = useState<TabId>("holdings");

  // 口座残高
  const [accountBalance, setAccountBalanceState] = useState<AccountBalance>({ cashJpy: 0, cashUsd: 0 });

  // 取引履歴
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // その他資産
  const [otherAssets, setOtherAssetsState] = useState<OtherAsset[]>([]);

  // 売却モーダル
  const [sellTarget, setSellTarget] = useState<{
    holding: HoldingWithValue;
    group: TickerGroup;
  } | null>(null);
  const [sellForm, setSellForm] = useState({ shares: "", price: "", date: new Date().toISOString().slice(0, 10) });
  const [sellSubmitting, setSellSubmitting] = useState(false);

  // 入出金モーダル
  const [showCashModal, setShowCashModal] = useState(false);
  const [cashForm, setCashForm] = useState({ type: "deposit" as "deposit" | "withdraw", amount: "", currency: "JPY" as "JPY" | "USD" });
  const [cashSubmitting, setCashSubmitting] = useState(false);

  // その他資産追加
  const [showOtherForm, setShowOtherForm] = useState(false);
  const [otherForm, setOtherForm] = useState({
    type: "foreign_deposit" as "foreign_deposit" | "investment_trust",
    ticker: "",
    name: "",
    currency: "JPY",
    amount: "",
    currentValue: "",
    costBasis: "",
    purchaseDate: new Date().toISOString().slice(0, 10),
    memo: "",
  });
  const [otherSubmitting, setOtherSubmitting] = useState(false);
  const [editingOtherId, setEditingOtherId] = useState<string | null>(null);
  const [editOtherForm, setEditOtherForm] = useState({ currentValue: "", memo: "" });

  // 投資信託検索
  const [fundSearchQuery, setFundSearchQuery] = useState("");
  const [fundSuggestions, setFundSuggestions] = useState<StockSearchResult[]>([]);
  const [showFundSuggestions, setShowFundSuggestions] = useState(false);
  const [fundSearching, setFundSearching] = useState(false);
  const [fundSelectedIndex, setFundSelectedIndex] = useState(-1);
  const fundSearchRef = useRef<HTMLDivElement>(null);
  const fundDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 投資信託の基準価額
  const [fundPrices, setFundPrices] = useState<Record<string, number>>({});

  // 外側クリックでサジェスト閉じる
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
      if (fundSearchRef.current && !fundSearchRef.current.contains(e.target as Node)) {
        setShowFundSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 検索キーワードが変わったらAPI検索（300msデバウンス）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (searchQuery.length === 0) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const results = await searchStocksAPI(searchQuery);
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
      setSelectedIndex(-1);
      setSearching(false);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // 投資信託検索（300msデバウンス）
  useEffect(() => {
    if (fundDebounceRef.current) clearTimeout(fundDebounceRef.current);
    if (fundSearchQuery.length === 0) {
      setFundSuggestions([]);
      setShowFundSuggestions(false);
      return;
    }
    setFundSearching(true);
    fundDebounceRef.current = setTimeout(async () => {
      const results = await searchStocksAPI(fundSearchQuery);
      // MUTUALFUNDを優先表示、ただしETFなども含める
      const sorted = results.sort((a, b) => {
        if (a.type === "MUTUALFUND" && b.type !== "MUTUALFUND") return -1;
        if (a.type !== "MUTUALFUND" && b.type === "MUTUALFUND") return 1;
        return 0;
      });
      setFundSuggestions(sorted);
      setShowFundSuggestions(sorted.length > 0);
      setFundSelectedIndex(-1);
      setFundSearching(false);
    }, 300);
    return () => {
      if (fundDebounceRef.current) clearTimeout(fundDebounceRef.current);
    };
  }, [fundSearchQuery]);

  // 投資信託の基準価額を自動取得
  const fetchFundPrices = useCallback(async (assets: OtherAsset[]) => {
    const fundTickers = assets
      .filter((a) => a.type === "investment_trust" && a.ticker)
      .map((a) => a.ticker!);
    if (fundTickers.length === 0) return;

    try {
      const res = await fetch(`/api/stocks/prices?tickers=${encodeURIComponent(fundTickers.join(","))}`);
      if (res.ok) {
        const data = await res.json();
        const fp: Record<string, number> = {};
        for (const [ticker, info] of Object.entries(data.prices ?? {})) {
          fp[ticker] = (info as { price: number }).price;
        }
        setFundPrices(fp);
      }
    } catch (err) {
      console.error("Failed to fetch fund prices:", err);
    }
  }, []);

  // 銘柄選択
  const selectStock = (stock: StockSearchResult) => {
    setFormData({
      ...formData,
      ticker: stock.ticker,
      name: stock.name,
      market: stock.market === "JP" ? "JP" : "US",
    });
    setSearchQuery("");
    setShowSuggestions(false);
  };

  // キーボード操作
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      selectStock(suggestions[selectedIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // データ取得
  const loadData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [h, s, bal, tx, oa] = await Promise.all([
        getHoldings(user.uid),
        getPortfolioSnapshots(user.uid, 90),
        getAccountBalance(user.uid),
        getTransactions(user.uid),
        getOtherAssets(user.uid),
      ]);
      setHoldings(h);
      setSnapshots(s);
      setAccountBalanceState(bal);
      setTransactions(tx);
      setOtherAssetsState(oa);

      // 今日のスナップショットが無ければ保存
      const today = new Date().toISOString().slice(0, 10);
      const hasToday = s.some((sn) => sn.date === today);
      if (!hasToday && h.length > 0) {
        const totalCost = h.reduce(
          (sum, item) => sum + item.shares * item.avgCost,
          0
        );
        await savePortfolioSnapshot(user.uid, {
          date: today,
          totalValue: totalCost,
          totalCost,
          holdingsCount: h.length,
        });
        const updated = await getPortfolioSnapshots(user.uid, 90);
        setSnapshots(updated);
      }
    } catch (err) {
      console.error("Failed to load portfolio:", err);
    }
    setLoading(false);
  }, [user]);

  // 現在価格を取得
  const fetchPrices = useCallback(async (holdingsList: Holding[]) => {
    if (holdingsList.length === 0) return;
    setPricesLoading(true);
    try {
      const uniqueTickers = [...new Set(holdingsList.map((h) => h.ticker))];
      const res = await fetch(`/api/stocks/prices?tickers=${encodeURIComponent(uniqueTickers.join(","))}`);
      if (res.ok) {
        const data = await res.json();
        setPrices(data.prices ?? {});
        setUsdJpy(data.usdJpy ?? null);
      }
    } catch (err) {
      console.error("Failed to fetch prices:", err);
    }
    setPricesLoading(false);
  }, []);

  // パターン検出
  const fetchPatterns = useCallback(async (holdingsList: Holding[]) => {
    if (holdingsList.length === 0) return;
    setPatternsLoading(true);
    try {
      const uniqueTickers = [...new Set(holdingsList.map((h) => h.ticker))];
      const res = await fetch(`/api/stocks/patterns?tickers=${encodeURIComponent(uniqueTickers.join(","))}`);
      if (res.ok) {
        const data = await res.json();
        const mapped: Record<string, Record<string, PatternData[]>> = {};
        for (const [ticker, info] of Object.entries(data.patterns ?? {})) {
          const p = (info as { patterns?: Record<string, PatternData[]> }).patterns;
          if (p) mapped[ticker] = p;
        }
        setTickerPatterns(mapped);
      }
    } catch (err) {
      console.error("Failed to fetch patterns:", err);
    }
    setPatternsLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // holdingsが変わったら価格取得 + パターン検出
  useEffect(() => {
    if (holdings.length > 0) {
      fetchPrices(holdings);
      fetchPatterns(holdings);
    }
  }, [holdings, fetchPrices, fetchPatterns]);

  // 投資信託の基準価額を取得
  useEffect(() => {
    if (otherAssets.length > 0) {
      fetchFundPrices(otherAssets);
    }
  }, [otherAssets, fetchFundPrices]);

  // 銘柄追加
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    try {
      const shares = Number(formData.shares) || 1;
      const avgCost = Number(formData.avgCost);
      const market = formData.market;

      await addHolding(user.uid, {
        ticker: formData.ticker.toUpperCase(),
        name: formData.name,
        shares,
        avgCost,
        market,
        memo: "",
        purchaseDate: formData.purchaseDate,
      });

      // 買付記録をトランザクションに追加
      const totalAmount = shares * avgCost;
      const commission = calcCommission(market, totalAmount);
      await addTransaction(user.uid, {
        type: "buy",
        ticker: formData.ticker.toUpperCase(),
        name: formData.name,
        market,
        shares,
        price: avgCost,
        amount: totalAmount + commission,
        commission,
        currency: market === "US" ? "USD" : "JPY",
        date: formData.purchaseDate,
      });

      // 預り金を減らす
      const newBal = { ...accountBalance };
      if (market === "US") {
        newBal.cashUsd = Math.max(0, newBal.cashUsd - totalAmount - commission);
      } else {
        newBal.cashJpy = Math.max(0, newBal.cashJpy - totalAmount - commission);
      }
      await setAccountBalance(user.uid, newBal);

      setFormData({
        ticker: "",
        name: "",
        shares: "100",
        avgCost: "",
        market: "JP",
        purchaseDate: new Date().toISOString().slice(0, 10),
      });
      setShowForm(false);
      await loadData();
    } catch (err) {
      console.error("Failed to add holding:", err);
    }
    setSubmitting(false);
  };

  // 編集開始
  const startEdit = (h: Holding) => {
    setEditingId(h.id ?? null);
    setEditForm({
      shares: String(h.shares),
      avgCost: String(h.avgCost),
      purchaseDate: h.purchaseDate ?? "",
    });
  };

  // 編集保存
  const handleEditSave = async (holdingId: string) => {
    if (!user) return;
    setEditSubmitting(true);
    try {
      await updateHolding(user.uid, holdingId, {
        shares: Number(editForm.shares) || 1,
        avgCost: Number(editForm.avgCost) || 0,
        purchaseDate: editForm.purchaseDate,
      });
      setEditingId(null);
      await loadData();
    } catch (err) {
      console.error("Failed to update holding:", err);
    }
    setEditSubmitting(false);
  };

  // 削除確認モーダルを開く
  const requestDelete = (h: { id?: string; ticker: string; name: string; shares: number }) => {
    if (!h.id) return;
    setDeleteTarget({ id: h.id, ticker: h.ticker, name: h.name, shares: h.shares });
  };

  // 銘柄削除（モーダルから確定）
  const confirmDelete = async () => {
    if (!user || !deleteTarget) return;
    setDeleting(deleteTarget.id);
    setDeleteTarget(null);
    try {
      await deleteHolding(user.uid, deleteTarget.id);
      await loadData();
    } catch (err) {
      console.error("Failed to delete:", err);
    }
    setDeleting(null);
  };

  // 売却実行
  const handleSell = async () => {
    if (!user || !sellTarget) return;
    setSellSubmitting(true);
    try {
      const { holding, group } = sellTarget;
      const sellShares = Number(sellForm.shares) || 0;
      const sellPrice = Number(sellForm.price) || 0;
      if (sellShares <= 0 || sellPrice <= 0) return;

      const market = holding.market;
      const sellAmount = sellShares * sellPrice;
      const commission = calcCommission(market, sellAmount);
      const costBasis = sellShares * holding.avgCost;
      const realizedPnl = sellAmount - costBasis - commission;

      // トランザクション記録
      await addTransaction(user.uid, {
        type: "sell",
        ticker: group.ticker,
        name: group.name,
        market,
        shares: sellShares,
        price: sellPrice,
        amount: sellAmount - commission,
        commission,
        currency: market === "US" ? "USD" : "JPY",
        realizedPnl,
        date: sellForm.date,
      });

      // 預り金を増やす
      const newBal = { ...accountBalance };
      if (market === "US") {
        newBal.cashUsd += sellAmount - commission;
      } else {
        newBal.cashJpy += sellAmount - commission;
      }
      await setAccountBalance(user.uid, newBal);

      // ホールディング更新
      if (sellShares >= holding.shares) {
        // 全株売却 → 削除
        if (holding.id) await deleteHolding(user.uid, holding.id);
      } else {
        // 一部売却 → 株数を減らす
        if (holding.id) {
          await updateHolding(user.uid, holding.id, {
            shares: holding.shares - sellShares,
          });
        }
      }

      setSellTarget(null);
      await loadData();
    } catch (err) {
      console.error("Failed to sell:", err);
    }
    setSellSubmitting(false);
  };

  // 入出金実行
  const handleCashAction = async () => {
    if (!user) return;
    setCashSubmitting(true);
    try {
      const amount = Number(cashForm.amount) || 0;
      if (amount <= 0) return;

      const newBal = { ...accountBalance };
      if (cashForm.currency === "JPY") {
        if (cashForm.type === "deposit") newBal.cashJpy += amount;
        else newBal.cashJpy = Math.max(0, newBal.cashJpy - amount);
      } else {
        if (cashForm.type === "deposit") newBal.cashUsd += amount;
        else newBal.cashUsd = Math.max(0, newBal.cashUsd - amount);
      }
      await setAccountBalance(user.uid, newBal);

      await addTransaction(user.uid, {
        type: cashForm.type,
        amount,
        commission: 0,
        currency: cashForm.currency,
        date: new Date().toISOString().slice(0, 10),
        memo: cashForm.type === "deposit" ? "入金" : "出金",
      });

      setCashForm({ type: "deposit", amount: "", currency: "JPY" });
      setShowCashModal(false);
      await loadData();
    } catch (err) {
      console.error("Cash action failed:", err);
    }
    setCashSubmitting(false);
  };

  // その他資産追加
  const handleAddOther = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setOtherSubmitting(true);
    try {
      await addOtherAsset(user.uid, {
        type: otherForm.type,
        ticker: otherForm.ticker || undefined,
        name: otherForm.name,
        currency: otherForm.currency,
        amount: Number(otherForm.amount) || 0,
        currentValue: Number(otherForm.currentValue) || 0,
        costBasis: Number(otherForm.costBasis) || 0,
        purchaseDate: otherForm.purchaseDate,
        memo: otherForm.memo,
      });
      setOtherForm({ type: "foreign_deposit", ticker: "", name: "", currency: "JPY", amount: "", currentValue: "", costBasis: "", purchaseDate: new Date().toISOString().slice(0, 10), memo: "" });
      setShowOtherForm(false);
      await loadData();
    } catch (err) {
      console.error("Failed to add other asset:", err);
    }
    setOtherSubmitting(false);
  };

  // グループ展開トグル
  const toggleExpand = (ticker: string) => {
    setExpandedTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  };

  // === 集計計算 ===
  const currencySymbol = (market: string) => (market === "US" ? "$" : "¥");
  const formatPrice = (v: number, market: string) => {
    if (market === "US") return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `¥${Math.round(v).toLocaleString("ja-JP")}`;
  };

  // 各銘柄の評価額計算
  const holdingsWithValue: HoldingWithValue[] = holdings.map((h) => {
    const p = prices[h.ticker];
    const costBasis = h.shares * h.avgCost;
    const currentPrice = p?.price ?? null;
    const marketValue = currentPrice !== null ? h.shares * currentPrice : null;
    const pnl = marketValue !== null ? marketValue - costBasis : null;
    const pnlPct = costBasis > 0 && pnl !== null ? (pnl / costBasis) * 100 : null;
    const marketValueJpy =
      marketValue !== null && h.market === "US" && usdJpy
        ? marketValue * usdJpy
        : marketValue;
    const costBasisJpy =
      h.market === "US" && usdJpy ? costBasis * usdJpy : costBasis;
    return { ...h, currentPrice, marketValue, pnl, pnlPct, marketValueJpy, costBasisJpy };
  });

  // ティッカー別にグループ化
  const tickerGroups: TickerGroup[] = (() => {
    const map = new Map<string, HoldingWithValue[]>();
    for (const h of holdingsWithValue) {
      const key = h.ticker;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(h);
    }
    const groups: TickerGroup[] = [];
    for (const [ticker, lots] of map) {
      const first = lots[0];
      const totalShares = lots.reduce((s, l) => s + l.shares, 0);
      const totalCostBasis = lots.reduce((s, l) => s + l.shares * l.avgCost, 0);
      const weightedAvgCost = totalShares > 0 ? totalCostBasis / totalShares : 0;
      const currentPrice = first.currentPrice;
      const totalMarketValue = currentPrice !== null ? totalShares * currentPrice : null;
      const totalPnl = totalMarketValue !== null ? totalMarketValue - totalCostBasis : null;
      const totalPnlPct = totalCostBasis > 0 && totalPnl !== null ? (totalPnl / totalCostBasis) * 100 : null;
      const totalMarketValueJpy = lots.reduce((s, l) => s + (l.marketValueJpy ?? l.costBasisJpy), 0);
      const totalCostBasisJpy = lots.reduce((s, l) => s + l.costBasisJpy, 0);
      lots.sort((a, b) => (a.purchaseDate ?? "").localeCompare(b.purchaseDate ?? ""));
      groups.push({
        ticker, name: first.name, market: first.market, totalShares, weightedAvgCost, totalCostBasis,
        currentPrice, totalMarketValue, totalPnl, totalPnlPct, totalMarketValueJpy, totalCostBasisJpy, lots,
      });
    }
    return groups;
  })();

  const totalCostJpy = holdingsWithValue.reduce((s, h) => s + h.costBasisJpy, 0);
  const totalValueJpy = holdingsWithValue.reduce((s, h) => s + (h.marketValueJpy ?? h.costBasisJpy), 0);
  const totalPnlJpy = totalValueJpy - totalCostJpy;
  const totalPnlPct = totalCostJpy > 0 ? (totalPnlJpy / totalCostJpy) * 100 : 0;
  const uniqueTickerCount = tickerGroups.length;

  // === カテゴリ別小計 ===
  // 国内株式
  const jpHoldings = holdingsWithValue.filter((h) => h.market === "JP");
  const jpValueJpy = jpHoldings.reduce((s, h) => s + (h.marketValueJpy ?? h.costBasisJpy), 0);
  const jpCostJpy = jpHoldings.reduce((s, h) => s + h.costBasisJpy, 0);
  const jpPnlJpy = jpValueJpy - jpCostJpy;
  const jpPnlPct = jpCostJpy > 0 ? (jpPnlJpy / jpCostJpy) * 100 : 0;
  const jpTickerCount = new Set(jpHoldings.map((h) => h.ticker)).size;

  // 米国株式
  const usHoldings = holdingsWithValue.filter((h) => h.market === "US");
  const usValueJpy = usHoldings.reduce((s, h) => s + (h.marketValueJpy ?? h.costBasisJpy), 0);
  const usCostJpy = usHoldings.reduce((s, h) => s + h.costBasisJpy, 0);
  const usPnlJpy = usValueJpy - usCostJpy;
  const usPnlPct = usCostJpy > 0 ? (usPnlJpy / usCostJpy) * 100 : 0;
  const usTickerCount = new Set(usHoldings.map((h) => h.ticker)).size;

  // 投資信託（基準価額を自動反映）
  const investmentTrusts = otherAssets.filter((a) => a.type === "investment_trust").map((a) => {
    // ティッカーがあって基準価額が取れていたら、評価額を自動計算
    if (a.ticker && fundPrices[a.ticker]) {
      const nav = fundPrices[a.ticker]; // 基準価額（1万口あたり）
      // 投信は口数ベース: 評価額 = 基準価額 × (口数 / 10000)
      const autoValue = a.amount > 0 ? nav * (a.amount / 10000) : nav;
      return { ...a, currentValue: autoValue };
    }
    return a;
  });
  const itValueJpy = investmentTrusts.reduce((s, a) => {
    if (a.currency === "JPY") return s + a.currentValue;
    return s + a.currentValue * (usdJpy ?? 145);
  }, 0);
  const itCostJpy = investmentTrusts.reduce((s, a) => {
    if (a.currency === "JPY") return s + a.costBasis;
    return s + a.costBasis * (usdJpy ?? 145);
  }, 0);
  const itPnlJpy = itValueJpy - itCostJpy;
  const itPnlPct = itCostJpy > 0 ? (itPnlJpy / itCostJpy) * 100 : 0;

  // 外貨預金
  const foreignDeposits = otherAssets.filter((a) => a.type === "foreign_deposit");
  const fdValueJpy = foreignDeposits.reduce((s, a) => {
    if (a.currency === "JPY") return s + a.currentValue;
    return s + a.currentValue * (usdJpy ?? 145);
  }, 0);
  const fdCostJpy = foreignDeposits.reduce((s, a) => {
    if (a.currency === "JPY") return s + a.costBasis;
    return s + a.costBasis * (usdJpy ?? 145);
  }, 0);
  const fdPnlJpy = fdValueJpy - fdCostJpy;

  // 口座全体の計算
  const cashJpyTotal = accountBalance.cashJpy + (accountBalance.cashUsd * (usdJpy ?? 145));
  const otherAssetsJpy = itValueJpy + fdValueJpy;
  const totalAccountValue = totalValueJpy + cashJpyTotal + otherAssetsJpy;

  // 実現損益合計
  const totalRealizedPnl = transactions
    .filter((t) => t.type === "sell" && t.realizedPnl != null)
    .reduce((s, t) => s + (t.realizedPnl ?? 0), 0);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  // タブ定義
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "holdings", label: "保有銘柄", icon: "📈" },
    { id: "account", label: "口座サマリー", icon: "🏦" },
    { id: "history", label: "取引履歴", icon: "📋" },
    { id: "others", label: "その他資産", icon: "💱" },
  ];

  return (
    <div className="space-y-6">
      {/* ヘッダ */}
      <div className="flex items-center justify-between">
        <h1
          className="text-sm uppercase tracking-[0.2em] text-[var(--color-accent)]"
          style={MONO}
        >
          // Portfolio
        </h1>
        {usdJpy && (
          <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>
            USD/JPY {usdJpy.toFixed(2)}
          </span>
        )}
      </div>

      {/* === 統合サマリーカード === */}
      <div
        className="relative p-5 rounded"
        style={{
          border: "1px solid var(--color-border)",
          background: "var(--bg-card)",
          boxShadow: "inset 0 0 0 1px rgba(0,240,255,0.06), 0 0 20px rgba(0,240,255,0.08)",
        }}
      >
        <span className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[var(--color-accent)] opacity-60" />

        {/* 口座総額 */}
        <div className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--color-border)" }}>
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
            Total Account Value
          </span>
          <div
            className="text-3xl md:text-4xl font-bold mt-1"
            style={{
              ...MONO,
              color: "var(--color-accent)",
              textShadow: "0 0 14px rgba(0,240,255,0.5)",
            }}
          >
            ¥{Math.round(totalAccountValue).toLocaleString("ja-JP")}
          </div>
          {(pricesLoading || patternsLoading) && (
            <span className="text-[10px] text-[var(--color-accent)] loading-pulse" style={MONO}>
              {pricesLoading ? "価格取得中..." : "パターン分析中..."}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {/* 株式評価額 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Stocks
            </span>
            <div className="text-lg font-bold mt-1 text-[var(--color-text)]" style={MONO}>
              ¥{Math.round(totalValueJpy).toLocaleString("ja-JP")}
            </div>
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              {uniqueTickerCount}銘柄 / {holdings.length}ロット
            </span>
          </div>

          {/* 含み損益 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Unrealized P&L
            </span>
            <div
              className="text-lg font-bold mt-1"
              style={{ ...MONO, color: totalPnlJpy >= 0 ? "var(--color-up)" : "var(--color-down)" }}
            >
              {totalPnlJpy >= 0 ? "+" : ""}¥{Math.round(totalPnlJpy).toLocaleString("ja-JP")}
            </div>
            <span
              className="text-[10px] font-medium px-1 py-0.5"
              style={{ ...MONO, color: totalPnlJpy >= 0 ? "var(--color-up)" : "var(--color-down)", background: totalPnlJpy >= 0 ? "rgba(255,59,107,0.12)" : "rgba(0,217,255,0.12)" }}
            >
              {totalPnlPct >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%
            </span>
          </div>

          {/* 預り金 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Cash (預り金)
            </span>
            <div className="text-lg font-bold mt-1 text-[var(--color-text)]" style={MONO}>
              ¥{Math.round(accountBalance.cashJpy).toLocaleString("ja-JP")}
            </div>
            {accountBalance.cashUsd > 0 && (
              <span className="text-[10px] text-[var(--color-accent-2)]" style={MONO}>
                + ${accountBalance.cashUsd.toFixed(2)}
              </span>
            )}
          </div>

          {/* その他資産 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Other Assets
            </span>
            <div className="text-lg font-bold mt-1 text-[var(--color-text)]" style={MONO}>
              ¥{Math.round(otherAssetsJpy).toLocaleString("ja-JP")}
            </div>
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              {otherAssets.length}件
            </span>
          </div>

          {/* 実現損益 */}
          <div>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>
              Realized P&L
            </span>
            <div
              className="text-lg font-bold mt-1"
              style={{ ...MONO, color: totalRealizedPnl >= 0 ? "var(--color-up)" : "var(--color-down)" }}
            >
              {totalRealizedPnl >= 0 ? "+" : ""}¥{Math.round(totalRealizedPnl).toLocaleString("ja-JP")}
            </div>
          </div>
        </div>
      </div>

      {/* 資産推移チャート */}
      {snapshots.length > 1 && (
        <div
          className="p-4 rounded"
          style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}
        >
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-3" style={MONO}>
            Asset History
          </span>
          <PortfolioChart snapshots={snapshots} />
        </div>
      )}

      {/* === タブ切り替え === */}
      <div className="flex gap-1 overflow-x-auto" style={{ borderBottom: "1px solid var(--color-border)" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-4 py-2.5 text-xs whitespace-nowrap transition-all min-h-[44px]"
            style={{
              ...MONO,
              color: activeTab === tab.id ? "var(--color-accent)" : "var(--color-text-secondary)",
              borderBottom: activeTab === tab.id ? "2px solid var(--color-accent)" : "2px solid transparent",
              background: activeTab === tab.id ? "rgba(0,240,255,0.05)" : "transparent",
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* ============ TAB: 保有銘柄 ============ */}
      {activeTab === "holdings" && (
        <>
          {/* 🔮 保有銘柄の将来性ヘルス */}
          {tickerGroups.length > 0 && (
            <PortfolioHealthPanel
              tickers={tickerGroups.map((g) => g.ticker)}
              tickerNames={Object.fromEntries(tickerGroups.map((g) => [g.ticker, g.name]))}
              totalValueByTicker={Object.fromEntries(
                tickerGroups.map((g) => [g.ticker, g.totalMarketValueJpy ?? g.totalCostBasisJpy])
              )}
            />
          )}

          {/* 立花証券連携カード */}
          <TachibanaSyncCard />

          {/* 追加ボタン */}
          <button
            onClick={() => setShowForm(!showForm)}
            className="w-full md:w-auto px-4 py-2.5 text-sm font-medium min-h-[44px] transition-all"
            style={{
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              background: showForm ? "rgba(0,240,255,0.1)" : "transparent",
              ...MONO,
            }}
          >
            {showForm ? "> CANCEL" : "> ADD HOLDING (買付)"}
          </button>

          {/* 追加フォーム */}
          {showForm && (
            <form
              onSubmit={handleSubmit}
              className="p-4 space-y-4 rounded"
              style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}
            >
              {/* 銘柄検索 */}
              <div ref={searchRef} className="relative">
                <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                  銘柄を検索
                </label>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                  className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]"
                  style={MONO}
                  placeholder="銘柄コードまたは企業名で検索 (例: イビデン, 7203, AAPL)"
                />
                {searching && (
                  <span className="absolute right-3 top-[30px] text-[10px] text-[var(--color-accent)]" style={MONO}>
                    検索中...
                  </span>
                )}

                {/* サジェスト一覧 */}
                {showSuggestions && (
                  <div
                    className="absolute z-50 w-full mt-1 max-h-[280px] overflow-y-auto rounded"
                    style={{
                      background: "var(--bg-card)",
                      border: "1px solid var(--color-accent)",
                      boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0,240,255,0.15)",
                    }}
                  >
                    {suggestions.map((s, i) => (
                      <button
                        key={`${s.ticker}-${s.market}`}
                        type="button"
                        className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                        style={{
                          background: i === selectedIndex ? "rgba(0,240,255,0.12)" : "transparent",
                          borderBottom: "1px solid var(--color-border)",
                        }}
                        onMouseEnter={() => setSelectedIndex(i)}
                        onClick={() => selectStock(s)}
                      >
                        <span
                          className="text-xs px-1.5 py-0.5 rounded"
                          style={{
                            background: s.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)",
                            color: s.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)",
                            ...MONO, fontSize: "10px",
                          }}
                        >
                          {s.market}
                        </span>
                        <span className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>{s.ticker}</span>
                        <span className="text-sm text-[var(--color-text)] flex-1">{s.name}</span>
                        {s.exchange && (
                          <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">{s.exchange}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 選択された銘柄の表示 */}
              {formData.ticker && (
                <div
                  className="flex items-center gap-3 px-3 py-2 rounded"
                  style={{ background: "rgba(0,240,255,0.06)", border: "1px solid rgba(0,240,255,0.2)" }}
                >
                  <span className="text-xs px-1.5 py-0.5" style={{ background: formData.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: formData.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)", ...MONO, fontSize: "10px" }}>
                    {formData.market}
                  </span>
                  <span className="text-sm font-bold text-[var(--color-accent)]" style={MONO}>{formData.ticker}</span>
                  <span className="text-sm text-[var(--color-text)]">{formData.name}</span>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, ticker: "", name: "", market: "JP" })}
                    className="ml-auto text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] transition-colors"
                    style={MONO}
                  >
                    {">"} CLEAR
                  </button>
                </div>
              )}

              {/* 数量 / 取得単価 / 購入日 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                    数量（株数）
                  </label>
                  <input type="number" value={formData.shares} onChange={(e) => setFormData({ ...formData, shares: e.target.value })} min="1" className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO} placeholder="100" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                    取得単価（{formData.market === "US" ? "ドル" : "円"}）
                  </label>
                  <input type="number" value={formData.avgCost} onChange={(e) => setFormData({ ...formData, avgCost: e.target.value })} required min="0" step="0.01" className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO} placeholder={formData.market === "US" ? "150.00" : "3200"} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                    購入日
                  </label>
                  <input type="date" value={formData.purchaseDate} onChange={(e) => setFormData({ ...formData, purchaseDate: e.target.value })} required className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...MONO, colorScheme: "dark" }} />
                </div>
              </div>

              {/* 手数料プレビュー */}
              {formData.avgCost && formData.shares && (
                <div className="text-[10px] text-[var(--color-text-secondary)] px-1" style={MONO}>
                  手数料: {formData.market === "JP" ? "¥0（ゼロコース）" : `$${calcCommission("US", Number(formData.shares) * Number(formData.avgCost)).toFixed(2)}（0.495%）`}
                  {" / "}
                  買付余力から {formData.market === "US" ? "$" : "¥"}
                  {(() => {
                    const amt = Number(formData.shares) * Number(formData.avgCost);
                    const comm = calcCommission(formData.market, amt);
                    return formData.market === "US" ? (amt + comm).toFixed(2) : Math.round(amt + comm).toLocaleString();
                  })()}
                  {" "}差引
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !formData.ticker || !formData.avgCost}
                className="w-full md:w-auto px-6 py-2.5 text-sm font-medium min-h-[44px] disabled:opacity-50 transition-all"
                style={{
                  border: "1px solid var(--color-accent)",
                  background: "rgba(0,240,255,0.12)",
                  color: "var(--color-accent)",
                  ...MONO,
                  boxShadow: "0 0 14px rgba(0,240,255,0.3)",
                }}
              >
                {submitting ? "> SAVING..." : "> BUY (買付)"}
              </button>
            </form>
          )}

          {/* 全銘柄チャート表示トグル */}
          {tickerGroups.length > 0 && (
            <div className="flex items-center justify-between gap-3 flex-wrap p-2 rounded" style={{ background: "rgba(0,240,255,0.03)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center gap-2 text-xs" style={MONO}>
                <button
                  onClick={() => {
                    if (allChartsExpanded) {
                      setAllChartsExpanded(false);
                      setChartExpandedTickers(new Set());
                    } else {
                      setAllChartsExpanded(true);
                      setChartExpandedTickers(new Set(tickerGroups.map((g) => g.ticker)));
                    }
                  }}
                  className="px-3 py-1.5 text-xs transition-all"
                  style={{
                    border: `1px solid ${allChartsExpanded ? "var(--color-accent)" : "var(--color-border)"}`,
                    color: allChartsExpanded ? "var(--color-accent)" : "var(--color-text-secondary)",
                    background: allChartsExpanded ? "rgba(0,240,255,0.1)" : "transparent",
                    ...MONO,
                  }}
                >
                  📈 {allChartsExpanded ? "全詳細チャート閉じる" : "全詳細チャート展開"}
                </button>
                <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
                  | 既定タイムフレーム:
                </span>
                {[
                  { id: "5m", label: "5分" },
                  { id: "1h", label: "1時間" },
                  { id: "1d", label: "日足" },
                  { id: "1wk", label: "週足" },
                  { id: "1mo", label: "月足" },
                ].map((tf) => (
                  <button
                    key={tf.id}
                    onClick={() => setGlobalTimeframe(tf.id)}
                    className="px-2 py-1 text-[10px]"
                    style={{
                      border: `1px solid ${globalTimeframe === tf.id ? "var(--color-accent-magenta)" : "var(--color-border)"}`,
                      color: globalTimeframe === tf.id ? "var(--color-accent-magenta)" : "var(--color-text-secondary)",
                      background: globalTimeframe === tf.id ? "rgba(255,0,255,0.08)" : "transparent",
                      ...MONO,
                    }}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-[var(--color-text-secondary)] w-full md:w-auto" style={MONO}>
                ※ コンパクトチャートは常時表示 / 📈で詳細展開
              </span>
            </div>
          )}

          {/* 保有銘柄リスト */}
          <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
            {/* ヘッダー */}
            <div
              className="hidden md:grid grid-cols-9 gap-2 px-4 py-2 border-b border-[var(--color-border)]"
              style={{ ...MONO, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)" }}
            >
              <span>Ticker / Name</span>
              <span className="text-right">数量</span>
              <span className="text-right">平均単価</span>
              <span className="text-right">現在価格</span>
              <span className="text-right">評価額</span>
              <span className="text-right">損益</span>
              <span className="text-center">ロット</span>
              <span className="text-center">売却</span>
              <span className="text-right">Action</span>
            </div>

            {tickerGroups.length === 0 && (
              <div className="py-12 text-center text-[var(--color-text-secondary)]">
                <p className="text-sm">保有銘柄がありません</p>
                <p className="text-xs mt-1">上のボタンから銘柄を追加してください</p>
              </div>
            )}

            {tickerGroups.map((g) => {
              const sym = currencySymbol(g.market);
              const isUp = (g.totalPnl ?? 0) >= 0;
              const pnlColor = isUp ? "var(--color-up)" : "var(--color-down)";
              const isExpanded = expandedTickers.has(g.ticker);
              const hasMultipleLots = g.lots.length > 1;

              return (
                <div key={g.ticker} className="border-b border-[var(--color-border)] last:border-b-0">
                  {/* モバイル サマリー行 */}
                  <div className="md:hidden p-3 space-y-2">
                    <div className="flex justify-between items-start">
                      <div
                        className="cursor-pointer flex-1"
                        onClick={() => hasMultipleLots ? toggleExpand(g.ticker) : router.push(`/stock/${g.ticker}`)}
                      >
                        <div className="flex items-center gap-2">
                          {hasMultipleLots && (
                            <span className="text-[10px] text-[var(--color-accent)] transition-transform" style={{ display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
                          )}
                          <span className="text-[9px] px-1 py-0.5" style={{ background: g.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: g.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)", ...MONO }}>{g.market}</span>
                          <span className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]" style={MONO}>{g.ticker}</span>
                        </div>
                        <div className="text-sm font-medium mt-0.5">{g.name}</div>
                        {tickerPatterns[g.ticker] && (
                          <div className="mt-1"><PatternBadgeGroup patterns={tickerPatterns[g.ticker]} size="sm" /></div>
                        )}
                      </div>
                      <div className="text-right">
                        {g.currentPrice !== null ? (
                          <>
                            <div className="text-sm font-bold" style={MONO}>{formatPrice(g.currentPrice, g.market)}</div>
                            {g.totalPnlPct !== null && (
                              <div className="text-xs font-medium" style={{ ...MONO, color: pnlColor }}>{isUp ? "+" : ""}{g.totalPnlPct.toFixed(2)}%</div>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-[var(--color-text-secondary)] loading-pulse" style={MONO}>...</span>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
                      <span>
                        {g.totalShares.toLocaleString()}株 @ {sym}{g.market === "US" ? g.weightedAvgCost.toFixed(2) : Math.round(g.weightedAvgCost).toLocaleString()}
                        {hasMultipleLots && <span className="ml-1 text-[var(--color-accent)] opacity-80">({g.lots.length}ロット)</span>}
                      </span>
                      {g.totalPnl !== null && (
                        <span style={{ ...MONO, color: pnlColor }}>{isUp ? "+" : ""}{sym}{Math.abs(Math.round(g.totalPnl)).toLocaleString()}</span>
                      )}
                    </div>
                    {/* モバイル売却ボタン */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setSellTarget({ holding: g.lots[0], group: g }); setSellForm({ shares: String(g.lots[0].shares), price: String(g.currentPrice ?? g.lots[0].avgCost), date: new Date().toISOString().slice(0, 10) }); }}
                        className="text-[10px] px-2 py-1 transition-colors"
                        style={{ border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", ...MONO }}
                      >
                        SELL
                      </button>
                      <button
                        onClick={() => toggleChart(g.ticker)}
                        className="text-[10px] px-2 py-1 transition-colors"
                        style={{
                          border: `1px solid ${chartExpandedTickers.has(g.ticker) ? "var(--color-accent)" : "var(--color-border)"}`,
                          color: chartExpandedTickers.has(g.ticker) ? "var(--color-accent)" : "var(--color-text-secondary)",
                          ...MONO,
                        }}
                      >
                        📈 チャート
                      </button>
                    </div>
                  </div>

                  {/* デスクトップ サマリー行 */}
                  <div
                    className="hidden md:grid grid-cols-9 gap-2 px-4 py-3 items-center transition-all"
                    style={{ background: isExpanded ? "rgba(0,240,255,0.03)" : "transparent" }}
                  >
                    <div
                      className="cursor-pointer flex items-start gap-1"
                      onClick={() => hasMultipleLots ? toggleExpand(g.ticker) : router.push(`/stock/${g.ticker}`)}
                    >
                      <div>
                        <div className="flex items-center gap-1.5">
                          {hasMultipleLots && (
                            <span className="text-[9px] text-[var(--color-accent)] transition-transform inline-block" style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
                          )}
                          <span className="text-[9px] px-1 py-0.5" style={{ background: g.market === "US" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: g.market === "US" ? "var(--color-accent-2)" : "var(--color-accent)", ...MONO }}>{g.market}</span>
                          <span className="text-[10px] text-[var(--color-accent)] tracking-[0.1em]" style={MONO}>{g.ticker}</span>
                        </div>
                        <div className="text-sm mt-0.5">{g.name}</div>
                        {tickerPatterns[g.ticker] && (
                          <div className="mt-1"><PatternBadgeGroup patterns={tickerPatterns[g.ticker]} size="sm" /></div>
                        )}
                      </div>
                    </div>
                    <span className="text-sm text-right font-bold" style={MONO}>{g.totalShares.toLocaleString()}</span>
                    <span className="text-sm text-right" style={MONO}>{sym}{g.market === "US" ? g.weightedAvgCost.toFixed(2) : Math.round(g.weightedAvgCost).toLocaleString()}</span>
                    <span className="text-sm text-right" style={MONO}>
                      {g.currentPrice !== null ? (
                        <span className="cursor-pointer hover:underline" onClick={() => router.push(`/stock/${g.ticker}`)}>{formatPrice(g.currentPrice, g.market)}</span>
                      ) : (
                        <span className="loading-pulse text-[var(--color-text-secondary)]">...</span>
                      )}
                    </span>
                    <span className="text-sm text-right font-bold" style={MONO}>{g.totalMarketValue !== null ? formatPrice(g.totalMarketValue, g.market) : "—"}</span>
                    <div className="text-right">
                      {g.totalPnl !== null ? (
                        <>
                          <div className="text-sm font-bold" style={{ ...MONO, color: pnlColor }}>{isUp ? "+" : ""}{sym}{Math.abs(Math.round(g.totalPnl)).toLocaleString()}</div>
                          <div className="text-[10px]" style={{ ...MONO, color: pnlColor }}>{isUp ? "+" : ""}{g.totalPnlPct?.toFixed(2)}%</div>
                        </>
                      ) : (
                        <span className="text-sm text-[var(--color-text-secondary)]">—</span>
                      )}
                    </div>
                    <span className="text-center">
                      {hasMultipleLots ? (
                        <button onClick={() => toggleExpand(g.ticker)} className="text-xs text-[var(--color-accent)] hover:underline px-2 py-1" style={MONO}>
                          {g.lots.length}ロット {isExpanded ? "▲" : "▼"}
                        </button>
                      ) : (
                        <span className="text-xs text-[var(--color-text-secondary)]" style={MONO}>1</span>
                      )}
                    </span>
                    {/* 売却ボタン */}
                    <span className="text-center">
                      <button
                        onClick={() => {
                          setSellTarget({ holding: g.lots[0], group: g });
                          setSellForm({ shares: String(g.lots[0].shares), price: String(g.currentPrice ?? g.lots[0].avgCost), date: new Date().toISOString().slice(0, 10) });
                        }}
                        className="text-xs px-2 py-1 transition-all hover:shadow-[0_0_8px_rgba(255,43,214,0.3)]"
                        style={{ border: "1px solid var(--color-accent-2)", color: "var(--color-accent-2)", ...MONO }}
                      >
                        SELL
                      </button>
                    </span>
                    <div className="text-right flex gap-1 justify-end">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleChart(g.ticker); }}
                        className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-1.5 py-1 transition-colors"
                        style={{
                          ...MONO,
                          border: `1px solid ${chartExpandedTickers.has(g.ticker) ? "var(--color-accent)" : "transparent"}`,
                          color: chartExpandedTickers.has(g.ticker) ? "var(--color-accent)" : undefined,
                        }}
                        title="チャート表示/非表示"
                      >
                        📈
                      </button>
                      {!hasMultipleLots && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); startEdit(g.lots[0]); }}
                            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-1.5 py-1 transition-colors"
                            style={{ ...MONO, border: "1px solid transparent" }}
                            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-accent)")}
                            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                          >
                            EDIT
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); requestDelete(g.lots[0]); }}
                            disabled={deleting === g.lots[0].id}
                            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-1.5 py-1 disabled:opacity-50 transition-colors"
                            style={{ ...MONO, border: "1px solid transparent" }}
                            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-up)")}
                            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
                          >
                            {deleting === g.lots[0].id ? "..." : "DEL"}
                          </button>
                        </>
                      )}
                      {hasMultipleLots && !isExpanded && (
                        <button onClick={() => toggleExpand(g.ticker)} className="text-xs text-[var(--color-accent)] hover:underline px-1.5 py-1" style={MONO}>
                          詳細
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 常時表示のコンパクトチャート (展開してない時のみ) */}
                  {!chartExpandedTickers.has(g.ticker) && (
                    <div className="px-4 pb-2" style={{ background: "rgba(0,0,0,0.05)" }}>
                      <HoldingChart
                        ticker={g.ticker}
                        avgCost={g.weightedAvgCost}
                        lots={g.lots.map((l) => ({
                          shares: l.shares,
                          avgCost: l.avgCost,
                          purchaseDate: l.purchaseDate,
                        }))}
                        market={g.market}
                        fixedTimeframe={globalTimeframe}
                        height={70}
                        compact
                      />
                    </div>
                  )}

                  {/* 詳細チャート (展開時) */}
                  {chartExpandedTickers.has(g.ticker) && (
                    <div className="px-4 py-3 border-t border-[var(--color-border)]" style={{ background: "rgba(0,0,0,0.2)" }}>
                      <HoldingChart
                        ticker={g.ticker}
                        avgCost={g.weightedAvgCost}
                        lots={g.lots.map((l) => ({
                          shares: l.shares,
                          avgCost: l.avgCost,
                          purchaseDate: l.purchaseDate,
                        }))}
                        market={g.market}
                        defaultTimeframe={globalTimeframe}
                        height={240}
                      />
                    </div>
                  )}

                  {/* 展開ロット */}
                  {isExpanded && hasMultipleLots && (
                    <div>
                      {g.lots.map((lot) => {
                        const lotSym = currencySymbol(lot.market);
                        const lotIsUp = (lot.pnl ?? 0) >= 0;
                        const lotPnlColor = lotIsUp ? "var(--color-up)" : "var(--color-down)";
                        const isEditingThis = editingId === lot.id;

                        return (
                          <div key={lot.id}>
                            {isEditingThis ? (
                              <div className="px-4 md:px-8 py-3 space-y-3" style={{ background: "rgba(0,240,255,0.05)", borderTop: "1px solid rgba(0,240,255,0.15)", borderBottom: "1px solid rgba(0,240,255,0.15)" }}>
                                <div className="text-[10px] text-[var(--color-accent)] uppercase tracking-[0.1em]" style={MONO}>▸ ロット編集 — {lot.purchaseDate || "日付なし"}</div>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                  <div>
                                    <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>数量</label>
                                    <input type="number" value={editForm.shares} onChange={(e) => setEditForm({ ...editForm, shares: e.target.value })} min="1" className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>取得単価（{lot.market === "US" ? "ドル" : "円"}）</label>
                                    <input type="number" value={editForm.avgCost} onChange={(e) => setEditForm({ ...editForm, avgCost: e.target.value })} min="0" step="0.01" className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>購入日</label>
                                    <input type="date" value={editForm.purchaseDate} onChange={(e) => setEditForm({ ...editForm, purchaseDate: e.target.value })} className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={{ ...MONO, colorScheme: "dark" }} />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={() => lot.id && handleEditSave(lot.id)} disabled={editSubmitting} className="px-4 py-1.5 text-xs font-medium disabled:opacity-50" style={{ border: "1px solid var(--color-accent)", background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>{editSubmitting ? "SAVING..." : "SAVE"}</button>
                                  <button onClick={() => setEditingId(null)} className="px-4 py-1.5 text-xs" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>CANCEL</button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {/* モバイル ロット行 */}
                                <div className="md:hidden px-6 py-2 border-t border-[var(--color-border)]" style={{ background: "rgba(0,240,255,0.02)" }}>
                                  <div className="flex justify-between text-xs">
                                    <span className="text-[var(--color-text-secondary)]">
                                      {lot.purchaseDate || "—"} ／ {lot.shares}株 @ {lotSym}{lot.avgCost.toLocaleString()}
                                    </span>
                                    <div className="flex gap-2 items-center">
                                      {lot.pnl !== null && (
                                        <span style={{ ...MONO, color: lotPnlColor }}>{lotIsUp ? "+" : ""}{lotSym}{Math.abs(Math.round(lot.pnl)).toLocaleString()}</span>
                                      )}
                                      <button onClick={() => { setSellTarget({ holding: lot, group: g }); setSellForm({ shares: String(lot.shares), price: String(g.currentPrice ?? lot.avgCost), date: new Date().toISOString().slice(0, 10) }); }} className="text-[var(--color-accent-2)] opacity-70" style={MONO}>SELL</button>
                                      <button onClick={() => startEdit(lot)} className="text-[var(--color-accent)] opacity-70" style={MONO}>EDIT</button>
                                      <button onClick={() => requestDelete(lot)} className="text-[var(--color-up)] opacity-70" style={MONO}>DEL</button>
                                    </div>
                                  </div>
                                </div>

                                {/* デスクトップ ロット行 */}
                                <div className="hidden md:grid grid-cols-9 gap-2 px-4 py-2 items-center text-xs" style={{ background: "rgba(0,240,255,0.02)", borderTop: "1px dashed rgba(0,240,255,0.1)", paddingLeft: "2.5rem" }}>
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[var(--color-text-secondary)] opacity-50" style={MONO}>└</span>
                                    <span className="text-[var(--color-text-secondary)]" style={MONO}>{lot.purchaseDate || "—"}</span>
                                  </div>
                                  <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>{lot.shares.toLocaleString()}</span>
                                  <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>{lotSym}{lot.avgCost.toLocaleString()}</span>
                                  <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>—</span>
                                  <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>{lot.marketValue !== null ? formatPrice(lot.marketValue, lot.market) : "—"}</span>
                                  <div className="text-right">
                                    {lot.pnl !== null ? (
                                      <>
                                        <div style={{ ...MONO, color: lotPnlColor }}>{lotIsUp ? "+" : ""}{lotSym}{Math.abs(Math.round(lot.pnl)).toLocaleString()}</div>
                                        <div className="text-[9px] opacity-70" style={{ ...MONO, color: lotPnlColor }}>{lotIsUp ? "+" : ""}{lot.pnlPct?.toFixed(2)}%</div>
                                      </>
                                    ) : (
                                      <span className="text-[var(--color-text-secondary)]">—</span>
                                    )}
                                  </div>
                                  <span />
                                  {/* ロット別売却 */}
                                  <span className="text-center">
                                    <button
                                      onClick={() => { setSellTarget({ holding: lot, group: g }); setSellForm({ shares: String(lot.shares), price: String(g.currentPrice ?? lot.avgCost), date: new Date().toISOString().slice(0, 10) }); }}
                                      className="text-[var(--color-accent-2)] hover:underline px-1"
                                      style={MONO}
                                    >
                                      SELL
                                    </button>
                                  </span>
                                  <div className="text-right flex gap-1 justify-end">
                                    <button onClick={(e) => { e.stopPropagation(); startEdit(lot); }} className="text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-1.5 py-0.5 transition-colors" style={{ ...MONO, border: "1px solid transparent" }} onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-accent)")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}>EDIT</button>
                                    <button onClick={(e) => { e.stopPropagation(); requestDelete(lot); }} disabled={deleting === lot.id} className="text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-1.5 py-0.5 disabled:opacity-50 transition-colors" style={{ ...MONO, border: "1px solid transparent" }} onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-up)")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}>{deleting === lot.id ? "..." : "DEL"}</button>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 1ロットの場合の編集フォーム */}
                  {!hasMultipleLots && editingId === g.lots[0].id && (
                    <div className="px-4 md:px-8 py-3 space-y-3" style={{ background: "rgba(0,240,255,0.05)", borderTop: "1px solid rgba(0,240,255,0.15)" }}>
                      <div className="text-[10px] text-[var(--color-accent)] uppercase tracking-[0.1em]" style={MONO}>▸ 編集</div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>数量</label>
                          <input type="number" value={editForm.shares} onChange={(e) => setEditForm({ ...editForm, shares: e.target.value })} min="1" className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>取得単価（{g.market === "US" ? "ドル" : "円"}）</label>
                          <input type="number" value={editForm.avgCost} onChange={(e) => setEditForm({ ...editForm, avgCost: e.target.value })} min="0" step="0.01" className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>購入日</label>
                          <input type="date" value={editForm.purchaseDate} onChange={(e) => setEditForm({ ...editForm, purchaseDate: e.target.value })} className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={{ ...MONO, colorScheme: "dark" }} />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => g.lots[0].id && handleEditSave(g.lots[0].id)} disabled={editSubmitting} className="px-4 py-1.5 text-xs font-medium disabled:opacity-50" style={{ border: "1px solid var(--color-accent)", background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>{editSubmitting ? "SAVING..." : "SAVE"}</button>
                        <button onClick={() => setEditingId(null)} className="px-4 py-1.5 text-xs" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>CANCEL</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ============ TAB: 口座サマリー ============ */}
      {activeTab === "account" && (
        <div className="space-y-4">
          {/* 入出金ボタン */}
          <button
            onClick={() => setShowCashModal(true)}
            className="w-full md:w-auto px-4 py-2.5 text-sm font-medium min-h-[44px] transition-all"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", ...MONO }}
          >
            {"> 入金 / 出金"}
          </button>

          {/* 口座内訳 — カテゴリ別小計 */}
          <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
            <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--color-border)" }}>
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>Account Breakdown</span>
            </div>

            {/* ── 株式セクション ── */}
            <div className="px-4 py-2" style={{ background: "rgba(0,240,255,0.03)", borderBottom: "1px solid var(--color-border)" }}>
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent)] opacity-80" style={MONO}>📈 Stocks — 株式</span>
            </div>

            {/* 国内株式 */}
            <AccountRow
              icon="🇯🇵" label="国内株式" sub={`${jpTickerCount}銘柄`}
              value={`¥${Math.round(jpValueJpy).toLocaleString("ja-JP")}`}
              pnl={jpPnlJpy} pnlPct={jpPnlPct}
            />

            {/* 米国株式 */}
            <AccountRow
              icon="🇺🇸" label="米国株式" sub={`${usTickerCount}銘柄`}
              value={`¥${Math.round(usValueJpy).toLocaleString("ja-JP")}`}
              pnl={usPnlJpy} pnlPct={usPnlPct}
            />

            {/* 株式小計 */}
            <div className="px-4 py-2.5 flex justify-between items-center" style={{ background: "rgba(0,240,255,0.05)", borderBottom: "2px solid var(--color-border)" }}>
              <span className="text-xs font-bold text-[var(--color-accent)]" style={MONO}>株式 小計</span>
              <div className="text-right">
                <span className="text-base font-bold text-[var(--color-accent)]" style={MONO}>
                  ¥{Math.round(totalValueJpy).toLocaleString("ja-JP")}
                </span>
                <span className="text-[10px] ml-2" style={{ ...MONO, color: totalPnlJpy >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                  {totalPnlJpy >= 0 ? "+" : ""}{totalPnlPct.toFixed(2)}%
                </span>
              </div>
            </div>

            {/* ── 投資信託セクション ── */}
            <div className="px-4 py-2" style={{ background: "rgba(255,43,214,0.03)", borderBottom: "1px solid var(--color-border)" }}>
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent-2)] opacity-80" style={MONO}>📊 Investment Trusts — 投資信託</span>
            </div>

            {investmentTrusts.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[var(--color-text-secondary)]" style={{ borderBottom: "1px solid var(--color-border)" }}>
                登録なし
              </div>
            ) : (
              investmentTrusts.map((it) => {
                const pnl = it.currentValue - it.costBasis;
                const pct = it.costBasis > 0 ? (pnl / it.costBasis) * 100 : 0;
                const sym = it.currency === "JPY" ? "¥" : it.currency === "USD" ? "$" : it.currency;
                return (
                  <AccountRow
                    key={it.id}
                    icon="📊" label={it.name} sub={it.purchaseDate ?? ""}
                    value={`${sym}${it.currentValue.toLocaleString()}`}
                    pnl={pnl} pnlPct={pct}
                  />
                );
              })
            )}

            {/* 投資信託小計 */}
            <div className="px-4 py-2.5 flex justify-between items-center" style={{ background: "rgba(255,43,214,0.05)", borderBottom: "2px solid var(--color-border)" }}>
              <span className="text-xs font-bold text-[var(--color-accent-2)]" style={MONO}>投資信託 小計</span>
              <div className="text-right">
                <span className="text-base font-bold text-[var(--color-accent-2)]" style={MONO}>
                  ¥{Math.round(itValueJpy).toLocaleString("ja-JP")}
                </span>
                {itCostJpy > 0 && (
                  <span className="text-[10px] ml-2" style={{ ...MONO, color: itPnlJpy >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                    {itPnlJpy >= 0 ? "+" : ""}{itPnlPct.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>

            {/* ── 外貨預金セクション ── */}
            <div className="px-4 py-2" style={{ background: "rgba(251,191,36,0.03)", borderBottom: "1px solid var(--color-border)" }}>
              <span className="text-[10px] uppercase tracking-[0.15em] opacity-80" style={{ ...MONO, color: "#fbbf24" }}>💱 Foreign Deposits — 外貨預金</span>
            </div>

            {foreignDeposits.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[var(--color-text-secondary)]" style={{ borderBottom: "1px solid var(--color-border)" }}>
                登録なし
              </div>
            ) : (
              foreignDeposits.map((fd) => {
                const pnl = fd.currentValue - fd.costBasis;
                const pct = fd.costBasis > 0 ? (pnl / fd.costBasis) * 100 : 0;
                const sym = fd.currency === "JPY" ? "¥" : fd.currency === "USD" ? "$" : fd.currency;
                return (
                  <AccountRow
                    key={fd.id}
                    icon="💱" label={fd.name} sub={fd.currency}
                    value={`${sym}${fd.currentValue.toLocaleString()}`}
                    pnl={pnl} pnlPct={pct}
                  />
                );
              })
            )}

            {/* 外貨小計 */}
            <div className="px-4 py-2.5 flex justify-between items-center" style={{ background: "rgba(251,191,36,0.05)", borderBottom: "2px solid var(--color-border)" }}>
              <span className="text-xs font-bold" style={{ ...MONO, color: "#fbbf24" }}>外貨預金 小計</span>
              <div className="text-right">
                <span className="text-base font-bold" style={{ ...MONO, color: "#fbbf24" }}>
                  ¥{Math.round(fdValueJpy).toLocaleString("ja-JP")}
                </span>
              </div>
            </div>

            {/* ── 預り金セクション ── */}
            <div className="px-4 py-2" style={{ background: "rgba(0,240,255,0.02)", borderBottom: "1px solid var(--color-border)" }}>
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)]" style={MONO}>💰 Cash — 預り金</span>
            </div>

            <AccountRow
              icon="💴" label="円預り金（買付余力）" sub="JPY"
              value={`¥${Math.round(accountBalance.cashJpy).toLocaleString("ja-JP")}`}
            />
            <div className="px-4 py-3 flex justify-between items-center" style={{ borderBottom: "1px solid var(--color-border)" }}>
              <div>
                <div className="text-sm text-[var(--color-text)]">💵 ドル預り金</div>
                <span className="text-[10px] text-[var(--color-text-secondary)]">USD</span>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-[var(--color-accent-2)]" style={MONO}>${accountBalance.cashUsd.toFixed(2)}</div>
                {usdJpy && (
                  <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>≈ ¥{Math.round(accountBalance.cashUsd * usdJpy).toLocaleString("ja-JP")}</div>
                )}
              </div>
            </div>

            {/* 預り金小計 */}
            <div className="px-4 py-2.5 flex justify-between items-center" style={{ background: "rgba(0,240,255,0.03)", borderBottom: "2px solid var(--color-border)" }}>
              <span className="text-xs font-bold text-[var(--color-text-secondary)]" style={MONO}>預り金 小計</span>
              <span className="text-base font-bold text-[var(--color-text)]" style={MONO}>
                ¥{Math.round(cashJpyTotal).toLocaleString("ja-JP")}
              </span>
            </div>

            {/* ── 実現損益 ── */}
            <div className="px-4 py-3 flex justify-between items-center" style={{ borderBottom: "1px solid var(--color-border)" }}>
              <div>
                <div className="text-sm text-[var(--color-text)]">💰 実現損益（累計）</div>
                <span className="text-[10px] text-[var(--color-text-secondary)]">Realized P&L</span>
              </div>
              <div className="text-lg font-bold" style={{ ...MONO, color: totalRealizedPnl >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                {totalRealizedPnl >= 0 ? "+" : ""}¥{Math.round(totalRealizedPnl).toLocaleString("ja-JP")}
              </div>
            </div>

            {/* ═══ 総計 ═══ */}
            <div className="px-4 py-4 flex justify-between items-center" style={{ background: "rgba(0,240,255,0.06)" }}>
              <div>
                <div className="text-sm font-bold text-[var(--color-accent)]">口座資産 総計</div>
                <span className="text-[10px] text-[var(--color-text-secondary)]">Total Account Value</span>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold" style={{ ...MONO, color: "var(--color-accent)", textShadow: "0 0 10px rgba(0,240,255,0.4)" }}>
                  ¥{Math.round(totalAccountValue).toLocaleString("ja-JP")}
                </div>
              </div>
            </div>
          </div>

          {/* 手数料体系 */}
          <div className="rounded p-4" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-text-secondary)] block mb-3" style={MONO}>
              Fee Structure — 楽天証券
            </span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-[var(--color-text-secondary)]">
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>JP</span>
                <span>国内株式: <strong className="text-[var(--color-accent)]">¥0</strong>（ゼロコース）</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(255,43,214,0.15)", color: "var(--color-accent-2)", ...MONO }}>US</span>
                <span>米国株式: <strong className="text-[var(--color-accent-2)]">0.495%</strong>（税込・上限$22）</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ TAB: 取引履歴 ============ */}
      {activeTab === "history" && (
        <div className="space-y-4">
          <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
            <div className="hidden md:grid grid-cols-7 gap-2 px-4 py-2 border-b border-[var(--color-border)]" style={{ ...MONO, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--color-text-secondary)" }}>
              <span>Date</span>
              <span>Type</span>
              <span>Ticker</span>
              <span className="text-right">数量 / 価格</span>
              <span className="text-right">金額</span>
              <span className="text-right">手数料</span>
              <span className="text-right">実現損益</span>
            </div>

            {transactions.length === 0 && (
              <div className="py-12 text-center text-[var(--color-text-secondary)]">
                <p className="text-sm">取引履歴がありません</p>
              </div>
            )}

            {transactions.map((tx) => {
              const typeLabel = { buy: "BUY", sell: "SELL", deposit: "入金", withdraw: "出金", dividend: "配当" }[tx.type];
              const typeColor = {
                buy: "var(--color-accent)",
                sell: "var(--color-accent-2)",
                deposit: "var(--color-up)",
                withdraw: "var(--color-down)",
                dividend: "#fbbf24",
              }[tx.type];

              return (
                <div key={tx.id}>
                  {/* モバイル */}
                  <div className="md:hidden p-3 border-b border-[var(--color-border)]">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] px-1.5 py-0.5 font-bold" style={{ color: typeColor, background: `${typeColor}15`, ...MONO }}>{typeLabel}</span>
                          <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>{tx.date}</span>
                        </div>
                        {tx.ticker && <div className="text-sm mt-1" style={MONO}>{tx.ticker} {tx.name && <span className="text-[var(--color-text-secondary)]">{tx.name}</span>}</div>}
                        {tx.shares && <div className="text-xs text-[var(--color-text-secondary)]" style={MONO}>{tx.shares}株 @ {tx.currency === "USD" ? "$" : "¥"}{tx.price?.toLocaleString()}</div>}
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold" style={MONO}>{tx.currency === "USD" ? "$" : "¥"}{Math.round(tx.amount).toLocaleString()}</div>
                        {tx.commission > 0 && <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>手数料: {tx.currency === "USD" ? "$" : "¥"}{tx.commission.toFixed(2)}</div>}
                        {tx.realizedPnl != null && (
                          <div className="text-xs font-bold" style={{ ...MONO, color: tx.realizedPnl >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                            {tx.realizedPnl >= 0 ? "+" : ""}{tx.currency === "USD" ? "$" : "¥"}{Math.round(tx.realizedPnl).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* デスクトップ */}
                  <div className="hidden md:grid grid-cols-7 gap-2 px-4 py-2.5 items-center border-b border-[var(--color-border)] text-sm">
                    <span className="text-[var(--color-text-secondary)]" style={MONO}>{tx.date}</span>
                    <span className="font-bold" style={{ color: typeColor, ...MONO }}>{typeLabel}</span>
                    <span style={MONO}>
                      {tx.ticker ? (
                        <span className="cursor-pointer hover:underline text-[var(--color-accent)]" onClick={() => tx.ticker && router.push(`/stock/${tx.ticker}`)}>{tx.ticker}</span>
                      ) : (
                        <span className="text-[var(--color-text-secondary)]">—</span>
                      )}
                    </span>
                    <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>
                      {tx.shares ? `${tx.shares}株 @ ${tx.currency === "USD" ? "$" : "¥"}${tx.price?.toLocaleString()}` : "—"}
                    </span>
                    <span className="text-right font-bold" style={MONO}>{tx.currency === "USD" ? "$" : "¥"}{Math.round(tx.amount).toLocaleString()}</span>
                    <span className="text-right text-[var(--color-text-secondary)]" style={MONO}>
                      {tx.commission > 0 ? `${tx.currency === "USD" ? "$" : "¥"}${tx.commission.toFixed(2)}` : "—"}
                    </span>
                    <span className="text-right">
                      {tx.realizedPnl != null ? (
                        <span className="font-bold" style={{ ...MONO, color: tx.realizedPnl >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
                          {tx.realizedPnl >= 0 ? "+" : ""}{tx.currency === "USD" ? "$" : "¥"}{Math.round(tx.realizedPnl).toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-[var(--color-text-secondary)]" style={MONO}>—</span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============ TAB: その他資産 ============ */}
      {activeTab === "others" && (
        <div className="space-y-4">
          <button
            onClick={() => setShowOtherForm(!showOtherForm)}
            className="w-full md:w-auto px-4 py-2.5 text-sm font-medium min-h-[44px] transition-all"
            style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)", background: showOtherForm ? "rgba(0,240,255,0.1)" : "transparent", ...MONO }}
          >
            {showOtherForm ? "> CANCEL" : "> ADD ASSET"}
          </button>

          {showOtherForm && (
            <form onSubmit={handleAddOther} className="p-4 space-y-4 rounded" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
              {/* 種類選択 */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>種類</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setOtherForm({ ...otherForm, type: "investment_trust", currency: "JPY", ticker: "", name: "" })}
                    className="px-4 py-2 text-sm min-h-[40px] flex-1"
                    style={{ border: `1px solid ${otherForm.type === "investment_trust" ? "var(--color-accent-2)" : "var(--color-border)"}`, background: otherForm.type === "investment_trust" ? "rgba(255,43,214,0.1)" : "transparent", color: otherForm.type === "investment_trust" ? "var(--color-accent-2)" : "var(--color-text-secondary)", ...MONO }}>
                    📊 投資信託
                  </button>
                  <button type="button" onClick={() => setOtherForm({ ...otherForm, type: "foreign_deposit", currency: "USD", ticker: "", name: "" })}
                    className="px-4 py-2 text-sm min-h-[40px] flex-1"
                    style={{ border: `1px solid ${otherForm.type === "foreign_deposit" ? "var(--color-accent)" : "var(--color-border)"}`, background: otherForm.type === "foreign_deposit" ? "rgba(0,240,255,0.1)" : "transparent", color: otherForm.type === "foreign_deposit" ? "var(--color-accent)" : "var(--color-text-secondary)", ...MONO }}>
                    💱 外貨預金
                  </button>
                </div>
              </div>

              {/* 投資信託: 銘柄検索 */}
              {otherForm.type === "investment_trust" && (
                <>
                  <div ref={fundSearchRef} className="relative">
                    <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                      ファンド検索
                    </label>
                    <input
                      type="text"
                      value={fundSearchQuery}
                      onChange={(e) => setFundSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (!showFundSuggestions) return;
                        if (e.key === "ArrowDown") { e.preventDefault(); setFundSelectedIndex((p) => Math.min(p + 1, fundSuggestions.length - 1)); }
                        else if (e.key === "ArrowUp") { e.preventDefault(); setFundSelectedIndex((p) => Math.max(p - 1, 0)); }
                        else if (e.key === "Enter" && fundSelectedIndex >= 0) {
                          e.preventDefault();
                          const s = fundSuggestions[fundSelectedIndex];
                          setOtherForm({ ...otherForm, ticker: s.ticker, name: s.name, currency: s.market === "US" ? "USD" : "JPY" });
                          setFundSearchQuery("");
                          setShowFundSuggestions(false);
                        }
                        else if (e.key === "Escape") setShowFundSuggestions(false);
                      }}
                      onFocus={() => { if (fundSuggestions.length > 0) setShowFundSuggestions(true); }}
                      className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent-2)] focus:outline-none min-h-[44px]"
                      style={MONO}
                      placeholder="ファンド名で検索 (例: eMAXIS, S&P500, 全世界)"
                    />
                    {fundSearching && (
                      <span className="absolute right-3 top-[30px] text-[10px] text-[var(--color-accent-2)]" style={MONO}>検索中...</span>
                    )}

                    {showFundSuggestions && (
                      <div className="absolute z-50 w-full mt-1 max-h-[280px] overflow-y-auto rounded" style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent-2)", boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(255,43,214,0.15)" }}>
                        {fundSuggestions.map((s, i) => (
                          <button key={`${s.ticker}-${i}`} type="button"
                            className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors"
                            style={{ background: i === fundSelectedIndex ? "rgba(255,43,214,0.12)" : "transparent", borderBottom: "1px solid var(--color-border)" }}
                            onMouseEnter={() => setFundSelectedIndex(i)}
                            onClick={() => {
                              setOtherForm({ ...otherForm, ticker: s.ticker, name: s.name, currency: s.market === "US" ? "USD" : "JPY" });
                              setFundSearchQuery("");
                              setShowFundSuggestions(false);
                            }}>
                            <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: s.type === "MUTUALFUND" ? "rgba(255,43,214,0.15)" : "rgba(0,240,255,0.15)", color: s.type === "MUTUALFUND" ? "var(--color-accent-2)" : "var(--color-accent)", ...MONO }}>
                              {s.type === "MUTUALFUND" ? "投信" : s.type === "ETF" ? "ETF" : s.market}
                            </span>
                            <span className="text-[10px] text-[var(--color-accent-2)]" style={MONO}>{s.ticker}</span>
                            <span className="text-sm text-[var(--color-text)] flex-1">{s.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 選択されたファンドの表示 */}
                  {otherForm.ticker && (
                    <div className="flex items-center gap-3 px-3 py-2 rounded" style={{ background: "rgba(255,43,214,0.06)", border: "1px solid rgba(255,43,214,0.2)" }}>
                      <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(255,43,214,0.15)", color: "var(--color-accent-2)", ...MONO }}>投信</span>
                      <span className="text-[10px] text-[var(--color-accent-2)]" style={MONO}>{otherForm.ticker}</span>
                      <span className="text-sm text-[var(--color-text)] flex-1">{otherForm.name}</span>
                      <span className="text-[10px] text-[var(--color-accent)] opacity-70" style={MONO}>基準価額自動取得</span>
                      <button type="button" onClick={() => setOtherForm({ ...otherForm, ticker: "", name: "" })}
                        className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)]" style={MONO}>CLEAR</button>
                    </div>
                  )}

                  {/* ティッカーが無い場合は手動名称入力 */}
                  {!otherForm.ticker && (
                    <div>
                      <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                        名称（検索で見つからない場合は手動入力）
                      </label>
                      <input type="text" value={otherForm.name} onChange={(e) => setOtherForm({ ...otherForm, name: e.target.value })}
                        className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO}
                        placeholder="eMAXIS Slim 全世界株式" />
                    </div>
                  )}
                </>
              )}

              {/* 外貨預金: 手動名称入力 */}
              {otherForm.type === "foreign_deposit" && (
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>名称</label>
                  <input type="text" value={otherForm.name} onChange={(e) => setOtherForm({ ...otherForm, name: e.target.value })} required
                    className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO}
                    placeholder="米ドル定期" />
                </div>
              )}

              {/* 共通フィールド */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>通貨</label>
                  <select value={otherForm.currency} onChange={(e) => setOtherForm({ ...otherForm, currency: e.target.value })} className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] min-h-[44px]" style={{ ...MONO, colorScheme: "dark" }}>
                    <option value="JPY">JPY (円)</option>
                    <option value="USD">USD (ドル)</option>
                    <option value="EUR">EUR (ユーロ)</option>
                    <option value="AUD">AUD (豪ドル)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                    {otherForm.type === "investment_trust" ? "保有口数" : "預入額"}
                  </label>
                  <input type="number" value={otherForm.amount} onChange={(e) => setOtherForm({ ...otherForm, amount: e.target.value })} required min="0" step="0.01"
                    className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO}
                    placeholder={otherForm.type === "investment_trust" ? "50000 (口)" : "1000"} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>取得額（{otherForm.currency === "JPY" ? "円" : otherForm.currency}）</label>
                  <input type="number" value={otherForm.costBasis} onChange={(e) => setOtherForm({ ...otherForm, costBasis: e.target.value })} required min="0" step="0.01"
                    className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                    {otherForm.ticker ? "現在評価額（自動更新）" : "現在評価額"}
                  </label>
                  <input type="number" value={otherForm.currentValue} onChange={(e) => setOtherForm({ ...otherForm, currentValue: e.target.value })}
                    required={!otherForm.ticker} min="0" step="0.01"
                    className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO}
                    placeholder={otherForm.ticker ? "自動取得（初期値任意）" : ""} />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>購入日</label>
                  <input type="date" value={otherForm.purchaseDate} onChange={(e) => setOtherForm({ ...otherForm, purchaseDate: e.target.value })}
                    className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={{ ...MONO, colorScheme: "dark" }} />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)] block mb-1" style={MONO}>メモ</label>
                  <input type="text" value={otherForm.memo} onChange={(e) => setOtherForm({ ...otherForm, memo: e.target.value })}
                    className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[44px]" style={MONO} placeholder="任意" />
                </div>
              </div>

              <button type="submit" disabled={otherSubmitting || !otherForm.name} className="px-6 py-2.5 text-sm font-medium min-h-[44px] disabled:opacity-50"
                style={{ border: "1px solid var(--color-accent)", background: "rgba(0,240,255,0.12)", color: "var(--color-accent)", ...MONO, boxShadow: "0 0 14px rgba(0,240,255,0.3)" }}>
                {otherSubmitting ? "> SAVING..." : "> SAVE"}
              </button>
            </form>
          )}

          {/* 資産リスト */}
          <div className="rounded overflow-hidden" style={{ border: "1px solid var(--color-border)", background: "var(--bg-card)" }}>
            {otherAssets.length === 0 && (
              <div className="py-12 text-center text-[var(--color-text-secondary)]">
                <p className="text-sm">その他資産がありません</p>
                <p className="text-xs mt-1">投資信託や外貨預金を追加できます</p>
              </div>
            )}

            {otherAssets.map((asset) => {
              // 投信でティッカーがあれば自動価格を反映
              const autoPrice = asset.ticker && fundPrices[asset.ticker] ? fundPrices[asset.ticker] : null;
              const displayValue = autoPrice && asset.amount > 0
                ? autoPrice * (asset.amount / 10000)
                : asset.currentValue;
              const pnl = displayValue - asset.costBasis;
              const pnlPct = asset.costBasis > 0 ? (pnl / asset.costBasis) * 100 : 0;
              const isUp = pnl >= 0;
              const isEditing = editingOtherId === asset.id;

              return (
                <div key={asset.id} className="px-4 py-3 border-b border-[var(--color-border)] last:border-b-0">
                  {isEditing ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>
                            現在評価額{asset.ticker ? "（ティッカーあり＝自動更新）" : ""}
                          </label>
                          <input type="number" value={editOtherForm.currentValue} onChange={(e) => setEditOtherForm({ ...editOtherForm, currentValue: e.target.value })}
                            className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>メモ</label>
                          <input type="text" value={editOtherForm.memo} onChange={(e) => setEditOtherForm({ ...editOtherForm, memo: e.target.value })}
                            className="w-full bg-[var(--bg-input)] border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={async () => {
                          if (!user || !asset.id) return;
                          await updateOtherAsset(user.uid, asset.id, { currentValue: Number(editOtherForm.currentValue) || 0, memo: editOtherForm.memo });
                          setEditingOtherId(null); await loadData();
                        }} className="px-4 py-1.5 text-xs font-medium" style={{ border: "1px solid var(--color-accent)", background: "rgba(0,240,255,0.15)", color: "var(--color-accent)", ...MONO }}>SAVE</button>
                        <button onClick={() => setEditingOtherId(null)} className="px-4 py-1.5 text-xs" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>CANCEL</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{asset.type === "foreign_deposit" ? "💱" : "📊"}</span>
                          <span className="text-sm font-medium text-[var(--color-text)]">{asset.name}</span>
                          {asset.ticker && (
                            <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(255,43,214,0.1)", color: "var(--color-accent-2)", ...MONO }}>{asset.ticker}</span>
                          )}
                          <span className="text-[9px] px-1.5 py-0.5" style={{ background: "rgba(0,240,255,0.1)", color: "var(--color-accent)", ...MONO }}>{asset.currency}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {asset.purchaseDate && <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>{asset.purchaseDate}</span>}
                          {asset.costBasis > 0 && <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>取得: {asset.currency === "JPY" ? "¥" : "$"}{asset.costBasis.toLocaleString()}</span>}
                          {asset.type === "investment_trust" && asset.amount > 0 && <span className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>{asset.amount.toLocaleString()}口</span>}
                          {autoPrice && <span className="text-[10px] text-[var(--color-accent-2)]" style={MONO}>基準価額: ¥{Math.round(autoPrice).toLocaleString()}</span>}
                          {asset.memo && <span className="text-[10px] text-[var(--color-text-secondary)]">/ {asset.memo}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="text-sm font-bold" style={MONO}>
                            {asset.currency === "JPY" ? "¥" : "$"}{Math.round(displayValue).toLocaleString()}
                          </div>
                          <div className="text-[10px]" style={{ ...MONO, color: isUp ? "var(--color-up)" : "var(--color-down)" }}>
                            {isUp ? "+" : ""}{Math.round(pnl).toLocaleString()} ({isUp ? "+" : ""}{pnlPct.toFixed(2)}%)
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => { setEditingOtherId(asset.id ?? null); setEditOtherForm({ currentValue: String(displayValue), memo: asset.memo ?? "" }); }}
                            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] px-1.5 py-1" style={MONO}>EDIT</button>
                          <button onClick={async () => { if (!user || !asset.id) return; await deleteOtherAsset(user.uid, asset.id); await loadData(); }}
                            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-up)] px-1.5 py-1" style={MONO}>DEL</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* === 売却モーダル === */}
      {sellTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(5,6,13,0.85)", backdropFilter: "blur(4px)" }}
          onClick={() => setSellTarget(null)}
        >
          <div
            className="relative w-[90vw] max-w-lg p-6 rounded space-y-5"
            style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent-2)", boxShadow: "0 0 40px rgba(255,43,214,0.2), inset 0 0 0 1px rgba(255,43,214,0.1)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="absolute top-0 left-0 w-4 h-4 border-t border-l" style={{ borderColor: "var(--color-accent-2)" }} />
            <span className="absolute top-0 right-0 w-4 h-4 border-t border-r" style={{ borderColor: "var(--color-accent-2)" }} />
            <span className="absolute bottom-0 left-0 w-4 h-4 border-b border-l" style={{ borderColor: "var(--color-accent-2)" }} />
            <span className="absolute bottom-0 right-0 w-4 h-4 border-b border-r" style={{ borderColor: "var(--color-accent-2)" }} />

            <div className="flex items-center gap-2">
              <span className="text-[var(--color-accent-2)] text-lg">📉</span>
              <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent-2)]" style={MONO}>Sell — {sellTarget.group.ticker}</span>
            </div>

            <div className="px-3 py-2.5 rounded" style={{ background: "rgba(255,43,214,0.06)", border: "1px solid rgba(255,43,214,0.15)" }}>
              <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>
                {sellTarget.group.ticker} — {sellTarget.group.name}
              </div>
              <div className="text-xs text-[var(--color-text)] opacity-80 mt-0.5" style={MONO}>
                保有: {sellTarget.holding.shares.toLocaleString()}株 @ {currencySymbol(sellTarget.holding.market)}{sellTarget.holding.avgCost.toLocaleString()}
              </div>
              {sellTarget.group.currentPrice !== null && (
                <div className="text-xs text-[var(--color-accent)] mt-0.5" style={MONO}>
                  現在値: {formatPrice(sellTarget.group.currentPrice, sellTarget.group.market)}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>売却数量</label>
                <input type="number" value={sellForm.shares} onChange={(e) => setSellForm({ ...sellForm, shares: e.target.value })} min="1" max={sellTarget.holding.shares} className="w-full bg-[var(--bg-input)] border border-[var(--color-accent-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
              </div>
              <div>
                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>売却単価</label>
                <input type="number" value={sellForm.price} onChange={(e) => setSellForm({ ...sellForm, price: e.target.value })} min="0" step="0.01" className="w-full bg-[var(--bg-input)] border border-[var(--color-accent-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={MONO} />
              </div>
              <div>
                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>売却日</label>
                <input type="date" value={sellForm.date} onChange={(e) => setSellForm({ ...sellForm, date: e.target.value })} className="w-full bg-[var(--bg-input)] border border-[var(--color-accent-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none min-h-[40px]" style={{ ...MONO, colorScheme: "dark" }} />
              </div>
            </div>

            {/* プレビュー */}
            {sellForm.shares && sellForm.price && (() => {
              const shares = Number(sellForm.shares);
              const price = Number(sellForm.price);
              const market = sellTarget.holding.market;
              const sym = currencySymbol(market);
              const sellAmount = shares * price;
              const commission = calcCommission(market, sellAmount);
              const costBasis = shares * sellTarget.holding.avgCost;
              const realizedPnl = sellAmount - costBasis - commission;
              const isProfit = realizedPnl >= 0;

              return (
                <div className="text-xs space-y-1 px-3 py-2 rounded" style={{ background: "rgba(255,43,214,0.04)", border: "1px solid rgba(255,43,214,0.1)" }}>
                  <div className="flex justify-between" style={MONO}>
                    <span className="text-[var(--color-text-secondary)]">売却代金</span>
                    <span>{sym}{sellAmount.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between" style={MONO}>
                    <span className="text-[var(--color-text-secondary)]">手数料</span>
                    <span>{market === "JP" ? "¥0" : `$${commission.toFixed(2)}`}</span>
                  </div>
                  <div className="flex justify-between" style={MONO}>
                    <span className="text-[var(--color-text-secondary)]">取得原価</span>
                    <span>{sym}{costBasis.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between font-bold pt-1" style={{ ...MONO, borderTop: "1px dashed rgba(255,43,214,0.2)" }}>
                    <span>実現損益</span>
                    <span style={{ color: isProfit ? "var(--color-up)" : "var(--color-down)" }}>
                      {isProfit ? "+" : ""}{sym}{Math.round(realizedPnl).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px]" style={MONO}>
                    <span className="text-[var(--color-text-secondary)]">預り金に戻る額</span>
                    <span className="text-[var(--color-accent)]">{sym}{Math.round(sellAmount - commission).toLocaleString()}</span>
                  </div>
                </div>
              );
            })()}

            <div className="flex gap-3 justify-end pt-1">
              <button onClick={() => setSellTarget(null)} className="px-5 py-2 text-xs min-h-[40px]" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>CANCEL</button>
              <button
                onClick={handleSell}
                disabled={sellSubmitting || !sellForm.shares || !sellForm.price || Number(sellForm.shares) > sellTarget.holding.shares}
                className="px-5 py-2 text-xs font-medium min-h-[40px] disabled:opacity-50"
                style={{ border: "1px solid var(--color-accent-2)", background: "rgba(255,43,214,0.15)", color: "var(--color-accent-2)", boxShadow: "0 0 12px rgba(255,43,214,0.25)", ...MONO }}
              >
                {sellSubmitting ? "SELLING..." : "SELL"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === 入出金モーダル === */}
      {showCashModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(5,6,13,0.85)", backdropFilter: "blur(4px)" }}
          onClick={() => setShowCashModal(false)}
        >
          <div
            className="relative w-[90vw] max-w-md p-6 rounded space-y-5"
            style={{ background: "var(--bg-card)", border: "1px solid var(--color-accent)", boxShadow: "0 0 40px rgba(0,240,255,0.15)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="absolute top-0 left-0 w-4 h-4 border-t border-l border-[var(--color-accent)]" />
            <span className="absolute top-0 right-0 w-4 h-4 border-t border-r border-[var(--color-accent)]" />

            <div className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)]" style={MONO}>
              💰 入金 / 出金
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setCashForm({ ...cashForm, type: "deposit" })}
                className="px-3 py-2 text-sm min-h-[40px]"
                style={{
                  border: `1px solid ${cashForm.type === "deposit" ? "var(--color-accent)" : "var(--color-border)"}`,
                  background: cashForm.type === "deposit" ? "rgba(0,240,255,0.1)" : "transparent",
                  color: cashForm.type === "deposit" ? "var(--color-accent)" : "var(--color-text-secondary)",
                  ...MONO,
                }}
              >入金</button>
              <button
                onClick={() => setCashForm({ ...cashForm, type: "withdraw" })}
                className="px-3 py-2 text-sm min-h-[40px]"
                style={{
                  border: `1px solid ${cashForm.type === "withdraw" ? "var(--color-up)" : "var(--color-border)"}`,
                  background: cashForm.type === "withdraw" ? "rgba(255,59,107,0.1)" : "transparent",
                  color: cashForm.type === "withdraw" ? "var(--color-up)" : "var(--color-text-secondary)",
                  ...MONO,
                }}
              >出金</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>通貨</label>
                <select value={cashForm.currency} onChange={(e) => setCashForm({ ...cashForm, currency: e.target.value as "JPY" | "USD" })} className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] min-h-[40px]" style={{ ...MONO, colorScheme: "dark" }}>
                  <option value="JPY">JPY (円)</option>
                  <option value="USD">USD (ドル)</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-[var(--color-text-secondary)] block mb-1" style={MONO}>金額</label>
                <input type="number" value={cashForm.amount} onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })} min="0" step="0.01" className="w-full bg-[var(--bg-input)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-h-[40px]" style={MONO} placeholder={cashForm.currency === "JPY" ? "1000000" : "1000"} />
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowCashModal(false)} className="px-5 py-2 text-xs min-h-[40px]" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>CANCEL</button>
              <button
                onClick={handleCashAction}
                disabled={cashSubmitting || !cashForm.amount}
                className="px-5 py-2 text-xs font-medium min-h-[40px] disabled:opacity-50"
                style={{ border: "1px solid var(--color-accent)", background: "rgba(0,240,255,0.12)", color: "var(--color-accent)", ...MONO }}
              >
                {cashSubmitting ? "処理中..." : cashForm.type === "deposit" ? "入金する" : "出金する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === 削除確認モーダル === */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(5,6,13,0.85)", backdropFilter: "blur(4px)" }}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="relative w-[90vw] max-w-md p-6 rounded space-y-5"
            style={{ background: "var(--bg-card)", border: "1px solid var(--color-up)", boxShadow: "0 0 40px rgba(255,59,107,0.2), inset 0 0 0 1px rgba(255,59,107,0.1)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="absolute top-0 left-0 w-4 h-4 border-t border-l" style={{ borderColor: "var(--color-up)" }} />
            <span className="absolute top-0 right-0 w-4 h-4 border-t border-r" style={{ borderColor: "var(--color-up)" }} />
            <span className="absolute bottom-0 left-0 w-4 h-4 border-b border-l" style={{ borderColor: "var(--color-up)" }} />
            <span className="absolute bottom-0 right-0 w-4 h-4 border-b border-r" style={{ borderColor: "var(--color-up)" }} />

            <div className="flex items-center gap-2">
              <span className="text-[var(--color-up)] text-lg">⚠</span>
              <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-up)]" style={MONO}>Delete Confirmation</span>
            </div>

            <div className="px-3 py-2.5 rounded" style={{ background: "rgba(255,59,107,0.06)", border: "1px solid rgba(255,59,107,0.15)" }}>
              <div className="text-sm font-bold text-[var(--color-text)]" style={MONO}>
                {deleteTarget.ticker} — {deleteTarget.name}
              </div>
              <div className="text-xs text-[var(--color-text)] opacity-80 mt-0.5" style={MONO}>
                {deleteTarget.shares.toLocaleString()} 株
              </div>
            </div>

            <p className="text-sm text-[var(--color-text)]">
              このロットを削除しますか？<span className="opacity-70">この操作は取り消せません。</span>
            </p>

            <div className="flex gap-3 justify-end pt-1">
              <button onClick={() => setDeleteTarget(null)} className="px-5 py-2 text-xs min-h-[40px]" style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", ...MONO }}>CANCEL</button>
              <button onClick={confirmDelete} className="px-5 py-2 text-xs font-medium min-h-[40px]" style={{ border: "1px solid var(--color-up)", background: "rgba(255,59,107,0.15)", color: "var(--color-up)", boxShadow: "0 0 12px rgba(255,59,107,0.25)", ...MONO }}>DELETE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ========================================
// 立花証券 連携カード
// ========================================
interface TachibanaHolding {
  ticker: string;
  shares: number;
  avgCost: number;
  evalPrice: number;
  evalAmount: number;
  pnl: number;
  pnlRate: number;
}
interface TachibanaPortfolio {
  ok: boolean;
  env?: string;
  lastLoginDate?: string;
  totalEvalAmount?: number;
  totalPnl?: number;
  holdings?: TachibanaHolding[];
  error?: string;
}

function TachibanaSyncCard() {
  const [data, setData] = useState<TachibanaPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0); // forces re-render for "X秒前" updates

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { auth } = await import("@/lib/firebase");
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("ログインが必要です");
      const res = await fetch("/api/tachibana/portfolio", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as TachibanaPortfolio;
      setData(json);
      setLastFetchedAt(new Date());
      if (json.ok) setExpanded(true);
    } catch (e) {
      setData({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  // 自動更新: 60秒間隔。ただしタブ非表示時は停止
  useEffect(() => {
    if (!autoRefresh) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      // 開始時に1回取得
      fetchData();
      timer = setInterval(() => {
        if (!document.hidden) fetchData();
      }, 60_000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoRefresh, fetchData]);

  // "X秒前" 表示を1秒ごとに更新
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const sinceText = lastFetchedAt
    ? (() => {
        const sec = Math.floor((Date.now() - lastFetchedAt.getTime()) / 1000);
        if (sec < 60) return `${sec}秒前`;
        if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
        return `${Math.floor(sec / 3600)}時間前`;
      })()
    : "未取得";
  void tick; // suppress unused warning

  return (
    <div
      className="p-4 rounded space-y-3"
      style={{
        border: "1px solid var(--color-accent-magenta)",
        background: "rgba(255,0,255,0.04)",
      }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent-magenta)] font-medium flex items-center gap-2" style={MONO}>
            🏦 立花証券 e支店 連携 {data?.env && `(${data.env})`}
            {autoRefresh && (
              <span
                className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded"
                style={{
                  background: "rgba(0,240,255,0.1)",
                  color: "var(--color-accent)",
                  border: "1px solid var(--color-accent)",
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                LIVE
              </span>
            )}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-1" style={MONO}>
            {lastFetchedAt
              ? `最終更新: ${sinceText}${autoRefresh ? "（60秒毎に自動更新中）" : ""}`
              : "リアルな保有銘柄を立花APIから直接取得"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-[10px] cursor-pointer select-none px-2 py-1.5"
            style={MONO}
          >
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-3.5 h-3.5 accent-[var(--color-accent-magenta)]"
            />
            <span className="text-[var(--color-text-secondary)]">自動更新</span>
          </label>
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-4 py-2 text-xs font-medium min-h-[40px] transition-all"
            style={{
              border: "1px solid var(--color-accent-magenta)",
              color: "var(--color-accent-magenta)",
              background: loading ? "rgba(255,0,255,0.15)" : "transparent",
              ...MONO,
            }}
          >
            {loading ? "取得中..." : "> 取得 / 更新"}
          </button>
        </div>
      </div>

      {data && !data.ok && (
        <div className="text-xs text-red-400" style={MONO}>
          エラー: {data.error}
        </div>
      )}

      {data?.ok && expanded && (
        <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
          <div className="grid grid-cols-2 gap-3 text-xs" style={MONO}>
            <div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">評価額合計</div>
              <div className="text-base font-medium">
                ¥{(data.totalEvalAmount ?? 0).toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">評価損益</div>
              <div
                className="text-base font-medium"
                style={{
                  color: (data.totalPnl ?? 0) >= 0 ? "var(--color-accent)" : "#ff4d6d",
                }}
              >
                {(data.totalPnl ?? 0) >= 0 ? "+" : ""}¥{(data.totalPnl ?? 0).toLocaleString()}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            {(data.holdings ?? []).map((h) => (
              <div
                key={h.ticker}
                className="grid grid-cols-[80px_60px_1fr_1fr_80px] gap-2 text-xs py-1.5 px-2 rounded"
                style={{ background: "rgba(0,0,0,0.3)", ...MONO }}
              >
                <span className="text-[var(--color-accent)]">{h.ticker}</span>
                <span>{h.shares}株</span>
                <span className="text-right text-[var(--color-text-secondary)]">
                  ¥{h.evalAmount.toLocaleString()}
                </span>
                <span
                  className="text-right"
                  style={{
                    color: h.pnl >= 0 ? "var(--color-accent)" : "#ff4d6d",
                  }}
                >
                  {h.pnl >= 0 ? "+" : ""}¥{h.pnl.toLocaleString()}
                </span>
                <span
                  className="text-right"
                  style={{
                    color: h.pnlRate >= 0 ? "var(--color-accent)" : "#ff4d6d",
                  }}
                >
                  {h.pnlRate >= 0 ? "+" : ""}{h.pnlRate.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)]" style={MONO}>
            ※ 立花APIから取得したリアルデータです（{data.env === "demo" ? "デモ環境" : "本番環境"}）。
            上の手動登録銘柄とは別管理です。
          </div>
        </div>
      )}
    </div>
  );
}

// ========================================
// 資産推移チャート（SVGベース）
// ========================================
// ========================================
// 口座サマリー行コンポーネント
// ========================================
function AccountRow({ icon, label, sub, value, pnl, pnlPct }: {
  icon: string;
  label: string;
  sub?: string;
  value: string;
  pnl?: number;
  pnlPct?: number;
}) {
  const MONO_INNER = { fontFamily: "'JetBrains Mono', monospace" };
  return (
    <div className="px-4 py-3 flex justify-between items-center" style={{ borderBottom: "1px solid var(--color-border)" }}>
      <div>
        <div className="text-sm text-[var(--color-text)]">{icon} {label}</div>
        {sub && <span className="text-[10px] text-[var(--color-text-secondary)]">{sub}</span>}
      </div>
      <div className="text-right">
        <div className="text-sm font-bold text-[var(--color-text)]" style={MONO_INNER}>{value}</div>
        {pnl != null && pnlPct != null && (
          <div className="text-[10px]" style={{ ...MONO_INNER, color: pnl >= 0 ? "var(--color-up)" : "var(--color-down)" }}>
            {pnl >= 0 ? "+" : ""}¥{Math.round(pnl).toLocaleString("ja-JP")} ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
          </div>
        )}
      </div>
    </div>
  );
}

function PortfolioChart({ snapshots }: { snapshots: PortfolioSnapshot[] }) {
  if (snapshots.length < 2) return null;

  const W = 800;
  const H = 200;
  const PX = 40;
  const PY = 20;
  const chartW = W - PX * 2;
  const chartH = H - PY * 2;

  const values = snapshots.map((s) => s.totalValue);
  const minV = Math.min(...values) * 0.98;
  const maxV = Math.max(...values) * 1.02;
  const rangeV = maxV - minV || 1;

  const points = snapshots.map((s, i) => {
    const x = PX + (i / (snapshots.length - 1)) * chartW;
    const y = PY + chartH - ((s.totalValue - minV) / rangeV) * chartH;
    return `${x},${y}`;
  });

  const polyline = points.join(" ");
  const areaPoints = `${PX},${PY + chartH} ${polyline} ${PX + chartW},${PY + chartH}`;

  const isUp = values[values.length - 1] >= values[0];
  const lineColor = isUp ? "var(--color-up)" : "var(--color-down)";
  const glowColor = isUp ? "rgba(255,59,107,0.5)" : "rgba(0,217,255,0.5)";
  const fillColor = isUp ? "rgba(255,59,107,0.08)" : "rgba(0,217,255,0.08)";

  const yLabels = [minV, (minV + maxV) / 2, maxV].map((v) => ({
    value: v,
    y: PY + chartH - ((v - minV) / rangeV) * chartH,
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }}>
      <defs>
        <filter id="chart-glow">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      {yLabels.map((l, i) => (
        <g key={i}>
          <line x1={PX} y1={l.y} x2={PX + chartW} y2={l.y} stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="4 4" />
          <text x={PX - 5} y={l.y + 3} textAnchor="end" fill="var(--color-text-secondary)" fontSize="9" fontFamily="'JetBrains Mono', monospace">
            {(l.value / 10000).toFixed(0)}万
          </text>
        </g>
      ))}
      <text x={PX} y={H - 2} fill="var(--color-text-secondary)" fontSize="9" fontFamily="'JetBrains Mono', monospace">
        {snapshots[0].date.slice(5)}
      </text>
      <text x={PX + chartW} y={H - 2} textAnchor="end" fill="var(--color-text-secondary)" fontSize="9" fontFamily="'JetBrains Mono', monospace">
        {snapshots[snapshots.length - 1].date.slice(5)}
      </text>
      <polygon points={areaPoints} fill={fillColor} />
      <polyline points={polyline} fill="none" stroke={glowColor} strokeWidth="4" filter="url(#chart-glow)" />
      <polyline points={polyline} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
      {points.length > 0 && (
        <circle
          cx={parseFloat(points[points.length - 1].split(",")[0])}
          cy={parseFloat(points[points.length - 1].split(",")[1])}
          r="4"
          fill={lineColor}
          style={{ filter: `drop-shadow(0 0 6px ${glowColor})` }}
        />
      )}
    </svg>
  );
}
