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
  where,
  serverTimestamp,
  Timestamp,
  writeBatch,
  setDoc,
  limit as fsLimit,
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
  purchaseDate?: string; // YYYY-MM-DD
  source?: "manual" | "mail";  // mail = 楽天約定メールより自動反映
  sourceKeys?: string[];        // 反映済み fill キー (参照用)
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
// Watchlist Groups（お気に入りグループ）
// ============================================================
export interface WatchlistGroup {
  id?: string;
  name: string;
  order: number;
  createdAt?: Timestamp;
}

export async function getWatchlistGroups(uid: string): Promise<WatchlistGroup[]> {
  const q = query(userCol(uid, "watchlistGroups"), orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as WatchlistGroup));
}

export async function addWatchlistGroup(uid: string, name: string, order: number) {
  return addDoc(userCol(uid, "watchlistGroups"), {
    name,
    order,
    createdAt: serverTimestamp(),
  });
}

export async function updateWatchlistGroup(uid: string, id: string, name: string) {
  return updateDoc(doc(db, "users", uid, "watchlistGroups", id), {
    name,
  });
}

export async function deleteWatchlistGroup(uid: string, id: string) {
  // グループ内の銘柄も全部消す
  const itemsQ = query(
    userCol(uid, "watchlist"),
    where("groupId", "==", id)
  );
  const snap = await getDocs(itemsQ);
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, "users", uid, "watchlistGroups", id));
  return batch.commit();
}

// ============================================================
// Watchlist Items（お気に入り銘柄）
// ============================================================
export interface WatchlistItem {
  id?: string;
  ticker: string;
  name: string;
  market: string;
  groupId: string;
  addedAt?: Timestamp;
}

