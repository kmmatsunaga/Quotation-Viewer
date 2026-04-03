const pptxgen = require("pptxgenjs");

let pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "Claude Code & Claude Work";

// Color palette — Deep Tech theme
const C = {
  darkBg:   "0D1B2A",
  navyBg:   "0A2342",
  midBlue:  "1565C0",
  teal:     "00BCD4",
  tealDark: "0097A7",
  white:    "FFFFFF",
  offWhite: "E8EEF4",
  gray:     "455A64",  // darkened for contrast
  amber:    "FFB300",
  light:    "F4F8FC",
  border:   "B0BEC5",
  purple:   "4A148C",
};

const JA = "Meiryo";
const EN = "Arial";
const W = 10, H = 5.625;

const makeShadow = () => ({
  type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.1
});

// ─────────────────────────────────────────────
// SLIDE 1 — Title
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.darkBg };

  // Left accent band
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 0.25, h: H,
    fill: { color: C.teal }, line: { type: "none" }
  });

  // Bottom accent strip
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: H - 0.08, w: W, h: 0.08,
    fill: { color: C.teal }, line: { type: "none" }
  });

  // Decorative circles (fully off-screen top-right)
  s.addShape(pres.shapes.OVAL, {
    x: 7.5, y: -2.5, w: 5.5, h: 5.5,
    fill: { color: C.midBlue, transparency: 70 }, line: { type: "none" }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 8.5, y: -1.2, w: 3.0, h: 3.0,
    fill: { color: C.teal, transparency: 80 }, line: { type: "none" }
  });

  // Center content vertically (start at y=1.2 for a well-balanced block)
  s.addText("Claude Code", {
    x: 0.6, y: 1.2, w: 8.5, h: 1.0,
    fontSize: 52, bold: true, color: C.white, fontFace: EN,
    align: "left", margin: 0
  });
  s.addText("& Claude Work", {
    x: 0.6, y: 2.1, w: 8.5, h: 1.0,
    fontSize: 52, bold: true, color: C.teal, fontFace: EN,
    align: "left", margin: 0
  });

  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 3.2, w: 3.5, h: 0.05,
    fill: { color: C.tealDark }, line: { type: "none" }
  });

  s.addText("できること まとめ", {
    x: 0.6, y: 3.4, w: 8, h: 0.55,
    fontSize: 22, color: C.offWhite, fontFace: JA,
    align: "left", margin: 0
  });

  s.addText("Anthropic Claude — 機能比較ガイド", {
    x: 0.6, y: 4.95, w: 8, h: 0.4,
    fontSize: 12, color: C.gray, fontFace: JA,
    align: "left", margin: 0
  });
}

// ─────────────────────────────────────────────
// SLIDE 2 — Claude Code とは
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.light };

  // Header bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 1.1,
    fill: { color: C.navyBg }, line: { type: "none" }
  });
  s.addText("Claude Code とは", {
    x: 0.5, y: 0.18, w: 9, h: 0.75,
    fontSize: 28, bold: true, color: C.white, fontFace: JA,
    align: "left", margin: 0
  });

  // Left panel
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 1.3, w: 4.5, h: 3.9,
    fill: { color: C.navyBg }, line: { type: "none" },
    shadow: makeShadow()
  });

  // Icon circle on light bg so emoji is visible
  s.addShape(pres.shapes.OVAL, {
    x: 1.5, y: 1.5, w: 1.3, h: 1.3,
    fill: { color: C.teal, transparency: 30 }, line: { type: "none" }
  });
  s.addText("🖥️", {
    x: 1.5, y: 1.5, w: 1.3, h: 1.3,
    fontSize: 36, align: "center", valign: "middle", margin: 0
  });

  s.addText("AI コーディング エージェント", {
    x: 0.55, y: 2.9, w: 4.2, h: 0.45,
    fontSize: 15, bold: true, color: C.teal, fontFace: JA,
    align: "center", margin: 0
  });

  s.addText(
    "ターミナルから直接使えるAIエージェント。コードの読み書き・実行・デバッグをすべて自律的に行います。\n\n開発者の「右腕」として、複雑な実装タスクをステップバイステップで完遂します。",
    {
      x: 0.55, y: 3.45, w: 4.1, h: 1.6,
      fontSize: 13, color: C.offWhite, fontFace: JA,
      align: "left", margin: 0, paraSpaceAfter: 6
    }
  );

  // Right feature cards
  const items = [
    { icon: "⌨️", title: "CLI ベース",    desc: "ターミナルで動作するコマンドラインツール" },
    { icon: "📂", title: "ファイル操作",  desc: "コードの読み込み・編集・作成を自動実行" },
    { icon: "🔧", title: "コマンド実行",  desc: "テスト・ビルド・デプロイを直接実行" },
    { icon: "🧠", title: "コード理解",    desc: "大規模コードベースを丸ごと把握・分析" },
  ];

  items.forEach((item, i) => {
    const y = 1.3 + i * 0.95;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 5.3, y, w: 4.3, h: 0.82,
      fill: { color: C.white }, line: { color: C.border, width: 1 },
      shadow: makeShadow()
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 5.3, y, w: 0.08, h: 0.82,
      fill: { color: C.teal }, line: { type: "none" }
    });
    // Icon on white background circle
    s.addShape(pres.shapes.OVAL, {
      x: 5.45, y: y + 0.17, w: 0.44, h: 0.44,
      fill: { color: C.teal, transparency: 70 }, line: { type: "none" }
    });
    s.addText(item.icon, {
      x: 5.45, y: y + 0.17, w: 0.44, h: 0.44,
      fontSize: 16, align: "center", valign: "middle", margin: 0
    });
    s.addText(item.title, {
      x: 5.98, y: y + 0.07, w: 3.5, h: 0.33,
      fontSize: 14, bold: true, color: C.navyBg, fontFace: JA,
      align: "left", margin: 0
    });
    s.addText(item.desc, {
      x: 5.98, y: y + 0.42, w: 3.5, h: 0.3,
      fontSize: 11.5, color: C.gray, fontFace: JA,
      align: "left", margin: 0
    });
  });
}

