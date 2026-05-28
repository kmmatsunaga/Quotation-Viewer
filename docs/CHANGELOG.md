# Cavka Changelog

このファイルは Cavka の主要な変更履歴を時系列で記録する。
`CAVKA_SPEC.md` が「現在の状態」を表すのに対し、こちらは「いつ何を変えたか」を表す。

形式: `## YYYY-MM-DD` の見出しの下に、変更点を箇条書き。
カテゴリ prefix: `feat:` 新機能 / `fix:` 不具合修正 / `refactor:` 内部改善 / `docs:` ドキュメント / `chore:` その他

---

## 2026-05-28

- feat: **将来性スコアエンジン Phase 3a** — 適時開示イベント検出
  - `src/lib/disclosure-events.ts` 新規: 立花ニュースのヘッドラインをキーワード分類 (業績修正・配当修正・自社株買い・分割・M&A・不祥事・訴訟)
  - 時間減衰加重スコア (-100〜+100) + `hasCriticalNegative` フラグ (不祥事/訴訟は -15pt 強制ペナルティ)
  - sentiment cache と同じ Firestore レコード `meta/sentiment_{ticker}` に追加保存 (POST /api/stocks/sentiment/[ticker] で同時計算)
  - `evaluateFutureScore` に4つ目の入力追加。±20pt の影響, 「🚨 重大開示警告」「🚀 上方修正+強気」「🟠 下方修正後-慎重」など新ラベル判定
  - FutureScorePanel UI: 📰 適時開示イベントセクション (スコア + イベント別バッジ + 最新3件の見出し)
  - **Phase 3b (EDINET 大量保有報告)** と **Phase 3c (四季報スクレイピング)** は保留 (3b: API key 要登録、3c: ToS リスク)
- feat: **将来性スコアエンジン Phase 4** — Gemini ニュース感情分析
  - `src/lib/gemini-client.ts` 新規: Gemini API 薄ラッパ (geminiGenerate / geminiGenerateJson)
  - `src/lib/news-sentiment.ts` 新規: 立花ニュース → Gemini 一括分類 → 時間減衰加重平均 × 拡散係数 で `finalScore` (-100〜+100) を算出
  - API `/api/stocks/sentiment/[ticker]` (GET=キャッシュ取得, POST=Gemini再計算&保存)
  - Vercel Cron `/api/cron/sentiment-update` (毎日17:00 UTC=JST翌2:00) 追加: ポートフォリオ+お気に入り銘柄を一括更新
  - Firestore キャッシュ: `meta/sentiment_{ticker}` (36時間で stale 扱い)
  - `evaluateFutureScore` にセンチメント入力追加、総合スコアに ±15pt の影響 (stale 時は半減)
  - FutureScorePanel UI に 📰 ニュース感情バー追加 (スコア / 平均感情 × 拡散係数 / very_positive〜very_negative ラベル / stale 表示)
  - 必要環境変数: `GEMINI_API_KEY` (Vercel env と .env.local 両方に追加)
- feat: **将来性スコアエンジン Phase 2** — Yahoo アナリストデータ取り込み
  - `src/lib/analyst-data.ts` 新規: financialData / recommendationTrend / earningsTrend を正規化 (`fetchAnalystData`)
  - **Value 因子**: アナリスト目標株価との Upside% で ±20pt 補正 (現値>目標15%超 = 過熱で -20)
  - **Growth 因子**: 来期 EPS 予想成長率と今期売上予想成長率を追加
  - **EPS Revisions 因子**: Phase 1 代替版を捨て、本物のアナリスト上方/下方修正件数 (30日/7日) + recommendationMean + Buy推奨数の3ヶ月変化 で評価。日本株でデータ無ければ Phase 1 代替に fallback
  - **過熱検出** (`overhyped`): 現値が目標株価を 15% 以上上回ったら 🔥 警告 + 10pt減点 + 「過熱気味」判定
  - **クオリティグロース例外取消**: Forward PEG > 3 で例外解除、ただし net revisions ≥ +30 件なら救済 (AAPL のように高 PER でもアナリストが上方修正連打している銘柄を保護)
  - API `/api/stocks/future-score/[ticker]` でアナリストデータ並列取得、結果に `analyst` フィールド追加
  - FutureScorePanel UI: アナリストコンセンサスバー (目標株価/Upside/人数/recommendationMean/Net Revisions)、過熱バナー、例外取消注記を追加
