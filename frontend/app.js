/* 运动库 SportDB — PWA 逻辑 + sql.js-httpvfs 真实接线
 * 布局思路参考 yihong0618/running_page：顶部统计 / 热力图 / 列表 / 年报。
 *
 * 数据层（task-6 已接通）：
 *  1. 首选 sql.js-httpvfs 按需读 DB_CONFIG.dbUrl（sport-db/data.db，需 Range 支持，
 *     GitHub Pages 原生支持；本地用 `python -m http.server` 在 sport-db/ 根启动）。
 *  2. data.db 缺失 / httpvfs 失败时，自动降级 fetch data/workouts/<年>.csv
 *    （当年 + 查询跨度内各年，兼容本地根服务与 Pages 两种目录布局）。
 * 表结构与 scripts/build_db.py 对齐：workouts(date, start_time, type,
 * distance_m/distance_km, duration_s, avg_pace_s, avg_hr, calories, steps,
 * source, file_path, confidence)。
 */
'use strict';

/* ================= 日期 & Tab 切换 ================= */
document.getElementById('today-date').textContent =
  new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

/* ================= PWA：Service Worker ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(
      () => { document.getElementById('sw-status').textContent = 'PWA ✓'; },
      () => { document.getElementById('sw-status').textContent = 'PWA 离线缓存未启用'; },
    );
  });
}

/* ================= 今天页：图片上传框（仅本地预览） ================= */
const inputImage = document.getElementById('input-image');
const imagePreview = document.getElementById('image-preview');
const dropImage = document.getElementById('drop-image');

inputImage.addEventListener('change', () => previewImages(inputImage.files));
['dragover', 'dragenter'].forEach((ev) => dropImage.addEventListener(ev, (e) => { e.preventDefault(); dropImage.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dropImage.addEventListener(ev, (e) => { e.preventDefault(); dropImage.classList.remove('over'); }));
dropImage.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) { inputImage.files = e.dataTransfer.files; previewImages(e.dataTransfer.files); }
});

function previewImages(files) {
  imagePreview.innerHTML = '';
  [...(files || [])].filter((f) => f.type.startsWith('image/')).slice(0, 12).forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = document.createElement('img');
      img.src = reader.result; img.alt = f.name; img.title = f.name;
      imagePreview.appendChild(img);
    };
    reader.readAsDataURL(f);
  });
  if (!imagePreview.children.length && files?.length) {
    imagePreview.innerHTML = '<span class="hint">所选文件不是图片，已忽略。</span>';
  }
}

/* ================= 今天页：GPX/TCX/KML 文件框（仅本地解析文件名） ================= */
const inputTrack = document.getElementById('input-track');
const trackList = document.getElementById('track-list');
const dropTrack = document.getElementById('drop-track');

inputTrack.addEventListener('change', () => listTracks(inputTrack.files));
['dragover', 'dragenter'].forEach((ev) => dropTrack.addEventListener(ev, (e) => { e.preventDefault(); dropTrack.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dropTrack.addEventListener(ev, (e) => { e.preventDefault(); dropTrack.classList.remove('over'); }));
dropTrack.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) { inputTrack.files = e.dataTransfer.files; listTracks(e.dataTransfer.files); }
});

function listTracks(files) {
  trackList.innerHTML = '';
  const arr = [...(files || [])];
  if (!arr.length) { trackList.innerHTML = '<li class="empty">暂无文件</li>'; return; }
  arr.slice(0, 20).forEach((f) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const ok = ['gpx', 'tcx', 'kml'].includes(ext);
    const li = document.createElement('li');
    li.innerHTML = `<span>${ok ? '✅' : '⚠️'} ${f.name}</span><span>${(f.size / 1024).toFixed(1)} KB</span>`;
    trackList.appendChild(li);
  });
}

/* ================= 示例数据（未接库前演示用，保留） ================= */
document.getElementById('btn-load-demo').addEventListener('click', () => {
  document.getElementById('stat-dist').textContent = '8.42';
  document.getElementById('stat-count').textContent = '1';
  document.getElementById('stat-days').textContent = '3';
});