export async function getWatchlist(uid: string): Promise<WatchlistItem[]> {
  const q = query(userCol(uid, "watchlist"), orderBy("addedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as WatchlistItem));
}

export async function getWatchlistByGroup(uid: string, groupId: string): Promise<WatchlistItem[]> {
  // 複合インデックス不要 — 全件取得してクライアントフィルタ
  const q = query(userCol(uid, "watchlist"));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as WatchlistItem))
    .filter((item) => item.groupId === groupId)
    .sort((a, b) => {
      const aTime = a.addedAt?.toMillis?.() ?? 0;
      const bTime = b.addedAt?.toMillis?.() ?? 0;
      return bTime - aTime;
    });
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
export type AlertType =
  | "price_above"         // 株価が targetPrice 以上
  | "price_below"         // 株価が targetPrice 以下
  | "earnings_days_before" // 決算 N 日前
  | "earnings_post_move"   // 決算後の値動きが ±N% 超えたら
  | "volume_anomaly"       // 出来高が普段の N 倍超え
  | "margin_squeeze";      // 信用倍率 < 1 になったら (踏み上げ候補)

export interface PriceAlert {
  id?: string;
  ticker: string;
  name: string;
  // 旧式互換: condition + targetPrice
  condition?: "above" | "below";
  targetPrice?: number;
  // 新式: type + params
  type?: AlertType;
  params?: {
    targetPrice?: number;       // price_above/below 用
    daysBefore?: number;         // earnings_days_before 用 (例: 3)
    movePct?: number;            // earnings_post_move / volume_anomaly 用 (例: 5)
  };
  active: boolean;
  triggered: boolean;
  triggeredAt?: Timestamp | null;
  triggeredValue?: number | null;  // 発動時の値 (デバッグ・通知用)
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export async function getAlerts(uid: string): Promise<PriceAlert[]> {
  const q = query(userCol(uid, "alerts"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as PriceAlert));
}

export async function addAlert(uid: string, data: Omit<PriceAlert, "id" | "active" | "triggered" | "createdAt" | "updatedAt">) {
  // 旧式 (condition + targetPrice) を新式 (type + params) に変換
  let normalized: Partial<PriceAlert> = { ...data };
  if (data.condition && data.targetPrice !== undefined && !data.type) {
    normalized = {
      ...data,
      type: data.condition === "above" ? "price_above" : "price_below",
      params: { targetPrice: data.targetPrice },
    };
  }
  return addDoc(userCol(uid, "alerts"), {
    ...normalized,
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

// ============================================================
// Account Balance（口座残高・預り金）
// ============================================================
export interface AccountBalance {
  cashJpy: number;       // 円預り金
  cashUsd: number;       // ドル預り金
  updatedAt?: Timestamp;
}

export async function getAccountBalance(uid: string): Promise<AccountBalance> {
  const ref = doc(db, "users", uid, "settings", "accountBalance");
  const snap = await getDoc(ref);
  if (!snap.exists()) return { cashJpy: 0, cashUsd: 0 };
  const data = snap.data();
  return {
    cashJpy: Number(data.cashJpy ?? 0),
    cashUsd: Number(data.cashUsd ?? 0),
  };
}

export async function setAccountBalance(uid: string, balance: AccountBalance) {
  const ref = doc(db, "users", uid, "settings", "accountBalance");
  const { setDoc: setDocFn } = await import("firebase/firestore");
  return setDocFn(ref, { ...balance, updatedAt: serverTimestamp() });
}

// ============================================================
// Transactions（取引履歴）
// ============================================================
export interface Transaction {
  id?: string;
  type: "buy" | "sell" | "deposit" | "withdraw" | "dividend";
  ticker?: string;
  name?: string;
  market?: string;
  shares?: number;
  price?: number;
  amount: number;            // 総額（手数料込み） ＝ 実際に動いた金額
  commission: number;        // 手数料
  currency: "JPY" | "USD";
  realizedPnl?: number;      // 売却時の実現損益
  memo?: string;
  date: string;              // YYYY-MM-DD
  /** 自動取込の重複排除キー (楽天約定メールなら fillKey)。手動入力では undefined */
  sourceKey?: string;
  createdAt?: Timestamp;
}

/**
 * 約定メールから現金を同期し始める基準時刻。
 * 過去分に遡って適用すると、手動で記録済みの取引と二重計上になるため、
 * 「この時刻より後の約定」だけを現金に反映する。初回同期時に now で作られる。
 */
export async function getCashSyncStartAt(uid: string): Promise<string | null> {
  const snap = await getDoc(doc(db, "users", uid, "settings", "cashSync"));
  return snap.exists() ? ((snap.data().startAt as string) ?? null) : null;
}
export async function setCashSyncStartAt(uid: string, iso: string) {
  const { setDoc: setDocFn } = await import("firebase/firestore");
  return setDocFn(doc(db, "users", uid, "settings", "cashSync"), { startAt: iso, updatedAt: serverTimestamp() });
}

export async function getTransactions(uid: string, limitN: number = 100): Promise<Transaction[]> {
  const q = query(
    userCol(uid, "transactions"),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.slice(0, limitN).map((d) => ({ id: d.id, ...d.data() } as Transaction));
}

export async function addTransaction(uid: string, data: Omit<Transaction, "id" | "createdAt">) {
  return addDoc(userCol(uid, "transactions"), {
    ...data,
    createdAt: serverTimestamp(),
  });
}

// ============================================================
// Other Assets（外貨預金・投資信託など）
// ============================================================
export interface OtherAsset {
  id?: string;
  type: "foreign_deposit" | "investment_trust";
  ticker?: string;           // YF ティッカー（投資信託用、基準価額自動取得）
  name: string;
  currency: string;          // JPY, USD, EUR, etc.
  amount: number;            // 数量（口数 or 金額）
  currentValue: number;      // 現在の評価額（手動入力 or 自動）
  costBasis: number;         // 取得額
  purchaseDate?: string;     // YYYY-MM-DD
  memo?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export async function getOtherAssets(uid: string): Promise<OtherAsset[]> {
  const q = query(userCol(uid, "otherAssets"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as OtherAsset));
}

export async function addOtherAsset(uid: string, data: Omit<OtherAsset, "id" | "createdAt" | "updatedAt">) {
  return addDoc(userCol(uid, "otherAssets"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateOtherAsset(uid: string, id: string, data: Partial<OtherAsset>) {
  const ref = doc(db, "users", uid, "otherAssets", id);
  return updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

export async function deleteOtherAsset(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "otherAssets", id));
}

// ============================================================
// Commission（手数料計算）— 楽天証券ベース
// ============================================================
/**
 * 楽天証券 ゼロコース: 国内株式 ¥0
 * 米国株式: 約定代金の 0.495%（税込）、上限 $22（税込）
 * ※ 最低手数料なし（2023年以降）
 */
export function calcCommission(market: string, amount: number): number {
  if (market === "JP") return 0; // ゼロコース
  // US stocks
  const fee = amount * 0.00495;
  return Math.min(fee, 22);
}

// ============================================================
// Pattern Alert Settings（パターンアラート設定）
// LINE Messaging API 用
// ============================================================
export interface PatternAlertSettings {
  channelAccessToken: string;
  lineUserId: string;
  enabled: boolean;
  threshold: number; // proximity threshold (0-100)
}

export async function getPatternAlertSettings(
  uid: string
): Promise<PatternAlertSettings> {
  const [tokenSnap, userIdSnap, enabledSnap, thresholdSnap] = await Promise.all([
    getDoc(doc(db, "users", uid, "settings", "lineChannelAccessToken")),
    getDoc(doc(db, "users", uid, "settings", "lineUserId")),
    getDoc(doc(db, "users", uid, "settings", "patternAlertEnabled")),
    getDoc(doc(db, "users", uid, "settings", "patternAlertThreshold")),
  ]);

  return {
    channelAccessToken: tokenSnap.exists()
      ? (tokenSnap.data().value as string)
      : "",
    lineUserId: userIdSnap.exists()
      ? (userIdSnap.data().value as string)
      : "",
    enabled: enabledSnap.exists()
      ? enabledSnap.data().value === "true"
      : false,
    threshold: thresholdSnap.exists()
      ? Number(thresholdSnap.data().value)
      : 40,
  };
}

export async function savePatternAlertSettings(
  uid: string,
  settings: PatternAlertSettings
) {
  await Promise.all([
    setSetting(uid, "lineChannelAccessToken", settings.channelAccessToken),
    setSetting(uid, "lineUserId", settings.lineUserId),
    setSetting(uid, "patternAlertEnabled", String(settings.enabled)),
    setSetting(uid, "patternAlertThreshold", String(settings.threshold)),
  ]);
}

// ============================================================
// Watched Patterns（パターン監視）
// ============================================================
export async function getWatchedPatterns(uid: string): Promise<string[]> {
  const snap = await getDoc(doc(db, "users", uid, "settings", "watchedPatterns"));
  if (!snap.exists()) return [];
  const val = snap.data().value as string;
  return val ? val.split(",").filter(Boolean) : [];
}

export async function setWatchedPatterns(uid: string, patternIds: string[]) {
  return setSetting(uid, "watchedPatterns", patternIds.join(","));
}

// ============================================================
// Watchdog Events（ポートフォリオ・ウォッチドッグ）
// 保有銘柄に異変があった時に記録される自動検知イベント
// ============================================================
export type WatchdogEventType =
  | "price_spike"          // 価格急変
  | "volume_anomaly"        // 出来高異常
  | "margin_squeeze"        // 信用倍率急変・踏み上げ警戒
  | "earnings_warning"      // 決算前警告
  | "stop_loss_near"        // 損切りライン接近
  | "target_reached"        // シナリオ目標達成
  | "news_alert";           // 重要ニュース

export type WatchdogSeverity = "info" | "warning" | "critical";

export interface WatchdogEvent {
  id?: string;
  ticker: string;
  name: string;
  type: WatchdogEventType;
  severity: WatchdogSeverity;
  message: string;
  data?: Record<string, unknown>;
  triggeredAt?: Timestamp;
  acknowledged?: boolean;
  lineNotified?: boolean;
  // 重複防止用キー (同じイベントは1日1回まで)
  dedupKey?: string;
}

export async function getWatchdogEvents(
  uid: string,
  limit: number = 50
): Promise<WatchdogEvent[]> {
  const q = query(userCol(uid, "watchdogEvents"), orderBy("triggeredAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.slice(0, limit).map((d) => ({ id: d.id, ...d.data() } as WatchdogEvent));
}

export async function addWatchdogEvent(
  uid: string,
  data: Omit<WatchdogEvent, "id" | "triggeredAt" | "acknowledged">
) {
  return addDoc(userCol(uid, "watchdogEvents"), {
    ...data,
    acknowledged: false,
    triggeredAt: serverTimestamp(),
  });
}

export async function acknowledgeWatchdogEvent(uid: string, id: string) {
  return updateDoc(doc(db, "users", uid, "watchdogEvents", id), {
    acknowledged: true,
  });
}

// ============================================================
// Daily Recommendations（デイリーおすすめ）
// AIエージェントが毎朝生成する「今日のおすすめ」
// ============================================================
export interface DailyRecommendation {
  id?: string;
  date: string;  // YYYY-MM-DD
  recommendations: {
    ticker: string;
    name: string;
    market: string;
    score: number;        // 0-100
    summary: string;       // 1行サマリ
    reasons: string[];     // 推奨理由 (3-5個)
    currentPrice: number;
    changePct: number;
    suggestedAction?: string;
  }[];
  generatedAt?: Timestamp;
}

export async function getDailyRecommendation(
  uid: string,
  date?: string  // YYYY-MM-DD, 省略時は今日
): Promise<DailyRecommendation | null> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const ref = doc(db, "users", uid, "dailyRecommendations", targetDate);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as DailyRecommendation;
}

export async function setDailyRecommendation(
  uid: string,
  data: Omit<DailyRecommendation, "id" | "generatedAt">
) {
  const ref = doc(db, "users", uid, "dailyRecommendations", data.date);
  const { setDoc } = await import("firebase/firestore");
  return setDoc(ref, {
    ...data,
    generatedAt: serverTimestamp(),
  });
}

// ============================================================
// Investment Scenarios（投資シナリオ）
// 銘柄を買う前に「シナリオ」を書いておき、後で振り返ることで
// 投資判断の質を向上させる機能。
// ============================================================
export type ScenarioDirection = "buy" | "sell" | "watch";
export type ScenarioHoldingPeriod = "1w" | "1m" | "3m" | "6m" | "1y" | "long";
export type ScenarioStatus =
  | "active"             // 監視中
  | "achieved"           // 目標達成
  | "stopped"            // 損切り発動
  | "expired"            // 保有期間超過
  | "manually_closed";   // 手動クローズ

export const SCENARIO_RATIONALE_TAGS = [
  "決算",
  "業績好調",
  "テーマ性",
  "テクニカル",
  "材料発表",
  "押し目",
  "高配当",
  "成長性",
  "割安",
  "需給",
  "直感",
] as const;

export const SCENARIO_REFLECTION_TAGS = [
  "シナリオ通り",
  "想定外の好材料",
  "想定外の悪材料",
  "市場全体の影響",
  "為替の影響",
  "感情で動いた",
  "我慢できた",
  "我慢できなかった",
  "ルール守れた",
  "ルール破った",
] as const;

export interface InvestmentScenario {
  id?: string;
  ticker: string;
  name: string;
  market: string;
  direction: ScenarioDirection;
  entryPrice: number;
  targetPrices: number[];          // 目標株価 (複数OK、達成しやすい順に並べる)
  stopLossPrice: number;
  holdingPeriod: ScenarioHoldingPeriod;
  rationale: string;               // 自由記述
  rationaleTags: string[];
  risks: string;                   // 想定リスク (自由記述)
  confidence: number;              // 1〜5
  status: ScenarioStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  closedAt?: Timestamp | null;
  closePrice?: number | null;
  closeReason?: string;
  reflectionTags?: string[];
  reflectionNote?: string;
  // 達成評価フラグ（自動 or 手動でセット）
  achievedTargets?: number[];      // 達成したtarget価格のインデックス
  maxFavorablePrice?: number;      // シナリオ中の最高値（買いの場合）/最安値（売り）
  maxAdversePrice?: number;        // 同 最悪値
}

export async function getScenarios(
  uid: string,
  status?: ScenarioStatus
): Promise<InvestmentScenario[]> {
  const q = query(userCol(uid, "scenarios"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  let list = snap.docs.map((d) => ({ id: d.id, ...d.data() } as InvestmentScenario));
  if (status) list = list.filter((s) => s.status === status);
  return list;
}

export async function getScenario(uid: string, id: string): Promise<InvestmentScenario | null> {
  const ref = doc(db, "users", uid, "scenarios", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as InvestmentScenario;
}

export async function addScenario(
  uid: string,
  data: Omit<InvestmentScenario, "id" | "createdAt" | "updatedAt" | "status">
) {
  return addDoc(userCol(uid, "scenarios"), {
    ...data,
    status: "active" as ScenarioStatus,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateScenario(
  uid: string,
  id: string,
  data: Partial<InvestmentScenario>
) {
  const ref = doc(db, "users", uid, "scenarios", id);
  return updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

export async function closeScenario(
  uid: string,
  id: string,
  closeData: {
    status: Exclude<ScenarioStatus, "active">;
    closePrice: number;
    closeReason?: string;
    reflectionTags?: string[];
    reflectionNote?: string;
  }
) {
  const ref = doc(db, "users", uid, "scenarios", id);
  return updateDoc(ref, {
    ...closeData,
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteScenario(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "scenarios", id));
}

// ============================================================
// Trades（トレードジャーナル）
// ============================================================

/** エントリー根拠タグの定義 (勝率をタグ別に集計する) */
export const TRADE_REASON_TAGS = [
  "板圧",
  "VWAP反発",
  "VWAP抜け",
  "ギャップ",
  "出来高急増",
  "ニュース",
  "セクター連動",
  "テクニカル",
  "評決強気",
  "リバウンド狙い",
  "勘",
] as const;

export interface Trade {
  id?: string;
  ticker: string;
  name: string;
  market: string;              // "JP" | "US"
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  entryAt: string;             // ISO datetime
  exitPrice: number | null;
  exitAt: string | null;       // ISO datetime
  status: "open" | "closed";
  pnl: number | null;          // 決済時に確定 (手数料抜き)
  pnlPct: number | null;
  reasonTags: string[];        // TRADE_REASON_TAGS から複数
  memo: string;
  source: "manual" | "csv" | "mail" | "tachibana";
  sourceKeys?: string[];       // 重複排除キー (Gmail msgId / CSV行ハッシュ等)
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export function computeTradePnl(t: Pick<Trade, "side" | "qty" | "entryPrice">, exitPrice: number): { pnl: number; pnlPct: number } {
  const diff = t.side === "long" ? exitPrice - t.entryPrice : t.entryPrice - exitPrice;
  const pnl = Math.round(diff * t.qty);
  const pnlPct = t.entryPrice > 0 ? Math.round((diff / t.entryPrice) * 10000) / 100 : 0;
  return { pnl, pnlPct };
}

export async function getTrades(uid: string, limitN = 500): Promise<Trade[]> {
  const q = query(userCol(uid, "trades"), orderBy("entryAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.slice(0, limitN).map((d) => ({ id: d.id, ...d.data() } as Trade));
}

export async function addTrade(uid: string, data: Omit<Trade, "id" | "createdAt" | "updatedAt">) {
  return addDoc(userCol(uid, "trades"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateTrade(uid: string, id: string, data: Partial<Trade>) {
  const ref = doc(db, "users", uid, "trades", id);
  return updateDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

export async function deleteTrade(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "trades", id));
}

/** オープンポジションを決済してクローズ */
export async function closeTrade(uid: string, trade: Trade, exitPrice: number, exitAt: string) {
  const { pnl, pnlPct } = computeTradePnl(trade, exitPrice);
  return updateTrade(uid, trade.id!, {
    exitPrice,
    exitAt,
    status: "closed",
    pnl,
    pnlPct,
  });
}

// ============================================================
// PositionPlan (買い方の設計) — 買う前に作る規律の装置
// ============================================================
export interface PositionPlan {
  id?: string;
  ticker: string;
  name: string;
  createdPrice: number;         // 作成時の現在値
  entries: { label: string; price: number; shares: number; amount: number }[];
  totalShares: number;
  totalAmount: number;
  avgEntry: number;
  stop: number;                 // 損切りライン (厳守)
  target: number;               // 利確目安 (RRR 2:1)
  riskAmount: number;
  riskPctOfAssets: number;
  positionPctOfAssets: number;
  lotSize: 1 | 100;             // 1=かぶミニ / 100=単元
  memo: string;                 // なぜ買うか (テーゼ)
  status: "planned" | "executing" | "done" | "cancelled";
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export async function getPositionPlans(uid: string): Promise<PositionPlan[]> {
  const q = query(userCol(uid, "positionPlans"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as PositionPlan));
}

export async function addPositionPlan(uid: string, data: Omit<PositionPlan, "id" | "createdAt" | "updatedAt">) {
  return addDoc(userCol(uid, "positionPlans"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updatePositionPlan(uid: string, id: string, data: Partial<PositionPlan>) {
  return updateDoc(doc(db, "users", uid, "positionPlans", id), { ...data, updatedAt: serverTimestamp() });
}

export async function deletePositionPlan(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "positionPlans", id));
}

// ============================================================
// Notes (気づきメモ) — 使い込み中に引っかかった瞬間を1行で残す壁打ちの球
// ============================================================
export type NoteCategory = "usability" | "feature" | "trust" | "bug";
export interface Note {
  id?: string;
  text: string;
  category: NoteCategory;
  path: string;          // メモした時の画面パス (例 /warroom)
  ticker: string | null; // 画面が銘柄詳細なら ticker
  status: "open" | "done";
  createdAt?: Timestamp;
}

export async function getNotes(uid: string): Promise<Note[]> {
  const snap = await getDocs(query(userCol(uid, "notes"), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Note));
}

export async function addNote(uid: string, data: Omit<Note, "id" | "createdAt">) {
  return addDoc(userCol(uid, "notes"), { ...data, createdAt: serverTimestamp() });
}

export async function updateNote(uid: string, id: string, data: Partial<Note>) {
  return updateDoc(doc(db, "users", uid, "notes", id), data);
}

export async function deleteNote(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "notes", id));
}

// ============================================================
// 🩺 投資家問診票 (Investor Profile)
//   users/{uid}/profile/current         — 最新の回答 (編集で上書き)
//   users/{uid}/profileHistory/{autoId} — 保存のたびのスナップショット (心境の変化を追う)
// ============================================================
export interface InvestorProfileDoc {
  answers: Record<string, unknown>;
  scores: Record<string, number>;
  savedAt?: Timestamp;
  note?: string;              // 保存時の一言 (任意)
  changedKeys?: string[];     // 前回から変わった質問ID
}

export async function getInvestorProfile(uid: string): Promise<InvestorProfileDoc | null> {
  const snap = await getDoc(doc(db, "users", uid, "profile", "current"));
  return snap.exists() ? (snap.data() as InvestorProfileDoc) : null;
}

/** 保存 = current の上書き + 履歴への追記 (変更があった時だけ履歴を残す) */
export async function saveInvestorProfile(
  uid: string,
  answers: Record<string, unknown>,
  scores: Record<string, number>,
  note?: string,
): Promise<{ changedKeys: string[]; historySaved: boolean }> {
  const prev = await getInvestorProfile(uid);
  const changedKeys: string[] = [];
  const keys = new Set([...Object.keys(answers), ...Object.keys(prev?.answers ?? {})]);
  for (const k of keys) {
    if (JSON.stringify(answers[k] ?? null) !== JSON.stringify(prev?.answers?.[k] ?? null)) changedKeys.push(k);
  }
  await setDoc(doc(db, "users", uid, "profile", "current"), {
    answers, scores, savedAt: serverTimestamp(), note: note ?? "",
  });
  const historySaved = changedKeys.length > 0 || !prev;
  if (historySaved) {
    await addDoc(userCol(uid, "profileHistory"), {
      answers, scores, savedAt: serverTimestamp(), note: note ?? "", changedKeys,
    });
  }
  return { changedKeys, historySaved };
}

export async function getProfileHistory(uid: string, limitN = 30): Promise<(InvestorProfileDoc & { id: string })[]> {
  const q = query(userCol(uid, "profileHistory"), orderBy("savedAt", "desc"), fsLimit(limitN));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as InvestorProfileDoc) }));
}
