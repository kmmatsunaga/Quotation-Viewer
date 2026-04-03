/**
 * 会議資料ダッシュボード - フロントエンド
 */

// ── グローバル状態 ───────────────────────────────────
let AREAS = [];
let CURRENT_AREA = null;
let CHART_INSTANCES = {};  // area -> {monthly, weekly}
let DATA_CACHE = {};       // area -> summaryData
let CURRENT_WEEK_KEY = null;
let CURRENT_USER = null;   // {username, role, display_name}
let PREVIEW_MODE = false;  // 編集者のプレビューモード
let SNAPSHOT_WEEKS = {};   // {week_key: {created_at, created_by}}
let VIEWING_SNAPSHOT = false;
let SNAPSHOT_CACHE = {};   // area -> snapshot data for current selected week
let THIS_WEEK_KEY = null;  // 実際の「今週」の week_key (is_current=true)
let NO_DATA_MODE = false;  // スナップショットなし＆今週でない → No Data表示

// グラフ設定関連
let TEMPLATE_DEFS = [];     // サーバーから取得するテンプレート定義一覧
let _graphConfigCache = {};  // area -> {blocks: [...]}
let _graphConfigLoaded = {}; // area -> bool
let _graphConfigDirty = {};  // area -> bool (未保存フラグ)

// ── Chart.js datalabels プラグイン登録 ───────────────
if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
  // デフォルトはOFF (各チャートで個別ON)
  Chart.defaults.plugins.datalabels = { display: false };
}

const COLORS = {
  actual:   '#1a6fc4',
  actualFg: 'rgba(26,111,196,0.8)',
  prospect: '#e67e22',
  prospectFg: 'rgba(230,126,34,0.75)',
  line:     '#e74c3c',
  prev:     'rgba(180,180,180,0.6)',
  curr:     'rgba(26,111,196,0.75)',
  next:     'rgba(39,174,96,0.65)',
  currLine: '#e74c3c',
};

// ── 初期化 ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.body.insertAdjacentHTML('beforeend', '<div id="toast"></div>');

  document.getElementById('current-date').textContent =
    new Date().toLocaleDateString('ja-JP', {year:'numeric', month:'long', day:'numeric', weekday:'short'});

  // ユーザー情報取得
  await initUser();

  // 更新ボタン / プレビュートグル: 編集者のみ表示
  const refreshBtn = document.getElementById('btn-bq-refresh');
  if (refreshBtn) refreshBtn.style.display = isEditor() ? '' : 'none';
  const previewToggle = document.getElementById('btn-preview-toggle');
  if (previewToggle) previewToggle.style.display = isEditor() ? '' : 'none';
  // 編集者は初期状態で編集モード表示
  if (isEditor()) {
    document.body.classList.add('edit-mode');
    const header = document.querySelector('.app-header');
    if (header) header.classList.add('editing');
    const editBadge = document.getElementById('edit-mode-badge');
    if (editBadge) editBadge.style.display = '';
  }
  // 閲覧者はテンプレート常時表示 (edit-mode/preview-modeクラスなし)

  // テンプレート定義を取得
  try {
    const defRes = await fetch('/api/template-definitions');
    TEMPLATE_DEFS = await defRes.json();
  } catch(e) { console.warn('Template defs load error:', e); }

  // 最終更新日時を取得・表示
  await loadRefreshStatus();
  // スナップショット一覧を取得
  await loadArchiveList();

  showLoading(true);
  await loadAreas();
  showLoading(false);
});

// ── ユーザー認証 ─────────────────────────────────────
async function initUser() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
    if (!data.logged_in) { window.location.href = '/login'; return; }
    CURRENT_USER = data;
    updateUserBadge();
  } catch(e) {
    window.location.href = '/login';
  }
}

function isEditor() { return CURRENT_USER?.role === 'editor'; }

function updateUserBadge() {
  if (!CURRENT_USER) return;
  const badge = document.getElementById('user-badge');
  const isEd = isEditor();
  badge.textContent = `${CURRENT_USER.display_name || CURRENT_USER.email} (${isEd ? '編集者' : '閲覧者'})`;
  badge.style.background = isEd ? 'rgba(39,174,96,.35)' : 'rgba(255,255,255,.18)';

  // 管理メニューはeditorのみ
  const adminMenu = document.getElementById('user-menu-admin');
  if (adminMenu) adminMenu.style.display = isEd ? 'block' : 'none';
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#user-info')) {
    const m = document.getElementById('user-menu');
    if (m) m.style.display = 'none';
  }
});

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ── ユーザー管理モーダル ──────────────────────────────
function openUserManager() {
  document.getElementById('user-menu').style.display = 'none';
  document.getElementById('user-manager-modal').style.display = 'flex';
  loadUserList();
}
function closeUserManager() {
  document.getElementById('user-manager-modal').style.display = 'none';
}

async function loadUserList() {
  const res = await fetch('/api/auth/users');
  if (!res.ok) return;
  const users = await res.json();
  const tbody = document.getElementById('user-table-body');
  tbody.innerHTML = '';
  users.forEach(u => {
    const isMe = u.email === CURRENT_USER?.email;
    const roleLabel = u.role === 'editor' ? '編集者' : '閲覧者';
    const otherRole = u.role === 'editor' ? 'viewer' : 'editor';
    const otherLabel = u.role === 'editor' ? '→閲覧者' : '→編集者';
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${u.email}${isMe ? ' <span style="color:#1a6fc4;font-size:10px">（自分）</span>' : ''}</td>
        <td>${u.display_name || '-'}</td>
        <td><span class="role-badge ${u.role}">${roleLabel}</span></td>
        <td>
          ${!isMe ? `
            <button onclick="changeRole('${u.email}','${otherRole}')" class="btn-sm">${otherLabel}</button>
            <button onclick="deleteUser('${u.email}')" class="btn-sm danger">削除</button>
          ` : ''}
        </td>
      </tr>
    `);
  });
}

async function addUser() {
  const email   = document.getElementById('new-username').value.trim().toLowerCase();
  const display = document.getElementById('new-display').value.trim();
  const role    = document.getElementById('new-role').value;
  if (!email) { showToast('メールアドレスは必須です', 'error'); return; }
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email, display_name: display || email, role })
  });
  const data = await res.json();
  if (res.ok) {
    showToast(`${email} を追加しました`, 'success');
    ['new-username','new-display'].forEach(id => document.getElementById(id).value = '');
    loadUserList();
  } else {
    showToast(data.error || '追加失敗', 'error');
  }
}

async function changeRole(email, newRole) {
  const label = newRole === 'editor' ? '編集者' : '閲覧者';
  if (!confirm(`${email} のロールを「${label}」に変更しますか？`)) return;
  const res = await fetch(`/api/auth/users/${encodeURIComponent(email)}/role`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ role: newRole })
  });
  if (res.ok) { showToast('ロールを変更しました', 'success'); loadUserList(); }
  else showToast('変更失敗', 'error');
}

async function deleteUser(email) {
  if (!confirm(`${email} を削除しますか？`)) return;
  const res = await fetch(`/api/auth/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
  const data = await res.json();
  if (res.ok) { showToast('削除しました', 'success'); loadUserList(); }
  else showToast(data.error || '削除失敗', 'error');
}

// ── エリア読み込み ────────────────────────────────────
async function loadAreas() {
  try {
    const res = await fetch('/api/areas');
    const data = await res.json();
    AREAS = data.areas || [];
    renderTabs();
    if (AREAS.length > 0) {
      switchArea(AREAS[0]);
    }
  } catch(e) {
    showToast('エリア取得エラー: ' + e.message, 'error');
  }
}

const BSA_GAS_URL = "https://script.google.com/a/macros/ekmtc.com/s/AKfycbwcptuochwA3URLdf8gUQzz2FbOJ1_ileh53AkPZEJD4UuWvt3tW06nXCrsExAOhZ_A/exec";

function renderTabs() {
  const tabList = document.getElementById('tab-list');
  tabList.innerHTML = '';
  const SUB_AREAS = new Set(["IN-West","IN-East","PKG&PEN","PKW&PGU","MIP","MNL","SGN","HPH"]);
  AREAS.forEach(area => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (SUB_AREAS.has(area) ? ' tab-btn-sub' : '');
    btn.textContent = area;
    btn.dataset.area = area;
    btn.onclick = () => switchArea(area);
    tabList.appendChild(btn);
  });
  // BSA タブを最後に追加
  const bsaBtn = document.createElement('button');
  bsaBtn.className = 'tab-btn tab-btn-bsa';
  bsaBtn.textContent = 'BSA';
  bsaBtn.dataset.area = '__BSA__';
  bsaBtn.onclick = () => switchToBSA();
  tabList.appendChild(bsaBtn);
}

function switchToBSA() {
  CURRENT_AREA = '__BSA__';
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.area === '__BSA__');
  });
  // 通常パネルを非表示
  document.querySelectorAll('.area-panel').forEach(p => p.classList.remove('active'));
  // BSAパネルを表示（なければ作成）
  let bsaPanel = document.getElementById('bsa-panel');
  if (!bsaPanel) {
    bsaPanel = document.createElement('div');
    bsaPanel.id = 'bsa-panel';
    bsaPanel.className = 'bsa-panel';
    bsaPanel.innerHTML = `
      <div class="bsa-iframe-wrap">
        <iframe src="${BSA_GAS_URL}" class="bsa-iframe"></iframe>
      </div>`;
    document.getElementById('area-panels').appendChild(bsaPanel);
  }
  bsaPanel.style.display = 'block';
}

// ── エリア切り替え ────────────────────────────────────
async function switchArea(area) {
  // 未保存チェック
  if (CURRENT_AREA && _graphConfigDirty[CURRENT_AREA] && area !== CURRENT_AREA) {
    if (!confirm('グラフ設定が未保存です。保存せずにAreaを変更しますか？')) return;
    _graphConfigDirty[CURRENT_AREA] = false;
  }
  CURRENT_AREA = area;

  // BSAパネル非表示
  const bsaPanel = document.getElementById('bsa-panel');
  if (bsaPanel) bsaPanel.style.display = 'none';

  // タブアクティブ
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.area === area);
  });

  // パネルの表示/非表示
  ensurePanel(area);
  document.querySelectorAll('.area-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.area === area);
  });

  // No Data 状態が解除されている場合、先にクリア
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  if (panel) clearNoData(panel);

  // データ取得・描画
  if (NO_DATA_MODE) {
    // No Data 表示
    renderNoData(area);
  } else if (VIEWING_SNAPSHOT && CURRENT_WEEK_KEY && SNAPSHOT_WEEKS[CURRENT_WEEK_KEY]) {
    if (SNAPSHOT_CACHE[area]) {
      renderArea(area, SNAPSHOT_CACHE[area]);
    } else {
      showLoading(true);
      await loadArchive(area, CURRENT_WEEK_KEY);
      showLoading(false);
    }
  } else {
    if (!DATA_CACHE[area]) {
      showLoading(true);
      await loadSummary(area);
      showLoading(false);
    } else {
      renderArea(area, DATA_CACHE[area]);
    }
  }
}

// ── パネル生成 ────────────────────────────────────────
function ensurePanel(area) {
  if (document.querySelector(`.area-panel[data-area="${area}"]`)) return;

  const tmpl = document.getElementById('area-panel-template');
  const panel = tmpl.content.cloneNode(true).querySelector('.area-panel');
  panel.dataset.area = area;
  panel.querySelector('.area-title').textContent = area;

  // 予測入力ボタン (editorのみ)
  const predictBtn = panel.querySelector('.btn-predict-prospects');
  if (predictBtn) {
    predictBtn.addEventListener('click', () => fillPrediction(area));
  }

  // 一括保存ボタン (editorのみ)
  const saveAllBtn = panel.querySelector('.btn-save-all-prospects');
  if (saveAllBtn) {
    saveAllBtn.addEventListener('click', () => saveAllProspects(area));
  }

  // ブロック追加ボタン (editorのみ)
  panel.querySelectorAll('.btn-add-block').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      if (type === 'image') {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = (e) => addImageBlock(area, e);
        inp.click();
      } else {
        addBlock(area, type);
      }
    });
  });

  // 左パネルタブ切り替え (Prospect / グラフ)
  panel.querySelectorAll('.lp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      // 未保存チェック
      if (_graphConfigDirty[area] && tab.dataset.tab === 'prospect') {
        if (!confirm('グラフ設定が未保存です。保存せずに切り替えますか？')) return;
        _graphConfigDirty[area] = false;
      }
      // タブ切り替え
      panel.querySelectorAll('.lp-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
      panel.querySelectorAll('[data-tab-panel]').forEach(p => p.style.display = p.dataset.tabPanel === tabName ? '' : 'none');
      panel.querySelectorAll('[data-tab-content]').forEach(h => h.style.display = h.dataset.tabContent === tabName ? 'flex' : 'none');
      // グラフタブ初回: 設定を読み込み
      if (tabName === 'graph' && !_graphConfigLoaded[area]) {
        loadGraphConfig(panel, area);
      }
    });
  });

  // グラフ設定保存ボタン
  const saveConfigBtn = panel.querySelector('.btn-save-graph-config');
  if (saveConfigBtn) saveConfigBtn.addEventListener('click', () => saveGraphConfig(area));

  // テンプレートボタン
  const tplBtn = panel.querySelector('.btn-template-config');
  if (tplBtn) tplBtn.addEventListener('click', () => openTemplateDialog(area));

  // 適用ボタン
  const propagateBtn = panel.querySelector('.btn-propagate-config');
  if (propagateBtn) propagateBtn.addEventListener('click', () => openApplyDialog(area));

  // クリアボタン
  const clearBtn = panel.querySelector('.btn-clear-graph-config');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!confirm('Summaryのブロックをすべてクリアしますか？')) return;
    _graphConfigCache[area] = [];
    _graphConfigDirty[area] = true;
    const tplData = TEMPLATE_CACHE[area];
    if (tplData) _renderGraphCanvas(panel, area, tplData);
    showToast('すべてクリアしました。Save で確定してください', 'success');
  });

  document.getElementById('area-panels').appendChild(panel);
}

// ── データ読み込み ────────────────────────────────────
async function loadSummary(area) {
  try {
    const mw = CURRENT_WEEK_KEY ? `&meeting_week=${encodeURIComponent(CURRENT_WEEK_KEY)}` : '';
    const res = await fetch(`/api/summary?area=${area}${mw}`);
    const data = await res.json();
    DATA_CACHE[area] = data;
    renderArea(area, data);
  } catch(e) {
    showToast(`${area} データ取得エラー: ` + e.message, 'error');
  }
}

// ── No Data 表示 ─────────────────────────────────────
function renderNoData(area) {
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  if (!panel) return;

  // パネル内の全コンテンツを非表示
  Array.from(panel.children).forEach(el => {
    if (!el.classList.contains('no-data-overlay')) {
      el.style.display = 'none';
    }
  });

  // No Data オーバーレイを表示
  let overlay = panel.querySelector('.no-data-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'no-data-overlay';
    const hint = isEditor()
      ? '<p class="no-data-hint">「🔄 更新」ボタンを押すと最新データが保存されます。</p>'
      : '';
    overlay.innerHTML = `
      <div class="no-data-content">
        <div class="no-data-icon">📭</div>
        <h2>No Data</h2>
        <p>この週のアーカイブはありません。</p>
        ${hint}
      </div>`;
    panel.appendChild(overlay);
  }
  overlay.style.display = 'flex';
}

function clearNoData(panel) {
  if (!panel) return;
  const overlay = panel.querySelector('.no-data-overlay');
  if (overlay) overlay.style.display = 'none';
  // パネル内の全コンテンツを再表示
  Array.from(panel.children).forEach(el => {
    if (!el.classList.contains('no-data-overlay')) {
      el.style.display = '';
    }
  });
}

// ── エリア描画メイン ──────────────────────────────────
function renderArea(area, data) {
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  if (!panel) return;

  // No Data 状態をクリア
  clearNoData(panel);

  // 月間チャート
  renderMonthlyChart(panel, area, data.monthly || [], data.weekly || []);

  // 週間チャート
  renderWeeklyChart(panel, area, data.weekly || []);

  // BSA Chart（固定位置）
  _renderBSAInPanel(panel, area);

  // Top5 Shipper
  renderShipperTable(panel, data.top_shippers || [], data.monthly || []);

  // 月間見込みテーブル (当月・来月)
  renderMonthlyProspect(panel, area, data.monthly || []);

  // Prospect入力テーブル
  renderProspectTable(panel, area, data.weekly || []);

  // 週セレクタ更新 (最初のエリアのみ, 週変更時はスキップ) ← loadBlocks より先に呼ぶ
  if (AREAS[0] === area && !window._skipWeekSelectorUpdate) updateWeekSelector(data.weekly || []);

  // ブロックエディター (CURRENT_WEEK_KEY が確定してから呼ぶ)
  const weekKey = CURRENT_WEEK_KEY || getCurrentWeekKey();
  loadBlocks(panel, area, weekKey).then(() => {
    // ブロック描画完了後にUI状態を適用（ボタン消失防止）
    applyArchiveModeUI(panel);
  });

  // 選択中の週をハイライト
  highlightSelectedWeek(panel, weekKey);

  // スナップショットモード: 見込み入力を無効化 & バナー表示
  applyArchiveModeUI(panel);

  // テンプレートブロック読み込み (左パネル内)
  _loadAndRenderGraphBlocks(panel, area);
}

