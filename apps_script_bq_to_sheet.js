/**
 * BigQuery → Google Sheets エクスポート
 * 対象スプレッドシートのスクリプトエディタに貼り付けて実行してください。
 *
 * 手順:
 * 1. ターゲットシート (https://docs.google.com/spreadsheets/d/1ou_SV9UZA8HLttxB7-cSILMgVP_7Pzk1yus-Z9PZLqE/)
 *    を開く
 * 2. 拡張機能 > Apps Script を開く
 * 3. このスクリプトを貼り付けて保存
 * 4. runExport() を選択して ▶ 実行
 * 5. 初回は権限承認ダイアログが出るので「許可」をクリック
 */

const PROJECT_ID = 'booking-data-388605';
const SHEET_NAME = 'Sheet1'; // 書き込み先シート名（必要に応じて変更）

const SQL = `
select
  format_date("%Y-%m", date(Year, Month, 1)) as YearMonth,
  db.Booking_Shipper,
  db.BKG_Shipper_code,
  POL,
  CTR,
  POD,
  DLY,
  TEU,
  P_C,
  Route,
  cast(BKG_Date as string) as BKG_Date,
  cast(ETD as string) as ETD
from (
  select year, month, Booking_Shipper, BKG_Shipper_code, POL, CTR, POD, DLY, TEU, P_C, Route, BKG_Date, ETD
  from daily_booking_data.daily_2025_1st_half where Status <> "Cancel"
  union all
  select year, month, Booking_Shipper, BKG_Shipper_code, POL, CTR, POD, DLY, TEU, P_C, Route, BKG_Date, ETD
  from daily_booking_data.daily_2025_2nd_half where Status <> "Cancel"
  union all
  select year, month, Booking_Shipper, BKG_Shipper_code, POL, CTR, POD, DLY, TEU, P_C, Route, BKG_Date, ETD
  from daily_booking_data.daily_2026_1st_half where Status <> "Cancel"
) as db
left join handover.handover_row as ho
  on db.BKG_Shipper_Code = ho.BKG_Shipper_code
`;

function runExport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  // シートがなければ作成
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  Logger.log('BigQuery クエリを実行中...');

  // BigQuery ジョブ投入
  const request = {
    query: SQL,
    useLegacySql: false,
    location: 'US',
    timeoutMs: 120000,
  };

  let response;
  try {
    response = BigQuery.Jobs.query(PROJECT_ID, request);
  } catch (e) {
    SpreadsheetApp.getUi().alert('BigQuery エラー: ' + e.message);
    return;
  }

  const jobId = response.jobReference.jobId;

  // クエリ完了待ち（ページング対応）
  let pageToken = null;
  const allRows = [];
  let schema = null;

  // 最初のページ
  let queryResult = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId, { timeoutMs: 120000 });
  schema = queryResult.schema;
  (queryResult.rows || []).forEach(r => allRows.push(r));
  pageToken = queryResult.pageToken;

  // 続きのページがあれば取得
  while (pageToken) {
    queryResult = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId, { pageToken: pageToken });
    (queryResult.rows || []).forEach(r => allRows.push(r));
    pageToken = queryResult.pageToken;
  }

  Logger.log(`取得行数: ${allRows.length}`);

  // スキーマからヘッダーを作成
  const headers = schema.fields.map(f => f.name);

  // BigQuery の行形式 → 配列に変換
  const dataRows = allRows.map(row =>
    row.f.map(cell => (cell.v === null || cell.v === undefined ? '' : cell.v))
  );

  // シートに書き込み
  sheet.clearContents();

  const allData = [headers, ...dataRows];
  const range = sheet.getRange(1, 1, allData.length, headers.length);
  range.setValues(allData);

  // ── 書式設定 ──────────────────────────────────────────
  // ヘッダー行: 背景色・太字・白文字
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setBackground('#4472C4');
  headerRange.setFontColor('#FFFFFF');
  headerRange.setFontWeight('bold');
  headerRange.setHorizontalAlignment('center');

  // 1行目を固定
  sheet.setFrozenRows(1);

  // 列幅の自動調整（最大 300px）
  for (let i = 1; i <= headers.length; i++) {
    sheet.autoResizeColumn(i);
    if (sheet.getColumnWidth(i) > 300) {
      sheet.setColumnWidth(i, 300);
    }
  }

  // オートフィルター追加
  sheet.getRange(1, 1, allData.length, headers.length).createFilter();

  // データ行: 交互背景色
  for (let r = 2; r <= allData.length; r++) {
    const bg = r % 2 === 0 ? '#DDEEFF' : '#FFFFFF';
    sheet.getRange(r, 1, 1, headers.length).setBackground(bg);
  }

  Logger.log('完了！');
  SpreadsheetApp.getUi().alert(
    `✅ 完了！\n${allRows.length.toLocaleString()} 行を "${SHEET_NAME}" に書き込みました。`
  );
}
