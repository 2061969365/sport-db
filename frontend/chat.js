/* 运动库 SportDB — 独立聊天页（task-9）
 * 不依赖 app.js（app.js 顶层读写首页 DOM，聊天页独立加载更稳）；
 * 数据摘要逻辑与 app.js / worker/worker.js 对齐：
 *   CSV 列名与 scripts/import_mi.py 一致（date,type,distance_m,duration_s,
 *   avg_pace_s,avg_hr,start_utc...），摘要口径与 worker.js summarize() 一致。
 * 调模型约定与 worker.js askModel 一致：POST VISION_ENDPOINT
 *   (/v1/chat/completions，免 Key，不带 Authorization，不传 max_tokens)。
 */
'use strict';

/* ================= 常量（可改） ================= */
const VISION_MODEL_DEFAULT = 'muse-spark-1.3-contributor-free';
const VISION_ENDPOINT_DEFAULT = ''; // 无默认网关：在页面设置里填写后存 localStorage
const LS_HISTORY = 'sportdb.chat.history.v1';
const LS_CONFIG = 'sportdb.chat.config.v1';
const HISTORY_CONTEXT_N = 8; // 发送时附带最近 N 条历史作多轮上下文
const REPLY_CLIP = 3500; // 与 worker.js 一致的单条上限内裁剪

/* CSV 降级基址候选（与 app.js 一致，兼容本地根服务 / Pages 两种布局） */
const CSV_BASE_CANDIDATES = [
  '../data/',
  './data/',
  './data/data/',
  '../data/data/',
];

/* ================= 小工具 ================= */
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ================= 配置（localStorage） ================= */
function loadConfig() {
  try {
    return Object.assign(
      { endpoint: VISION_ENDPOINT_DEFAULT, model: VISION_MODEL_DEFAULT },
      JSON.parse(localStorage.getItem(LS_CONFIG) || '{}'),
    );
  } catch { return { endpoint: VISION_ENDPOINT_DEFAULT, model: VISION_MODEL_DEFAULT }; }
}
function saveConfig(cfg) {
  localStorage.setItem(LS_CONFIG, JSON.stringify(cfg));
}

/* ================= 历史（localStorage） ================= */
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
    return Array.isArray(arr) ? arr.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
  } catch { return []; }
}
function saveHistory(arr) {
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(-100))); } catch {}
}

/* ================= CSV 解析（与 app.js 同款，支持引号包裹列） ================= */
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

async function fetchCsvYear(year) {
  const errors = [];
  for (const base of CSV_BASE_CANDIDATES) {
    const url = `${base}workouts/${year}.csv`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) { errors.push(`${url} HTTP ${resp.status}`); continue; }
      return { text: await resp.text(), url };
    } catch (err) {
      errors.push(`${url}: ${(err && err.message) || err}`);
    }
  }
  const e = new Error(`当年 CSV 不可读：${errors.join('；')}`);
  throw e;
}

/* ================= 近30天分项摘要（口径与 build_report 对齐） ================= */
const RUN_TYPES = ['outdoor_running', 'indoor_running', 'outdoor_run_class'];
function grpOf(t) {
  t = t || '';
  if (RUN_TYPES.includes(t)) return '跑步';
  if (t.includes('riding')) return '骑行';
  if (t.includes('walk')) return '步行';
  if (t.includes('swim')) return '游泳';
  if (t.includes('skip')) return '跳绳';
  return '综合训练';
}
function fmtPace(s) {
  return `${Math.floor(s / 60)}'${String(Math.round(s % 60)).padStart(2, '0')}` + '”/km';
}
function summarizeRows(recent) {
  const byGrp = {}, days = new Set();
  let last = null;
  for (const w of recent) {
    const g = grpOf(w.type);
    (byGrp[g] = byGrp[g] || []).push(w);
    if (w.date) days.add(w.date);
    if (!last || Number(w.start_utc) > Number(last.start_utc)) last = w;
  }
  const lines = [`近30天共运动${recent.length}次，活跃${days.size}天（今天${fmtDate(new Date())}）。`];
  const runs = byGrp['跑步'] || [];
  if (runs.length) {
    const pd = runs.reduce((a, w) => a + (toNum(w.distance_m) || 0), 0);
    const pt = runs.reduce((a, w) => a + (toNum(w.duration_s) || 0), 0);
    const hrs = runs.map((w) => toNum(w.avg_hr)).filter((x) => x != null);
    let seg = `跑步${runs.length}次共${(pd / 1000).toFixed(1)}km`;
    if (pd > 0 && pt > 0) seg += `，均配速${fmtPace(pt / (pd / 1000))}`;
    if (hrs.length) seg += `，均心率${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}bpm`;
    lines.push(seg + '。');
  }
  for (const name of ['骑行', '步行', '游泳', '跳绳', '综合训练']) {
    const rs = byGrp[name] || [];
    if (rs.length) lines.push(`${name}${rs.length}次共${(rs.reduce((a, w) => a + (toNum(w.distance_m) || 0), 0) / 1000).toFixed(1)}km。`);
  }
  if (last) lines.push(`最近一次：${last.date} ${grpOf(last.type)} ${((toNum(last.distance_m) || 0) / 1000).toFixed(2)}km 用时 ${Math.round((toNum(last.duration_s) || 0) / 60)}min。`);
  return lines.join(String.fromCharCode(10));
}