// ── KPI ──────────────────────────────────────────────
function renderKPIs(panel, data) {
  const weekly = data.weekly || [];
  const monthly = data.monthly || [];

  // 今月実績
  const currMonth = monthly.find(m => m.is_current) || monthly.find(m => !m.is_future) || {};

  panel.querySelector('.shipper-count').textContent = data.shipper_count ?? '-';
  panel.querySelector('.curr-teu').textContent =
    currMonth.TEU != null ? currMonth.TEU.toLocaleString() : '-';
  panel.querySelector('.curr-cm1-teu').textContent =
    currMonth.CM1_per_TEU != null ? '$' + currMonth.CM1_per_TEU.toLocaleString() : '-';
}

// ── チャートタイトル生成 ─────────────────────────────
const MONTH_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function buildRangeTitle(prefix, items, ymKey) {
  if (!items || items.length === 0) return prefix;
  const first = items[0][ymKey] || '';
  const last = items[items.length - 1][ymKey] || '';
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  if (!fy || !fm || !ly || !lm) return prefix;
  const fLabel = `${fy} ${MONTH_EN[fm - 1]}`;
  const lLabel = fy === ly ? MONTH_EN[lm - 1] : `${ly} ${MONTH_EN[lm - 1]}`;
  return `${prefix} 【${fLabel} - ${lLabel}】`;
}

// ── 月間チャート ──────────────────────────────────────
function renderMonthlyChart(panel, area, monthly, weeklyData) {
  const canvas = panel.querySelector('.monthly-chart');
  const key = `${area}_monthly`;

  if (CHART_INSTANCES[key]) { CHART_INSTANCES[key].destroy(); }

  // タイトル動的更新
  const mTitle = panel.querySelector('.monthly-chart-title');
  if (mTitle) mTitle.textContent = buildRangeTitle('月間推移', monthly, 'ym');

  // ラベルに社数を埋め込む (複数行)
  const labels = monthly.map(m => {
    const sc = m.shipper_count > 0 ? `(${m.shipper_count}社)` : '';
    return sc ? [m.label, sc] : m.label;
  });

  // 週次の見込み合計を ym 別に集計
  const prospectSumByYm = {};
  const prospectCM1TotalByYm = {}; // 月の見込み CM1 合計 (CM1/T × TEU)
  (weeklyData || []).forEach(w => {
    if (w.prospect_TEU != null) {
      prospectSumByYm[w.ym] = (prospectSumByYm[w.ym] || 0) + w.prospect_TEU;
    }
    if (w.prospect_CM1 != null && w.prospect_TEU != null && w.prospect_TEU > 0) {
      prospectCM1TotalByYm[w.ym] = (prospectCM1TotalByYm[w.ym] || 0) + w.prospect_CM1 * w.prospect_TEU;
    }
  });

  // 見込みTEUを先に計算 (月間見込み優先 → 週次合計)
  const _prospectTEU = monthly.map(m => {
    if (!m.is_future && !m.is_current) return null;
    if (m.m_prospect_teu != null) return m.m_prospect_teu;
    const pSum = prospectSumByYm[m.ym];
    return (pSum != null && pSum > 0) ? pSum : null;
  });

  // 実績: 見込みがある月は実績を非表示 (見込みバーに置き換え)
  const actualTEU = monthly.map((m, i) => {
    if (_prospectTEU[i] != null) return null;  // 見込みがある→実績バー非表示
    return m.TEU > 0 ? m.TEU : null;
  });

  // 見込み: 当月・将来月で見込みデータがある月のみ
  const prospectTEU = _prospectTEU;

  // CM1/T ライン: 見込みがある月は見込みCM1優先、なければ実績
  const cm1PerTEU = monthly.map(m => {
    if (m.is_future || m.is_current) {
      // 見込みCM1がある場合はそちらを優先
      if (m.m_prospect_cm1 != null) return m.m_prospect_cm1;
      const pTEU = prospectSumByYm[m.ym];
      const pCM1Total = prospectCM1TotalByYm[m.ym];
      if (pTEU > 0 && pCM1Total != null) return Math.round(pCM1Total / pTEU * 10) / 10;
    }
    // 実績
    if (m.CM1_per_TEU > 0) return m.CM1_per_TEU;
    return null;
  });
  const cm1PointColorsMon = monthly.map((m, i) => {
    if ((m.is_future || m.is_current) && _prospectTEU[i] != null) return COLORS.prospect;
    return COLORS.line;
  });

  CHART_INSTANCES[key] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '実績 TEU',
          data: actualTEU,
          backgroundColor: COLORS.actualFg,
          borderColor: COLORS.actual,
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'y',
          order: 1,
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
            anchor: 'center', align: 'center',
            font: { size: 12, weight: 'bold' },
            color: '#fff',
            formatter: v => v != null ? v.toLocaleString() : '',
          },
        },
        {
          label: '見込 TEU',
          data: prospectTEU,
          backgroundColor: COLORS.prospectFg,
          borderColor: COLORS.prospect,
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'y',
          order: 1,
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
            anchor: 'center', align: 'center',
            font: { size: 12, weight: 'bold' },
            color: '#fff',
            formatter: v => v != null ? v.toLocaleString() : '',
          },
        },
        {
          label: 'CM1/TEU',
          data: cm1PerTEU,
          type: 'line',
          borderColor: COLORS.line,
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: cm1PointColorsMon,
          tension: 0.3,
          yAxisID: 'y2',
          order: 0,
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
            anchor: 'end', align: 'top', offset: 6,
            font: { size: 11, weight: 'bold' },
            color: '#fff',
            backgroundColor: '#c62828',
            borderRadius: 3,
            padding: { top: 2, bottom: 2, left: 4, right: 4 },
            formatter: v => v != null ? '$' + Math.round(v).toLocaleString() : '',
          },
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex === 2) return `CM1/TEU: $${Math.round(ctx.parsed.y ?? 0).toLocaleString()}`;
              return `${ctx.dataset.label}: ${ctx.parsed.y?.toLocaleString() ?? '-'} TEU`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          type: 'linear', position: 'left',
          title: { display: true, text: 'TEU', font: {size:11} },
          grid: { color: '#f0f0f0' },
          ticks: { callback: v => v.toLocaleString() },
          grace: '15%',
        },
        y2: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'CM1/TEU ($)', font: {size:11} },
          grid: { drawOnChartArea: false },
          ticks: { callback: v => '$' + v.toLocaleString() },
          grace: '15%',
        }
      }
    }
  });
}

// ── 週間チャート ──────────────────────────────────────
function renderWeeklyChart(panel, area, weekly) {
  const canvas = panel.querySelector('.weekly-chart');
  const key = `${area}_weekly`;

  if (CHART_INSTANCES[key]) { CHART_INSTANCES[key].destroy(); }

  // タイトル動的更新 (重複ym除外)
  const wTitle = panel.querySelector('.weekly-chart-title');
  if (wTitle) {
    const uniqueYms = [...new Set(weekly.map(w => w.ym))].map(ym => ({ym}));
    wTitle.textContent = buildRangeTitle('週間推移', uniqueYms, 'ym');
  }

  // 月ごとに色分け
  const months = [...new Set(weekly.map(w => w.month_label))];
  const monthColors = {
    [months[0]]: COLORS.prev,
    [months[1]]: COLORS.curr,
    [months[2]]: COLORS.next,
  };

  const labels = weekly.map(w => {
    const marker = w.is_current ? '▶' : '';
    const sc = w.shipper_count > 0 ? `${w.shipper_count}社` : '';
    const parts = [`W${w.week}${marker}`, `(${w.month_label})`];
    if (sc) parts.push(sc);
    return parts;
  });

  // 実績 TEU: 過去・現在・将来の全週で確定済み予約を表示
  const actualTEU = weekly.map(w => w.TEU > 0 ? w.TEU : null);
  // 見込 TEU: 今週・将来週の手入力値
  const prospectTEU = weekly.map(w => {
    if (!w.is_future && !w.is_current) return null;
    return w.prospect_TEU ?? null;
  });
  // CM1/T ライン: 今週以降は見込み CM1/T を優先、過去は実績
  const cm1Line = weekly.map(w => {
    if (w.is_future || w.is_current) {
      if (w.prospect_CM1 != null) return w.prospect_CM1;
      if (w.CM1_per_TEU > 0) return w.CM1_per_TEU;
      return null;
    }
    if (w.CM1_per_TEU > 0) return w.CM1_per_TEU;
    return null;
  });
  const cm1PointColors = weekly.map(w => {
    if ((w.is_future || w.is_current) && w.prospect_CM1 != null) return COLORS.prospect;
    return COLORS.line;
  });

  // バーの色を月ごとに
  const barColors = weekly.map(w => {
    const base = monthColors[w.month_label] || COLORS.actualFg;
    return w.is_future ? COLORS.prospectFg : base;
  });

  CHART_INSTANCES[key] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: '実績 TEU',
          data: actualTEU,
          backgroundColor: weekly.map(w => monthColors[w.month_label] || COLORS.actualFg),
          borderWidth: 1,
          borderRadius: 3,
          yAxisID: 'y',
          order: 1,
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
            anchor: 'center', align: 'center',
            font: { size: 11, weight: 'bold' },
            color: '#fff',
            formatter: v => v != null ? v.toLocaleString() : '',
          },
        },
        {
          label: '見込 TEU',
          data: prospectTEU,
          backgroundColor: COLORS.prospectFg,
          borderWidth: 1,
          borderRadius: 3,
          yAxisID: 'y',
          order: 1,
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
            anchor: 'center', align: 'center',
            font: { size: 11, weight: 'bold' },
            color: '#fff',
            formatter: v => v != null ? v.toLocaleString() : '',
          },
        },
        {
          label: 'CM1/TEU',
          data: cm1Line,
          type: 'line',
          borderColor: COLORS.line,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: cm1PointColors,
          tension: 0.2,
          yAxisID: 'y2',
          order: 0,
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
            anchor: 'end', align: 'top', offset: 6,
            font: { size: 12, weight: 'bold' },
            color: '#fff',
            backgroundColor: '#c62828',
            borderRadius: 3,
            padding: { top: 2, bottom: 2, left: 4, right: 4 },
            formatter: v => v != null ? '$' + Math.round(v).toLocaleString() : '',
          },
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: ctx => {
              const w = weekly[ctx[0].dataIndex];
              return `W${w.week} (${w.week_start} 〜 ${w.week_end})`;
            },
            label: ctx => {
              if (ctx.datasetIndex === 2) return `CM1/TEU: $${Math.round(ctx.parsed.y ?? 0).toLocaleString()}`;
              return `${ctx.dataset.label}: ${ctx.parsed.y?.toLocaleString() ?? '-'} TEU`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: {size:11}, maxRotation: 0 }
        },
        y: {
          type: 'linear', position: 'left',
          title: { display: true, text: 'TEU', font: {size:11} },
          grid: { color: '#f0f0f0' },
          ticks: { callback: v => v.toLocaleString() },
          grace: '15%',
        },
        y2: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'CM1/TEU ($)', font: {size:11} },
          grid: { drawOnChartArea: false },
          ticks: { callback: v => '$' + v.toLocaleString() },
          grace: '15%',
        }
      }
    }
  });
}

// ── Top5 Shipper テーブル ─────────────────────────────
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthAbbr(label) {
  // "2026/03" → "Mar" / "Mar '26" → "Mar"
  if (!label) return label;
  const slash = label.match(/\/(\d{1,2})$/);
  if (slash) return MONTH_ABBR[parseInt(slash[1], 10) - 1] || label;
  return label.split(' ')[0];
}
/** "2026/03" → "2026 Mar" */
function ymToLabel(ym) {
  if (!ym) return ym;
  const m = ym.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]} ${MONTH_ABBR[parseInt(m[2],10)-1]||m[2]}`;
  return ym;
}

function renderShipperTable(panel, shippers, monthly) {
  const months = monthly || [];
  let currIdx = -1;
  for (let i = months.length - 1; i >= 0; i--) {
    if (!months[i].is_future) { currIdx = i; break; }
  }
  const prevLabel = currIdx > 0 ? (monthAbbr(months[currIdx-1]?.label) || '前月') : '前月';
  const currLabel = currIdx >= 0 ? (monthAbbr(months[currIdx]?.label) || '今月') : '今月';
  const nextLabel = (currIdx >= 0 && currIdx+1 < months.length)
    ? (monthAbbr(months[currIdx+1]?.label) || '来月') : '来月';

  // thead を月名で更新
  const theadTr = panel.querySelector('.shipper-table thead tr');
  theadTr.innerHTML = `
    <th>Shipper</th>
    <th>${prevLabel}<br>TEU</th>
    <th>${prevLabel}<br>CM1/T</th>
    <th>${currLabel}<br>TEU</th>
    <th>${currLabel}<br>CM1/T</th>
    <th>${nextLabel}<br>TEU</th>
    <th>GAP<br>±TEU</th>
  `;

  const tbody = panel.querySelector('.shipper-tbody');
  tbody.innerHTML = '';

  if (!shippers.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px">データなし</td></tr>';
    return;
  }

  shippers.forEach((s, idx) => {
    const gapCls = s.gap_teu > 0 ? 'gap-pos' : s.gap_teu < 0 ? 'gap-neg' : '';
    const gapStr = s.gap_teu > 0 ? '+' + s.gap_teu.toLocaleString() : s.gap_teu.toLocaleString();
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${idx+1}. ${s.shipper}</td>
        <td>${(s.prev?.TEU ?? 0).toLocaleString()}</td>
        <td>$${(s.prev?.CM1_per_TEU ?? 0).toLocaleString()}</td>
        <td><strong>${(s.curr?.TEU ?? 0).toLocaleString()}</strong></td>
        <td>$${(s.curr?.CM1_per_TEU ?? 0).toLocaleString()}</td>
        <td>${(s.next?.TEU ?? 0).toLocaleString()}</td>
        <td class="${gapCls}">${gapStr}</td>
      </tr>
    `);
  });
}