// ─────────────────────────────────────────────
// SLIDE 3 — Claude Code でできること
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.light };

  // Header bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 1.1,
    fill: { color: C.navyBg }, line: { type: "none" }
  });
  s.addText("Claude Code でできること", {
    x: 0.5, y: 0.18, w: 7.5, h: 0.75,
    fontSize: 28, bold: true, color: C.white, fontFace: JA,
    align: "left", margin: 0
  });
  // Styled tag pill (not floating plain text)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 8.05, y: 0.27, w: 1.7, h: 0.45,
    fill: { color: C.teal }, line: { type: "none" }
  });
  s.addText("Coding Agent", {
    x: 8.05, y: 0.27, w: 1.7, h: 0.45,
    fontSize: 13, bold: true, color: C.navyBg, fontFace: EN,
    align: "center", valign: "middle", margin: 0
  });

  const features = [
    { color: "0097A7", icon: "💻", title: "コード生成・実装",   desc: "自然言語の指示から\n機能を丸ごと実装" },
    { color: "1565C0", icon: "🐛", title: "デバッグ・修正",     desc: "エラーを自動検出し\n根本原因から修正" },
    { color: "6A1B9A", icon: "🔄", title: "リファクタリング",   desc: "コード品質を改善し\n可読性を向上" },
    { color: "2E7D32", icon: "✅", title: "テスト自動化",       desc: "ユニットテストを\n自動作成・実行" },
    { color: "E65100", icon: "📖", title: "コード解説",         desc: "複雑な処理を\n分かりやすく説明" },
    { color: "0277BD", icon: "🗄️", title: "コードベース解析", desc: "大規模プロジェクトを\n俯瞰的に理解" },
  ];

  const cols = 3, cardW = 2.85, cardH = 1.75, gapX = 0.35, gapY = 0.3;
  const startX = 0.33, startY = 1.3;

  features.forEach((f, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = startX + col * (cardW + gapX);
    const y = startY + row * (cardH + gapY);

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cardW, h: cardH,
      fill: { color: C.white }, line: { color: C.border, width: 1 },
      shadow: makeShadow()
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cardW, h: 0.07,
      fill: { color: f.color }, line: { type: "none" }
    });
    // Icon in colored circle on white card background
    s.addShape(pres.shapes.OVAL, {
      x: x + 0.18, y: y + 0.18, w: 0.55, h: 0.55,
      fill: { color: f.color, transparency: 80 }, line: { type: "none" }
    });
    s.addText(f.icon, {
      x: x + 0.18, y: y + 0.18, w: 0.55, h: 0.55,
      fontSize: 20, align: "center", valign: "middle", margin: 0
    });
    s.addText(f.title, {
      x: x + 0.82, y: y + 0.2, w: cardW - 0.95, h: 0.45,
      fontSize: 14, bold: true, color: C.navyBg, fontFace: JA,
      align: "left", margin: 0
    });
    s.addText(f.desc, {
      x: x + 0.18, y: y + 0.82, w: cardW - 0.35, h: 0.78,
      fontSize: 12, color: C.gray, fontFace: JA,
      align: "left", margin: 0
    });
  });
}

