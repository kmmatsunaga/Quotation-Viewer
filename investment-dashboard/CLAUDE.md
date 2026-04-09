# Investment Dashboard - Project Context

## Overview
個人投資ポートフォリオ管理ダッシュボード。楽天証券 MarketSpeed II 風のUI。
Streamlit + yfinance + SQLite 構成。全て日本語表記。

## Quick Start
```bash
pip install -r requirements.txt
python -m streamlit run app.py --server.port 8502 --server.headless true
```

## Architecture
```
app.py           — Streamlit メインアプリ（全7ページ、楽天証券風CSS）
config.py        — 設定（DB, API URL, テクニカルパラメータ, デフォルト銘柄リスト）
data_fetcher.py  — データ取得（yfinance / JNX CSV / 立花証券API stub）
portfolio_db.py  — SQLite CRUD（holdings / watchlist / price_alerts テーブル）
analysis.py      — テクニカル分析・スコアリング（ta ライブラリ使用）
notifier.py      — LINE Messaging API プッシュ通知
```

## Pages (7)
1. マーケット概況 — 指数バー + 日本株/米国株一覧
2. お気に入り — Notionギャラリー風カード + SVGスパークライン + スコアバー
3. 銘柄分析 — ローソク足チャート + テクニカル指標 + スコア
4. ポートフォリオ — 保有銘柄CRUD + メモ機能 + 資産サマリー + 損益テーブル
5. 価格アラート — 条件設定 + 手動チェック + LINE通知連携
6. おすすめ銘柄 — テクニカルスコアリング（日本株/米国株）
7. JNX 夜間取引 — ジャパンネクスト証券 夜間PTS CSVデータ

## Data Sources
- yfinance: 東証(.T), NYSE/NASDAQ（15分遅延）
- JNX: japannext.co.jp 公開CSV（夜間PTS無料）
- 立花証券 e支店 API: リアルタイム東証（stub実装、要口座開設）

## Tech Notes
- Python 3.14: `pandas-ta` 非対応 → `ta` ライブラリを使用
- TOPIX: `^TOPX` 取得不可 → `1306.T`(TOPIX ETF)で代替
- 日本市場慣習: 上昇=赤(#d32f2f), 下降=青(#1565c0)

## LINE Notification Setup
```
LINE_CHANNEL_ACCESS_TOKEN=<token>
LINE_USER_ID=<user_id>
```

## TODO
- [ ] 立花証券 e支店 API 本実装（WebSocket、要口座）
- [ ] LINE Developers 設定 → アラート通知E2Eテスト
- [ ] デプロイ（Streamlit Cloud / Render / VPS）
- [ ] APScheduler 定期アラートチェック
- [ ] ポートフォリオ CSVインポート/エクスポート