// ── Prospect 入力テーブル ────────────────────────────
function renderProspectTable(panel, area, weekly) {
  const tbody = panel.querySelector('.prospect-tbody');
  tbody.innerHTML = '';

  let lastMonth = null;

  // 選択中の週を「今週」として扱う
  const selectedKey = CURRENT_WEEK_KEY || '';
  const selectedIdx = weekly.findIndex(w => w.week_key === selectedKey);

  weekly.forEach((w, idx) => {
    const isFirstOfMonth = w.month_label !== lastMonth;
    lastMonth = w.month_label;

    const monthIdx = w.ym === getRelativeMonth(-1) ? 0 :
                     w.ym === getRelativeMonth(0)  ? 1 : 2;
    const monthBadgeClass = monthIdx === 0 ? 'prev' : monthIdx === 2 ? 'next' : '';

    // 選択週基準で過去・今週・未来を判定
    const isSelectedWeek = w.week_key === selectedKey;
    const isPastWeek = selectedIdx >= 0 ? idx < selectedIdx : (!w.is_future && !w.is_current);
    const isFutureWeek = selectedIdx >= 0 ? idx > selectedIdx : w.is_future;

    const rowClass = isSelectedWeek ? 'current-row selected-week' :
                     isFutureWeek ? 'future-row' : '';

    const currentMark = isSelectedWeek ? '<span class="current-marker">◀今週</span>' : '';

    const prospectTEU = w.prospect_TEU ?? '';
    const prospectCM1 = w.prospect_CM1 ?? '';

    // 選択週以降のみ入力可（それ以前は「ー」表示）
    const canEdit  = isEditor() && !isPastWeek && !VIEWING_SNAPSHOT;
    const disabled = canEdit ? '' : 'disabled';
    const readonly = canEdit ? '' : 'style="background:#f5f5f5"';

    const prospectTeuCell = isPastWeek
      ? '<td class="dash-cell">ー</td>'
      : `<td><input type="number" class="prospect-input p-teu" ${disabled} ${readonly}
           value="${prospectTEU}" placeholder="TEU"></td>`;
    const prospectCm1Cell = isPastWeek
      ? '<td class="dash-cell">ー</td>'
      : `<td><input type="number" class="prospect-input p-cm1" ${disabled} ${readonly}
           value="${prospectCM1}" placeholder="CM1/T"></td>`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr class="${rowClass}" data-week-key="${w.week_key}">
        <td>
          ${isFirstOfMonth
            ? `<span class="month-badge ${monthBadgeClass}">${w.month_label}</span>`
            : ''}
        </td>
        <td class="week-badge">W${w.week}${currentMark}</td>
        <td class="period-col">${formatPeriod(w.week_start, w.week_end)}</td>
        <td style="color:#666">${w.TEU ? w.TEU.toLocaleString() : '-'}</td>
        <td style="color:#666">${w.CM1_per_TEU ? '$'+w.CM1_per_TEU.toLocaleString() : '-'}</td>
        ${prospectTeuCell}
        ${prospectCm1Cell}
      </tr>
    `);
  });
}

// 相対月 (delta=-1:前月, 0:今月, 1:来月) のYM文字列
function getRelativeMonth(delta) {
  const d = new Date();
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function formatPeriod(start, end) {
  if (!start || !end) return '';
  const s = start.slice(5).replace('-', '/');
  const e = end.slice(5).replace('-', '/');
  return `${s}〜${e}`;
}

// ── Prospect 一括保存 ────────────────────────────────
async function saveAllProspects(area) {
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  const rows = panel.querySelectorAll('.prospect-tbody tr[data-week-key]');

  const saves = [];
  rows.forEach(tr => {
    const teuInput = tr.querySelector('.p-teu');
    const cm1Input = tr.querySelector('.p-cm1');
    if (!teuInput || teuInput.disabled) return; // 過去週・閲覧者はスキップ
    const weekKey = tr.dataset.weekKey;
    const teu = teuInput.value;
    const cm1 = cm1Input.value;
    saves.push(fetch('/api/prospect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        week_key: weekKey, area,
        meeting_week: CURRENT_WEEK_KEY || '',
        teu: teu !== '' ? parseFloat(teu) : null,
        cm1: cm1 !== '' ? parseFloat(cm1) : null,
      })
    }));
  });

  if (!saves.length) { showToast('保存対象の行がありません', ''); return; }

  try {
    await Promise.all(saves);
    await saveMonthlyProspects(area);  // 月間見込みも一緒に保存
    showToast('見込みを保存しました ✓', 'success');
    delete DATA_CACHE[area];
    await loadSummary(area);
  } catch(e) {
    showToast('保存エラー: ' + e.message, 'error');
  }
}

// ── 月間見込みテーブル (前月・当月・来月) ────────────────
function renderMonthlyProspect(panel, area, monthly) {
  const tbody = panel.querySelector('.monthly-prospect-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // 後ろから3件 = 前月・当月・来月
  const targets = monthly.slice(-3);
  targets.forEach(m => {
    const isPast = !m.is_current && !m.is_future;  // 前月
    const canEdit = isEditor() && !isPast;           // 当月・来月のみ入力可
    const dis = canEdit ? '' : 'disabled';
    const bg  = canEdit ? '' : 'style="background:#f5f5f5"';
    const lastDay = new Date(m.year, m.month, 0).getDate();
    const period  = `${String(m.month).padStart(2,'0')}/01〜${String(m.month).padStart(2,'0')}/${lastDay}`;

    const prospectTeuCell = isPast
      ? '<td class="dash-cell">ー</td>'
      : `<td><input type="number" class="prospect-input mp-teu" ${dis} ${bg}
           value="${m.m_prospect_teu ?? ''}" placeholder="TEU"></td>`;
    const prospectCm1Cell = isPast
      ? '<td class="dash-cell">ー</td>'
      : `<td><input type="number" class="prospect-input mp-cm1" ${dis} ${bg}
           value="${m.m_prospect_cm1 ?? ''}" placeholder="CM1/T"></td>`;

    tbody.insertAdjacentHTML('beforeend', `
      <tr data-ym="${m.ym}" data-editable="${!isPast}">
        <td>${m.label}</td>
        <td class="period-col" style="font-size:11px">${period}</td>
        <td style="color:#666">${m.TEU ? m.TEU.toLocaleString() : '-'}</td>
        <td style="color:#666">${m.CM1_per_TEU ? '$'+m.CM1_per_TEU.toLocaleString() : '-'}</td>
        ${prospectTeuCell}
        ${prospectCm1Cell}
      </tr>
    `);
  });
}

async function saveMonthlyProspects(area) {
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  // data-editable="true" の行のみ保存
  const rows  = panel.querySelectorAll('.monthly-prospect-tbody tr[data-editable="true"]');
  const saves = [];
  rows.forEach(tr => {
    const ym  = tr.dataset.ym;
    const teuEl = tr.querySelector('.mp-teu');
    const cm1El = tr.querySelector('.mp-cm1');
    if (!teuEl) return;
    saves.push(fetch('/api/monthly_prospect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ym, area,
        meeting_week: CURRENT_WEEK_KEY || '',
        teu: teuEl.value !== '' ? parseFloat(teuEl.value) : null,
        cm1_per_teu: cm1El?.value !== '' ? parseFloat(cm1El?.value) : null,
      })
    }));
  });
  await Promise.all(saves);
}

// ── 予測入力 ─────────────────────────────────────────
async function fillPrediction(area) {
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  if (!panel) return;
  try {
    showToast('予測計算中…', '');
    const mw = CURRENT_WEEK_KEY || '';
    const res = await fetch(`/api/predict?area=${encodeURIComponent(area)}&meeting_week=${encodeURIComponent(mw)}`);
    const pred = await res.json();

    // 月間見込みに反映 (空欄のみ or 全上書き)
    const monthRows = panel.querySelectorAll('.monthly-prospect-tbody tr[data-editable="true"]');
    let filled = 0;
    monthRows.forEach(tr => {
      const ym = tr.dataset.ym;
      const mp = pred.monthly?.[ym];
      if (!mp) return;
      const teuEl = tr.querySelector('.mp-teu');
      const cm1El = tr.querySelector('.mp-cm1');
      if (teuEl && !teuEl.disabled && teuEl.value === '') {
        teuEl.value = mp.teu;
        teuEl.style.color = '#7c3aed';  // 紫色で予測値を区別
        filled++;
      }
      if (cm1El && !cm1El.disabled && cm1El.value === '') {
        cm1El.value = mp.cm1_per_teu;
        cm1El.style.color = '#7c3aed';
        filled++;
      }
    });

    // 週次見込みに反映 (空欄のみ)
    const weekRows = panel.querySelectorAll('.prospect-tbody tr[data-week-key]');
    weekRows.forEach(tr => {
      const wkey = tr.dataset.weekKey;
      const wp = pred.weekly?.[wkey];
      if (!wp) return;
      const teuEl = tr.querySelector('.p-teu');
      const cm1El = tr.querySelector('.p-cm1');
      if (teuEl && !teuEl.disabled && teuEl.value === '') {
        teuEl.value = wp.teu;
        teuEl.style.color = '#7c3aed';
        filled++;
      }
      if (cm1El && !cm1El.disabled && cm1El.value === '') {
        cm1El.value = wp.cm1_per_teu;
        cm1El.style.color = '#7c3aed';
        filled++;
      }
    });

    if (filled > 0) {
      showToast(`${filled}件の予測値を入力しました (紫色) — 確認後「一括保存」してください`, 'success');
    } else {
      showToast('入力済みの欄があるため予測値は追加されませんでした', '');
    }
  } catch(e) {
    showToast('予測エラー: ' + e.message, 'error');
  }
}

// ── ブロックエディター ─────────────────────────────────
async function loadBlocks(panel, area, weekKey) {
  try {
    const blocks = await (await fetch(`/api/blocks?week_key=${encodeURIComponent(weekKey)}&area=${encodeURIComponent(area)}`)).json();
    renderBlocks(panel, area, weekKey, blocks);
  } catch(e) {
    console.warn('Block load error:', e);
  }
}

function renderBlocks(panel, area, weekKey, blocks) {
  const container = panel.querySelector('.blocks-container');
  if (!container) return;
  container.innerHTML = '';
  blocks.forEach(b => container.appendChild(createBlockEl(b, area, weekKey)));
}

function createBlockEl(block, area, weekKey) {
  const el = document.createElement('div');
  el.className = 'block';
  el.dataset.blockId = block.id;
  el.dataset.blockType = block.block_type;

  const typeLabel = { text: '📝 テキスト', image: '🖼 Image', ai: '🤖 AI分析' }[block.block_type] || block.block_type;

  if (block.block_type === 'ai') {
    // AI チャットブロック
    let aiData = { messages: [], lastResult: null };
    try { if (block.content) {
      const parsed = JSON.parse(block.content);
      // 旧形式互換
      if (parsed.messages) { aiData = parsed; }
      else if (parsed.prompt) {
        aiData.messages = [{ role: 'user', text: parsed.prompt }];
        if (parsed.html) aiData.messages.push({ role: 'ai', text: parsed.html, html: parsed.html });
        if (parsed.chart) aiData.messages.push({ role: 'ai', text: '', chart: parsed.chart });
        aiData.lastResult = parsed.html ? { html: parsed.html } : parsed.chart ? { chart: parsed.chart } : null;
      }
    }} catch(e) {}

    const hasHistory = aiData.messages.length > 0;
    el.innerHTML = `
      <div class="block-header editor-only">
        <div class="block-ctrl">
          <button class="btn-block-up" title="上へ">↑</button>
          <button class="btn-block-down" title="下へ">↓</button>
          <button class="btn-block-del" title="削除">✕</button>
        </div>
      </div>
      <div class="ai-block-wrap${hasHistory ? '' : ' ai-expanded'}">
        <div class="ai-latest-result"></div>
        <div class="ai-expand-hint">💬 クリックで会話を表示</div>
        <div class="ai-chat-messages editor-only"></div>
        <div class="ai-input-row editor-only">
          <input type="text" class="ai-prompt-input" placeholder="質問を入力... 例: 3月のTEU前月比トップ5を表で">
          <button class="btn-ai-run">送信</button>
        </div>
        <div class="ai-preview-result"></div>
      </div>
    `;

    const chatArea = el.querySelector('.ai-chat-messages');
    const previewResult = el.querySelector('.ai-preview-result');
    const latestResult = el.querySelector('.ai-latest-result');
    const expandHint = el.querySelector('.ai-expand-hint');
    const aiWrap = el.querySelector('.ai-block-wrap');
    const promptInput = el.querySelector('.ai-prompt-input');
    const runBtn = el.querySelector('.btn-ai-run');

    // 展開/折りたたみ
    function collapseAiBlock() {
      if (chatHistory.length === 0) return; // 空なら常に展開
      aiWrap.classList.remove('ai-expanded');
    }
    function expandAiBlock() {
      aiWrap.classList.add('ai-expanded');
      setTimeout(() => { chatArea.scrollTop = chatArea.scrollHeight; }, 50);
    }

    // 最新結果クリックで展開
    latestResult.addEventListener('click', () => expandAiBlock());
    expandHint.addEventListener('click', () => expandAiBlock());

    // 入力欄フォーカスで展開
    promptInput.addEventListener('focus', () => expandAiBlock());

    // ブロック外クリックで折りたたみ
    document.addEventListener('click', (e) => {
      if (!el.contains(e.target)) collapseAiBlock();
    });

    // 会話履歴をメモリに保持
    const chatHistory = [...aiData.messages];

    // チャートを描画するヘルパー
    function renderChartIn(container, cd) {
      container.innerHTML = `<h4 style="margin:0 0 8px;color:#1a237e">${escHtml(cd.title || '')}</h4><canvas class="ai-chart-canvas"></canvas>`;
      const canvas = container.querySelector('.ai-chart-canvas');
      canvas.style.maxHeight = '300px';
      const chartType = (cd.type === 'bar+line') ? 'bar' : cd.type;
      const datasets = cd.datasets.map(ds => ({
        label: ds.label, data: ds.data, type: ds.type || chartType,
        backgroundColor: ds.backgroundColor || '#3f51b5',
        borderColor: ds.borderColor || ds.backgroundColor || '#3f51b5',
        borderWidth: ds.type === 'line' ? 2 : 1, borderRadius: ds.type === 'line' ? 0 : 4,
        fill: false, tension: 0.3, pointRadius: ds.type === 'line' ? 4 : undefined,
        yAxisID: ds.yAxisID || 'y', order: ds.type === 'line' ? 0 : 1,
      }));
      const hasY1 = datasets.some(ds => ds.yAxisID === 'y1');
      const scales = { y: { position: 'left', title: { display: !!cd.y_label, text: cd.y_label || '' }, beginAtZero: true } };
      if (hasY1) scales.y1 = { position: 'right', title: { display: !!cd.y1_label, text: cd.y1_label || '' }, grid: { drawOnChartArea: false }, beginAtZero: true };
      new Chart(canvas, {
        type: chartType, data: { labels: cd.labels, datasets },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } }, scales }
      });
    }

    // チャットメッセージを表示
    function renderChatHistory() {
      chatArea.innerHTML = '';
      if (chatHistory.length === 0) {
        chatArea.innerHTML = '<div class="ai-empty-hint">🤖 何でも聞いてください。データに基づいて分析します。</div>';
        return;
      }
      chatHistory.forEach((msg, i) => {
        const bubble = document.createElement('div');
        if (msg.role === 'user') {
          bubble.className = 'ai-msg ai-msg-user';
          bubble.textContent = msg.text;
        } else {
          bubble.className = 'ai-msg ai-msg-ai';
          if (msg.chart) {
            setTimeout(() => renderChartIn(bubble, msg.chart), 50);
          } else if (msg.html) {
            bubble.innerHTML = msg.html;
          } else {
            bubble.textContent = msg.text || '';
          }
        }
        chatArea.appendChild(bubble);
      });
      chatArea.scrollTop = chatArea.scrollHeight;
    }

    // 最新結果を表示（折りたたみ時 + プレビュー用）
    function updatePreviewResult() {
      previewResult.innerHTML = '';
      latestResult.innerHTML = '';
      if (!aiData.lastResult) {
        expandHint.style.display = 'none';
        return;
      }
      expandHint.style.display = '';
      if (aiData.lastResult.chart) {
        setTimeout(() => {
          renderChartIn(latestResult, aiData.lastResult.chart);
          renderChartIn(previewResult, aiData.lastResult.chart);
        }, 50);
      } else if (aiData.lastResult.html) {
        latestResult.innerHTML = aiData.lastResult.html;
        previewResult.innerHTML = aiData.lastResult.html;
      }
    }

    // 初期描画
    renderChatHistory();
    updatePreviewResult();

    // 保存
    async function saveAiBlock() {
      const saveData = JSON.stringify({ messages: chatHistory, lastResult: aiData.lastResult });
      await fetch(`/api/blocks/${block.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: saveData })
      });
    }

    // 送信処理
    async function sendMessage() {
      const prompt = promptInput.value.trim();
      if (!prompt) return;
      promptInput.value = '';

      // ユーザーメッセージ追加
      chatHistory.push({ role: 'user', text: prompt });
      renderChatHistory();

      // ローディング表示
      const loadingEl = document.createElement('div');
      loadingEl.className = 'ai-msg ai-msg-ai ai-msg-loading';
      loadingEl.innerHTML = '<div class="loading-spinner-small"></div><span>分析中...</span>';
      chatArea.appendChild(loadingEl);
      chatArea.scrollTop = chatArea.scrollHeight;
      runBtn.disabled = true;

      try {
        // 会話履歴をAPIに送る（最新メッセージ除く）
        const historyForApi = chatHistory.slice(0, -1).map(m => ({
          role: m.role, text: m.role === 'user' ? m.text : (m.html || m.text || JSON.stringify(m.chart || ''))
        }));

        const res = await fetch('/api/ai-analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, area, history: historyForApi })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'AI分析エラー');

        // AIメッセージ追加
        const aiMsg = { role: 'ai', text: '' };
        if (data.chart) {
          aiMsg.chart = data.chart;
          aiData.lastResult = { chart: data.chart };
        } else {
          aiMsg.html = data.html;
          aiMsg.text = data.html;
          aiData.lastResult = { html: data.html };
        }
        chatHistory.push(aiMsg);
        loadingEl.remove();
        renderChatHistory();
        updatePreviewResult();
        await saveAiBlock();
        showToast('AI分析完了 ✓', 'success');
      } catch(e) {
        loadingEl.remove();
        chatHistory.push({ role: 'ai', text: '', html: `<p style="color:#c62828">❌ ${escHtml(e.message)}</p>` });
        renderChatHistory();
        showToast('AI分析エラー: ' + e.message, 'error');
      } finally {
        runBtn.disabled = false;
        promptInput.focus();
      }
    }

    runBtn.addEventListener('click', sendMessage);
    promptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

  } else if (block.block_type === 'image') {
    const w = block.img_width || 200;
    el.innerHTML = `
      <div class="block-header editor-only">

        <div class="block-ctrl">
          <button class="btn-block-up" title="上へ">↑</button>
          <button class="btn-block-down" title="下へ">↓</button>
          <button class="btn-block-del" title="削除">✕</button>
        </div>
      </div>
      <div class="block-img-wrap">
        <div class="block-img-slider-row">
          <label>サイズ: <input type="range" class="img-size-slider-item" min="80" max="800" step="20" value="${w}"></label>
          <span class="img-size-label-item">${w}px</span>
        </div>
        <img class="block-img" src="/data/uploads/${block.filename}" style="width:${w}px"
             onclick="openModal('/data/uploads/${block.filename}','')">
      </div>
    `;
    const slider = el.querySelector('.img-size-slider-item');
    const label  = el.querySelector('.img-size-label-item');
    const img    = el.querySelector('.block-img');
    let sliderTimer;
    slider.addEventListener('input', () => {
      const sz = parseInt(slider.value);
      label.textContent = sz + 'px';
      img.style.width   = sz + 'px';
      clearTimeout(sliderTimer);
      sliderTimer = setTimeout(() => {
        fetch(`/api/blocks/${block.id}`, {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ img_width: sz })
        });
      }, 600);
    });

  } else {
    // text ブロック (Quill リッチテキストエディタ)
    el.innerHTML = `
      <div class="block-header editor-only">
        <div class="block-ctrl">
          <button class="btn-block-up" title="上へ">↑</button>
          <button class="btn-block-down" title="下へ">↓</button>
          <button class="btn-block-del" title="削除">✕</button>
        </div>
      </div>
      <div class="block-content-wrap">
        <div class="quill-editor-wrap editor-only">
          <div class="quill-editor"></div>
        </div>
        <div class="block-text-preview viewer-text">${block.content || ''}</div>
      </div>
    `;
    const editorWrap = el.querySelector('.quill-editor-wrap');
    const editorDiv  = el.querySelector('.quill-editor');
    const preview    = el.querySelector('.block-text-preview');

    // 表示制御はCSSで行う（inline styleは使わない）

    // Quill初期化（DOMに追加された後に実行する必要がある）
    setTimeout(() => {
      if (!editorDiv.isConnected) return;
      const quill = new Quill(editorDiv, {
        theme: 'snow',
        modules: {
          toolbar: [
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'color': [] }, { 'background': [] }],
            [{ 'size': ['small', false, 'large', 'huge'] }],
            [{ 'list': 'ordered'}, { 'list': 'bullet' }],
            ['clean']
          ]
        },
        placeholder: 'テキストを入力...'
      });
      // 既存コンテンツをセット
      if (block.content) {
        quill.root.innerHTML = block.content;
      }
      // ② ツールバーはフォーカス時のみ表示
      quill.on('selection-change', (range) => {
        if (range) {
          editorWrap.classList.add('ql-focused');
        } else {
          editorWrap.classList.remove('ql-focused');
        }
      });
      // 自動保存 (debounce 1.5秒)
      let _quillTimer;
      quill.on('text-change', () => {
        clearTimeout(_quillTimer);
        _quillTimer = setTimeout(async () => {
          const html = quill.root.innerHTML;
          try {
            await fetch(`/api/blocks/${block.id}`, {
              method: 'PATCH', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ content: html })
            });
            preview.innerHTML = html;
            showToast('自動保存 ✓', 'success');
          } catch(e) {
            showToast('自動保存エラー: ' + e.message, 'error');
          }
        }, 1500);
      });
      el._quill = quill;
    }, 50);
  }

  // 共通コントロール
  const upBtn  = el.querySelector('.btn-block-up');
  const dnBtn  = el.querySelector('.btn-block-down');
  const delBtn = el.querySelector('.btn-block-del');

  if (upBtn)  upBtn.addEventListener('click',  () => moveBlock(block.id, 'up',   area, weekKey));
  if (dnBtn)  dnBtn.addEventListener('click',  () => moveBlock(block.id, 'down', area, weekKey));
  if (delBtn) delBtn.addEventListener('click', () => deleteBlock(block.id, area, weekKey));

  return el;
}