// ─────────────────────────────────────────────
// SLIDE 4 — Claude Work とは
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.light };

  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 1.1,
    fill: { color: C.purple }, line: { type: "none" }
  });
  s.addText("Claude Work とは", {
    x: 0.5, y: 0.18, w: 9, h: 0.75,
    fontSize: 28, bold: true, color: C.white, fontFace: JA,
    align: "left", margin: 0
  });

  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 1.3, w: 4.5, h: 3.9,
    fill: { color: C.purple }, line: { type: "none" },
    shadow: makeShadow()
  });

  // Icon circle
  s.addShape(pres.shapes.OVAL, {
    x: 1.5, y: 1.5, w: 1.3, h: 1.3,
    fill: { color: C.amber, transparency: 30 }, line: { type: "none" }
  });
  s.addText("💼", {
    x: 1.5, y: 1.5, w: 1.3, h: 1.3,
    fontSize: 36, align: "center", valign: "middle", margin: 0
  });

  s.addText("ビジネス・業務向け AI アシスタント", {
    x: 0.55, y: 2.9, w: 4.2, h: 0.45,
    fontSize: 14, bold: true, color: C.amber, fontFace: JA,
    align: "center", margin: 0
  });

  s.addText(
    "ブラウザから使えるAIアシスタント。メール・文書作成・情報整理・分析など、日常業務を幅広くサポートします。\n\nチームや企業でも活用でき、知識労働者の生産性を大幅に向上させます。",
    {
      x: 0.55, y: 3.45, w: 4.1, h: 1.6,
      fontSize: 13, color: C.offWhite, fontFace: JA,
      align: "left", margin: 0, paraSpaceAfter: 6
    }
  );

  const items = [
    { icon: "🌐", title: "ブラウザベース",  desc: "claude.ai からすぐに使えるWebアプリ" },
    { icon: "📄", title: "文書・文章作成",  desc: "メール・レポート・提案書を高品質で作成" },
    { icon: "📊", title: "データ分析",      desc: "ファイルをアップロードして情報を整理" },
    { icon: "🤝", title: "チーム利用",      desc: "Team/Enterprise プランで組織導入可能" },
  ];

  items.forEach((item, i) => {
    const y = 1.3 + i * 0.95;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 5.3, y, w: 4.3, h: 0.82,
      fill: { color: C.white }, line: { color: C.border, width: 1 },
      shadow: makeShadow()
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 5.3, y, w: 0.08, h: 0.82,
      fill: { color: C.amber }, line: { type: "none" }
    });
    s.addShape(pres.shapes.OVAL, {
      x: 5.45, y: y + 0.17, w: 0.44, h: 0.44,
      fill: { color: C.amber, transparency: 70 }, line: { type: "none" }
    });
    s.addText(item.icon, {
      x: 5.45, y: y + 0.17, w: 0.44, h: 0.44,
      fontSize: 16, align: "center", valign: "middle", margin: 0
    });
    s.addText(item.title, {
      x: 5.98, y: y + 0.07, w: 3.5, h: 0.33,
      fontSize: 14, bold: true, color: C.purple, fontFace: JA,
      align: "left", margin: 0
    });
    s.addText(item.desc, {
      x: 5.98, y: y + 0.42, w: 3.5, h: 0.3,
      fontSize: 11.5, color: C.gray, fontFace: JA,
      align: "left", margin: 0
    });
  });
}

