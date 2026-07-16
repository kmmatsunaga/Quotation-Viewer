/**
 * 業界/テーマ × 代表銘柄マッピング
 *
 * 構造: B (JPX風業種) + C (手動テーマ) のハイブリッド。
 *   業種: 33業種に縛らず、Cavka の判断で実用的な括りに整理 (例「半導体」「自動車」)
 *   テーマ: 横断的テーマ (例「AI関連」「防衛」「インバウンド」)
 *
 * 同じ銘柄が複数のテーマに属するのは OK (例: ソニーは「電子部品」「ゲーム・エンタメ」両方)
 *
 * 代表銘柄は時価総額/出来高上位 10-20 銘柄を厳選。
 * 新規上場銘柄やニッチ銘柄は省略 (Hot Index の母数を安定させるため)
 */

export type SectorCategory = "industry" | "theme";

export interface SectorDef {
  id: string;            // "semiconductor"
  name: string;          // "半導体"
  emoji: string;
  category: SectorCategory;
  description: string;   // 投資視点での説明
  tickers: string[];     // 代表銘柄 4桁
  macroDrivers: string[]; // 連動するマクロ要因 ID (例: "china", "oil")
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 業種 (Industry) - 伝統的セクター分類
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const INDUSTRIES: SectorDef[] = [
  {
    id: "auto",
    name: "自動車",
    emoji: "🚗",
    category: "industry",
    description: "輸送用機器、自動車本体・部品",
    tickers: ["7203", "7267", "7201", "7269", "7270", "7211", "7261", "7202", "6902", "6201"],
    macroDrivers: ["fx_weak_yen", "china_demand", "fed_cut"],
  },
  {
    id: "bank",
    name: "銀行",
    emoji: "🏦",
    category: "industry",
    description: "メガバンク、地銀、信託",
    tickers: ["8306", "8316", "8411", "7182", "8308", "8304", "8331", "8334", "8354", "8355"],
    macroDrivers: ["fed_hike", "boj_hike", "recession_low"],
  },
  {
    id: "insurance",
    name: "保険",
    emoji: "🛡",
    category: "industry",
    description: "損保・生保",
    tickers: ["8766", "8725", "8630", "8795", "8750"],
    macroDrivers: ["fed_hike", "boj_hike"],
  },
  {
    id: "trading",
    name: "商社",
    emoji: "🌐",
    category: "industry",
    description: "総合商社 (資源・エネルギー・食料の世界貿易)",
    tickers: ["8058", "8031", "8001", "8002", "8053", "2768"],
    macroDrivers: ["oil_high", "china_demand", "fx_weak_yen"],
  },
  {
    id: "semiconductor",
    name: "半導体",
    emoji: "💾",
    category: "industry",
    description: "半導体製造装置・素材・デバイス",
    tickers: ["8035", "6857", "6920", "6963", "6981", "6526", "4063", "3436", "6754", "6753"],
    macroDrivers: ["semi_cycle_up", "china_demand", "fed_cut", "fx_weak_yen"],
  },
  {
    id: "electronics",
    name: "電子部品・電機",
    emoji: "⚡",
    category: "industry",
    description: "電子部品、家電、産業用電機",
    tickers: ["6758", "6981", "6762", "6971", "6594", "6501", "6502", "6701", "6098", "6504"],
    macroDrivers: ["semi_cycle_up", "fx_weak_yen", "china_demand"],
  },
  {
    id: "telecom",
    name: "通信",
    emoji: "📡",
    category: "industry",
    description: "通信キャリア、データセンター",
    tickers: ["9432", "9433", "9434", "9613", "9697", "4307"],
    macroDrivers: ["recession_low"],
  },
  {
    id: "shipping",
    name: "海運",
    emoji: "🚢",
    category: "industry",
    description: "外航海運、コンテナ船、タンカー",
    tickers: ["9101", "9104", "9107"],
    macroDrivers: ["china_demand", "oil_high"],
  },
  {
    id: "rail_air",
    name: "鉄道・空運",
    emoji: "🚄",
    category: "industry",
    description: "JR各社、私鉄、航空",
    tickers: ["9020", "9022", "9001", "9007", "9202", "9201"],
    macroDrivers: ["inbound", "oil_low"],
  },
  {
    id: "steel",
    name: "鉄鋼",
    emoji: "🏗",
    category: "industry",
    description: "高炉、特殊鋼",
    tickers: ["5401", "5411", "5406"],
    macroDrivers: ["china_demand"],
  },
  {
    id: "chemical",
    name: "化学",
    emoji: "🧪",
    category: "industry",
    description: "総合化学、ファインケミカル",
    tickers: ["4063", "4188", "4452", "4901", "4204", "4061", "4042"],
    macroDrivers: ["china_demand", "oil_high"],
  },
  {
    id: "pharma",
    name: "医薬品",
    emoji: "💊",
    category: "industry",
    description: "医薬品メーカー",
    tickers: ["4502", "4503", "4519", "4523", "4568", "4578"],
    macroDrivers: ["fed_cut"],
  },
  {
    id: "food",
    name: "食品・飲料",
    emoji: "🍱",
    category: "industry",
    description: "食品メーカー、飲料",
    tickers: ["2914", "2503", "2502", "2802", "2587"],
    macroDrivers: ["recession_low"],
  },
  {
    id: "retail",
    name: "小売・流通",
    emoji: "🛒",
    category: "industry",
    description: "小売、コンビニ、スーパー、ドラッグ",
    tickers: ["9983", "3382", "8267", "3099", "3088"],
    macroDrivers: ["fx_strong_yen", "consumer_strong"],
  },
  {
    id: "real_estate",
    name: "不動産",
    emoji: "🏢",
    category: "industry",
    description: "デベロッパー、REIT",
    tickers: ["8801", "8802", "8830", "3289"],
    macroDrivers: ["fed_cut", "boj_dovish"],
  },
  {
    id: "construction",
    name: "建設・住宅",
    emoji: "🏗",
    category: "industry",
    description: "ゼネコン、住宅",
    tickers: ["1925", "1928", "1812", "1801", "1802", "1803", "1808"],
    macroDrivers: ["boj_dovish"],
  },
  {
    id: "utility",
    name: "電力・ガス",
    emoji: "💡",
    category: "industry",
    description: "電力会社、都市ガス",
    tickers: ["9501", "9503", "9532", "9531"],
    macroDrivers: ["oil_low", "recession_low"],
  },
  {
    id: "machinery",
    name: "機械",
    emoji: "🏭",
    category: "industry",
    description: "工作機械、産業機械",
    tickers: ["6301", "6326", "6273", "6361", "6367", "6273", "6954"],
    macroDrivers: ["semi_cycle_up", "china_demand", "fx_weak_yen"],
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// テーマ (Theme) - 横断的テーマ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const THEMES: SectorDef[] = [
  {
    id: "ai",
    name: "AI関連",
    emoji: "🤖",
    category: "theme",
    description: "AI 開発・基盤・応用",
    tickers: ["9984", "4307", "6098", "3655", "3902", "4475", "6526", "6920"],
    macroDrivers: ["semi_cycle_up", "fed_cut"],
  },
  {
    id: "defense",
    name: "防衛",
    emoji: "🛡",
    category: "theme",
    description: "防衛装備、軍需対応",
    tickers: ["7011", "7012", "7013", "6203", "6208", "5631"],
    macroDrivers: [],
  },
  {
    id: "ev_battery",
    name: "EV・蓄電池",
    emoji: "🔋",
    category: "theme",
    description: "電池材料、EV関連",
    tickers: ["6752", "4188", "5803", "3402", "6594", "5713"],
    macroDrivers: ["china_demand"],
  },
  {
    id: "hydrogen",
    name: "水素・新エネ",
    emoji: "💨",
    category: "theme",
    description: "水素エネルギー、燃料電池",
    tickers: ["1605", "5020", "5019", "8088", "1928"],
    macroDrivers: [],
  },
  {
    id: "renewable",
    name: "再生エネ",
    emoji: "🌱",
    category: "theme",
    description: "太陽光・風力・地熱",
    tickers: ["9513", "9519", "9522", "1418"],
    macroDrivers: [],
  },
  {
    id: "inbound",
    name: "インバウンド",
    emoji: "✈",
    category: "theme",
    description: "訪日観光関連 (ホテル、空運、化粧品、百貨店)",
    tickers: ["9202", "9201", "9020", "4452", "3099", "8233", "3382"],
    macroDrivers: ["fx_weak_yen"],
  },
  {
    id: "game",
    name: "ゲーム・エンタメ",
    emoji: "🎮",
    category: "theme",
    description: "ゲーム、コンテンツ、SNS",
    tickers: ["7974", "9684", "3659", "7832", "4751", "6758"],
    macroDrivers: ["recession_low"],
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ALL_SECTORS: SectorDef[] = [...INDUSTRIES, ...THEMES];

export function getSectorById(id: string): SectorDef | null {
  return ALL_SECTORS.find((s) => s.id === id) ?? null;
}

/** ある銘柄が所属する全テーマを返す */
export function getSectorsForTicker(ticker: string): SectorDef[] {
  return ALL_SECTORS.filter((s) => s.tickers.includes(ticker));
}

/** マクロ要因の日本語ラベル (表示用) */
export const MACRO_DRIVER_LABELS: Record<string, string> = {
  fx_weak_yen: "💴 円安追風",
  fx_strong_yen: "💴 円高追風",
  fed_hike: "🇺🇸 FRB利上げ追風",
  fed_cut: "🇺🇸 FRB利下げ追風",
  boj_hike: "🇯🇵 日銀利上げ追風",
  boj_dovish: "🇯🇵 日銀緩和追風",
  china_demand: "🇨🇳 中国需要追風",
  oil_high: "🛢 原油高追風",
  oil_low: "🛢 原油安追風",
  recession_low: "📈 景気拡大追風",
  inbound: "✈ インバウンド追風",
  consumer_strong: "🛒 消費堅調追風",
  semi_cycle_up: "🔬 半導体サイクル追風",
};