async function addBlock(area, type) {
  const weekKey = getCurrentWeekKey();
  if (!weekKey) { showToast('週を選択してください', 'error'); return; }
  try {
    const res = await fetch('/api/blocks', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ block_type: type, week_key: weekKey, area, content: '' })
    });
    if (!res.ok) { const d = await res.json(); showToast('ブロック追加エラー: ' + (d.error||res.status), 'error'); return; }
    const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
    await loadBlocks(panel, area, weekKey);
  } catch(e) {
    showToast('ブロック追加エラー: ' + e.message, 'error');
  }
}

async function addImageBlock(area, event) {
  const file = event.target.files[0];
  if (!file) return;
  const weekKey = CURRENT_WEEK_KEY || getCurrentWeekKey();
  const formData = new FormData();
  formData.append('block_type', 'image');
  formData.append('week_key',   weekKey);
  formData.append('area',       area);
  formData.append('image',      file);
  await fetch('/api/blocks', { method: 'POST', body: formData });
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  await loadBlocks(panel, area, weekKey);
  event.target.value = '';
}

async function deleteBlock(blockId, area, weekKey) {
  if (!confirm('このブロックを削除しますか？')) return;
  await fetch(`/api/blocks/${blockId}`, { method: 'DELETE' });
  const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
  await loadBlocks(panel, area, weekKey);
}

async function moveBlock(blockId, direction, area, weekKey) {
  const panel     = document.querySelector(`.area-panel[data-area="${area}"]`);
  const container = panel.querySelector('.blocks-container');
  const blocks    = [...container.querySelectorAll('.block')];
  const idx       = blocks.findIndex(b => b.dataset.blockId == blockId);
  if (direction === 'up'   && idx === 0) return;
  if (direction === 'down' && idx === blocks.length - 1) return;

  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  // DOM 順序を swap してから API に送る
  const order = blocks.map((b, i) => ({ id: b.dataset.blockId, order: i }));
  const tmp = order[idx].order;
  order[idx].order = order[newIdx].order;
  order[newIdx].order = tmp;

  await fetch('/api/blocks/reorder', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ order })
  });
  await loadBlocks(panel, area, weekKey);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── モーダル ──────────────────────────────────────────
function openModal(src, caption) {
  document.getElementById('modal-img').src = src;
  document.getElementById('modal-caption').textContent = caption;
  document.getElementById('img-modal').style.display = 'flex';
}
function closeModal() {
  document.getElementById('img-modal').style.display = 'none';
}

// ── 週セレクタ ────────────────────────────────────────
function updateWeekSelector(weekly) {
  const sel = document.getElementById('week-selector');
  const prevKey = CURRENT_WEEK_KEY;  // 現在の選択を保持
  sel.innerHTML = '';
  let hasSelected = false;
  weekly.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.week_key;
    let label = `${w.month_label} W${w.week} (${formatPeriod(w.week_start, w.week_end)})`;
    if (w.is_current) {
      label += ' ◀今週';
      THIS_WEEK_KEY = w.week_key;  // 実際の今週を記録
    }
    if (SNAPSHOT_WEEKS[w.week_key]) label += ' ✅';
    opt.textContent = label;
    // 前回の選択を維持、なければ今週を選択
    if (prevKey && w.week_key === prevKey) {
      opt.selected = true;
      hasSelected = true;
    } else if (!prevKey && w.is_current) {
      opt.selected = true;
      hasSelected = true;
    }
    sel.appendChild(opt);
  });
  if (!hasSelected && sel.options.length > 0) {
    // 前回の選択が見つからなかった場合、今週を探す
    const currOpt = Array.from(sel.options).find(o =>
      weekly.find(w => w.week_key === o.value && w.is_current));
    if (currOpt) currOpt.selected = true;
  }
  CURRENT_WEEK_KEY = sel.value;
  sel.onchange = () => onWeekChange(sel.value);

  // 初回ロード時にボタンラベルとバナーを設定
  updateRefreshButtonLabel();
  updateArchiveBanner();
}

async function onWeekChange(weekKey) {
  // 未保存チェック
  if (CURRENT_AREA && _graphConfigDirty[CURRENT_AREA]) {
    if (!confirm('グラフ設定が未保存です。保存せずに週を変更しますか？')) return;
    _graphConfigDirty[CURRENT_AREA] = false;
  }
  CURRENT_WEEK_KEY = weekKey;
  SNAPSHOT_CACHE = {};  // エリアキャッシュクリア
  TEMPLATE_CACHE = {}; // テンプレートキャッシュクリア
  _graphConfigCache = {}; _graphConfigLoaded = {}; // グラフ設定もクリア

  const hasSnapshot = !!SNAPSHOT_WEEKS[weekKey];
  const isThisWeek = (weekKey === THIS_WEEK_KEY);
  VIEWING_SNAPSHOT = hasSnapshot;
  NO_DATA_MODE = !hasSnapshot;  // スナップショットなし → 今週でも No Data

  // 更新ボタンラベル変更
  updateRefreshButtonLabel();

  // スナップショットバナー更新
  updateArchiveBanner();

  // 週ごとの更新日時を反映
  updateRefreshDisplay();

  if (!CURRENT_AREA) return;

  showLoading(true);
  window._skipWeekSelectorUpdate = true;

  // 全パネルの No Data 状態をクリア（週が変わったため）
  document.querySelectorAll('.area-panel').forEach(p => clearNoData(p));

  if (hasSnapshot) {
    // アーカイブあり: 保存済みデータで全体を再描画
    SNAPSHOT_CACHE = {};
    await loadArchive(CURRENT_AREA, weekKey);
  } else {
    // スナップショットなし: No Data 表示（今週含む）
    ensurePanel(CURRENT_AREA);
    renderNoData(CURRENT_AREA);
  }

  window._skipWeekSelectorUpdate = false;
  showLoading(false);
}

function getCurrentWeekKey() {
  return CURRENT_WEEK_KEY || document.getElementById('week-selector')?.value || '';
}

// ── BQ 最終更新日時 ───────────────────────────────────
let _globalLastRefresh = null;
async function loadRefreshStatus() {
  try {
    const res = await fetch('/api/refresh-status');
    if (!res.ok) return;
    const data = await res.json();
    _globalLastRefresh = data.last_refresh;
    updateRefreshDisplay(data.last_refresh);
  } catch(e) { /* ignore */ }
}

function updateRefreshDisplay(isoStr) {
  const el = document.getElementById('last-refresh-info');
  if (!el) return;

  // 週ごとのスナップショット日時を優先表示
  const wk = CURRENT_WEEK_KEY || '';
  const arch = SNAPSHOT_WEEKS[wk];
  if (arch && arch.created_at) {
    const fmt = new Date(arch.created_at).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    el.textContent = `最終更新: ${fmt}`;
    return;
  }
  // 今週でライブデータの場合
  const src = isoStr || _globalLastRefresh;
  if (wk === THIS_WEEK_KEY && src) {
    const fmt = new Date(src).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    el.textContent = `最終更新: ${fmt}`;
    return;
  }
  el.textContent = '';
}

// ── アーカイブ関連 ──────────────────────────────────────
async function loadArchiveList() {
  try {
    const res = await fetch('/api/snapshot/list');
    const data = await res.json();
    SNAPSHOT_WEEKS = {};
    (data.snapshots || []).forEach(s => {
      SNAPSHOT_WEEKS[s.week_key] = { created_at: s.created_at, created_by: s.created_by };
    });
  } catch(e) { console.warn('archive list error', e); }
}

async function loadArchive(area, weekKey) {
  try {
    const res = await fetch(`/api/snapshot?week_key=${encodeURIComponent(weekKey)}&area=${encodeURIComponent(area)}`);
    const data = await res.json();
    if (data.exists) {
      SNAPSHOT_CACHE[area] = data;
      renderArea(area, data);
    } else {
      // アーカイブなし → ライブデータ表示
      VIEWING_SNAPSHOT = false;
      DATA_CACHE = {};
      await loadSummary(area);
    }
  } catch(e) {
    showToast('データ読込エラー: ' + e.message, 'error');
  }
}

function updateRefreshButtonLabel() {
  const btn = document.getElementById('btn-bq-refresh');
  if (!btn) return;
  btn.textContent = '🔄 更新';
}

function updateArchiveBanner() {
  let banner = document.getElementById('snapshot-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'snapshot-banner';
    const header = document.querySelector('.dashboard-header');
    if (header) header.after(banner);
  }
  const wk = CURRENT_WEEK_KEY || '';
  const arch = SNAPSHOT_WEEKS[wk];
  if (VIEWING_SNAPSHOT && arch) {
    const fmt = new Date(arch.created_at).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit'
    });
    banner.innerHTML = `📂 <strong>${wk}</strong> アーカイブ (${fmt} 保存)`;
    banner.style.display = 'block';
    banner.className = 'snapshot-banner archive';
  } else if (NO_DATA_MODE && wk) {
    banner.innerHTML = `⚠️ <strong>${wk}</strong> — アーカイブなし（「🔄 更新」で保存できます）`;
    banner.style.display = 'block';
    banner.className = 'snapshot-banner no-data';
  } else if (!VIEWING_SNAPSHOT && wk) {
    banner.innerHTML = `📝 <strong>${wk}</strong> — ライブデータ（今週）`;
    banner.style.display = 'block';
    banner.className = 'snapshot-banner live';
  } else {
    banner.style.display = 'none';
  }
}

function applyArchiveModeUI(panel) {
  if (!panel) return;
  const isCurrentWeekSnapshot = VIEWING_SNAPSHOT && (CURRENT_WEEK_KEY === THIS_WEEK_KEY);
  if ((VIEWING_SNAPSHOT && !isCurrentWeekSnapshot) || NO_DATA_MODE) {
    // アーカイブ閲覧中: 見込み入力を無効化
    panel.querySelectorAll('.prospect-input').forEach(inp => {
      inp.disabled = true;
      inp.style.background = '#f0f0f0';
    });
    const saveBtn = panel.querySelector('.btn-save-all-prospects');
    if (saveBtn) saveBtn.style.display = 'none';
    const predictBtn = panel.querySelector('.btn-predict-prospects');
    if (predictBtn) predictBtn.style.display = 'none';
    const addBar = panel.querySelector('.add-block-bar');
    if (addBar) addBar.style.display = 'none';
  } else {
    // ライブモード: 編集者は入力可能
    if (isEditor()) {
      panel.querySelectorAll('.prospect-input').forEach(inp => {
        if (inp.dataset.editable !== 'false') {
          inp.disabled = false;
          inp.style.background = '';
        }
      });
      const saveBtn = panel.querySelector('.btn-save-all-prospects');
      if (saveBtn) saveBtn.style.display = '';
      const predictBtn = panel.querySelector('.btn-predict-prospects');
      if (predictBtn) predictBtn.style.display = '';
      const addBar = panel.querySelector('.add-block-bar');
      if (addBar) addBar.style.display = '';
    }
  }
}

function highlightSelectedWeek(panel, weekKey) {
  if (!panel) return;
  panel.querySelectorAll('tr[data-week-key]').forEach(tr => {
    tr.classList.toggle('selected-week', tr.dataset.weekKey === weekKey);
  });
}

// ── データ更新（編集者のみ）─────────────────────────────
// 「更新」= BQデータ再取得 + 今週のアーカイブに自動保存
async function triggerRefresh() {
  const weekKey = CURRENT_WEEK_KEY;
  if (!weekKey) {
    showToast('週を選択してください', 'error');
    return;
  }

  // 同じ週のアーカイブがあれば上書き確認
  const existing = SNAPSHOT_WEEKS[weekKey];
  if (existing) {
    const fmt = new Date(existing.created_at).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit'
    });
    const ok = confirm(`${weekKey} は ${fmt} に更新済みです。\n再度更新しますか？`);
    if (!ok) return;
  }

  const btn = document.getElementById('btn-bq-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }

  try {
    const res = await fetch('/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_key: weekKey }),
    });
    const data = await res.json();
    if (data.ok) {
      // アーカイブ一覧を更新
      SNAPSHOT_WEEKS[weekKey] = { created_at: data.created_at, created_by: data.refreshed_by };
      SNAPSHOT_CACHE = {};
      DATA_CACHE = {};
      VIEWING_SNAPSHOT = true;
      NO_DATA_MODE = false;

      updateRefreshDisplay(data.last_refresh);
      updateArchiveBanner();

      // 週セレクターの ✅ マーク更新
      const sel = document.getElementById('week-selector');
      if (sel) {
        const opt = sel.querySelector(`option[value="${weekKey}"]`);
        if (opt && !opt.textContent.includes('✅')) opt.textContent += ' ✅';
      }

      // アーカイブから再描画
      showLoading(true);
      await loadArchive(CURRENT_AREA, weekKey);
      showLoading(false);
      showToast(`${weekKey} データを更新・保存しました ✓`, 'success');
    } else {
      showToast('更新失敗: ' + (data.error || ''), 'error');
    }
  } catch(e) {
    showToast('更新エラー: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 更新'; }
  }
}

// ── プレビューモード ───────────────────────────────────
function togglePreviewMode() {
  // 未保存チェック
  if (CURRENT_AREA && _graphConfigDirty[CURRENT_AREA] && !PREVIEW_MODE) {
    if (!confirm('グラフ設定が未保存です。保存せずにプレビューに切り替えますか？')) return;
    _graphConfigDirty[CURRENT_AREA] = false;
  }
  PREVIEW_MODE = !PREVIEW_MODE;
  document.body.classList.toggle('preview-mode', PREVIEW_MODE);
  document.body.classList.toggle('edit-mode', !PREVIEW_MODE);
  const btn = document.getElementById('btn-preview-toggle');
  if (btn) btn.textContent = PREVIEW_MODE ? '✏️ 編集モードへ' : '👁 プレビューモードへ';
  // ヘッダー赤 + 「編集モード」表示
  const header = document.querySelector('.app-header');
  if (header) header.classList.toggle('editing', !PREVIEW_MODE);
  const badge = document.getElementById('edit-mode-badge');
  if (badge) badge.style.display = PREVIEW_MODE ? 'none' : '';
  // プレビュー切り替え時にテンプレートを再描画 (設定反映)
  if (PREVIEW_MODE && CURRENT_AREA) {
    TEMPLATE_CACHE[CURRENT_AREA] = null;
    const panel = document.querySelector(`.area-panel[data-area="${CURRENT_AREA}"]`);
    if (panel) _loadAndRenderGraphBlocks(panel, CURRENT_AREA);
  }
}

// ── グラフブロック (左パネル内カスタマイズ) ──────────────────
let TEMPLATE_CACHE = {}; // area -> template data from API

async function loadTemplateData(area) {
  const mw = CURRENT_WEEK_KEY ? `&meeting_week=${encodeURIComponent(CURRENT_WEEK_KEY)}` : '';
  try {
    const res = await fetch(`/api/template-data?area=${encodeURIComponent(area)}${mw}`);
    const data = await res.json();
    TEMPLATE_CACHE[area] = data;
    return data;
  } catch(e) { console.warn('Template data load error:', e); return null; }
}