// ─────────────────────────────────────────────
// SLIDE 5 — Claude Work でできること
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.light };

  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 1.1,
    fill: { color: C.purple }, line: { type: "none" }
  });
  s.addText("Claude Work でできること", {
    x: 0.5, y: 0.18, w: 7.5, h: 0.75,
    fontSize: 28, bold: true, color: C.white, fontFace: JA,
    align: "left", margin: 0
  });
  // Styled tag pill
  s.addShape(pres.shapes.RECTANGLE, {
    x: 7.95, y: 0.27, w: 1.8, h: 0.45,
    fill: { color: C.amber }, line: { type: "none" }
  });
  s.addText("AI Assistant", {
    x: 7.95, y: 0.27, w: 1.8, h: 0.45,
    fontSize: 13, bold: true, color: C.navyBg, fontFace: EN,
    align: "center", valign: "middle", margin: 0
  });

  const features = [
    { color: "7B1FA2", icon: "✍️", title: "文書・メール作成", desc: "提案書・報告書・\nメールを瞬時に作成" },
    { color: "C62828", icon: "📊", title: "情報整理・要約",   desc: "長文を読んで\nポイントを抽出" },
    { color: "1565C0", icon: "🔍", title: "調査・リサーチ",   desc: "テーマについて\n深く調査・分析" },
    { color: "2E7D32", icon: "💡", title: "ブレスト・企画",   desc: "アイデア出しや\n戦略立案を支援" },
    { color: "E65100", icon: "🌏", title: "翻訳・多言語対応", desc: "高精度な翻訳と\nローカライズ支援" },
    { color: "00695C", icon: "📑", title: "画像・PDF 解析",   desc: "資料を読み取り\n内容を解説" },
  ];

  const cols = 3, cardW = 2.85, cardH = 1.75, gapX = 0.35, gapY = 0.3;
  const startX = 0.33, startY = 1.3;

  features.forEach((f, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = startX + col * (cardW + gapX);
    const y = startY + row * (cardH + gapY);

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cardW, h: cardH,
      fill: { color: C.white }, line: { color: C.border, width: 1 },
      shadow: makeShadow()
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cardW, h: 0.07,
      fill: { color: f.color }, line: { type: "none" }
    });
    s.addShape(pres.shapes.OVAL, {
      x: x + 0.18, y: y + 0.18, w: 0.55, h: 0.55,
      fill: { color: f.color, transparency: 80 }, line: { type: "none" }
    });
    s.addText(f.icon, {
      x: x + 0.18, y: y + 0.18, w: 0.55, h: 0.55,
      fontSize: 20, align: "center", valign: "middle", margin: 0
    });
    s.addText(f.title, {
      x: x + 0.82, y: y + 0.2, w: cardW - 0.95, h: 0.45,
      fontSize: 14, bold: true, color: C.purple, fontFace: JA,
      align: "left", margin: 0
    });
    s.addText(f.desc, {
      x: x + 0.18, y: y + 0.82, w: cardW - 0.35, h: 0.78,
      fontSize: 12, color: C.gray, fontFace: JA,
      align: "left", margin: 0
    });
  });
}

// ─────────────────────────────────────────────
// SLIDE 6 — 比較・使い分け
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.darkBg };

  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 1.1,
    fill: { color: C.navyBg }, line: { type: "none" }
  });
  s.addText("使い分けのポイント", {
    x: 0.5, y: 0.15, w: 9, h: 0.8,
    fontSize: 28, bold: true, color: C.white, fontFace: JA,
    align: "center", margin: 0
  });

  // Left column — Claude Code
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.35, y: 1.25, w: 4.3, h: 4.0,
    fill: { color: C.navyBg }, line: { color: C.teal, width: 2.5 },
    shadow: makeShadow()
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.35, y: 1.25, w: 4.3, h: 0.58,
    fill: { color: C.teal }, line: { type: "none" }
  });
  s.addText("Claude Code", {
    x: 0.45, y: 1.29, w: 4.1, h: 0.5,
    fontSize: 18, bold: true, color: C.navyBg, fontFace: EN,
    align: "center", margin: 0
  });

  const codePoints = [
    "👩‍💻  対象：エンジニア・開発者",
    "⌨️  使い方：ターミナル / CLI",
    "📁  得意：コード生成・修正・実行",
    "🔍  強み：コードベース全体の理解",
    "🚀  活用：機能開発・バグ修正・自動化",
  ];
  codePoints.forEach((text, i) => {
    s.addText(text, {
      x: 0.5, y: 2.0 + i * 0.58, w: 4.0, h: 0.5,
      fontSize: 13, color: C.offWhite, fontFace: JA,
      align: "left", margin: 0
    });
  });

  // Right column — Claude Work
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.35, y: 1.25, w: 4.3, h: 4.0,
    fill: { color: "2D0E5A" }, line: { color: C.amber, width: 2.5 },
    shadow: makeShadow()
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 5.35, y: 1.25, w: 4.3, h: 0.58,
    fill: { color: C.amber }, line: { type: "none" }
  });
  s.addText("Claude Work", {
    x: 5.45, y: 1.29, w: 4.1, h: 0.5,
    fontSize: 18, bold: true, color: C.navyBg, fontFace: EN,
    align: "center", margin: 0
  });

  const workPoints = [
    "👔  対象：ビジネスパーソン全般",
    "🌐  使い方：ブラウザ / claude.ai",
    "📝  得意：文書作成・要約・分析",
    "🤝  強み：幅広い業務タスクに対応",
    "📈  活用：資料作成・調査・企画支援",
  ];
  workPoints.forEach((text, i) => {
    s.addText(text, {
      x: 5.45, y: 2.0 + i * 0.58, w: 4.0, h: 0.5,
      fontSize: 13, color: C.offWhite, fontFace: JA,
      align: "left", margin: 0
    });
  });

  // VS badge — white ring so it's visible on dark bg
  s.addShape(pres.shapes.OVAL, {
    x: 4.57, y: 2.8, w: 0.86, h: 0.86,
    fill: { color: C.white }, line: { type: "none" }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 4.62, y: 2.85, w: 0.76, h: 0.76,
    fill: { color: C.navyBg }, line: { type: "none" }
  });
  s.addText("VS", {
    x: 4.62, y: 2.88, w: 0.76, h: 0.7,
    fontSize: 15, bold: true, color: C.white, fontFace: EN,
    align: "center", valign: "middle", margin: 0
  });
}