/* =====================================================================
 * 数据层：sql.js-httpvfs 直读 data.db，失败降级读 data/workouts/*.csv
 * ---------------------------------------------------------------------
 * DB_CONFIG.dbUrl 相对 frontend/index.html：本地在 sport-db/ 根起服务时
 *   frontend/ -> ../data.db 恰好指向 sport-db/data.db（task-4 产物）。
 * Pages 发布时 sync.yml 会把 data.db 与 data/workouts/*.csv 一起拷贝进
 *   前端产物（./data.db + ./data/workouts/），因此初始化按候选顺序逐个试。
 * ===================================================================== */
const DB_CONFIG = {
  dbUrl: '../data.db', // task-6 约定：相对 frontend 的 data.db 路径（首选）
  workerUrl: 'https://cdn.jsdelivr.net/npm/sql.js-httpvfs@0.9.0/dist/sqlite.worker.js',
  wasmUrl: 'https://cdn.jsdelivr.net/npm/sql.js-httpvfs@0.9.0/dist/sql-wasm.wasm',
  requestChunkSize: 4096, // 与 build_db.py 的 page_size=1024 对齐，小块按需拉页
};

// data.db 候选地址（首个为 DB_CONFIG 约定值，其余兼容 Pages/直开 frontend 两种布局）
const DB_URL_CANDIDATES = [
  DB_CONFIG.dbUrl,
  './data.db',
  '../data/data.db', // 兼容旧占位写法指向的深层路径
  './data/data.db',
];
// CSV 降级基址候选：每项 + `workouts/<年>.csv` 逐个试（首个对应本地根服务布局）
const CSV_BASE_CANDIDATES = [
  '../data/',
  './data/',
  './data/data/',
  '../data/data/',
];

let _db = null;
let _dbUrl = '';
let _lastSource = 'none'; // 'httpvfs' | 'csv' | 'none'，供状态条与调试