// テンプレート描画関数マップ
const TPL_RENDERERS = {
  shipper_increase_curr: (d,p) => d.shipper_increase_curr?.items?.length > 0 ? _renderShipperTop(d.shipper_increase_curr, 'increase', '当月') : null,
  shipper_increase_next: (d,p) => d.shipper_increase_next?.items?.length > 0 ? _renderShipperTop(d.shipper_increase_next, 'increase', '翌月') : null,
  shipper_decrease_curr: (d,p) => d.shipper_decrease_curr?.items?.length > 0 ? _renderShipperTop(d.shipper_decrease_curr, 'decrease', '当月') : null,
  shipper_decrease_next: (d,p) => d.shipper_decrease_next?.items?.length > 0 ? _renderShipperTop(d.shipper_decrease_next, 'decrease', '翌月') : null,
  cm1_range:          (d,p) => d.cm1_range && Object.keys(d.cm1_range).length > 0 ? _renderCM1Range(d.cm1_range) : null,
  new_customer:       (d,p) => d.new_customer ? _renderNewCustomer(d.new_customer) : null,
  regain_customer:    (d,p) => d.regain_customer ? _renderRegainCustomer(d.regain_customer) : null,
  trade_lane:         (d,p) => d.trade_lane?.data?.length > 0 ? _renderTradeLane(d.trade_lane) : null,
  cm1_waterfall:      (d,p) => d.cm1_waterfall?.prev_cm1t != null ? _renderCM1Waterfall(d.cm1_waterfall, p) : null,
  booking_count:      (d,p) => d.booking_count ? _renderBookingCount(d.booking_count, p) : null,
  pol_count:          (d,p) => d.pol_count?.length > 0 ? _renderPOLCount(d.pol_count) : null,
  sales_contribution: (d,p) => d.sales_contribution && Object.keys(d.sales_contribution).length > 0 ? _renderSalesContribution(d.sales_contribution) : null,
};

/**
 * 左パネル内のグラフブロックをロード&描画
 * - 編集者「グラフ」タブ: 自由にカスタマイズ可能
 * - プレビュー / 閲覧者: 設定に基づいて表示
 */
async function _loadAndRenderGraphBlocks(panel, area) {
  try {
    const weekKey = CURRENT_WEEK_KEY || '';
    // 設定を取得
    if (!_graphConfigCache[area]) {
      try {
        const cfgRes = await fetch(`/api/template-config?week_key=${encodeURIComponent(weekKey)}&area=${encodeURIComponent(area)}`);
        const cfgData = await cfgRes.json();
        _graphConfigCache[area] = cfgData.blocks || [];
        _graphConfigLoaded[area] = true;
      } catch(e) { _graphConfigCache[area] = []; }
    }
    // テンプレートデータ取得
    if (!TEMPLATE_CACHE[area]) await loadTemplateData(area);
    const tplData = TEMPLATE_CACHE[area];
    if (!tplData) return;

    // グラフ設定パネル描画 (編集者のみ)
    if (isEditor() && _graphConfigLoaded[area]) {
      _renderGraphCanvas(panel, area, tplData);
    }
    // プレビュー用描画 (左パネルのgraph-preview-areaに描画)
    _renderGraphPreview(panel, area, tplData);
  } catch(e) {
    console.warn('Graph blocks error:', e);
  }
}

/**
 * 「グラフ」タブ: ブロックを自由配置・リサイズ可能なキャンバス
 */
const GC_SNAP = 10; // スナップグリッド間隔 (px)

function _snapTo(v) { return Math.round(v / GC_SNAP) * GC_SNAP; }

function _renderGraphCanvas(panel, area, tplData) {
  const container = panel.querySelector('.graph-config-list');
  if (!container) return;
  container.innerHTML = '';

  const blocks = _graphConfigCache[area] || [];
  // 初回: x,yが未設定なら自動配置
  _autoLayoutBlocks(blocks, container);

  // 各ブロックを描画
  blocks.forEach((block, idx) => {
    const def = TEMPLATE_DEFS.find(d => d.id === block.id);
    if (!def) return;
    const renderer = TPL_RENDERERS[block.id];
    if (!renderer) return;
    const content = renderer(tplData, panel);
    if (!content) return;

    const wrapper = _createResizableBlock(block, def, content, idx, area, panel, tplData);
    container.appendChild(wrapper);
  });

  // コンテナ高さ更新
  _updateCanvasHeight(container, blocks);

  // DOM追加完了後: 遅延描画が必要なチャートを描画
  const pendingB = window._pendingBookingCharts; window._pendingBookingCharts = null;
  const pendingD = window._pendingSalesDonut; window._pendingSalesDonut = null;
  setTimeout(() => { _flushPendingCharts(container, pendingB, pendingD); }, 150);

  // 「＋ グラフ追加」ボタン (absolute配置の外に固定配置)
  const addBar = document.createElement('div');
  addBar.className = 'gc-add-bar';
  addBar.style.position = 'absolute';
  addBar.style.zIndex = '10';
  addBar.style.left = '0'; addBar.style.right = '0';
  addBar.innerHTML = `<button class="gc-add-btn">＋ グラフ追加</button><div class="gc-add-dropdown" style="display:none"></div>`;
  container.appendChild(addBar);

  const btn = addBar.querySelector('.gc-add-btn');
  const dropdown = addBar.querySelector('.gc-add-dropdown');
  btn.addEventListener('click', () => {
    const usedIds = new Set(blocks.map(b => b.id));
    dropdown.innerHTML = '';
    const available = TEMPLATE_DEFS.filter(d => !usedIds.has(d.id));
    if (available.length === 0) {
      dropdown.innerHTML = '<div class="gc-dd-item disabled">すべて追加済み</div>';
    } else {
      available.forEach(def => {
        const item = document.createElement('div');
        item.className = 'gc-dd-item';
        item.textContent = def.label;
        item.addEventListener('click', () => {
          // 空きスペースに新ブロックを配置
          const newBlock = { id: def.id, enabled: true, width: 340, height: 250, x: 0, y: 0 };
          _findEmptySpot(blocks, newBlock, container);
          blocks.push(newBlock);
          _graphConfigDirty[area] = true;
          dropdown.style.display = 'none';
          _renderGraphCanvas(panel, area, tplData);
        });
        dropdown.appendChild(item);
      });
    }
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!addBar.contains(e.target)) dropdown.style.display = 'none';
  }, { once: false });
}

/**
 * x,y が未設定のブロックを自動レイアウト (上から順に詰める)
 */
function _autoLayoutBlocks(blocks, container) {
  const cw = container.clientWidth || 600;
  let curX = 0, curY = 0, rowH = 0;
  blocks.forEach(b => {
    if (b.x != null && b.y != null) return; // 既に位置設定済み
    const bw = b.width || 340;
    const bh = b.height || 250;
    if (curX + bw > cw && curX > 0) { curX = 0; curY += rowH + GC_SNAP; rowH = 0; }
    b.x = _snapTo(curX); b.y = _snapTo(curY);
    curX += bw + GC_SNAP;
    rowH = Math.max(rowH, bh);
  });
}

/**
 * 新規ブロックの空きスペースを探す
 */
function _findEmptySpot(blocks, newBlock, container) {
  const cw = container.clientWidth || 600;
  let maxBottom = 0;
  blocks.forEach(b => { maxBottom = Math.max(maxBottom, (b.y||0) + (b.height||250)); });
  newBlock.x = 0;
  newBlock.y = _snapTo(maxBottom + GC_SNAP);
}

/**
 * キャンバスの高さを全ブロックの最下端に合わせ、追加ボタンを配置
 */
function _updateCanvasHeight(container, blocks) {
  let maxBottom = 50;
  blocks.forEach(b => { maxBottom = Math.max(maxBottom, (b.y||0) + (b.height||250)); });
  const addBarTop = maxBottom + 10;
  container.style.minHeight = (addBarTop + 50) + 'px';
  const addBar = container.querySelector('.gc-add-bar');
  if (addBar) addBar.style.top = addBarTop + 'px';
}

/**
 * リサイズ・自由配置対応ブロックを生成
 */
const GC_MIN_W = 200;
const GC_MIN_H = 130;

