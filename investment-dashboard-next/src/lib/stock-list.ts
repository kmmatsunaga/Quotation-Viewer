/**
 * 主要銘柄リスト（オートコンプリート用）
 * ticker: Yahoo Finance形式
 */
export interface StockEntry {
  ticker: string;
  name: string;
  market: "JP" | "US";
}

export const STOCK_LIST: StockEntry[] = [
  // ===== 日本株 (東証) =====
  { ticker: "7203", name: "トヨタ自動車", market: "JP" },
  { ticker: "6758", name: "ソニーグループ", market: "JP" },
  { ticker: "6861", name: "キーエンス", market: "JP" },
  { ticker: "9984", name: "ソフトバンクグループ", market: "JP" },
  { ticker: "8306", name: "三菱UFJフィナンシャルG", market: "JP" },
  { ticker: "6501", name: "日立製作所", market: "JP" },
  { ticker: "7974", name: "任天堂", market: "JP" },
  { ticker: "4063", name: "信越化学工業", market: "JP" },
  { ticker: "6902", name: "デンソー", market: "JP" },
  { ticker: "9433", name: "KDDI", market: "JP" },
  { ticker: "6954", name: "ファナック", market: "JP" },
  { ticker: "9432", name: "日本電信電話 (NTT)", market: "JP" },
  { ticker: "8035", name: "東京エレクトロン", market: "JP" },
  { ticker: "4568", name: "第一三共", market: "JP" },
  { ticker: "6098", name: "リクルートHD", market: "JP" },
  { ticker: "6367", name: "ダイキン工業", market: "JP" },
  { ticker: "6273", name: "SMC", market: "JP" },
  { ticker: "6594", name: "日本電産 (ニデック)", market: "JP" },
  { ticker: "7741", name: "HOYA", market: "JP" },
  { ticker: "4519", name: "中外製薬", market: "JP" },
  { ticker: "7267", name: "本田技研工業 (ホンダ)", market: "JP" },
  { ticker: "8058", name: "三菱商事", market: "JP" },
  { ticker: "9434", name: "ソフトバンク", market: "JP" },
  { ticker: "6981", name: "村田製作所", market: "JP" },
  { ticker: "4661", name: "オリエンタルランド", market: "JP" },
  { ticker: "8001", name: "伊藤忠商事", market: "JP" },
  { ticker: "6762", name: "TDK", market: "JP" },
  { ticker: "3382", name: "セブン&アイHD", market: "JP" },
  { ticker: "4503", name: "アステラス製薬", market: "JP" },
  { ticker: "6301", name: "小松製作所 (コマツ)", market: "JP" },
  { ticker: "4901", name: "富士フイルムHD", market: "JP" },
  { ticker: "6857", name: "アドバンテスト", market: "JP" },
  { ticker: "7751", name: "キヤノン", market: "JP" },
  { ticker: "8031", name: "三井物産", market: "JP" },
  { ticker: "6971", name: "京セラ", market: "JP" },
  { ticker: "9983", name: "ファーストリテイリング", market: "JP" },
  { ticker: "2914", name: "日本たばこ産業 (JT)", market: "JP" },
  { ticker: "8766", name: "東京海上HD", market: "JP" },
  { ticker: "4502", name: "武田薬品工業", market: "JP" },
  { ticker: "8316", name: "三井住友フィナンシャルG", market: "JP" },
  { ticker: "8411", name: "みずほフィナンシャルG", market: "JP" },
  { ticker: "6702", name: "富士通", market: "JP" },
  { ticker: "6723", name: "ルネサスエレクトロニクス", market: "JP" },
  { ticker: "7011", name: "三菱重工業", market: "JP" },
  { ticker: "6920", name: "レーザーテック", market: "JP" },
  { ticker: "4578", name: "大塚HD", market: "JP" },
  { ticker: "9101", name: "日本郵船", market: "JP" },
  { ticker: "5108", name: "ブリヂストン", market: "JP" },
  { ticker: "6326", name: "クボタ", market: "JP" },
  { ticker: "2802", name: "味の素", market: "JP" },
  { ticker: "6753", name: "シャープ", market: "JP" },
  { ticker: "7201", name: "日産自動車", market: "JP" },
  { ticker: "8802", name: "三菱地所", market: "JP" },
  { ticker: "9020", name: "JR東日本", market: "JP" },
  { ticker: "9022", name: "JR東海", market: "JP" },
  { ticker: "2503", name: "キリンHD", market: "JP" },
  { ticker: "2502", name: "アサヒグループHD", market: "JP" },
  { ticker: "6752", name: "パナソニックHD", market: "JP" },
  { ticker: "7269", name: "スズキ", market: "JP" },
  { ticker: "3407", name: "旭化成", market: "JP" },
  { ticker: "4062", name: "イビデン", market: "JP" },
  { ticker: "6506", name: "安川電機", market: "JP" },
  { ticker: "4911", name: "資生堂", market: "JP" },
  { ticker: "6479", name: "ミネベアミツミ", market: "JP" },
  { ticker: "6146", name: "ディスコ", market: "JP" },
  { ticker: "6645", name: "オムロン", market: "JP" },
  { ticker: "3659", name: "ネクソン", market: "JP" },
  { ticker: "4385", name: "メルカリ", market: "JP" },
  { ticker: "6526", name: "ソシオネクスト", market: "JP" },
  { ticker: "6963", name: "ローム", market: "JP" },
  { ticker: "6988", name: "日東電工", market: "JP" },
  { ticker: "7735", name: "SCREENホールディングス", market: "JP" },

  // ===== 米国株 =====
  { ticker: "AAPL", name: "Apple", market: "US" },
  { ticker: "MSFT", name: "Microsoft", market: "US" },
  { ticker: "GOOGL", name: "Alphabet (Google)", market: "US" },
  { ticker: "AMZN", name: "Amazon", market: "US" },
  { ticker: "NVDA", name: "NVIDIA", market: "US" },
  { ticker: "META", name: "Meta Platforms", market: "US" },
  { ticker: "TSLA", name: "Tesla", market: "US" },
  { ticker: "JPM", name: "JPMorgan Chase", market: "US" },
  { ticker: "V", name: "Visa", market: "US" },
  { ticker: "AVGO", name: "Broadcom", market: "US" },
  { ticker: "UNH", name: "UnitedHealth Group", market: "US" },
  { ticker: "JNJ", name: "Johnson & Johnson", market: "US" },
  { ticker: "XOM", name: "Exxon Mobil", market: "US" },
  { ticker: "MA", name: "Mastercard", market: "US" },
  { ticker: "PG", name: "Procter & Gamble", market: "US" },
  { ticker: "HD", name: "Home Depot", market: "US" },
  { ticker: "COST", name: "Costco", market: "US" },
  { ticker: "ABBV", name: "AbbVie", market: "US" },
  { ticker: "KO", name: "Coca-Cola", market: "US" },
  { ticker: "PEP", name: "PepsiCo", market: "US" },
  { ticker: "CRM", name: "Salesforce", market: "US" },
  { ticker: "MRK", name: "Merck", market: "US" },
  { ticker: "LLY", name: "Eli Lilly", market: "US" },
  { ticker: "AMD", name: "AMD", market: "US" },
  { ticker: "NFLX", name: "Netflix", market: "US" },
  { ticker: "DIS", name: "Walt Disney", market: "US" },
  { ticker: "INTC", name: "Intel", market: "US" },
  { ticker: "ADBE", name: "Adobe", market: "US" },
  { ticker: "CSCO", name: "Cisco Systems", market: "US" },
  { ticker: "WMT", name: "Walmart", market: "US" },
  { ticker: "BA", name: "Boeing", market: "US" },
  { ticker: "NKE", name: "Nike", market: "US" },
  { ticker: "PYPL", name: "PayPal", market: "US" },
  { ticker: "UBER", name: "Uber Technologies", market: "US" },
  { ticker: "SQ", name: "Block (Square)", market: "US" },
  { ticker: "COIN", name: "Coinbase", market: "US" },
  { ticker: "PLTR", name: "Palantir Technologies", market: "US" },
  { ticker: "SOFI", name: "SoFi Technologies", market: "US" },
  { ticker: "ARM", name: "Arm Holdings", market: "US" },
  { ticker: "SMCI", name: "Super Micro Computer", market: "US" },
];

/**
 * 銘柄を検索（ticker or name でマッチ）
 * 最大 maxResults 件を返す
 */
export function searchStocks(
  keyword: string,
  maxResults: number = 10
): StockEntry[] {
  if (!keyword.trim()) return [];
  const lower = keyword.toLowerCase();
  return STOCK_LIST.filter(
    (s) =>
      s.ticker.toLowerCase().includes(lower) ||
      s.name.toLowerCase().includes(lower)
  ).slice(0, maxResults);
}
