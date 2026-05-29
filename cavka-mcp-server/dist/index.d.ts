#!/usr/bin/env node
/**
 * Cavka MCP Server — Neo Tokyo Trading Terminal
 *
 * Claude Desktop / Claude Code から投資データにアクセスするための MCP サーバー。
 * Cavka (Vercel) の API をラップして以下のツールを提供:
 *
 *   1. get_stock_prices     — 複数銘柄の現在価格・前日比を取得
 *   2. get_stock_detail     — 個別銘柄の詳細（テクニカル指標付き）
 *   3. get_fundamentals     — ファンダメンタル指標（PER/PBR/ROE等）
 *   4. search_stocks        — 銘柄名・ティッカーで検索
 *   5. detect_patterns      — チャートパターン検出（日足・週足・月足）
 *   6. screen_stocks        — 5軸ファンダメンタルスクリーニング
 *   7. list_nikkei225       — 日経225構成銘柄一覧
 */
export {};