function _createResizableBlock(block, def, content, idx, area, panel, tplData) {
  const wrapper = document.createElement('div');
  wrapper.className = 'gc-block';
  wrapper.dataset.idx = idx;
  // 自由配置: absolute position
  wrapper.style.left = (block.x || 0) + 'px';
  wrapper.style.top  = (block.y || 0) + 'px';
  wrapper.style.width  = (block.width || 340) + 'px';
  wrapper.style.height = (block.height || 250) + 'px';

  // ヘッダー (カード内の動的タイトルを優先)
  const dynamicTitle = content.querySelector('.card-header')?.textContent?.trim() || def.label;
  const header = document.createElement('div');
  header.className = 'gc-block-header';
  header.innerHTML = `
    <span class="gc-block-drag" title="ドラッグで自由配置">⠿</span>
    <span class="gc-block-title">${escHtml(dynamicTitle)}</span>
    <button class="gc-block-del" title="削除">✕</button>
  `;
  wrapper.appendChild(header);

  // コンテンツ
  const body = document.createElement('div');
  body.className = 'gc-block-body';
  const innerBody = content.querySelector('.card-body');
  if (innerBody) {
    // DOM ノードを直接移動（innerHTML コピーだと canvas 等が壊れる）
    while (innerBody.firstChild) body.appendChild(innerBody.firstChild);
  } else {
    body.appendChild(content);
  }
  wrapper.appendChild(body);

  // リサイズハンドル: 下辺(H)、右辺(W)、コーナー(W+H)
  const rH = document.createElement('div'); rH.className = 'gc-resize-h';
  const rW = document.createElement('div'); rW.className = 'gc-resize-w';
  const rC = document.createElement('div'); rC.className = 'gc-resize-corner';
  wrapper.appendChild(rH);
  wrapper.appendChild(rW);
  wrapper.appendChild(rC);

  // ── リサイズ共通 ──
  function _startResize(e, resizeW, resizeH) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = wrapper.offsetWidth, startHt = wrapper.offsetHeight;
    wrapper.classList.add('resizing');

    const onMove = (ev) => {
      if (resizeW) {
        const nw = Math.max(GC_MIN_W, _snapTo(startW + ev.clientX - startX));
        wrapper.style.width = nw + 'px';
      }
      if (resizeH) {
        const nh = Math.max(GC_MIN_H, _snapTo(startHt + ev.clientY - startY));
        wrapper.style.height = nh + 'px';
      }
      _updateBlockFontSize(wrapper);
    };
    const onUp = () => {
      wrapper.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      block.height = wrapper.offsetHeight;
      block.width = wrapper.offsetWidth;
      _graphConfigDirty[area] = true;
      _updateBlockOverflow(wrapper);
      _updateCanvasHeight(wrapper.parentElement, _graphConfigCache[area] || []);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  rH.addEventListener('mousedown', (e) => _startResize(e, false, true));
  rW.addEventListener('mousedown', (e) => _startResize(e, true, false));
  rC.addEventListener('mousedown', (e) => _startResize(e, true, true));

  // ── 自由ドラッグ移動 ──
  header.addEventListener('mousedown', (e) => {
    // 削除ボタンは除外
    if (e.target.closest('.gc-block-del')) return;
    e.preventDefault();
    const container = wrapper.parentElement;
    const startMX = e.clientX, startMY = e.clientY;
    const startL = parseInt(wrapper.style.left) || 0;
    const startT = parseInt(wrapper.style.top) || 0;
    wrapper.classList.add('gc-moving');
    container.classList.add('gc-dragging-active');

    const onMove = (ev) => {
      const nx = _snapTo(Math.max(0, startL + ev.clientX - startMX));
      const ny = _snapTo(Math.max(0, startT + ev.clientY - startMY));
      wrapper.style.left = nx + 'px';
      wrapper.style.top  = ny + 'px';
    };
    const onUp = () => {
      wrapper.classList.remove('gc-moving');
      container.classList.remove('gc-dragging-active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      block.x = parseInt(wrapper.style.left) || 0;
      block.y = parseInt(wrapper.style.top)  || 0;
      _graphConfigDirty[area] = true;
      _updateCanvasHeight(container, _graphConfigCache[area] || []);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── 削除 ──
  header.querySelector('.gc-block-del').addEventListener('click', () => {
    const blocks = _graphConfigCache[area];
    blocks.splice(idx, 1);
    _graphConfigDirty[area] = true;
    _renderGraphCanvas(panel, area, tplData);
  });

  // ── テーブル列幅リサイズ ──
  requestAnimationFrame(() => {
    _enableColumnResize(wrapper, block, area);
    _updateBlockFontSize(wrapper);
    _updateBlockOverflow(wrapper);
  });

  return wrapper;
}

/**
 * テーブルのカラム幅をドラッグで調整可能にする
 * colWidths を block config に保存 (テーブルごとにキーを分ける)
 */
function _enableColumnResize(wrapper, block, area) {
  const tables = wrapper.querySelectorAll('.tpl-table');
  tables.forEach((table, tblIdx) => {
    const ths = table.querySelectorAll('thead th');
    if (ths.length < 2) return;

    // 既存の colWidths を適用
    const key = `colWidths_${tblIdx}`;
    if (block[key] && block[key].length === ths.length) {
      _applyColWidths(table, block[key]);
    }

    // 各 th の右端にリサイズハンドルを追加 (全列対応)
    ths.forEach((th, colIdx) => {
      const handle = document.createElement('div');
      handle.className = 'gc-col-resizer';
      th.appendChild(handle);

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        handle.classList.add('active');
        const startX = e.clientX;
        const tw = table.offsetWidth;
        const widths = Array.from(ths).map(h => h.offsetWidth / tw * 100);
        // 最後の列: 前の列と幅を交換 / それ以外: 次の列と交換
        const isLast = colIdx >= ths.length - 1;
        const pairIdx = isLast ? colIdx - 1 : colIdx + 1;

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dPct = dx / tw * 100;
          const newWidths = [...widths];
          if (isLast) {
            // 最後の列: 差分を他の全列に均等分配 (1列だけ膨らまない)
            const newW = Math.max(5, widths[colIdx] + dPct);
            const diff = newW - widths[colIdx]; // 実際の変化量
            newWidths[colIdx] = newW;
            // 他列に均等分配
            const others = [];
            for (let i = 0; i < widths.length; i++) { if (i !== colIdx) others.push(i); }
            const share = diff / others.length;
            others.forEach(i => { newWidths[i] = Math.max(5, widths[i] - share); });
          } else {
            newWidths[colIdx]  = Math.max(5, widths[colIdx] + dPct);
            newWidths[pairIdx] = Math.max(5, widths[pairIdx] - dPct);
          }
          _applyColWidths(table, newWidths);
        };
        const onUp = () => {
          handle.classList.remove('active');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const finalWidths = Array.from(ths).map(h => h.offsetWidth / table.offsetWidth * 100);
          block[key] = finalWidths.map(w => Math.round(w * 10) / 10);
          _graphConfigDirty[area] = true;
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  });
}

function _applyColWidths(table, widths) {
  let colgroup = table.querySelector('colgroup');
  if (!colgroup) {
    colgroup = document.createElement('colgroup');
    table.insertBefore(colgroup, table.firstChild);
  }
  colgroup.innerHTML = '';
  widths.forEach(w => {
    const col = document.createElement('col');
    col.style.width = w + '%';
    colgroup.appendChild(col);
  });
}

/**
 * ブロック幅に応じてCSS変数でフォントサイズを動的調整
 * MIN_FONT 以下には縮小しない→スクロール
 */
const GC_MIN_FONT = 12;   // 最小フォントサイズ (px)
const GC_MAX_FONT = 14;   // 最大フォントサイズ (px)

function _updateBlockFontSize(wrapper) {
  const w = wrapper.offsetWidth;
  // 幅200px→MIN, 幅500px以上→MAX (線形補間)
  const range = GC_MAX_FONT - GC_MIN_FONT;
  const base = Math.max(GC_MIN_FONT, Math.min(GC_MAX_FONT, GC_MIN_FONT + (w - 200) * range / 300));
  const sm = Math.max(GC_MIN_FONT - 1, base - 1);
  const lg = base + 1;
  wrapper.style.setProperty('--gc-font', base.toFixed(1) + 'px');
  wrapper.style.setProperty('--gc-font-sm', sm.toFixed(1) + 'px');
  wrapper.style.setProperty('--gc-font-lg', lg.toFixed(1) + 'px');
}

/**
 * コンテンツが収まらない場合のみスクロール有効化
 */
function _updateBlockOverflow(wrapper) {
  const body = wrapper.querySelector('.gc-block-body');
  if (!body) return;
  // 一旦hidden → はみ出しチェック
  body.classList.remove('needs-scroll');
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 4) {
      body.classList.add('needs-scroll');
    }
  });
}

/**
 * プレビュー/閲覧者: 左パネル内にグラフブロックを表示
 */
function _renderGraphPreview(panel, area, tplData) {
  let previewArea = panel.querySelector('.graph-preview-area');
  if (!previewArea) {
    previewArea = document.createElement('div');
    previewArea.className = 'graph-preview-area';
    const graphPanel = panel.querySelector('.graph-config-panel');
    if (graphPanel) graphPanel.parentNode.insertBefore(previewArea, graphPanel.nextSibling);
    else {
      const leftCard = panel.querySelector('.left-panel-card');
      if (leftCard) leftCard.appendChild(previewArea);
    }
  }
  previewArea.innerHTML = '';
  if (!tplData) return;

  // 編集モードと同じ absolute 配置でブロックを描画
  previewArea.style.position = 'relative';

  const blocks = (_graphConfigCache[area] || []).filter(b => b.enabled !== false);
  if (blocks.length === 0) {
    TEMPLATE_DEFS.filter(d => d.default_on).forEach(def => {
      blocks.push({ id: def.id, width: 340, height: 250, x: 0, y: 0 });
    });
    _autoLayoutBlocks(blocks, previewArea);
  }

  let maxBottom = 50;
  for (const block of blocks) {
    const def = TEMPLATE_DEFS.find(d => d.id === block.id);
    const renderer = TPL_RENDERERS[block.id];
    if (!renderer) continue;
    const card = renderer(tplData, panel);
    if (!card) continue;

    // absolute 配置 (編集モードと同じ位置・サイズ)
    const wrapper = document.createElement('div');
    wrapper.className = 'gp-block';
    wrapper.style.position = 'absolute';
    wrapper.style.left   = (block.x || 0) + 'px';
    wrapper.style.top    = (block.y || 0) + 'px';
    wrapper.style.width  = (block.width || 340) + 'px';
    wrapper.style.height = (block.height || 250) + 'px';
    wrapper.style.overflow = 'auto';
    wrapper.style.background = '#fff';
    wrapper.style.borderRadius = '6px';
    wrapper.style.border = '1px solid #e0e0e0';
    wrapper.style.boxSizing = 'border-box';

    // タイトル (カード内の動的タイトルを優先)
    const dynamicTitle = card.querySelector('.card-header')?.textContent?.trim() || (def ? def.label : block.id);
    const titleEl = document.createElement('div');
    titleEl.className = 'gp-block-title';
    titleEl.textContent = dynamicTitle;
    wrapper.appendChild(titleEl);

    // card をそのまま wrapper に追加（innerHTML移動だと canvas/chart が壊れる）
    card.style.border = 'none';
    card.style.boxShadow = 'none';
    card.style.margin = '0';
    card.style.padding = '0';
    // card-header（_tplCard のタイトル）は非表示（wrapper のタイトルを使う）
    const cardHeader = card.querySelector('.card-header');
    if (cardHeader) cardHeader.style.display = 'none';
    wrapper.appendChild(card);

    // カラム幅を適用
    const tables = wrapper.querySelectorAll('.tpl-table');
    tables.forEach((table, tblIdx) => {
      const key = `colWidths_${tblIdx}`;
      if (block[key]) _applyColWidths(table, block[key]);
    });

    previewArea.appendChild(wrapper);
    maxBottom = Math.max(maxBottom, (block.y || 0) + (block.height || 250));
  }

  previewArea.style.minHeight = (maxBottom + 10) + 'px';

  // 遅延描画が必要なチャートを描画（ローカルにキャプチャしてからflush）
  const pendingB = window._pendingBookingCharts; window._pendingBookingCharts = null;
  const pendingD = window._pendingSalesDonut; window._pendingSalesDonut = null;
  setTimeout(() => { _flushPendingCharts(previewArea, pendingB, pendingD); }, 150);
}


// ── グラフ設定: 保存・伝播 ──────────────────────────────

async function loadGraphConfig(panel, area) {
  const weekKey = CURRENT_WEEK_KEY || '';
  try {
    const res = await fetch(`/api/template-config?week_key=${encodeURIComponent(weekKey)}&area=${encodeURIComponent(area)}`);
    const data = await res.json();
    _graphConfigCache[area] = data.blocks || [];
    _graphConfigLoaded[area] = true;
    _graphConfigDirty[area] = false;
    // キャンバスを即座に描画
    const tplData = TEMPLATE_CACHE[area] || await loadTemplateData(area);
    if (tplData) _renderGraphCanvas(panel, area, tplData);
  } catch(e) { console.warn('Graph config load error:', e); }
}

async function saveGraphConfig(area) {
  const weekKey = CURRENT_WEEK_KEY || '';
  const blocks = _graphConfigCache[area] || [];
  try {
    await fetch('/api/template-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_key: weekKey, area, blocks }),
    });
    _graphConfigDirty[area] = false;
    showToast('グラフ設定を保存しました', 'success');
    // プレビュー再描画
    TEMPLATE_CACHE[area] = null;
    const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
    if (panel) {
      const tplData = await loadTemplateData(area);
      if (tplData) _renderGraphPreview(panel, area, tplData);
    }
  } catch(e) {
    showToast('設定保存エラー: ' + e.message, 'error');
  }
}

// ── Template ダイアログ (保存/読み込み) ──────────────────

async function openTemplateDialog(area) {
  const blocks = _graphConfigCache[area] || [];
  if (_graphConfigDirty[area]) { showToast('先に Save を押してください', 'error'); return; }

  let modal = document.getElementById('template-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'template-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="closeTemplateDialog()"></div>
      <div class="modal-content" style="max-width:460px">
        <button class="modal-close" onclick="closeTemplateDialog()">✕</button>
        <h3 style="margin-bottom:14px">Template</h3>
        <div class="tpl-dialog-section">
          <label style="font-weight:600;font-size:13px">現在のスタイルを保存:</label>
          <div style="display:flex;gap:6px;margin-top:6px">
            <input id="tpl-save-name" type="text" placeholder="テンプレート名" style="flex:1;padding:5px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px">
            <button id="tpl-save-btn" style="padding:5px 12px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:pointer;font-size:12px">Save</button>
          </div>
        </div>
        <hr style="margin:14px 0;border:none;border-top:1px solid #e0e0e0">
        <div class="tpl-dialog-section">
          <label style="font-weight:600;font-size:13px">保存済みテンプレートから読み込み:</label>
          <div id="tpl-list" style="margin-top:8px;max-height:200px;overflow-y:auto"></div>
        </div>
        <div id="tpl-preview" style="display:none;margin-top:10px;border:1px solid #e0e0e0;border-radius:6px;padding:8px;background:#fafafa">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <label style="font-weight:600;font-size:12px;color:#555">Preview: <span id="tpl-preview-name"></span></label>
            <button id="tpl-preview-close" style="border:none;background:none;cursor:pointer;color:#999;font-size:13px">✕</button>
          </div>
          <div id="tpl-preview-blocks" style="display:flex;flex-wrap:wrap;gap:4px;min-height:40px"></div>
        </div>
        <div id="tpl-msg" style="margin-top:10px;font-size:12px;color:#666"></div>
      </div>`;
    document.body.appendChild(modal);
  }

  document.getElementById('tpl-save-name').value = '';
  document.getElementById('tpl-msg').textContent = '';
  document.getElementById('tpl-preview').style.display = 'none';
  modal.style.display = 'flex';

  // プレビュー閉じるボタン
  document.getElementById('tpl-preview-close').onclick = () => {
    document.getElementById('tpl-preview').style.display = 'none';
  };

  // Save ボタン
  document.getElementById('tpl-save-btn').onclick = async () => {
    const name = document.getElementById('tpl-save-name').value.trim();
    if (!name) { showToast('テンプレート名を入力してください', 'error'); return; }
    try {
      await fetch('/api/style-templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, blocks }),
      });
      showToast(`"${name}" を保存しました`, 'success');
      _loadTemplateList(area); // 一覧を更新
      document.getElementById('tpl-save-name').value = '';
    } catch(e) { showToast('保存エラー: ' + e.message, 'error'); }
  };

  // 一覧読み込み
  _loadTemplateList(area);
}

async function _loadTemplateList(area) {
  const listEl = document.getElementById('tpl-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="color:#999;font-size:12px">読み込み中...</div>';
  try {
    const res = await fetch('/api/style-templates');
    const templates = await res.json();
    if (templates.length === 0) {
      listEl.innerHTML = '<div style="color:#999;font-size:12px">保存済みテンプレートはありません</div>';
      return;
    }
    listEl.innerHTML = '';
    const myEmail = CURRENT_USER?.email || '';
    const mine = templates.filter(t => t.created_by === myEmail);
    const others = templates.filter(t => t.created_by !== myEmail);

    const renderGroup = (label, list, canDelete) => {
      if (list.length === 0) return;
      const header = document.createElement('div');
      header.style.cssText = 'font-size:11px;font-weight:700;color:#888;padding:4px 8px;background:#f7f8fa;border-bottom:1px solid #eee';
      header.textContent = label;
      listEl.appendChild(header);
      list.forEach(tpl => _renderTemplateRow(listEl, tpl, area, canDelete));
    };
    renderGroup('My Templates', mine, true);
    renderGroup('Others', others, false);
  } catch(e) { listEl.innerHTML = `<div style="color:red;font-size:12px">Error: ${e.message}</div>`; }
}

function _renderTemplateRow(container, tpl, area, canDelete) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid #f0f0f0;font-size:12px';
  const creator = (tpl.created_by || '').replace(/@.*/, '');
  const defBadge = tpl.is_default ? '<span style="color:#e67e22;font-size:10px;font-weight:700" title="デフォルトテンプレート">★ DEFAULT</span>' : '';
  const isMine = canDelete;  // canDelete = 自分のテンプレート
  const defBtnHtml = isMine
    ? (tpl.is_default
      ? `<button class="tpl-def-btn" data-action="unset" style="padding:2px 6px;border:1px solid #e67e22;border-radius:3px;background:#fff7ed;cursor:pointer;font-size:10px;color:#e67e22" title="デフォルト解除">★</button>`
      : `<button class="tpl-def-btn" data-action="set" style="padding:2px 6px;border:1px solid var(--border);border-radius:3px;background:#fff;cursor:pointer;font-size:10px;color:#999" title="デフォルトに設定">☆</button>`)
    : '';
  // ★DEFAULTテンプレートは削除不可
  const showDelete = isMine && !tpl.is_default;
  row.innerHTML = `
    <span class="tpl-name-link" style="flex:1;font-weight:600;cursor:pointer;color:#1a6fc4;text-decoration:underline" title="クリックでプレビュー">${escHtml(tpl.name)}</span>
    ${defBadge}
    <span style="color:#aaa;font-size:10px">${escHtml(creator)}</span>
    <span style="color:#999;font-size:10px">${tpl.block_count}blk</span>
    ${defBtnHtml}
    <button class="tpl-load-btn" style="padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:pointer;font-size:11px">Load</button>
    ${isMine && !tpl.is_default ? '<button class="tpl-del-btn" style="padding:2px 5px;border:none;background:none;cursor:pointer;color:#bbb;font-size:13px" title="削除">✕</button>' : ''}
  `;
  // プレビュー
  row.querySelector('.tpl-name-link').addEventListener('click', () => _showTemplatePreview(tpl.id, tpl.name));
  // Load
  row.querySelector('.tpl-load-btn').addEventListener('click', async () => {
    try {
      const r = await fetch(`/api/style-templates/${tpl.id}`);
      const data = await r.json();
      _graphConfigCache[area] = data.blocks || [];
      _graphConfigDirty[area] = true;
      closeTemplateDialog();
      showToast(`"${tpl.name}" を読み込みました。Save で確定してください`, 'success');
      const panel = document.querySelector(`.area-panel[data-area="${area}"]`);
      if (panel) {
        const tplData = TEMPLATE_CACHE[area];
        if (tplData) _renderGraphCanvas(panel, area, tplData);
      }
    } catch(e) { showToast('読み込みエラー: ' + e.message, 'error'); }
  });
  // Delete (自分のテンプレートのみ)
  const delBtn = row.querySelector('.tpl-del-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`"${tpl.name}" を削除しますか？`)) return;
      try {
        await fetch(`/api/style-templates/${tpl.id}`, { method: 'DELETE' });
        _loadTemplateList(area);
      } catch(e) { showToast('削除エラー: ' + e.message, 'error'); }
    });
  }
  // ★ デフォルト設定/解除ボタン
  const defBtn = row.querySelector('.tpl-def-btn');
  if (defBtn) {
    defBtn.addEventListener('click', async () => {
      const action = defBtn.dataset.action; // "set" or "unset"
      const endpoint = action === 'set' ? 'set-default' : 'unset-default';
      try {
        await fetch(`/api/style-templates/${tpl.id}/${endpoint}`, { method: 'POST' });
        showToast(action === 'set' ? `"${tpl.name}" をデフォルトに設定しました` : 'デフォルトを解除しました', 'success');
        _loadTemplateList(area);
      } catch(e) { showToast('エラー: ' + e.message, 'error'); }
    });
  }
  container.appendChild(row);
}

function closeTemplateDialog() {
  const m = document.getElementById('template-modal'); if (m) m.style.display = 'none';
}

/**
 * テンプレートのミニプレビューを表示
 * ブロックのレイアウト（位置・サイズ比率）をミニチュアで再現
 */
async function _showTemplatePreview(tplId, tplName) {
  const previewEl = document.getElementById('tpl-preview');
  const nameEl = document.getElementById('tpl-preview-name');
  const blocksEl = document.getElementById('tpl-preview-blocks');
  if (!previewEl || !blocksEl) return;

  nameEl.textContent = tplName;
  blocksEl.innerHTML = '<span style="color:#999;font-size:11px">読み込み中...</span>';
  previewEl.style.display = 'block';

  try {
    const res = await fetch(`/api/style-templates/${tplId}`);
    const data = await res.json();
    const blocks = data.blocks || [];
    if (blocks.length === 0) {
      blocksEl.innerHTML = '<span style="color:#999;font-size:11px">ブロックなし</span>';
      return;
    }

    // ミニチュアレイアウト: 実際の配置をスケールダウンして再現
    const SCALE = 0.25;
    const maxW = blocks.reduce((mx, b) => Math.max(mx, (b.x || 0) + (b.width || 340)), 400);
    const maxH = blocks.reduce((mx, b) => Math.max(mx, (b.y || 0) + (b.height || 250)), 300);

    blocksEl.innerHTML = '';
    blocksEl.style.position = 'relative';
    blocksEl.style.width = Math.min(400, maxW * SCALE) + 'px';
    blocksEl.style.height = Math.min(200, maxH * SCALE + 10) + 'px';
    blocksEl.style.background = '#fff';
    blocksEl.style.borderRadius = '4px';
    blocksEl.style.border = '1px solid #e8e8e8';
    blocksEl.style.overflow = 'hidden';

    blocks.forEach(block => {
      const def = TEMPLATE_DEFS.find(d => d.id === block.id);
      if (!def) return;
      const el = document.createElement('div');
      const w = (block.width || 340) * SCALE;
      const h = (block.height || 250) * SCALE;
      const x = (block.x || 0) * SCALE;
      const y = (block.y || 0) * SCALE;
      el.style.cssText = `
        position:absolute; left:${x}px; top:${y}px;
        width:${w}px; height:${h}px;
        border:1px solid #c0c8d4; border-radius:3px;
        background:#f0f4fa; overflow:hidden;
        font-size:8px; line-height:1.2; padding:2px 3px;
        color:#333; font-weight:600;
      `;
      el.textContent = def.label.replace(/^[^\s]+\s/, ''); // 絵文字除去
      el.title = def.label;
      blocksEl.appendChild(el);
    });
  } catch(e) {
    blocksEl.innerHTML = `<span style="color:red;font-size:11px">Error: ${e.message}</span>`;
  }
}


// ── 適用ダイアログ (Area固定スタイル) ──────────────────────

async function openApplyDialog(area) {
  const blocks = _graphConfigCache[area];
  if (!blocks || blocks.length === 0) { showToast('先に Save を押してください', 'error'); return; }
  if (_graphConfigDirty[area]) { showToast('先に Save を押してください', 'error'); return; }

  // 現在のArea固定状態を取得
  let isFixed = false;
  try {
    const r = await fetch(`/api/area-fixed-style?area=${encodeURIComponent(area)}`);
    const d = await r.json();
    isFixed = d.fixed;
  } catch(e) {}

  let modal = document.getElementById('apply-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'apply-modal';
    modal.className = 'modal';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal-backdrop" onclick="closeApplyDialog()"></div>
    <div class="modal-content" style="max-width:440px">
      <button class="modal-close" onclick="closeApplyDialog()">✕</button>
      <h3 style="margin-bottom:14px">適用 — ${escHtml(area)}</h3>
      <p style="font-size:13px;margin-bottom:14px;line-height:1.6">
        <strong>${escHtml(area)}</strong> は、今後もこのスタイルで固定しますか？<br>
        <small style="color:#666">Yes → まだデータがない週も、このAreaは固定スタイルで表示されます。<br>
        他のAreaは通常テンプレートのままです。</small>
      </p>
      <div style="display:flex;gap:10px;justify-content:center;margin-bottom:12px">
        <button id="apply-yes" style="padding:8px 28px;border:1px solid var(--border);border-radius:4px;background:#1a237e;color:#fff;cursor:pointer;font-size:13px;font-weight:600">Yes</button>
        <button id="apply-no" style="padding:8px 28px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:pointer;font-size:13px;font-weight:600">No</button>
      </div>
      ${isFixed ? '<p style="font-size:11px;color:#e67e22;text-align:center">現在このAreaは固定スタイル設定済みです。Noで解除できます。</p>' : ''}
      <div id="apply-msg" style="margin-top:8px;font-size:12px;text-align:center"></div>
    </div>`;
  modal.style.display = 'flex';

  // Yes: 固定する
  document.getElementById('apply-yes').addEventListener('click', async () => {
    const msgEl = document.getElementById('apply-msg');
    msgEl.textContent = '設定中...';
    try {
      await fetch('/api/area-fixed-style', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area, blocks }),
      });
      msgEl.innerHTML = '<span style="color:green">このAreaのスタイルを固定しました</span>';
      showToast(`${area} のスタイルを固定しました`, 'success');
    } catch(e) { msgEl.innerHTML = `<span style="color:red">Error: ${e.message}</span>`; }
  });

  // No: 解除 (固定済みなら)
  document.getElementById('apply-no').addEventListener('click', async () => {
    if (isFixed) {
      const msgEl = document.getElementById('apply-msg');
      msgEl.textContent = '解除中...';
      try {
        await fetch('/api/area-fixed-style', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ area, blocks: null }),
        });
        msgEl.innerHTML = '<span style="color:green">固定を解除しました</span>';
        showToast(`${area} の固定を解除しました`, 'success');
      } catch(e) { msgEl.innerHTML = `<span style="color:red">Error: ${e.message}</span>`; }
    } else {
      closeApplyDialog();
    }
  });
}

