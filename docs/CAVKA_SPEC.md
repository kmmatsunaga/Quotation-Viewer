# Cavka — Neo Tokyo Trading Terminal 設計書

> **最終更新**: 2026-05-28 (autoupdate by Claude)
> **目的**: 開発の継続性とAI(Claude)による再現性を担保する仕様書。
> 過去のチャット履歴がなくても、このファイルを読めばCavkaの全体像が把握できる状態を維持する。

---

## 📖 目次

1. [プロジェクト概要](#プロジェクト概要)
2. [ディレクトリ構成](#ディレクトリ構成)
3. [全体アーキテクチャ](#全体アーキテクチャ)
4. [ページ一覧](#ページ一覧)
5. [APIエンドポイント](#apiエンドポイント)
6. [データソース](#データソース)
7. [データモデル (Firestore)](#データモデル-firestore)
8. [環境変数](#環境変数)
9. [認証](#認証)
10. [MCPツール](#mcpツール)
11. [定期実行 (Cron)](#定期実行-cron)
12. [立花API実装メモ](#立花api実装メモ)
13. [キャッシュ戦略](#キャッシュ戦略)
14. [デプロイ](#デプロイ)
15. [将来性スコアエンジン](#将来性スコアエンジン-future-score)
16. [既知の制約・課題](#既知の制約課題)
17. [変更履歴](#変更履歴)

---

## プロジェクト概要

**Cavka** は個人投資家のための投資判断支援ダッシュボード。
- 立花証券e支店APIで実データ取得
- ファンダ・テクニカル・板情報を統合分析
- AIエージェントが「今日のおすすめ」「異変警告」を自動提示
- MCPサーバ経由でClaudeとも統合 (会話で「7203を分析して」など)

### キーバリュー
- **コスト**: 月額¥0 (Vercel Hobby + Firebase Spark + 立花API無料)
- **コンセプト**: 「データを集める」だけでなく「**意味を解釈し**、判断を補助する」

### 関連プロジェクト
- `investment-dashboard-next/` — フロント+API (Next.js 15)
- `cavka-mcp-server/` — Claude用MCPサーバ
- `investment-dashboard/` — 旧版 (FastAPI、ほぼ非利用)

---

## ディレクトリ構成

```
Quotation-Viewer/                       (プロジェクトルート、Vercel デプロイ対象)
├── docs/                              ← 本ファイル等の設計書
│   ├── CAVKA_SPEC.md                  ← この設計書
│   └── CHANGELOG.md                   ← 日々の変更履歴
├── investment-dashboard-next/         ← 本体 (Next.js 15)
│   ├── src/
│   │   ├── app/
│   │   │   ├── api/                   ← API Routes
│   │   │   │   ├── stocks/            ← 株価・ファンダ・パターン等
│   │   │   │   ├── tachibana/         ← 立花API ラッパ
│   │   │   │   ├── market/            ← トップ画面用 (indices, news)
│   │   │   │   ├── news/              ← 立花ニュース
│   │   │   │   ├── portfolio/         ← Firestoreポートフォリオ統合
│   │   │   │   ├── agent/             ← AIエージェント (daily-recommend)
│   │   │   │   ├── watchdog/          ← ポートフォリオ監視
│   │   │   │   ├── cron/              ← Vercel Cron用
│   │   │   │   ├── auth/qr/           ← QRログイン
│   │   │   │   ├── screener/cache/    ← スクリーナー結果キャッシュ
│   │   │   │   ├── alerts/            ← 価格・パターン・LINEアラート
│   │   │   │   └── line/              ← LINE通知
│   │   │   ├── stock/[ticker]/        ← 銘柄詳細 (主役画面)
│   │   │   ├── portfolio/             ← ポートフォリオ画面
│   │   │   ├── scenarios/             ← 投資シナリオ管理
│   │   │   ├── screener/              ← ファンダスクリーナー
│   │   │   ├── patterns/              ← パターンスキャン
│   │   │   ├── calendar/              ← 決算カレンダー
│   │   │   ├── news/                  ← ニュース一覧
│   │   │   ├── anomaly/               ← 出来高異常検知
│   │   │   ├── watchdog/              ← ウォッチドッグ履歴
│   │   │   ├── alerts/                ← 価格アラート設定
│   │   │   ├── recommendations/       ← おすすめ履歴
│   │   │   ├── favorites/             ← お気に入り
│   │   │   ├── analysis/              ← 銘柄検索 (stock/[ticker] に redirect)
│   │   │   ├── mobile-link/           ← iPhone用QR生成
│   │   │   ├── qr-login/              ← QRログイン (認証不要)
│   │   │   ├── login/                 ← ログイン (認証不要)
│   │   │   ├── AgentPanels.tsx        ← トップ画面の AI パネル
│   │   │   └── page.tsx               ← マーケット概況 (トップ)
│   │   ├── lib/
│   │   │   ├── firebase.ts            ← Firebase Client SDK
│   │   │   ├── firebase-admin.ts      ← Firebase Admin SDK
│   │   │   ├── auth-context.tsx       ← React 認証コンテキスト
│   │   │   ├── firestore.ts           ← Firestoreデータアクセス層
│   │   │   ├── tachibana.ts           ← 立花APIクライアント
│   │   │   ├── tachibana-columns.ts   ← 立花APIの圧縮カラム名マップ (942個)
│   │   │   ├── insights-engine.ts     ← 短中長期インサイト判定エンジン
│   │   │   ├── line-notify.ts         ← LINE通知
│   │   │   ├── yahoo-finance.ts       ← Yahoo Finance ヘルパ (crumb認証付)
│   │   │   ├── jp-stocks-cache.ts     ← 全銘柄マスタキャッシュ
│   │   │   ├── nikkei225.ts           ← 日経225銘柄リスト
│   │   │   ├── stock-list.ts          ← 主要銘柄補完用リスト
│   │   │   ├── chart-patterns.ts      ← チャートパターン定義・判定
│   │   │   └── api.ts                 ← フロント用APIラッパ
│   │   └── components/
│   │       ├── TopNav.tsx             ← 上部ナビ
│   │       ├── BottomNav.tsx          ← モバイル下部ナビ
│   │       ├── ClientLayout.tsx       ← AuthGuard
│   │       ├── PatternBadge.tsx
│   │       ├── IndexCard.tsx, IndexDetailChart.tsx
│   │       ├── NewsCard.tsx
│   │       └── StockRow.tsx
│   ├── public/
│   │   ├── manifest.json              ← PWA マニフェスト
│   │   ├── icon-*.png                 ← PWAアイコン
│   │   └── sw.js                      ← Service Worker
│   ├── vercel.json                    ← Cron 設定
│   ├── next.config.ts                 ← Firebase Auth プロキシ rewrite 等
│   └── .env.local                     ← 環境変数 (gitignore)
├── cavka-mcp-server/                  ← Claude MCP サーバ
│   ├── src/index.ts                   ← 16ツール定義
│   └── dist/index.js                  ← ビルド済 (Claude が直接 require)
├── .mcp.json                          ← Claude Code 用 MCP 設定
└── (legacy投資dashboard 等は省略)
```

---

## 全体アーキテクチャ

```
[Vercel デプロイ] quotation-viewer.vercel.app
    │
    ├─[Next.js Frontend]
    │   ├─ ブラウザ (PC / iPhone PWA)
    │   └─ Firebase Auth (Google + Email Link)
    │
    ├─[Next.js API Routes]
    │   ├─ 公開系  : /api/stocks/prices, /api/stocks/patterns 等
    │   ├─ 認証必要: /api/portfolio, /api/news, /api/tachibana/* 等
    │   └─ Cron専用: /api/cron/* (CRON_SECRET 必須)
    │
    ├─[Firebase Firestore]  ← ユーザーデータ + マスタキャッシュ
    │
    ├─[立花証券 e支店 API]   ← 国内株式リアルデータ
    │   (RSA暗号化セッション、Shift-JIS、圧縮形式)
    │
    ├─[Yahoo Finance]        ← 株価チャート + ファンダ
    │   (v8 chart は無認証、v10 quoteSummary は crumb認証)
    │
    └─[LINE Messaging API]   ← アラート通知

[ローカル PC]
    └─[Claude Desktop / Claude Code]
        └─[Cavka MCP Server (Node.js stdio)]
            └─→ Cavka API (HTTPS, x-api-key 認証)
```

### データフローの基本パターン

1. **ユーザー操作** → Next.js Frontend (React)
2. → Frontend が Firebase ID Token 付きで API Route 呼び出し
3. → API Route が認証検証 (Firebase Admin SDK)
4. → 各データソース (立花 / Yahoo / Firestore) から取得
5. → 加工してJSONで返す

### MCP連携の流れ

1. Claude (Desktop/Code) で「7203を分析して」と入力
2. → Claude が `analyze_stock` MCPツールを呼ぶ
3. → MCPサーバ (ローカル) が x-api-key で Cavka API を叩く
4. → 結果を整形して Claude に返す
5. → Claude が解釈して人間に提示

---

## ページ一覧

| パス | ラベル | 認証 | 内容 |
|---|---|---|---|
| `/` | マーケット概況 | 要 | 指数 / 主要銘柄 / マーケットニュース / 🤖AIパネル |
| `/favorites` | お気に入り | 要 | グループ別ウォッチリスト |
| `/analysis` | 銘柄分析 (検索) | 要 | 銘柄名/コード検索 → `/stock/:ticker` へ |
| `/stock/[ticker]` | 銘柄詳細 | 要 | **主役画面**: チャート/💡インサイト/📊決算パターン/📊板情報/🏦信用残/マルチTF/📰ニュース/パターン |
| `/patterns` | パターン | 要 | テクニカルパターンスキャン |
| `/screener` | スクリーナー | 要 | 11プリセット + 5軸カスタムフィルタ + 日経225/全銘柄スコープ + 結果キャッシュ |
| `/portfolio` | ポートフォリオ | 要 | 4タブ (保有/口座サマリー/取引履歴/その他資産) + 立花連携 + インラインチャート |
| `/scenarios` | シナリオ | 要 | 投資シナリオ作成/振り返り |
| `/calendar` | 決算カレンダー | 要 | 保有/お気に入りの決算予定 (緊急度別) |
| `/news` | ニュース | 要 | 立花リアルタイムニュース (TDnet/NQN/QUICK) |
| `/recommendations` | おすすめ履歴 | 要 | 過去30日のおすすめ一覧 |
| `/anomaly` | 異常検知 | 要 | 出来高異常 + ヒートレベル判定 |
| `/watchdog` | ウォッチドッグ | 要 | 自動監視イベント履歴 |
| `/alerts` | 価格アラート | 要 | 価格 / 決算N日前 / パターン アラート + LINE通知 |
| `/mobile-link` | モバイル連携 | 要 | iPhoneログイン用QRコード生成 |
| `/qr-login` | QRログイン | **不要** | iPhone側で受信 → Firebase Custom Tokenで自動ログイン |
| `/login` | ログイン | **不要** | Google OAuth + メールリンク (URL自動補完) |

---

## APIエンドポイント

### 公開系 (認証不要)
| パス | メソッド | 用途 |
|---|---|---|
| `/api/stocks/prices` | GET | 複数銘柄の現在価格 + USD/JPY |
| `/api/stock/[ticker]` | GET | 個別銘柄詳細 + テクニカル指標 |
| `/api/stocks/patterns` | GET | チャートパターン検出 (日週月足) |
| `/api/stocks/fundamentals` | GET | PER/PBR/ROE等 (yfQuoteSummary使用) |
| `/api/stocks/earnings` | GET | 決算予定 |
| `/api/stocks/earnings-pattern` | GET | 過去決算前後の値動きパターン分析 |
| `/api/stocks/volume-anomaly` | GET | 出来高異常検知スコア |
| `/api/stocks/search` | GET | 銘柄名/ティッカー検索 (Yahoo + 内部fallback) |
| `/api/stocks/master` | GET | 立花全銘柄マスタ取得 (Firestore キャッシュ) |
| `/api/stocks/full-analysis` | GET | 全データ統合 (analyze_stock用) |
| `/api/stocks/insights` | GET | 短中長期インサイト計算 |
| `/api/stocks/future-score/[ticker]` | GET | 将来性スコア (5因子グレード + バリュートラップ警告 + アナリスト + 感情) |
| `/api/stocks/sentiment/[ticker]` | GET | ニュース感情キャッシュ取得 (公開) |
| `/api/market/indices` | GET | 日経/TOPIX/S&P/NASDAQ |
| `/api/market/stocks/jp` | GET | 国内主要銘柄リスト |
| `/api/market/stocks/us` | GET | 米国主要銘柄リスト |
| `/api/market/news` | GET | 立花からマーケットニュース (認証不要) |
| `/api/screener/cache` | GET | スクリーナー結果キャッシュ取得 |

### 認証必要 (x-api-key or Firebase ID Token)
| パス | メソッド | 用途 |
|---|---|---|
| `/api/portfolio` | GET | 保有/お気に入り/シナリオ/取引履歴 一括取得 |
| `/api/tachibana/test` | GET | 立花API接続テスト |
| `/api/tachibana/portfolio` | GET | 立花からリアル保有銘柄 |
| `/api/tachibana/quotes` | GET | 板情報 + 時価 |
| `/api/tachibana/margin` | GET | 信用残・証金残・逆日歩 |
| `/api/tachibana/snapshot` | GET | quotes + margin 1セッション統合 (推奨) |
| `/api/news` | GET | 立花ニュースヘッダ |
| `/api/news/[id]` | GET | ニュース本文 |
| `/api/agent/daily-recommend` | GET/POST | おすすめ取得 (POST=生成) |
| `/api/watchdog/check` | POST | 異変チェック (cron用) |
| `/api/watchdog/events` | GET | 監視イベント履歴 |
| `/api/screener/cache` | POST | スクリーナー結果保存 |
| `/api/stocks/master` | POST | 立花マスタを再取得・保存 |
| `/api/auth/qr/generate` | POST | QRログイントークン発行 (PCログイン中) |
| `/api/auth/qr/redeem` | POST | QRトークン消費 → Custom Token (iPhone側) |
| `/api/alerts/price-check` | POST | 価格 + 決算アラートチェック |
| `/api/alerts/pattern-check` | POST | パターンアラートチェック |
| `/api/line/notify` | POST | LINE通知送信 |

### Cron専用 (CRON_SECRET認証)
| パス | スケジュール (JST) | 用途 |
|---|---|---|
| `/api/cron/daily-recommend` | 平日 07:00 | おすすめ自動生成 |
| `/api/cron/watchdog` | 平日 09:00, 15:00 | 異変自動チェック |
| `/api/alerts/pattern-check` | 毎日 08:00 | パターンアラート |

---

## データソース

### 1. 立花証券 e支店 API (v4r9)
- ベースURL (本番): `https://kabuka.e-shiten.jp/e_api_v4r9`
- ベースURL (デモ): `https://demo-kabuka.e-shiten.jp/e_api_v4r9`
- 現在 **デモ環境** に接続中
- 認証: RSA-2048 + OAEP/SHA-256 で仮想URLを暗号化
- 文字コード: Shift-JIS
- レスポンス形式: 圧縮 (数値キー → カラム名942個マッピング)
- 取得項目: 保有銘柄、板情報、時価、信用残、ニュース、銘柄マスタ
- 制限: 秒10件、1顧客1仮想URL (同時セッション禁止)

### 2. Yahoo Finance
- v8 chart API: 認証不要、株価チャート (1m〜1mo)
- v10 quoteSummary: crumb認証必要、ファンダメンタル等
- 制限: 1m足は過去7日、5m/15m/30mは過去60日

### 3. Firebase Firestore
- ユーザーデータ全般、マスタキャッシュ、スクリーナー結果

### 4. LINE Messaging API
- アラート通知用

---

## データモデル (Firestore)

### ユーザーごとデータ (`users/{uid}/...`)
| コレクション | 用途 |
|---|---|
| `holdings` | 保有銘柄 (手動登録) |
| `watchlist` | お気に入り銘柄 |
| `watchlistGroups` | お気に入りグループ |
| `alerts` | 価格・決算アラート (type/params 形式へ拡張済) |
| `transactions` | 取引履歴 (buy/sell/deposit/withdraw/dividend) |
| `otherAssets` | 投資信託・外貨預金 |
| `scenarios` | 投資シナリオ |
| `watchdogEvents` | 自動監視イベント履歴 |
| `dailyRecommendations` | 日次おすすめ (date=YYYY-MM-DD がdoc id) |
| `settings/*` | LINE設定、accountBalance、watchedPatterns 等 |

### グローバルキャッシュ (`meta/...`)
| ドキュメント | 用途 |
|---|---|
| `jpStockMaster` | 立花全銘柄マスタ (4,456銘柄) |
| `screenerCache_nikkei225` | 日経225スクリーン結果 |
| `screenerCache_full` | 全銘柄スクリーン結果 |

### 認証関連
| コレクション | 用途 |
|---|---|
| `qrLoginTokens` | QRログイン一時トークン (5分有効、1回使用) |

---

## 環境変数

### Vercel Production
| Key | 用途 |
|---|---|
| `NEXT_PUBLIC_FIREBASE_*` | Firebase Client 設定 (公開可) |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Firebase Admin SDK サービスアカウント (JSON文字列) |
| `MCP_API_KEY` | Cavka API のサーバー間認証キー |
| `CRON_SECRET` | Vercel Cron 専用認証キー |
| `TACHIBANA_ENV` | `demo` or `prod` |
| `TACHIBANA_AUTH_ID` | 立花認証ID |
| `TACHIBANA_PRIVATE_KEY` | RSA秘密鍵 (PEM、改行 `\n` エスケープ可) |
| `CAVKA_CRON_EMAILS` | Cronで処理するユーザーメール (カンマ区切り) |
| `CAVKA_CRON_SAMPLE_SIZE` | おすすめ生成時の分析銘柄数 (デフォルト12) |

### MCPサーバ (`.mcp.json` の env)
| Key | 値 |
|---|---|
| `MCP_API_KEY` | 同上 |
| `CAVKA_BASE_URL` | `https://quotation-viewer.vercel.app` (本番) または `http://localhost:3000` |
| `CAVKA_USER_EMAIL` | MCPツール経由でアクセスするユーザー |

---

## 認証

### Webブラウザ
1. **Google OAuth**: PC推奨、`signInWithPopup` (デスクトップ) / `signInWithRedirect` (モバイル)
2. **Email Link (Magic Link)**: iPhone推奨、URLにメアド自動埋め込み済
3. **QRログイン**: PC でQR生成 → iPhoneカメラで読む → Custom Token で自動サインイン
4. **iOS ITP対策**: `next.config.ts` で `/__/auth/*` を Firebase Hosting にプロキシ + authDomain を自分のドメインに

### API
- **Firebase ID Token**: `Authorization: Bearer <token>` (ブラウザから)
- **MCP API Key**: `x-api-key: <key>` (サーバー間、MCPサーバ → Cavka)
- **Cron Secret**: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron → /api/cron/*)
- **許可ユーザー**: `ALLOWED_EMAILS = ["make.some.noise6984@gmail.com"]` (各routeでハードコード)

### 永続化
- Firebase Auth = `browserLocalPersistence` 明示設定
- PWA化済 (manifest.json) → ホーム画面追加で次回タップ起動

---

## MCPツール

`cavka-mcp-server/src/index.ts` に16ツール定義 (Claude が呼び出し可):

| # | ツール名 | 用途 |
|---|---|---|
| 1 | `get_stock_prices` | 複数銘柄の現在価格 |
| 2 | `get_stock_detail` | 個別銘柄詳細 + テクニカル指標 |
| 3 | `get_fundamentals` | ファンダメンタル指標 |
| 4 | `search_stocks` | 銘柄検索 |
| 5 | `detect_patterns` | チャートパターン検出 |
| 6 | `screen_stocks` | ファンダスクリーニング |
| 7 | `list_nikkei225` | 日経225銘柄一覧 |
| 8 | `get_portfolio` | ユーザーポートフォリオ |
| 9 | `get_tachibana_holdings` | 立花の実保有銘柄 |
| 10 | `analyze_stock` | 銘柄の総合分析 (full-analysis 統合) |
| 11 | `get_my_scenarios` | 投資シナリオ一覧 |
| 12 | `get_earnings_calendar` | 決算カレンダー |
| 13 | `get_news` | 立花ニュース |
| 14 | `get_order_book` | 板情報 (10段) |
| 15 | `find_volume_anomalies` | 出来高異常検知 |
| 16 | `get_margin_info` | 信用残・逆日歩 |

ビルド: `cd cavka-mcp-server && npm run build`

---

## 定期実行 (Cron)

`investment-dashboard-next/vercel.json` に定義:

```json
{
  "crons": [
    { "path": "/api/alerts/pattern-check", "schedule": "0 23 * * *" },
    { "path": "/api/cron/daily-recommend", "schedule": "0 22 * * 1-5" },
    { "path": "/api/cron/watchdog", "schedule": "0 0 * * 1-5" },
    { "path": "/api/cron/watchdog", "schedule": "0 6 * * 1-5" }
  ]
}
```

(注: scheduleはUTC、JST = UTC+9)

| JST時刻 | 内容 |
|---|---|
| 平日 07:00 | おすすめ自動生成 |
| 平日 09:00 | 寄り前ウォッチドッグ |
| 平日 15:00 | 引け前ウォッチドッグ |
| 毎日 08:00 | パターンアラート |

### Hobby plan制限
- 関数実行 **10秒** まで
- daily-recommend は `CAVKA_CRON_SAMPLE_SIZE=12` で間に合わせ
- 本格化したい場合 Vercel Pro ($20/月) で60秒拡張

---

## 立花API実装メモ

### 重要な仕様
1. **認証**: `/auth/?{JSON}` に GET で `{sCLMID:"CLMAuthLoginRequest", sAuthId:"xxx"}` を送る
2. **応答**: 4種の仮想URL (REQUEST/MASTER/PRICE/EVENT) が **RSA公開鍵で暗号化**されて返る
3. **復号**: 自分の秘密鍵で base64→RSA-OAEP/SHA-256 復号、末尾の改行をtrim
4. **送信通番**: `p_no` を毎回インクリメント、戻ると "前要求.p_no >=" エラー
5. **時刻**: `p_sd_date` は **JST** (`yyyy.mm.dd-hh:mn:ss.ttt`)、UTCだと "exceed time limit" エラー
6. **文字コード**: Shift-JIS、ニュースは更に BASE64 → URL Encoded → Shift-JIS の3段デコード
7. **圧縮形式**: レスポンスのキーが数値 ("288":"1" 等)、`tachibana-columns.ts` の `COLUMNS[key-1]` でカラム名に変換
8. **セッション制約**: 1顧客1仮想URL。同時に複数API叩くと後発が先発を無効化 → snapshot API で統合
9. **時間制限**: e支店API は毎日特定時間メンテ (深夜2:00頃に「情報提供時間外」)

### 主要なI/F
| I/F | URL | 用途 |
|---|---|---|
| 認証 | `BASE/auth/` | ログイン/ログアウト |
| REQUEST | `urlRequest` | 注文・保有銘柄等 |
| MASTER | `urlMaster` | 銘柄マスタ・ニュース・信用残 |
| PRICE | `urlPrice` | 時価・板情報 |
| EVENT | `urlEvent` | WebSocket リアルタイム配信 (未実装) |

---

## キャッシュ戦略

| データ | 場所 | 更新タイミング |
|---|---|---|
| 銘柄マスタ (4,456) | Firestore `meta/jpStockMaster` | 手動 POST `/api/stocks/master` |
| スクリーナー結果 | Firestore `meta/screenerCache_*` | ユーザーがSCAN実行時 + sessionStorage |
| Yahoo Finance crumb | Node プロセスメモリ | 30分 |
| 立花マスタ (JP銘柄リスト) | Node メモリ | 1時間 |
| ニュース | Vercel ISR | 5分 |
| 株価 (個別) | Vercel ISR | 30秒〜60秒 |
| 立花信用残・板 | キャッシュなし (毎回ログイン) | リアルタイム |
| 日次おすすめ | Firestore `users/.../dailyRecommendations` | 朝7:00 cron + 手動生成 |

---

## デプロイ

### 本番URL
- **https://quotation-viewer.vercel.app/**

### デプロイ手順
```bash
cd C:/Users/matsunaga/Claude-Code-Test/Quotation-Viewer
npx vercel --prod
```

### MCP サーバ更新
```bash
cd cavka-mcp-server
npm run build      # → dist/index.js
# Claude Desktop / Code を再起動で反映
```

### 環境変数追加
```bash
cd Quotation-Viewer
npx vercel env add KEY_NAME production
```

---

## 将来性スコアエンジン (Future Score)

「数値的に優れているのに株価が上がらない」銘柄を検出するための独立サブシステム。
ファイル: `src/lib/future-score.ts` / API: `/api/stocks/future-score/[ticker]`

### コンセプト
- Seeking Alpha の **5因子 + 最弱因子キャップ** 方式を採用
- 5因子: **Value / Growth / Profitability / Momentum / EPS Revisions**
- 各因子を A+ / A / B+ / B / C / D / F の 7段階グレード化
- **1つでも D 以下があれば総合スコアを 50 (Neutral) に強制ダウン** → バリュートラップ回避

### 各因子の構成 (Phase 1)
| 因子 | 入力 | 評価軸 |
|---|---|---|
| Value | PER, PBR, 配当利回り | 割安なほど高評価 |
| Growth | 売上成長率, 利益成長率 | 二桁成長で加点、減益で減点 |
| Profitability | ROE, 営業利益率, 純利益率 | ROE>20% で満点、赤字で大幅減点 |
| Momentum | ROC20, SMA50比, ゴールデン/デッドクロス, レンジ位置 | 上昇トレンド継続で高評価 |
| EPS Revisions (Phase1代替) | 前回サプライズ, 利益成長×SMA200位置 | Phase 2 で Yahoo earningsTrend に差替予定 |

### 出力フラグ
- `valueTrap`: Value≥B+ AND Growth≤D AND Momentum≤D
  → 🚨 「割安だが市場が織り込んでいない構造的問題の可能性」
- `growthEmerging`: Growth≥A AND Momentum≥B+ AND Profitability≥B
  → 🌱 「市場が将来性を評価し始めた段階」
- `cappedBy`: 最弱因子の名前 (どの因子で総合が抑えられたか)

### Phase ロードマップ
- ✅ **Phase 1**: 既存データ (fundamentals + technical) で5因子グレード + キャップ
- ✅ **Phase 2**: Yahoo earningsTrend / recommendationTrend / financialData を取り込み (アナリスト目標株価, Net Revisions, recommendationMean), 過熱検出, 例外取消ロジック
- 🟡 **Phase 3a**: 適時開示イベント検出 (`src/lib/disclosure-events.ts`) — 立花ニュースから業績修正/配当/自社株買い/不祥事をキーワード分類
- ⏳ **Phase 3b**: EDINET 大量保有報告書 (API キー登録必要のため保留)
- ❌ **Phase 3c**: 四季報独自予想スクレイピング (ToS リスクで除外)
- ✅ **Phase 4**: Gemini (`gemini-2.5-flash`) でニュースセンチメント × 拡散係数 (`src/lib/news-sentiment.ts`, Firestore キャッシュ `meta/sentiment_{ticker}`, Cron `sentiment-update`)
- ✅ **Phase 5 (部分)**: FutureScorePanel UI (5因子グレード表 / バリュートラップ警告 / 過熱警告 / アナリストバー)

### Phase 2 で追加された暴走防止ブレーキ
- **過熱検出 (overhyped)**: 現値がアナリスト目標株価を 15%以上上回る (アナリスト3人以上) → 🔥 警告 + 10pt減点
- **クオリティグロース例外取消**: Forward PEG > 3 で AAPL/NVDA 救済例外を解除。ただし net revisions ≥ +30 件 or 上方修正率 ≥ 80% なら救済継続

### Phase 3a の特殊判定
- **🚨 重大開示警告**: 不祥事 (scandal) / 訴訟 (lawsuit) を検出 → 自動 avoid 判定 + -15pt
- **🚀 上方修正 + 強気**: 業績予想上方修正 検出かつスコア ≥60
- **🟠 下方修正後 - 慎重**: 業績予想下方修正 検出かつ上方修正なし → スコア低めなら avoid

### 設計判断の根拠
徹底調査 (楽天 iSPEED / SBI / マネックス / 株探 / みんかぶ / 四季報 / moomoo / TradingView / Simply Wall St / Seeking Alpha) の結果、Seeking Alpha の最弱因子キャップ方式が「数値良いのに動かない」検出に最も効果的と判明。

---

## 既知の制約・課題

### 解決済の落とし穴 (再発防止)
- ✅ Firebase Admin SDK: `getAuth()` 直接呼ぶと初期化前エラー → `getAdminAuth()` ヘルパ経由
- ✅ Yahoo Finance v10: crumb認証必須 → `yfQuoteSummary` ヘルパで自動取得
- ✅ 立花セッション衝突: `/api/tachibana/snapshot` で統合
- ✅ Vercel UTC vs 立花JST: `formatSdDate` で JST 固定
- ✅ MCP_API_KEY に改行混入: `printf` (echoでなく) で env add
- ✅ Next.js dev cache 破損: 定期的に `.next` 削除
- ✅ ポート競合: dev server が 3001/3002/3003 と転々 → プロセス全kill
- ✅ **`vercel env pull` の JSON 値破損**: `FIREBASE_SERVICE_ACCOUNT_KEY` のようにダブルクォートを含む値は CLI が `"{  "type"...` 形式で出力するため Node の env 解析で 3 文字に切り詰められる。対策: 値をシングルクォートで囲んで .env.local に手動追記 (例: `FIREBASE_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}'`)
- ✅ **立花センチメント計算で連続アクセス時セッション切断**: `sentiment-update` cron 内で `sleep 1000ms` だと信越化学等で「セッションが切断しました」エラー → `sleep 3000ms` に増加

### 未解決・将来
- ❌ JNX/PTS データ未対応 (立花/Yahoo ともに東証のみ)
- ❌ Vercel Hobby 10秒制限で全銘柄分析は難しい
- ❌ 立花APIメンテ時間 (深夜2-3時頃) にエラー
- ❌ Yahoo Finance v10 がたまに `Invalid Crumb` で空返す
- ❌ kabu STATION 連携未実装 (PTS取るには別途)
- ❌ BigQuery 連携未実装 (時系列分析やりたければ)

### 主要なユーザー
- メール: `make.some.noise6984@gmail.com` (ハードコード in 各 API route)

---

## 変更履歴

`docs/CHANGELOG.md` を参照。
直近の大きな変更:
- 2026-05-27: 設計書(本ファイル)初版作成
- 2026-05-26: QRログイン、スクリーナーキャッシュ、立花全銘柄マスタ、AIエージェント (daily-recommend + watchdog)
- 2026-05-26: 決算前後パターン分析、シナリオ機能、立花信用残/板情報、決算カレンダー、ニュース統合
- 2026-05-25: 💡インサイトエンジン (短中長期判定)
- 2026-05-22: 立花APIデモ連携完了、ポートフォリオ統合
- 2026-05-19頃: 立花口座開設、API申請、デモ環境テスト
- 2026-05-12頃: MCP連携、初期Cavka機能 (スクリーナー、パターン、ポートフォリオ等)