// ─────────────────────────────────────────────
// SLIDE 7 — まとめ (Closing)
// ─────────────────────────────────────────────
{
  let s = pres.addSlide();
  s.background = { color: C.darkBg };

  // Top accent strip
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: W, h: 0.08,
    fill: { color: C.teal }, line: { type: "none" }
  });
  // Bottom accent strip
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: H - 0.08, w: W, h: 0.08,
    fill: { color: C.teal }, line: { type: "none" }
  });

  // Decorative bg shapes (fully off or far back)
  s.addShape(pres.shapes.OVAL, {
    x: -1.5, y: -1.5, w: 5, h: 5,
    fill: { color: C.midBlue, transparency: 82 }, line: { type: "none" }
  });
  s.addShape(pres.shapes.OVAL, {
    x: 7.5, y: 2.5, w: 4, h: 4,
    fill: { color: C.purple, transparency: 82 }, line: { type: "none" }
  });

  s.addText("まとめ", {
    x: 1, y: 0.4, w: 8, h: 0.7,
    fontSize: 36, bold: true, color: C.white, fontFace: JA,
    align: "center", margin: 0
  });
  // Centered rule matching "まとめ" width approx
  s.addShape(pres.shapes.RECTANGLE, {
    x: 4.05, y: 1.2, w: 1.9, h: 0.05,
    fill: { color: C.teal }, line: { type: "none" }
  });

  // Two summary cards — vertically centered on slide
  const summaryItems = [
    { icon: "⌨️", color: C.teal,  bgColor: C.navyBg, title: "Claude Code", desc: "開発者向け CLI エージェント\nコードの生成・修正・実行を自律処理" },
    { icon: "💼", color: C.amber, bgColor: "2D0E5A",  title: "Claude Work", desc: "全ビジネスパーソン向け AI アシスタント\n文書・調査・分析・企画を幅広くサポート" },
  ];

  summaryItems.forEach((item, i) => {
    const x = 0.75 + i * 4.85;
    const y = 1.45;
    const cw = 4.15, ch = 3.6;

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cw, h: ch,
      fill: { color: item.bgColor }, line: { color: item.color, width: 2 },
      shadow: makeShadow()
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: cw, h: 0.07,
      fill: { color: item.color }, line: { type: "none" }
    });

    // Icon: light circle on dark panel so emoji is visible
    s.addShape(pres.shapes.OVAL, {
      x: x + (cw / 2) - 0.55, y: y + 0.25, w: 1.1, h: 1.1,
      fill: { color: item.color, transparency: 30 }, line: { type: "none" }
    });
    s.addText(item.icon, {
      x: x + (cw / 2) - 0.55, y: y + 0.25, w: 1.1, h: 1.1,
      fontSize: 32, align: "center", valign: "middle", margin: 0
    });

    s.addText(item.title, {
      x: x + 0.2, y: y + 1.5, w: cw - 0.4, h: 0.55,
      fontSize: 20, bold: true, color: item.color, fontFace: EN,
      align: "center", margin: 0
    });
    s.addText(item.desc, {
      x: x + 0.2, y: y + 2.15, w: cw - 0.4, h: 1.15,
      fontSize: 13, color: C.offWhite, fontFace: JA,
      align: "center", margin: 0
    });
  });

  s.addText("Anthropic Claude — より良い仕事を、より早く", {
    x: 0.5, y: 5.18, w: 9, h: 0.35,
    fontSize: 12, color: C.gray, fontFace: JA,
    align: "center", margin: 0
  });
}

// Write file
pres.writeFile({ fileName: "C:/Users/matsunaga/Claude-Code-Test/Quotation-Viewer/Claude_Code_Work.pptx" })
  .then(() => console.log("Done: Claude_Code_Work.pptx"))
  .catch(e => console.error(e));