function closeApplyDialog() {
  const m = document.getElementById('apply-modal'); if (m) m.style.display = 'none';
}


// ── テンプレート描画関数 ────────────────────────────────

function _tplCard(title) {
  const card = document.createElement('div');
  card.className = 'card tpl-card';
  card.innerHTML = `<div class="card-header">${title}</div><div class="card-body"></div>`;
  return card;
}

function _renderShipperTop(data, direction, period) {
  const isUp = direction === 'increase';
  const emoji = isUp ? '📈' : '📉';
  const label = isUp ? '増加' : '減少';
  const recentLabel = data.recent_label || period;
  const title = `${emoji} ${label}荷主 TOP3（${recentLabel}）`;
  const card = _tplCard(title);
  const items = data.items || [];

  if (items.length === 0) {
    card.querySelector('.card-body').innerHTML = '<p class="tpl-empty">該当なし</p>';
    return card;
  }

  let html = '<table class="tpl-table"><thead><tr>';
  html += '<th>Shipper</th>';
  html += '<th>3M Avg</th>';
  html += `<th>${escHtml(recentLabel)}</th>`;
  html += '<th>Gap</th>';
  html += '<th>Remark</th>';
  html += '</tr></thead><tbody>';

  for (const s of items) {
    const diffCls = s.diff >= 0 ? 'positive' : 'negative';
    const diffSign = s.diff >= 0 ? '+' : '';
    // 主要因コンボ表示: "TMK-SHA : 60 ⇒ 237"
    let comboStr = '-';
    if (s.top_combo) {
      const c = s.top_combo;
      comboStr = `${c.pol}-${c.dly} : ${c.avg3_teu} ⇒ ${c.recent_teu}`;
    }
    html += `<tr>`;
    html += `<td class="left">${escHtml(s.shipper)}</td>`;
    html += `<td>${s.avg3_teu.toLocaleString()}</td>`;
    html += `<td>${s.recent_teu.toLocaleString()}</td>`;
    html += `<td class="${diffCls}">${diffSign}${s.diff.toLocaleString()}</td>`;
    html += `<td class="left small">${escHtml(comboStr)}</td>`;
    html += `</tr>`;
  }
  html += '</tbody></table>';

  card.querySelector('.card-body').innerHTML = html;
  return card;
}

function _renderNewCustomer(data) {
  const card = _tplCard('🆕 New Customer');
  let html = '<p class="tpl-desc">過去12ヶ月実績ゼロ → 今月/来月で復活</p>';
  if (data.customers?.length > 0) {
    html += '<table class="tpl-table"><thead><tr><th>#</th><th>Shipper</th><th>TEU</th></tr></thead><tbody>';
    data.customers.forEach((c,i) => { html += `<tr><td>${i+1}</td><td class="left">${escHtml(c.shipper)}</td><td>${c.teu.toLocaleString()}</td></tr>`; });
    html += '</tbody></table>';
    if (data.overflow_count > 0) html += `<p class="tpl-overflow">他 ${data.overflow_count}社 / ${data.overflow_teu.toLocaleString()} TEU</p>`;
  } else html += '<p class="tpl-empty">該当なし</p>';
  html += `<p class="tpl-total">合計: ${data.total_count}社</p>`;
  card.querySelector('.card-body').innerHTML = html;
  return card;
}

function _renderRegainCustomer(data) {
  const card = _tplCard('🔄 Regain Customer');
  let html = '<p class="tpl-desc">7-12ヶ月前に実績あり → 6ヶ月休止 → 今月復活</p>';
  if (data.customers?.length > 0) {
    html += '<table class="tpl-table"><thead><tr><th>#</th><th>Shipper</th><th>TEU</th></tr></thead><tbody>';
    data.customers.forEach((c,i) => { html += `<tr><td>${i+1}</td><td class="left">${escHtml(c.shipper)}</td><td>${c.teu.toLocaleString()}</td></tr>`; });
    html += '</tbody></table>';
    if (data.overflow_count > 0) html += `<p class="tpl-overflow">他 ${data.overflow_count}社 / ${data.overflow_teu.toLocaleString()} TEU</p>`;
  } else html += '<p class="tpl-empty">該当なし</p>';
  html += `<p class="tpl-total">合計: ${data.total_count}社</p>`;
  card.querySelector('.card-body').innerHTML = html;
  return card;
}

function _renderPOLCount(data) {
  const card = _tplCard('🏭 POL数 (Monthly)');
  let html = '<table class="tpl-table"><thead><tr>';
  data.forEach(d => { html += `<th>${ymToLabel(d.ym)}</th>`; });
  html += '</tr></thead><tbody><tr>';
  data.forEach(d => { html += `<td>${d.pol_count}</td>`; });
  html += '</tr></tbody></table>';
  card.querySelector('.card-body').innerHTML = html;
  return card;
}

function _renderBookingCount(data, panel) {
  const card = _tplCard('📋 Booking件数');
  const body = card.querySelector('.card-body');
  let html = '<div class="tpl-sub-title">Monthly</div><table class="tpl-table"><thead><tr>';
  (data.monthly||[]).forEach(d => { html += `<th>${ymToLabel(d.ym)}</th>`; });
  html += '</tr></thead><tbody><tr>';
  (data.monthly||[]).forEach(d => { html += `<td>${d.count.toLocaleString()}</td>`; });
  html += '</tr></tbody></table>';
  html += '<div class="tpl-sub-title" style="margin-top:8px">Weekly</div>';
  html += '<div class="chart-wrap" style="height:140px"><canvas class="bkg-weekly-chart"></canvas></div>';
  body.innerHTML = html;
  // Chart描画はDOM追加後に遅延実行
  if (!window._pendingBookingCharts) window._pendingBookingCharts = [];
  window._pendingBookingCharts.push({ data, panel });
  return card;
}

function _renderSalesContribution(data) {
  const card = _tplCard('👤 営業マン寄与度');
  const body = card.querySelector('.card-body');
  const months = Object.keys(data).sort();

  // 月タブ
  let html = '<div class="tpl-month-tabs">';
  months.forEach((ym,i) => { html += `<button class="tpl-tab-btn${i===months.length-1?' active':''}" data-ym="${ym}">${ymToLabel(ym)}</button>`; });
  html += '</div>';

  months.forEach((ym,i) => {
    const monthData = data[ym] || {};
    const items = monthData.items || (Array.isArray(monthData) ? monthData : []);
    const totalTeu = monthData.total_teu || items.reduce((s,it) => s + (it.teu||0), 0);
    html += `<div class="tpl-tab-content" data-ym="${ym}" style="${i===months.length-1?'':'display:none'}">`;
    if (items.length > 0) {
      html += `<div style="position:relative;width:100%;height:calc(100% - 30px)"><canvas class="sales-donut-canvas" data-ym="${ym}"></canvas></div>`;
    } else {
      html += '<p class="tpl-empty">データなし</p>';
    }
    html += '</div>';
  });

  body.innerHTML = html;

  // タブ切替・チャート描画は DOM 追加後に _drawSalesDonutCharts で一括処理
  if (!window._pendingSalesDonut) window._pendingSalesDonut = [];
  window._pendingSalesDonut.push({ data, months });

  return card;
}

const _DONUT_COLORS = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
  '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac',
  '#86bcb6','#8cd17d','#b6992d','#d4a6c8','#499894',
];

/**
 * DOM追加後に遅延描画が必要なチャートを一括実行
 */
function _flushPendingCharts(container, pendingB, pendingD) {
  // Booking件数の棒グラフ
  const bookingQueue = pendingB || window._pendingBookingCharts;
  if (bookingQueue) {
    bookingQueue.forEach(({ data, panel }) => {
      const canvases = container.querySelectorAll('.bkg-weekly-chart');
      canvases.forEach(canvas => {
        if (canvas.dataset.drawn) return;
        if (data.weekly?.length > 0) {
          const ctx = canvas.getContext('2d');
          const key = `bkg_${panel?.dataset?.area||'x'}_${Date.now()}_${Math.random()}`;
          if (CHART_INSTANCES[key]) CHART_INSTANCES[key].destroy();
          CHART_INSTANCES[key] = new Chart(ctx, {
            type: 'bar',
            data: { labels: data.weekly.map(w=>w.week_label), datasets: [{ label:'件数', data: data.weekly.map(w=>w.count), backgroundColor:'#3f51b5' }] },
            options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, datalabels:{display:true,anchor:'end',align:'top',font:{size:9}} }, scales:{y:{beginAtZero:true,ticks:{precision:0}}} }
          });
          canvas.dataset.drawn = 'true';
        }
      });
    });
    if (!pendingB) window._pendingBookingCharts = null;
  }
  // ドーナツチャート
  const donutQueue = pendingD || window._pendingSalesDonut;
  if (donutQueue) {
    donutQueue.forEach(({ data, months }) => {
      _drawSalesDonutCharts(container, data, months);
    });
    if (!pendingD) window._pendingSalesDonut = null;
  }
}

function _drawSalesDonutCharts(container, data, months) {
  // container = .graph-config-list (DOM上に存在する要素)

  // アクティブタブのチャートのみ描画、他は pending
  months.forEach(ym => {
    const canvas = container.querySelector(`.sales-donut-canvas[data-ym="${ym}"]`);
    if (!canvas) return;
    const tabContent = canvas.closest('.tpl-tab-content');
    const isVisible = !tabContent || tabContent.style.display !== 'none';
    if (isVisible) {
      const monthData = data[ym] || {};
      const items = monthData.items || (Array.isArray(monthData) ? monthData : []);
      const totalTeu = monthData.total_teu || items.reduce((s,it) => s + (it.teu||0), 0);
      if (items.length > 0) _createSalesDonut(canvas, items, totalTeu);
    } else {
      canvas.dataset.pending = 'true';
    }
  });

  // タブ切替: 表示/非表示 + 未描画チャートの遅延描画
  container.querySelectorAll('.tpl-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // タブボタンの active 切替
      const block = btn.closest('.gc-block-body') || btn.closest('.gc-block') || container;
      block.querySelectorAll('.tpl-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // タブコンテンツの表示切替
      block.querySelectorAll('.tpl-tab-content').forEach(c => c.style.display = 'none');
      const target = block.querySelector(`.tpl-tab-content[data-ym="${btn.dataset.ym}"]`);
      if (target) target.style.display = '';
      // 未描画チャートを描画
      setTimeout(() => {
        const ym = btn.dataset.ym;
        const canvas = block.querySelector(`.sales-donut-canvas[data-ym="${ym}"]`);
        if (canvas && canvas.dataset.pending === 'true') {
          const monthData = data[ym] || {};
          const items = monthData.items || (Array.isArray(monthData) ? monthData : []);
          const totalTeu = monthData.total_teu || items.reduce((s,it) => s + (it.teu||0), 0);
          if (items.length > 0) _createSalesDonut(canvas, items, totalTeu);
          delete canvas.dataset.pending;
        }
      }, 50);
    });
  });
}

function _createSalesDonut(canvas, items, totalTeu) {
  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: items.map(it => it.sales),
      datasets: [{
        data: items.map(it => it.teu),
        backgroundColor: items.map((_, i) => _DONUT_COLORS[i % _DONUT_COLORS.length]),
        borderWidth: 1,
        borderColor: '#fff',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '40%',
      layout: { padding: 4 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const it = items[ctx.dataIndex];
              return it ? `${it.sales}: ${it.teu.toLocaleString()} TEU (${it.pct}%)` : '';
            }
          }
        },
        datalabels: {
          display: true,
          color: '#fff',
          font: { size: 10, weight: '700' },
          textShadowBlur: 3,
          textShadowColor: 'rgba(0,0,0,0.4)',
          textAlign: 'center',
          formatter: (value, ctx) => {
            const it = items[ctx.dataIndex];
            if (!it || it.pct < 6) return null;
            return it.sales + '\n' + it.pct + '%';
          },
          anchor: 'center',
          align: 'center',
          clamp: true,
        },
      },
    },
    plugins: [
      {
        id: 'centerText',
        afterDraw(chart) {
          const { ctx: c2d, chartArea } = chart;
          const cx = (chartArea.left + chartArea.right) / 2;
          const cy = (chartArea.top + chartArea.bottom) / 2;
          c2d.save();
          c2d.textAlign = 'center';
          c2d.textBaseline = 'middle';
          c2d.fillStyle = '#666';
          c2d.font = '10px sans-serif';
          c2d.fillText('合計', cx, cy - 10);
          c2d.fillStyle = '#222';
          c2d.font = 'bold 14px sans-serif';
          c2d.fillText(totalTeu.toLocaleString() + ' TEU', cx, cy + 6);
          c2d.restore();
        }
      },
    ],
  });
}

function _renderCM1Range(data) {
  const card = _tplCard('💰 CM1レンジ分析');
  const months = Object.keys(data).sort();
  const segs = [{key:'high',e:'🟢',l:'High'},{key:'mid',e:'🟡',l:'Mid'},{key:'low',e:'🔴',l:'Low'}];
  let html = '<div class="tpl-desc">CM1/TEU を上位25%（High）・中間（Mid）・下位25%（Low）に分類</div>';
  html += '<table class="tpl-table"><thead><tr><th>月</th><th>Seg</th><th>TEU</th><th>%</th><th>社数</th><th>CM1/T</th></tr></thead><tbody>';
  for (const ym of months) {
    const d = data[ym]; const info = d.q75!=null?`≥$${d.q75}/<$${d.q25}`:'';
    segs.forEach((seg,i) => {
      const s = d[seg.key]||{};
      html += '<tr>';
      if (i===0) html += `<td rowspan="3" class="ym-cell">${ymToLabel(ym)}<br><small>${info}</small></td>`;
      html += `<td>${seg.e} ${seg.l}</td><td>${(s.teu||0).toLocaleString()}</td><td>${s.pct||0}%</td><td>${s.shipper_count||0}</td><td>$${(s.cm1_per_teu||0).toLocaleString()}</td></tr>`;
    });
  }
  html += '</tbody></table>';
  card.querySelector('.card-body').innerHTML = html;
  return card;
}

