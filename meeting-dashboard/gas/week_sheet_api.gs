/**
 * GAS Web App: WEEKシートのA-C列データをJSON返却
 *
 * デプロイ手順:
 * 1. Google Apps Script (https://script.google.com/) で新規プロジェクト作成
 * 2. このコードを貼り付け
 * 3. デプロイ > 新しいデプロイ
 *    - 種類: ウェブアプリ
 *    - 実行するユーザー: 自分 (KMTCドメインユーザー)
 *    - アクセスできるユーザー: 全員
 * 4. デプロイURLをコピー → ダッシュボードの /api/week-mapping/sync に POST
 */

const SPREADSHEET_ID = "1LffPrGCW-hcGxsAq3lTPNe0g2SnDw17eBtv5OzRcz2E";
const SHEET_GID = 2038639737;

function doGet(e) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // gid でシートを特定
    var sheet = null;
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getSheetId() === SHEET_GID) {
        sheet = sheets[i];
        break;
      }
    }
    if (!sheet) {
      return _jsonResponse({ error: "WEEK sheet not found" }, 404);
    }

    var data = sheet.getDataRange().getValues();
    var rows = [];

    // 1行目はヘッダ、2行目以降を処理
    for (var i = 1; i < data.length; i++) {
      var cellA = data[i][0]; // DATE
      var cellB = data[i][1]; // Y (年の下2桁)
      var cellC = data[i][2]; // WEEK (週番号)

      // A列が空ならスキップ
      if (!cellA) continue;

      // 日付をISO形式に変換
      var dateStr;
      if (cellA instanceof Date) {
        dateStr = Utilities.formatDate(cellA, "Asia/Tokyo", "yyyy-MM-dd");
      } else {
        dateStr = String(cellA).replace(/\//g, "-");
      }

      rows.push({
        date: dateStr,
        year: Number(cellB),
        week: Number(cellC)
      });
    }

    return _jsonResponse({ rows: rows, count: rows.length });

  } catch (err) {
    return _jsonResponse({ error: err.message }, 500);
  }
}

function _jsonResponse(obj, code) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