function setDbStatus(text, ok) {
  const el = document.getElementById('db-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDuration(s) {
  s = Math.round(Number(s) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}
function yearsInRange(from, to) {
  const y0 = Number(String(from || '').slice(0, 4)), y1 = Number(String(to || '').slice(0, 4));
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return [new Date().getFullYear()];
  const out = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) out.push(y);
  return out;
}

/* ---------------- CSV 解析（支持引号包裹的 value_json 列） ---------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const push = () => { row.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') push();
    else if (c === '\n') { push(); rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  return rows.slice(1).filter((r) => r.length > 1 || (r[0] || '').trim() !== '')
    .map((r) => Object.fromEntries(header.map((h, k) => [h, (r[k] ?? '').trim()])));
}

/** CSV 行（import_mi.py 列名）归一化为与 data.db 查询一致的形状。 */
function normalizeCsvRow(r) {
  const distM = toNum(r.distance_m);
  const distKm = toNum(r.distance_km) ?? (distM != null ? distM / 1000 : null);
  return {
    id: r.id || '',
    date: r.date || '',
    start_time: toNum(r.start_utc ?? r.start_time),
    start_beijing: r.start_beijing || '',
    type: r.type || '',
    category: r.category || '',
    distance_m: distM,
    distance_km: distKm,
    duration_s: toNum(r.duration_s),
    avg_pace_s: toNum(r.avg_pace_s),
    avg_hr: toNum(r.avg_hr),
    calories: toNum(r.calories),
    steps: toNum(r.steps),
    source: r.source || 'mi_backup',
    file_path: r.file_path || '',
    confidence: toNum(r.confidence) ?? 1.0,
  };
}

async function fetchCsvYear(year) {
  const errors = [];
  for (const base of CSV_BASE_CANDIDATES) {
    const url = `${base}workouts/${year}.csv`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) { errors.push(`${url} HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      return { rows: parseCSV(text).map(normalizeCsvRow).filter((r) => r.date), url };
    } catch (err) {
      errors.push(`${url}: ${err.message || err}`);
    }
  }
  const e = new Error(`当年 CSV 不可读（已试 ${CSV_BASE_CANDIDATES.length} 个基址）：${errors.join('；')}`);
  e.csvErrors = errors;
  throw e;
}

/** 降级路径：按年份拉 CSV 并在内存中按日期范围过滤。 */
async function queryCsvWorkouts({ from, to } = {}) {
  const today = fmtDate(new Date());
  from = from || today; to = to || today;
  let all = [];
  let usedUrl = '';
  for (const y of yearsInRange(from, to)) {
    try {
      const { rows, url } = await fetchCsvYear(y);
      usedUrl = usedUrl || url;
      all = all.concat(rows);
    } catch (err) {
      // 某年缺文件不致命（比如跨年查询 chạm 到尚无文件的年份），继续其它年
      if (yearsInRange(from, to).length === 1) throw err;
    }
  }
  const out = all
    .filter((r) => r.date >= from && r.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start_time || 0) - (b.start_time || 0)));
  out.sourceUrl = usedUrl;
  return out;
}

/* ---------------- httpvfs 主路径 ---------------- */
function dbCandidates() {
  return [...new Set([DB_CONFIG.dbUrl, ...DB_URL_CANDIDATES])];
}

/** 初始化 httpvfs 查询 worker，逐个候选地址试到成功为止。 */
async function initDb() {
  if (_db) return _db;
  const lib = window.sqliteHttpvfs || self.sqliteHttpvfs;
  if (!lib || typeof lib.createDbWorker !== 'function') {
    throw new Error('sqlite-httpvfs 未加载：检查 index.html 底部 CDN script 是否放行（需联网）');
  }
  const errors = [];
  for (const url of dbCandidates()) {
    try {
      _db = await lib.createDbWorker(
        [{ from: 'inline', config: { serverMode: 'full', url, requestChunkSize: DB_CONFIG.requestChunkSize } }],
        DB_CONFIG.workerUrl,
        DB_CONFIG.wasmUrl,
      );
      // 连通性探针：读一行即算成功（data.db 不存在时这里抛错，换下一个候选）
      await _db.db.query('SELECT COUNT(*) AS n FROM workouts LIMIT 1');
      _dbUrl = url;
      setDbStatus(`data.db: 已连接 ✓ (${url})`, true);
      return _db;
    } catch (err) {
      errors.push(`${url}: ${err.message || err}`);
      _db = null;
    }
  }
  throw new Error(`data.db 不可读（已试 ${dbCandidates().join('、')}）：${errors.join('；')}`);
}

/** 行归一化：DB 列 -> 与 CSV 降级一致的形状（两者下游可互换）。 */
function normalizeDbRow(r) {
  const distM = toNum(r.distance_m);
  return {
    id: r.id || '',
    date: r.date || '',
    start_time: toNum(r.start_time),
    start_beijing: r.start_beijing || '',
    type: r.type || '',
    category: r.category || '',
    distance_m: distM,
    distance_km: toNum(r.distance_km) ?? (distM != null ? distM / 1000 : null),
    duration_s: toNum(r.duration_s),
    avg_pace_s: toNum(r.avg_pace_s),
    avg_hr: toNum(r.avg_hr),
    calories: toNum(r.calories),
    steps: toNum(r.steps),
    source: r.source || '',
    file_path: r.file_path || '',
    confidence: toNum(r.confidence) ?? 1.0,
  };
}

async function queryDbWorkouts({ from, to, limit = 2000 } = {}) {
  if (!_db) await initDb();
  const rows = await _db.db.query(
    `SELECT id, date, start_time, start_beijing, type, category,
            distance_m, distance_km, duration_s, avg_pace_s, avg_hr,
            calories, steps, source, file_path, confidence
       FROM workouts WHERE date BETWEEN ? AND ? ORDER BY date, start_time LIMIT ?`,
    [from, to, limit],
  );
  return (rows || []).map(normalizeDbRow);
}

/* ---------------- 统一查询入口 ---------------- */
/**
 * 按日期范围查询 workouts，主路径 httpvfs，失败自动降级读当年 CSV。
 * @returns {Promise<Array>} 归一化行数组（附加 .dataSource = 'httpvfs' | 'csv'）
 */
async function queryWorkouts({ from, to, limit = 2000 } = {}) {
  const today = fmtDate(new Date());
  from = from || today; to = to || today;
  try {
    const rows = await queryDbWorkouts({ from, to, limit });
    _lastSource = 'httpvfs';
    rows.dataSource = 'httpvfs';
    rows.dbUrl = _dbUrl;
    return rows;
  } catch (dbErr) {
    // data.db 尚不存在（task-4 未跑 / Pages 未拷贝 / 本地 file://）→ 降级 CSV
    const rows = await queryCsvWorkouts({ from, to });
    _lastSource = 'csv';
    rows.dataSource = 'csv';
    rows.dbUrl = rows.sourceUrl || '';
    rows.dbError = dbErr.message || String(dbErr);
    setDbStatus(`data.db 不可读，已降级 CSV ✓ (${rows.sourceUrl || 'workouts/年.csv'})`, true);
    return rows;
  }
}

/* ---------------- 聚合 + 视图渲染 ---------------- */
function sumKm(rows) {
  return rows.reduce((s, r) => s + (Number(r.distance_km) || 0), 0);
}

async function calcStreak(todayStr) {
  const end = new Date(todayStr + 'T12:00:00');
  const from = fmtDate(new Date(end.getTime() - 90 * 864e5));
  let rows = [];
  try { rows = await queryWorkouts({ from, to: todayStr }); }
  catch { return 0; }
  const active = new Set(rows.map((r) => r.date));
  let cursor = new Date(end);
  if (!active.has(fmtDate(cursor))) cursor = new Date(cursor.getTime() - 864e5); // 今天未练也算延续
  let streak = 0;
  while (active.has(fmtDate(cursor))) { streak++; cursor = new Date(cursor.getTime() - 864e5); }
  return streak;
}

function renderMonthList(rows, monthPrefix) {
  const tb = document.getElementById('month-tbody');
  if (!tb) return;
  const list = rows.filter((r) => r.date.startsWith(monthPrefix)).slice(-30).reverse();
  if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">本月暂无运动记录</td></tr>'; return; }
  tb.innerHTML = list.map((r) => {
    const km = r.distance_km != null ? (Number(r.distance_km)).toFixed(2) : '--';
    return `<tr><td>${r.date}</td><td>${r.type || '--'}</td><td>${km}</td><td>${r.duration_s != null ? fmtDuration(r.duration_s) : '--'}</td><td>${r.source || ''}</td></tr>`;
  }).join('');
}

function renderHeatmap(rows) {
  const grid = document.getElementById('heat-grid');
  if (!grid) return;
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) || 0) + (Number(r.distance_km) || 0));
  const today = new Date();
  const days = [];
  for (let i = 26 * 7 - 1; i >= 0; i--) days.push(new Date(today.getTime() - i * 864e5));
  // 按列（周）对齐：与占位一致用 grid-auto-flow: column
  grid.innerHTML = '';
  for (const d of days) {
    const km = byDate.get(fmtDate(d)) || 0;
    const c = document.createElement('i');
    c.className = km >= 15 ? 'lv4' : km >= 8 ? 'lv3' : km >= 3 ? 'lv2' : km > 0 ? 'lv1' : '';
    c.title = `${fmtDate(d)} ${km.toFixed(1)} km`;
    grid.appendChild(c);
  }
}

function renderAnnual(rows, year) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (!rows.length) { set('annual-dist', '--'); set('annual-count', '--'); set('annual-hours', '--'); set('annual-best', '--'); return; }
  const km = sumKm(rows);
  const hours = rows.reduce((s, r) => s + (Number(r.duration_s) || 0), 0) / 3600;
  const best = Math.max(...rows.map((r) => Number(r.distance_km) || 0));
  set('annual-dist', km.toFixed(1));
  set('annual-count', String(rows.length));
  set('annual-hours', hours.toFixed(1));
  set('annual-best', best.toFixed(2));
  void year;
}

/** 今天页聚合：填充 stat-dist / stat-count / stat-days，并顺带刷新日历/年报。 */
async function queryToday() {
  const now = new Date();
  const today = fmtDate(now);
  const monthPrefix = today.slice(0, 7);
  const year = today.slice(0, 4);
  const rows = await queryWorkouts({ from: today, to: today });
  const km = sumKm(rows);
  document.getElementById('stat-dist').textContent = km.toFixed(2);
  document.getElementById('stat-count').textContent = String(rows.length);
  document.getElementById('stat-days').textContent = String(await calcStreak(today));
  if (_lastSource === 'httpvfs') setDbStatus(`data.db: 已连接 ✓ (${_dbUrl || DB_CONFIG.dbUrl})`, true);
  // 日历当月列表 + 热力图（近 26 周）+ 年报：失败不阻塞今天页
  try {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthRows = await queryWorkouts({ from: fmtDate(firstDay), to: today });
    renderMonthList(monthRows, monthPrefix);
    const heatFrom = fmtDate(new Date(now.getTime() - 26 * 7 * 864e5));
    renderHeatmap(await queryWorkouts({ from: heatFrom, to: today }));
    renderAnnual(await queryWorkouts({ from: `${year}-01-01`, to: `${year}-12-31` }), year);
  } catch (err) {
    console.warn('[SportDB] 附属视图刷新失败（今天页数据正常）:', err);
  }
  return rows;
}

document.getElementById('btn-query-db').addEventListener('click', async () => {
  const btn = document.getElementById('btn-query-db');
  btn.disabled = true;
  btn.textContent = '查询中…';
  try {
    const rows = await queryToday();
    const tag = rows.dataSource === 'csv' ? `（CSV 降级：${rows.dbUrl || '当年.csv'}）` : `（${rows.dbUrl || DB_CONFIG.dbUrl}）`;
    btn.textContent = `已更新 ${rows.length} 条${tag}`;
  } catch (err) {
    console.error(err);
    setDbStatus('数据源不可读 ✗', false);
    alert(`查询失败：${err.message}\n\n本地验证：在 sport-db/ 根执行 python -m http.server，再用 http://localhost:8000/frontend/ 打开（file:// 下 fetch 会被浏览器拦截）。`);
    btn.textContent = '从 data.db 查询（预留）';
  } finally {
    btn.disabled = false;
  }
});

// 对外暴露，方便控制台调试 / 后续模块调用
window.SportDB = {
  DB_CONFIG, initDb, queryWorkouts, queryToday,
  get lastSource() { return _lastSource; },
  _debug: { fetchCsvYear, queryCsvWorkouts, dbCandidates, parseCSV, normalizeCsvRow },
};

// 首屏 best-effort 自刷新：有数据直接呈现，无数据保持占位骨架
window.addEventListener('load', () => {
  queryToday().catch((err) => console.warn('[SportDB] 首屏自动查询跳过:', err.message));
});

/* ================= 日历热力图占位（自动查询覆盖为真实格） ================= */
(function renderHeatPlaceholder() {
  const grid = document.getElementById('heat-grid');
  if (grid && grid.children.length) return; // 已有真实渲染则不动
  if (!grid) return;
  for (let i = 0; i < 26 * 7; i++) {
    const c = document.createElement('i');
    const r = Math.random();
    if (r > 0.93) c.className = 'lv4';
    else if (r > 0.85) c.className = 'lv3';
    else if (r > 0.72) c.className = 'lv2';
    else if (r > 0.55) c.className = 'lv1';
    grid.appendChild(c);
  }
})();