function _renderTradeLane(data) {
  const card = _tplCard(`🗺️ Trade Lane (${data.group_by})`);
  const months = data.months||[];
  let html = '<div class="heatmap-scroll"><table class="tpl-table heatmap-table"><thead><tr><th>'+data.group_by+'</th>';
  months.forEach(ym => { html += `<th>${ymToLabel(ym)}</th>`; });
  html += '</tr></thead><tbody>';
  let maxTeu = 0;
  for (const row of data.data||[]) for (const ym of months) { const v=row.months?.[ym]?.teu||0; if(v>maxTeu) maxTeu=v; }
  for (const row of data.data||[]) {
    html += `<tr><td class="left"><strong>${escHtml(row.lane)}</strong></td>`;
    for (const ym of months) {
      const cell = row.months?.[ym]||{teu:0,cm1_per_teu:0};
      const i = maxTeu>0?cell.teu/maxTeu:0;
      const bg = `rgb(${Math.round(220-i*190)},${Math.round(230-i*150)},${Math.round(255-i*50)})`;
      html += `<td style="background:${bg};color:${i>0.6?'#fff':'#333'};text-align:center" title="CM1/T:$${cell.cm1_per_teu}"><div class="hm-teu">${cell.teu.toLocaleString()}</div><div class="hm-cm1">$${cell.cm1_per_teu}</div></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  card.querySelector('.card-body').innerHTML = html;
  return card;
}

function _renderCM1Waterfall(data, panel) {
  const card = _tplCard('📊 CM1/TEU 前月比要因分解');
  const body = card.querySelector('.card-body');
  const chg = data.total_change>=0?'+':'';
  const cls = data.total_change>=0?'positive':'negative';
  let html = `<div class="wf-summary"><span>${data.prev_ym?.slice(5)}: <strong>$${data.prev_cm1t}</strong></span> → <span>${data.curr_ym?.slice(5)}: <strong>$${data.curr_cm1t}</strong></span> <span class="wf-change ${cls}">(${chg}$${data.total_change})</span></div>`;
  html += '<div class="chart-wrap" style="height:160px"><canvas class="wf-chart"></canvas></div>';
  html += '<table class="tpl-table wf-table"><tbody>';
  html += `<tr><td class="left">Mix効果</td><td class="${data.mix_effect>=0?'positive':'negative'}">${data.mix_effect>=0?'+':''}$${data.mix_effect}</td></tr>`;
  html += `<tr><td class="left">Rate効果</td><td class="${data.rate_effect>=0?'positive':'negative'}">${data.rate_effect>=0?'+':''}$${data.rate_effect}</td></tr>`;
  html += `<tr><td class="left">Volume効果</td><td class="${data.volume_effect>=0?'positive':'negative'}">${data.volume_effect>=0?'+':''}$${data.volume_effect}</td></tr>`;
  html += '</tbody></table>';
  body.innerHTML = html;
  const canvas = body.querySelector('.wf-chart');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const key = `wf_${panel?.dataset?.area||'x'}_${Date.now()}`;
    const labels = [data.prev_ym?.slice(5),'Mix','Rate','Vol',data.curr_ym?.slice(5)];
    const base = [0,data.prev_cm1t,data.prev_cm1t+data.mix_effect,data.prev_cm1t+data.mix_effect+data.rate_effect,0];
    const values = [data.prev_cm1t,data.mix_effect,data.rate_effect,data.volume_effect,data.curr_cm1t];
    const colors = values.map((v,i)=>i===0||i===4?'#1a237e':v>=0?'#2e7d32':'#c62828');
    CHART_INSTANCES[key] = new Chart(ctx, {
      type:'bar', data:{ labels, datasets:[
        {label:'Base',data:base,backgroundColor:'transparent',borderWidth:0,stack:'wf'},
        {label:'Value',data:values.map(v=>Math.abs(v)),backgroundColor:colors,stack:'wf'},
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false},
        datalabels:{ display:(c)=>c.datasetIndex===1, anchor:'end', align:'top',
          formatter:(val,c)=>{ const v=values[c.dataIndex]; return (c.dataIndex===0||c.dataIndex===4)?`$${v}`:`${v>=0?'+':''}$${v}`; },
          font:{size:10,weight:'bold'} }
      }, scales:{x:{stacked:true},y:{stacked:true,display:false}} }
    });
  }
  return card;
}


// ── UI ユーティリティ ─────────────────────────────────
function showLoading(show) {
  document.getElementById('loading').style.display = show ? 'flex' : 'none';
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'show ' + type;
  setTimeout(() => { toast.className = ''; }, 3000);
}

// ── BSA Chart ────────────────────────────────────────────
const BSA_GAS_JSON_URL = BSA_GAS_URL + '?format=postmessage';
let _bsaCache = null;  // フロントエンドキャッシュ

const BSA_SHEET_TO_AREA = {
  "AE":"AE","KR":"KR","NCN":"NCN","SCN":"SCN","HK":"HK",
  "ID":"ID","TH":"TH","SG":"SG",
  "IN":"IN","IN(E)":"IN-East","IN(W)":"IN-West",
  "PK":"PK","MY":"MY","PH":"PH",
  "VN":"VN","VN(SGN)":"SGN","VN(HPH)":"HPH",
  "MY(PKG&PEN)":"PKG&PEN","MY(PKW)":"_PKW","MY(PGU)":"_PGU",
  "PH(MIP)":"MIP","PH(MNL)":"MNL","MX":"MX","US":"US",
};

function _parseBSARows(rows) {
  const sf = v => { if (!v || v==='') return 0; const n=parseFloat(String(v).replace(/,/g,'').replace('%','')); return isNaN(n)?0:n; };
  const result = {};
  let r = 0;
  while (r < rows.length) {
    const row = rows[r];
    const areaName = (row[0]||'').trim();
    const rowType = (row[1]||'').trim();
    if (areaName && rowType === 'WEEK' && BSA_SHEET_TO_AREA[areaName]) {
      const dashArea = BSA_SHEET_TO_AREA[areaName];
      const weeks = row.slice(2).filter(c => String(c).trim());
      const n = weeks.length;
      const gr = (off) => { const idx=r+off; return idx<rows.length ? rows[idx].slice(2,2+n).concat(Array(Math.max(0,n-(rows[idx].length-2))).fill('')) : Array(n).fill(''); };
      const weekNums = gr(1).map(c => String(c).trim());
      const teu = gr(2).map(sf);
      const bsa = gr(3).map(sf);
      const roll = gr(4).map(sf);
      let rate = [];
      for (let off=5; off<8; off++) {
        const idx=r+off;
        if (idx<rows.length && ((rows[idx][1]||'').includes('消席率') || (rows[idx][1]||'').includes('%'))) {
          rate = rows[idx].slice(2,2+n).map(c => String(c).trim());
          break;
        }
      }
      if (!rate.length) rate = Array(n).fill('');
      // 小数値(0.45)を百分率(45%)に変換
      rate = rate.map(r => {
        if (!r || r === '' || r === 'BLANK') return r;
        if (String(r).includes('%')) return r;
        const n = parseFloat(r);
        if (!isNaN(n) && n > 0 && n < 10) return Math.round(n * 100) + '%';
        if (!isNaN(n) && n >= 10) return Math.round(n) + '%';
        return r;
      });
      result[dashArea] = { weeks: weeks.map(w=>String(w).trim()), week_nums: weekNums, teu, bsa, roll, rate };
      r += 6;
    } else { r++; }
  }
  // PKW, PGU を個別に保持（マージしない）
  if (result['_PKW']) { result['PKW'] = result['_PKW']; delete result['_PKW']; }
  if (result['_PGU']) { result['PGU'] = result['_PGU']; delete result['_PGU']; }
  // actual_demand 計算のみ（シミュレーションは描画時にCURRENT_WEEK_KEY基準で計算）
  for (const k of Object.keys(result)) {
    const d = result[k];
    d.actual_demand = d.teu.map((t,i) => t + d.roll[i]);
  }
  return result;
}

let _bsaFetchPromise = null;  // 重複リクエスト防止
function _fetchBSAData(force) {
  if (!force && _bsaCache) return Promise.resolve(_bsaCache);
  if (_bsaFetchPromise) return _bsaFetchPromise;  // 既にリクエスト中

  _bsaFetchPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('BSA: postMessage timeout (15s)');
      cleanup();
      resolve(_bsaCache || {});
    }, 15000);

    function onMessage(e) {
      if (!e.data || e.data.type !== 'bsa-data') return;
      console.log('BSA: received postMessage, rows:', (e.data.rows||[]).length);
      cleanup();
      const rows = e.data.rows || [];
      _bsaCache = _parseBSARows(rows);
      console.log('BSA: parsed areas', Object.keys(_bsaCache));
      resolve(_bsaCache);
    }

    function cleanup() {
      clearTimeout(timeout);
      _bsaFetchPromise = null;
      window.removeEventListener('message', onMessage);
      const old = document.getElementById('bsa-data-iframe');
      if (old) old.remove();
    }

    // 既存のiframeを除去
    const old = document.getElementById('bsa-data-iframe');
    if (old) old.remove();
    window.addEventListener('message', onMessage);

    const iframe = document.createElement('iframe');
    iframe.id = 'bsa-data-iframe';
    iframe.style.display = 'none';
    iframe.src = BSA_GAS_JSON_URL;
    document.body.appendChild(iframe);
    console.log('BSA: iframe created, loading', BSA_GAS_JSON_URL);
  });
  return _bsaFetchPromise;
}

// BSA非表示エリア
const BSA_HIDDEN_AREAS = new Set(['ALL','KR','JPC_KR','JPN_KR','NCN','SCN','HK','IN','PH','VN','MY']);
// エリア別BSAデータキー & 注記
const BSA_AREA_CONFIG = {
  'IN-West': { key: 'IN-West', note: '※PKを含む' },
  'PK':      { key: 'IN-West', note: '※West-INを含む' },
  'PKW&PGU': { keys: ['PKW', 'PGU'], tabs: true },  // サブタブ
};

function _renderBSAInPanel(panel, area) {
  const bsaRow = panel.querySelector('.bsa-chart-row');
  if (!bsaRow) return;

  // 非表示エリアはBSA行を隠す
  if (BSA_HIDDEN_AREAS.has(area)) {
    bsaRow.style.display = 'none';
    return;
  }
  bsaRow.style.display = '';

  const config = BSA_AREA_CONFIG[area];

  // PKW&PGU: サブタブ表示
  if (config?.tabs) {
    _renderBSAWithTabs(panel, bsaRow, area, config.keys);
    return;
  }

  const canvas = bsaRow.querySelector('.bsa-chart-canvas');
  if (!canvas) return;

  // 注記テキスト
  const header = bsaRow.querySelector('.card-header');
  let noteEl = header?.querySelector('.bsa-note');
  if (config?.note) {
    if (!noteEl) {
      noteEl = document.createElement('span');
      noteEl.className = 'bsa-note';
      noteEl.style.cssText = 'font-size:11px;color:#888;margin-left:8px;font-style:italic';
      header.insertBefore(noteEl, header.querySelector('.btn-bsa-refresh'));
    }
    noteEl.textContent = config.note;
  } else if (noteEl) { noteEl.remove(); }

  // BSA更新ボタン
  const refreshBtn = bsaRow.querySelector('.btn-bsa-refresh');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = '⏳ 更新中...';
      try {
        await _fetchBSAData(true);
        showToast('BSAデータ更新完了', 'success');
        _renderBSAInPanel(panel, area);
      } catch (e) { showToast('BSA更新エラー: ' + e.message, 'error'); }
      finally { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 更新'; }
    });
  }

  // BSAデータキー（エイリアス対応）
  const bsaKey = config?.key || area;

  _fetchBSAData().then(allData => {
    const areaData = allData[bsaKey];
    if (!areaData) {
      canvas.parentElement.innerHTML = '<p style="text-align:center;color:#999;padding:2em">BSAデータなし</p>';
      return;
    }
    _drawBSAChart(canvas, areaData, area);
    canvas.dataset.drawn = 'true';
  }).catch(e => console.warn('BSA chart error:', e));
}

function _renderBSAWithTabs(panel, bsaRow, area, subKeys) {
  const body = bsaRow.querySelector('.card-body');
  if (!body) return;

  // card-bodyからchart-wrapクラスを外す（内側で管理するため）
  body.classList.remove('chart-wrap', 'tall');

  // サブタブ + canvas を構築
  body.innerHTML = `
    <div class="bsa-sub-tabs" style="display:flex;gap:4px;margin-bottom:6px">
      ${subKeys.map((k,i) => `<button class="bsa-sub-tab${i===0?' active':''}" data-bsa-key="${k}">${k}</button>`).join('')}
    </div>
    <div class="chart-wrap tall">
      <canvas class="bsa-chart-canvas"></canvas>
    </div>`;

  const canvas = body.querySelector('.bsa-chart-canvas');
  const tabs = body.querySelectorAll('.bsa-sub-tab');

  // 現在のアクティブキーでチャート描画（共通キーで管理し、切替時にdestroy→再描画）
  const chartKey = `bsa_${area}`;
  function drawSub(key) {
    _fetchBSAData().then(allData => {
      const d = allData[key];
      if (!d) {
        canvas.parentElement.innerHTML = '<p style="text-align:center;color:#999;padding:2em">BSAデータなし: ' + key + '</p>';
        return;
      }
      // 同一canvasなので共通キーでdestroy
      if (CHART_INSTANCES[chartKey]) { CHART_INSTANCES[chartKey].destroy(); delete CHART_INSTANCES[chartKey]; }
      _drawBSAChart(canvas, d, area);
      canvas.dataset.drawn = 'true';
    });
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      drawSub(tab.dataset.bsaKey);
    });
  });

  // 更新ボタン
  const refreshBtn = bsaRow.querySelector('.btn-bsa-refresh');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = 'true';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = '⏳ 更新中...';
      try {
        await _fetchBSAData(true);
        showToast('BSAデータ更新完了', 'success');
        const activeKey = body.querySelector('.bsa-sub-tab.active')?.dataset.bsaKey || subKeys[0];
        drawSub(activeKey);
      } catch (e) { showToast('BSA更新エラー: ' + e.message, 'error'); }
      finally { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 更新'; }
    });
  }

  // 初回描画
  drawSub(subKeys[0]);
}

function _drawBSAChart(canvas, rawD, area) {
  const ctx = canvas.getContext('2d');
  const key = `bsa_${area}`;
  if (CHART_INSTANCES[key]) CHART_INSTANCES[key].destroy();

  // ±10週にフィルタ: CURRENT_WEEK_KEY("2026-W14") → YYWW(2614)
  let centerYYWW = 0;
  if (typeof CURRENT_WEEK_KEY === 'string') {
    const m = CURRENT_WEEK_KEY.match(/(\d{4})-W(\d+)/);
    if (m) centerYYWW = (parseInt(m[1]) % 100) * 100 + parseInt(m[2]);
  }
  // centerが取れなければfuture_startの位置を使う
  let centerIdx = rawD.future_start ?? Math.floor(rawD.weeks.length / 2);
  if (centerYYWW > 0) {
    for (let i = 0; i < rawD.week_nums.length; i++) {
      const wn = parseInt(rawD.week_nums[i]);
      if (!isNaN(wn) && wn >= centerYYWW) { centerIdx = i; break; }
    }
  }
  // ±10週にスライス
  const sliceStart = Math.max(0, centerIdx - 10);
  const sliceEnd = Math.min(rawD.weeks.length, centerIdx + 11);
  const sl = (arr) => arr.slice(sliceStart, sliceEnd);

  // スライスしたデータで描画
  const fs = Math.max(0, centerIdx - sliceStart);  // 今週のインデックス（スライス後）
  const d = {
    weeks: sl(rawD.weeks), week_nums: sl(rawD.week_nums),
    teu: sl(rawD.teu), bsa: sl(rawD.bsa), roll: sl(rawD.roll),
    rate: sl(rawD.rate), actual_demand: sl(rawD.actual_demand),
  };

  // 棒グラフ: TEU(青) + 累積ROLL(黄) = actual_demand
  const demand = d.actual_demand;  // TEU + Roll
  const carryOver = d.roll;         // 累積ROLL（スプレッドシートの値）
  const ownDemand = d.teu;          // TEU（当週分のみ）

  const datasets = [
    // ① 累積ROLL — 薄い黄（下段）
    {
      label: '累積ROLL',
      data: carryOver,
      backgroundColor: 'rgba(255,235,59,0.3)',
      borderColor: 'rgba(255,215,0,0.5)',
      borderWidth: 1,
      borderRadius: 4,
      borderSkipped: 'top',
      stack: 'demand',
      order: 3,
    },
    // ② 当週TEU+Roll — 青（上段）
    {
      label: 'TEU (当週)',
      data: ownDemand,
      backgroundColor: 'rgba(33,150,243,0.7)',
      borderColor: 'rgba(33,150,243,1)',
      borderWidth: 1,
      borderRadius: 4,
      borderSkipped: 'bottom',
      stack: 'demand',
      order: 2,
    },
    // ③ BSA Capacity — 緑線
    {
      label: 'BSA',
      type: 'line',
      data: d.bsa,
      borderColor: '#D32F2F',
      borderWidth: 2,
      pointRadius: 2,
      pointBackgroundColor: '#D32F2F',
      fill: false,
      order: 1,
    },
  ];

  CHART_INSTANCES[key] = new Chart(ctx, {
    type: 'bar',
    data: { labels: d.weeks, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 40 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { size: 10 } } },
        datalabels: {
          display: (c) => {
            if (c.datasetIndex === 2) return false;
            if (c.datasetIndex === 1) return true;
            return false;
          },
          formatter: (val, c) => {
            const i = c.dataIndex;
            const total = Math.round(demand[i]);
            const rate = d.rate[i] || '';
            const roll = Math.round(carryOver[i]);
            let label = roll > 0 ? `${total} (${roll})` : `${total}`;
            if (rate) label += `\n${rate}`;
            return label;
          },
          anchor: 'end',
          align: 'top',
          font: { size: 11, weight: 'bold' },
          textAlign: 'center',
          color: (c) => {
            const i = c.dataIndex;
            const rate = d.rate[i] || '';
            if (rate === 'BLANK') return '#999';
            const pct = parseFloat(rate);
            if (!isNaN(pct) && pct > 100) return '#c62828';
            return '#333';
          },
        },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const i = items[0]?.dataIndex;
              const lines = [];
              if (i != null) {
                lines.push(`TEU: ${Math.round(d.teu[i])}`);
                if (d.roll[i] > 0) lines.push(`累積ROLL: ${Math.round(d.roll[i])}`);
                lines.push(`合計: ${Math.round(demand[i])}`);
                if (d.rate[i]) lines.push(`消席率: ${d.rate[i]}`);
              }
              return lines.join('\n');
            }
          }
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          stacked: true,
          suggestedMax: Math.max(...demand) * 1.25,
          title: { display: true, text: 'TEU', font: { size: 11 } },
        },
        x: {
          stacked: true,
          ticks: { font: { size: 9 }, maxRotation: 45 },
        },
      },
    },
    plugins: [{
      afterDraw(chart) {
        const ctx2 = chart.ctx;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;

        // 今週の境界線
        if (fs > 0 && fs < d.weeks.length) {
          const x = xScale.getPixelForValue(fs) - (xScale.getPixelForValue(1) - xScale.getPixelForValue(0)) / 2;
          ctx2.save();
          ctx2.strokeStyle = '#FF9800';
          ctx2.lineWidth = 1.5;
          ctx2.setLineDash([4, 4]);
          ctx2.beginPath();
          ctx2.moveTo(x, yScale.top);
          ctx2.lineTo(x, yScale.bottom);
          ctx2.stroke();
          ctx2.fillStyle = '#FF9800';
          ctx2.font = '10px sans-serif';
          ctx2.fillText('▼ 今週', x + 2, yScale.top + 12);
          ctx2.restore();
        }

        // 右上に注記
        ctx2.save();
        ctx2.fillStyle = '#666';
        ctx2.font = '10px sans-serif';
        ctx2.textAlign = 'right';
        ctx2.fillText('※BSAを超える場合は、ROLL-OVERと仮定', chart.chartArea.right, chart.chartArea.top + 12);
        ctx2.restore();
      }
    }],
  });
}