- feat: **将来性スコアエンジン (Future Score) Phase 1** を実装
  - `src/lib/future-score.ts` 新規: Seeking Alpha 方式の 5因子グレードモデル (Value/Growth/Profitability/Momentum/EPS Revisions)
  - **最弱因子キャップ**: 1つでも D 以下があれば総合を Neutral に強制ダウン → バリュートラップ回避
  - **valueTrap フラグ**: Value≥B+ AND Growth≤D AND Momentum≤D → 🚨 警告
  - **growthEmerging フラグ**: Growth≥A AND Momentum≥B+ AND Profitability≥B → 🌱 早期発見
  - API `/api/stocks/future-score/[ticker]` 新規 (内部で stock + fundamentals を並列取得)
- docs: CAVKA_SPEC.md に「将来性スコアエンジン」セクションを追加 + API一覧に新ルート追記
- chore: 国内外証券アプリの推奨ロジック調査完了 (楽天/SBI/マネックス/株探/みんかぶ/四季報/moomoo/TradingView/Simply Wall St/Seeking Alpha)
- feat: **クオリティ・グロース例外** を追加 — Value=F でも Growth/Profitability が両方 A 以上ならキャップ免除 (AAPL/NVDA など高 PER 成長株が一律「中立」になる問題を解消)
- feat: **FutureScorePanel** (`/stock/[ticker]` 配下) を実装 — 5因子グレードのバッジ表示、バリュートラップ警告バナー、🌱 早期発見バナー、因子クリックで根拠表示、データ充足度表示

---

## 2026-05-27

- docs: `docs/CAVKA_SPEC.md` を新規作成（プロジェクト全体の設計図）
- docs: `docs/CHANGELOG.md` を新規作成
- chore: 設計書を毎日自動更新するスケジュールタスクを設定
- feat: iPhone ログイン簡略化（URL にメアド埋め込みで再入力不要、`browserLocalPersistence` で永続化、PWA 化推奨）
- feat: PC → iPhone の QR ログイン（`/mobile-link`、`/qr-login`、Firebase Custom Token、5分有効）
- feat: 立花スナップショット API (`/api/tachibana/snapshot`) と `TachibanaSnapshotContext` を追加（1セッションで複数パネル分のデータを共有、セッション競合解消）
- feat: 全銘柄マスター API (`/api/stocks/master`) と Firestore キャッシュ (`jp-stocks-cache.ts`)
- feat: スクリーナー結果の Firestore キャッシュ (`/api/screener/cache`)
- feat: Vercel Cron 追加 — `daily-recommend`（朝の AI レコメンド生成）、`watchdog` ×2
- fix: `/analysis` で社名入力時のサジェスト→`/stock/[ticker]` リダイレクトに変更
- fix: TopNav の改行問題（`whitespace: nowrap` + `word-break: keep-all`、`2xl` ブレークポイント、`scrollbar-hide`）
- fix: Firebase Admin SDK の初期化順序（`getAdminAuth()` ヘルパー導入）
- fix: `/api/market/stocks/jp` の host 解決（`VERCEL_URL` 依存をやめ `req.headers.get("host")` ベースに）
- fix: 指数チャートのフィールド名不一致（`candles` ↔ `chart`、`price` エイリアス追加）
- chore: JNX 市場切替ボタンを削除（立花/Yahoo は東証のみのため）