async function buildSummary30d() {
  const now = new Date();
  const to = fmtDate(now);
  const from = fmtDate(new Date(now.getTime() - 29 * 864e5));
  const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])];
  let all = [];
  for (const y of years) {
    try {
      const { text } = await fetchCsvYear(y);
      all = all.concat(parseCSV(text));
    } catch (err) {
      if (years.length === 1) throw err; // 单年查询：缺文件即整体失败
    }
  }
  const recent = all.filter((r) => r.date >= from && r.date <= to);
  return summarizeRows(recent);
}

/* ================= 直调模型（免 Key，不传 max_tokens） ================= */
async function askModel(endpoint, model, summary, history, question) {
  const messages = [
    { role: 'system', content: '你是一名懂数据的跑步教练，用简短口语中文回答（200字内）。规则：只用摘要数据说话，跑步是跑步、骑行是骑行，配速只谈跑步；先给一句话结论，再给1-2条带数字的具体建议；摘要里没有的就说不知道，不编数据；只谈训练恢复。以下是该用户近30天运动摘要：\n' + summary },
    ...history.slice(-HISTORY_CONTEXT_N).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.3, messages }),
  });
  if (!r.ok) throw new Error(`模型接口 HTTP ${r.status}`);
  const data = await r.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content;
  if (!text) throw new Error('模型返回为空');
  return String(text).slice(0, REPLY_CLIP);
}

/* ================= 页面逻辑 ================= */
const logEl = document.getElementById('chat-log');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('btn-send');
const summaryEl = document.getElementById('chat-summary');
const endpointEl = document.getElementById('cfg-endpoint');
const modelEl = document.getElementById('cfg-model');
const hintEl = document.getElementById('cfg-hint');

let history = loadHistory();
let sending = false;

(function initSettings() {
  const cfg = loadConfig();
  endpointEl.value = cfg.endpoint || '';
  modelEl.value = cfg.model || VISION_MODEL_DEFAULT;
  endpointEl.placeholder = 'https://你的网关/v1/chat/completions';
  hintEl.textContent = cfg.endpoint
    ? `当前 endpoint 已保存，模型 ${cfg.model || VISION_MODEL_DEFAULT}`
    : '尚未配置 endpoint：发送前请填写网关地址（/v1/chat/completions，免 Key）。';
})();

document.getElementById('btn-save-cfg').addEventListener('click', () => {
  const cfg = { endpoint: endpointEl.value.trim(), model: modelEl.value.trim() || VISION_MODEL_DEFAULT };
  saveConfig(cfg);
  hintEl.textContent = cfg.endpoint
    ? `已保存：${cfg.endpoint}，模型 ${cfg.model}`
    : '已保存（endpoint 为空时无法发送，请填写）。';
});

document.getElementById('btn-clear').addEventListener('click', () => {
  history = [];
  saveHistory(history);
  renderAll();
});

function bubble(role, text, cls) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}${cls ? ' ' + cls : ''}`;
  div.textContent = text; // textContent 天然防 XSS
  return div;
}

function renderAll() {
  logEl.innerHTML = '';
  if (!history.length) {
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.textContent = '还没有聊天记录，问点什么开始吧 👇';
    logEl.appendChild(tip);
    return;
  }
  for (const m of history) logEl.appendChild(bubble(m.role, m.content));
  logEl.scrollTop = logEl.scrollHeight;
}

function addErrorWithRetry(question, errText) {
  const div = document.createElement('div');
  div.className = 'msg bot error';
  const span = document.createElement('span');
  span.textContent = `发送失败：${errText}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'retry';
  btn.textContent = '重试';
  btn.addEventListener('click', () => {
    div.remove();
    send(question, true);
  });
  div.appendChild(span);
  div.appendChild(document.createElement('br'));
  div.appendChild(btn);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function refreshSummary() {
  try {
    summaryEl.textContent = await buildSummary30d();
  } catch (err) {
    summaryEl.textContent = `近30天数据不可读（${(err && err.message) || err}）。\n本地验证：在 sport-db/ 根执行 python -m http.server 后重试；仍可直接提问（摘要缺失会如实告知模型）。`;
  }
}

async function send(question, isRetry) {
  question = (question || '').trim();
  if (!question || sending) return;
  const cfg = loadConfig();
  if (!cfg.endpoint) {
    if (!isRetry) {
      history.push({ role: 'user', content: question, ts: Date.now() });
      saveHistory(history);
      renderAll();
    }
    addErrorWithRetry(question, '未配置 VISION_ENDPOINT，请先在上方设置里填写网关地址后重试。');
    document.querySelector('details.settings').open = true;
    return;
  }
  sending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '发送中…';
  try {
    if (!isRetry) {
      history.push({ role: 'user', content: question, ts: Date.now() });
      saveHistory(history);
      renderAll();
    }
    const thinking = bubble('bot', '思考中…', 'thinking');
    logEl.appendChild(thinking);
    logEl.scrollTop = logEl.scrollHeight;

    let summary;
    try {
      summary = await buildSummary30d();
      summaryEl.textContent = summary;
    } catch (err) {
      summary = `（注：近30天本地数据不可读：${(err && err.message) || err}，请基于通用知识回答并提醒用户检查数据服务。）`;
    }
    const reply = await askModel(cfg.endpoint, cfg.model || VISION_MODEL_DEFAULT, summary, history, question);
    thinking.remove();
    history.push({ role: 'assistant', content: reply, ts: Date.now() });
    saveHistory(history);
    renderAll();
  } catch (err) {
    logEl.querySelectorAll('.thinking').forEach((el) => el.remove());
    addErrorWithRetry(question, (err && err.message) || String(err));
  } finally {
    sending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = '发送';
    inputEl.focus();
  }
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = inputEl.value;
  inputEl.value = '';
  send(q, false);
});

renderAll();
refreshSummary();
