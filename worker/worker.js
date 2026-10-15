/**
 * sport-db Bot桥 Worker（无依赖，Cloudflare Workers 原生 fetch/Request/Response）。
 *
 * 双接入：
 *   POST /tg     Telegram webhook。校验请求头
 *                X-Telegram-Bot-Api-Secret-Token === TG_SECRET，通过后取
 *                message.text（兼容 edited_message）。
 *                兜底说明见 README（长轮询 getUpdates，不能与 webhook 并存）。
 *   POST /feishu  飞书事件订阅。type === "url_verification" 时原样回
 *                {"challenge": "..."}；header.event_type ===
 *                "im.message.receive_v1" 时从 event.message 取文本
 *                （text 型 content 是 "{\"text\":\"...\"}" JSON 字符串）。
 *
 * 统一逻辑（方案A：GitHub 即数据库）：
 *   读：优先 GitHub Contents API（强一致，写后立即可见），raw 兜底；
 *   写：update_workout 经 Contents API 读-改-写全文件，带 sha 乐观锁，
 *   409/422 重读重试一次；改库规则写进 system prompt 引导 Agent
 *  （先 query 到 id，一次只改用户明确说的字段，改完报旧值->新值）。
 *   会话记忆同样回写 bot_state/tg_history/（读 8 轮，存 12 轮/6000 字）。
 *   Telegram 经 Bot API sendMessage 回，飞书先取 tenant_access_token 再回。
 *
 * 密钥只放 Worker secrets：
 *   TG_BOT_TOKEN / TG_SECRET / GH_PAT（细粒度 PAT，仅 sport-db 的 Contents 读写）
 *   / FEISHU_APP_ID / FEISHU_APP_SECRET
 * 非密钥放 [vars]：REPO / VISION_ENDPOINT / VISION_MODEL。
 */

// ------------------------------------------------------------------ CSV
// 最小 CSV 解析器（处理引号包裹与 doubled-quote 转义，够解析 workouts/daily）。
function parseCSV(text) {
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ""; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const RUN_TYPES = ['outdoor_running', 'indoor_running', 'outdoor_run_class'];
const EDITABLE_FIELDS = ['distance_m', 'duration_s', 'avg_pace_s', 'avg_hr',
  'max_hr', 'min_hr', 'calories', 'steps', 'cadence', 'type'];

// ------------------------------------------------------------ GitHub 库
// 方案A：GitHub 即数据库。读优先 Contents API（强一致），raw 兜底；
// 写走 Contents API 全文件读-改-写，sha 不对（409/422）重读重试一次。
function utf8ToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghHeaders(env) {
  const h = { "Content-Type": "application/json", "User-Agent": "sport-db-worker/1.0" };
  if (env.GH_PAT) h.Authorization = `Bearer ${env.GH_PAT}`;
  return h;
}

// 读文件：{text, sha}；不存在返回 null。无 GH_PAT 时退回 raw（公开仓可读）。
async function ghGetFile(env, path) {
  if (env.GH_PAT) {
    try {
      const r = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}?ref=main`, {
        headers: ghHeaders(env),
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub读 ${path} 失败 ${r.status}`);
      const j = await r.json();
      if (j.type !== "file" || !j.content) return null;
      return { text: b64ToUtf8(j.content), sha: j.sha };
    } catch (e) {
      if (String(e.message || e).startsWith("GitHub读")) throw e;
      // fallthrough → raw
    }
  }
  const t = await fetchText(`https://raw.githubusercontent.com/${env.REPO}/main/${path}`);
  return t ? { text: t, sha: "" } : null;
}

// 写文件：需 sha（新建传空）。成功返回新 sha；sha 过期抛 Conflict。
async function ghPutFile(env, path, text, sha, message) {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，写库不可用");
  const body = { message, content: utf8ToB64(text), branch: "main" };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(body),
  });
  if (r.status === 409 || r.status === 422) {
    const t = await r.text();
    throw new Error(`Conflict:${t.slice(0, 160)}`);
  }
  if (!r.ok) throw new Error(`GitHub写 ${path} 失败 ${r.status}`);
  const j = await r.json();
  return (j.content || {}).sha || "";
}

// ------------------------------------------------------------ 数据摘要
async function fetchText(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
}

// 近 30 天训练摘要 + 每日数据覆盖天数。全部拉取失败时返回降级文本。
async function buildSummary(env) {
  const now = new Date();
  const y0 = now.getUTCFullYear(), y1 = y0 - 1;
  const cutoff = Date.now() - 30 * 864e5;
  const base = `https://raw.githubusercontent.com/${env.REPO}/main`;
  // 优先 Contents API（写后立即可见，无 CDN 缓存）；失败退回 raw。
  const [w0, w1, d0, d1] = await Promise.all([
    ghGetFile(env, `data/workouts/${y0}.csv`).catch(() => null),
    ghGetFile(env, `data/workouts/${y1}.csv`).catch(() => null),
    ghGetFile(env, `data/daily/${y0}.csv`).catch(() => null),
    ghGetFile(env, `data/daily/${y1}.csv`).catch(() => null),
  ]).then(async (got) => {
    if (got.every((g) => g && g.text)) return got.map((g) => g.text);
    return await Promise.all([
      fetchText(`${base}/data/workouts/${y0}.csv`),
      fetchText(`${base}/data/workouts/${y1}.csv`),
      fetchText(`${base}/data/daily/${y0}.csv`),
      fetchText(`${base}/data/daily/${y1}.csv`),
    ]);
  });
  const workouts = [...parseCSV(w0), ...parseCSV(w1)];
  const daily = [...parseCSV(d0), ...parseCSV(d1)];
  if (!workouts.length && !daily.length) {
    return "（近30天数据拉取失败：raw.githubusercontent 不可达，请稍后再问）";
  }
  const recent = workouts.filter((w) => Number(w.start_utc || 0) * 1000 >= cutoff);
  const kmByType = {};
  const RUN_TYPES = ['outdoor_running', 'indoor_running', 'outdoor_run_class'];
  let secs = 0; const byGrp = {};
  const days = new Set();
  let last = null;
  const grpOf = (t) => {
    t = t || '';
    if (RUN_TYPES.includes(t)) return '跑步';
    if (t.includes('riding')) return '骑行';
    if (t.includes('walk')) return '步行';
    if (t.includes('swim')) return '游泳';
    if (t.includes('skip')) return '跳绳';
    return '综合训练';
  };
  for (const w of recent) {
    const g = grpOf(w.type);
    (byGrp[g] = byGrp[g] || []).push(w);
    secs += num(w.duration_s);
    if (w.date) days.add(w.date);
    if (!last || Number(w.start_utc) > Number(last.start_utc)) last = w;
  }
  const todayBj = new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
  const fmtPace = (s) => `${Math.floor(s / 60)}'${String(Math.round(s % 60)).padStart(2, '0')}` + '”/km';
  const lines = [`近30天共运动${recent.length}次，活跃${days.size}天（今天${todayBj}）。`];
  const runs = byGrp['跑步'] || [];
  if (runs.length) {
    const pd = runs.reduce((a, w) => a + num(w.distance_m), 0);
    const pt = runs.reduce((a, w) => a + num(w.duration_s), 0);
    const hrs = runs.map((w) => num(w.avg_hr)).filter((x) => x);
    let seg = `跑步${runs.length}次共${(pd / 1000).toFixed(1)}km`;
    if (pd > 0 && pt > 0) seg += `，均配速${fmtPace(pt / (pd / 1000))}`;
    if (hrs.length) seg += `，均心率${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}bpm`;
    lines.push(seg + '。');
  }
  for (const name of ['骑行', '步行', '游泳', '跳绳', '综合训练']) {
    const rs = byGrp[name] || [];
    if (rs.length) lines.push(`${name}${rs.length}次共${(rs.reduce((a, w) => a + num(w.distance_m), 0) / 1000).toFixed(1)}km。`);
  }
  if (last) lines.push(`最近一次：${last.date} ${grpOf(last.type)} ${(num(last.distance_m) / 1000).toFixed(2)}km 用时 ${Math.round(num(last.duration_s) / 60)}min。`);
  const dailyDays = new Set(daily.filter((d) => Date.parse(d.time_beijing || d.date || '') >= cutoff).map((d) => (d.time_beijing || d.date || '').slice(0, 10)));
  lines.push(`每日健康数据覆盖 ${dailyDays.size} 天`);
  return lines.join(String.fromCharCode(10));
}

// 会话历史：bot_state/tg_history/<key>.json。
// 读优先 Contents API（刚写完立刻可见），raw 兜底；写走 Contents API。
// 无 GH_PAT 时只读不写（记忆退化为同轮有效）。
function histPath(key) {
  return `bot_state/tg_history/${key}.json`;
}

function cleanHist(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

async function fetchHistory(env, key) {
  try {
    const g = await ghGetFile(env, histPath(key)).catch(() => null);
    if (g && g.text) {
      try { return cleanHist(JSON.parse(g.text)).slice(-8); } catch { return []; }
    }
  } catch { /* fallthrough */ }
  return [];
}

async function saveHistory(env, key, hist) {
  if (!env.GH_PAT) return false;
  const kept = cleanHist(hist);
  let total = kept.reduce((a, m) => a + m.content.length, 0);
  while (kept.length > 2 && total > 6000) {
    total -= kept.shift().content.length;
  }
  const path = histPath(key);
  const text = JSON.stringify(kept);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cur = await ghGetFile(env, path).catch(() => null);
      await ghPutFile(env, path, text, cur ? cur.sha : "",
        `bot: 会话记忆 ${key} (${new Date().toISOString().slice(0, 10)})`);
      return true;
    } catch (e) {
      if (!String(e.message || e).startsWith("Conflict:") || attempt === 1) return false;
    }
  }
  return false;
}

// ----------------------------------------------------------------- Agent
const AGENT_SYS = "你是一名懂数据的跑步教练，也是这个运动库的管理员，用简短口语中文回答（200字内）。"
  + "规则：只用数据说话，跑步是跑步、骑行是骑行，配速只谈跑步；"
  + "先给一句话结论，再给1-2条带数字的具体建议；"
  + "摘要里没有的就说不知道，不编数据；只谈训练恢复。"
  + "改库规则：用户说改数时，必须先调 query_workouts 找到那条的 id 再调 update_workout，"
  + "一次只改用户明确说的字段，改完用中文报出改了哪条、旧值->新值；不确定的先问。";

const AGENT_TOOLS = [
  { type: "function",
    function: { name: "get_summary",
      description: "查近N天分项画像（跑步/骑行分开）。画像里已有30天摘要，要其它天数才调。",
      parameters: { type: "object", properties: {
        days: { type: "integer", description: "近N天，1-90" } } } } },
  { type: "function",
    function: { name: "query_workouts",
      description: "按条件查原始记录明细（含id）。改数据前必须先查到id。",
      parameters: { type: "object", properties: {
        type: { type: "string", description: "如 outdoor_running，不限填空" },
        date_from: { type: "string", description: "YYYY-MM-DD" },
        date_to: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", description: "默认10，最多30" } } } } },
  { type: "function",
    function: { name: "update_workout",
      description: "按id改一条记录。只能改用户明确说的字段，先query确认。",
      parameters: { type: "object", properties: {
        id: { type: "string", description: "query_workouts 给的id" },
        fields: { type: "object",
          description: "字段名->新值，允许：距离米distance_m/秒duration_s/配速avg_pace_s/心率avg_hr,max_hr,min_hr/卡路里calories/步数steps/步频cadence/类型type" } } } } },
];

// 当年+去年 workouts 全读进内存做工具查询（个人量级，单文件<1MB）。
async function loadWorkouts(env) {
  const now = new Date();
  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1];
  const out = [];
  for (const y of years) {
    const g = await ghGetFile(env, `data/workouts/${y}.csv`).catch(() => null);
    if (g && g.text) {
      for (const r of parseCSV(g.text)) { r._year = y; out.push(r); }
    }
  }
  return out;
}

function toolGetSummary(all, args) {
  let d = parseInt(args.days, 10);
  if (!Number.isFinite(d)) d = 30;
  d = Math.min(90, Math.max(1, d));
  const cut = new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
  const since = new Date(Date.parse(cut) - (d - 1) * 864e5).toISOString().slice(0, 10);
  const recent = all.filter((r) => (r.date || "") >= since);
  if (!recent.length) return `近${d}天无运动记录。`;
  const grpOf = (t) => {
    t = t || "";
    if (RUN_TYPES.includes(t)) return "跑步";
    if (t.includes("riding")) return "骑行";
    if (t.includes("walk")) return "步行";
    if (t.includes("swim")) return "游泳";
    if (t.includes("skip")) return "跳绳";
    return "综合训练";
  };
  const byGrp = {};
  for (const r of recent) {
    const g = grpOf(r.type);
    (byGrp[g] = byGrp[g] || []).push(r);
  }
  const lines = [`近${d}天共运动${recent.length}次。`];
  const runs = byGrp["跑步"] || [];
  if (runs.length) {
    const pd = runs.reduce((a, w) => a + num(w.distance_m), 0);
    const pt = runs.reduce((a, w) => a + num(w.duration_s), 0);
    const hrs = runs.map((w) => num(w.avg_hr)).filter((x) => x);
    let seg = `跑步${runs.length}次共${(pd / 1000).toFixed(1)}km`;
    if (pd > 0 && pt > 0) {
      const p = pt / (pd / 1000);
      seg += `，均配速${Math.floor(p / 60)}'${String(Math.round(p % 60)).padStart(2, "0")}”/km`;
    }
    if (hrs.length) seg += `，均心率${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}bpm`;
    lines.push(seg + "。");
  }
  for (const name of ["骑行", "步行", "游泳", "跳绳", "综合训练"]) {
    const rs = byGrp[name] || [];
    if (rs.length) {
      lines.push(`${name}${rs.length}次共${(rs.reduce((a, w) => a + num(w.distance_m), 0) / 1000).toFixed(1)}km。`);
    }
  }
  return lines.join(String.fromCharCode(10));
}

function toolQueryWorkouts(all, args) {
  let lim = parseInt(args.limit, 10);
  if (!Number.isFinite(lim)) lim = 10;
  lim = Math.min(30, Math.max(1, lim));
  const out = [];
  for (const r of all) {
    if (args.type && r.type !== args.type) continue;
    if (args.date_from && (r.date || "") < args.date_from) continue;
    if (args.date_to && (r.date || "") > args.date_to) continue;
    out.push({ id: r.id, date: r.date, type: r.type, distance_m: r.distance_m,
      duration_s: r.duration_s, avg_pace_s: r.avg_pace_s, avg_hr: r.avg_hr,
      max_hr: r.max_hr, steps: r.steps, source: r.source });
  }
  out.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
  return JSON.stringify(out.slice(-lim));
}

// CSV 行转回文本（只替换目标列，保持其余列与引号原样，用解析器重建）。
function stringifyCSV(head, rows) {
  const esc = (v) => {
    v = v == null ? "" : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return head.map(esc).join(",") + "\n"
    + rows.map((r) => head.map((h) => esc(r[h])).join(",")).join("\n") + "\n";
}

async function toolUpdateWorkout(env, all, actor, args) {
  const wid = String(args.id || "").trim();
  const fields = args.fields || {};
  if (!wid || typeof fields !== "object" || !Object.keys(fields).length) {
    return "失败：缺 id 或 fields 为空。";
  }
  const bad = Object.keys(fields).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (bad.length) return `失败：不允许改 ${bad.join(",")}，只能改 ${EDITABLE_FIELDS.join(",")}。`;
  const hit = all.find((r) => r.id === wid);
  if (!hit) return `失败：找不到 id=${wid}，先调 query_workouts 确认。`;
  const path = `data/workouts/${hit._year}.csv`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await ghGetFile(env, path).catch(() => null);
    if (!cur || !cur.text) return `失败：读 ${path} 失败，重试一次。`;
    const parsed = parseCSV(cur.text);
    if (!parsed.length) return `失败：${path} 为空或解析失败。`;
    const header = Object.keys(parsed[0]);
    const idx = parsed.findIndex((r) => r.id === wid);
    if (idx < 0) return `失败：${path} 里找不到 id=${wid}（可能刚被改动），请重查。`;
    const row = parsed[idx];
    const old = {};
    for (const k of Object.keys(fields)) old[k] = row[k] ?? "";
    for (const [k, v] of Object.entries(fields)) row[k] = (v == null ? "" : String(v));
    if (fields.type !== undefined) row.category = fields.type;
    const next = stringifyCSV(header, parsed);
    try {
      await ghPutFile(env, path, next, cur.sha || "",
        `bot: update ${wid} ${Object.keys(fields).join(",")} via ${actor}`);
      return `已改 ${wid}（${row.date} ${row.type}）：`
        + Object.keys(fields).map((k) => `${k} ${old[k]}->${row[k]}`).join("；");
    } catch (e) {
      if (!String(e.message || e).startsWith("Conflict:") || attempt === 1) {
        return `失败：写回冲突或接口错误（${String(e.message || e).slice(0, 120)}），请重说一次。`;
      }
    }
  }
  return "失败：连续冲突，请稍后再试。";
}

async function chatCall(env, messages, tools) {
  const body = { model: env.VISION_MODEL || "muse-spark-1.3-contributor-free", messages };
  if (tools) body.tools = tools;
  const r = await fetch(env.VISION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`模型接口 ${r.status}`);
  return (await r.json()).choices[0].message;
}

// Agent 循环：问答+工具（查数、改数），最多 4 轮工具调用。
async function runAgent(env, question, profile, history, actor) {
  const all = await loadWorkouts(env);
  const messages = [{ role: "system", content: AGENT_SYS + "\\n用户画像（近30天摘要）：\\n" + profile }];
  for (const m of (history || []).slice(-8)) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: question });
  const fns = {
    get_summary: (a) => toolGetSummary(all, a || {}),
    query_workouts: (a) => toolQueryWorkouts(all, a || {}),
    update_workout: (a) => toolUpdateWorkout(env, all, actor, a || {}),
  };
  for (let step = 0; step < 4; step++) {
    const msg = await chatCall(env, messages, AGENT_TOOLS);
    const calls = msg.tool_calls || [];
    const text = (msg.content || "").trim();
    if (!calls.length) return text || "刚没想出来，换个问法再试一次？";
    messages.push({ role: "assistant", content: text, tool_calls: calls });
    for (const c of calls) {
      const fn = (c.function || {}).name || "";
      let argv = {};
      try { argv = JSON.parse((c.function || {}).arguments || "{}"); } catch { argv = {}; }
      let result;
      try {
        result = fns[fn] ? await fns[fn](argv) : `未知工具 ${fn}`;
      } catch (e) {
        result = `工具 ${fn} 出错：${e.message || e}`;
      }
      messages.push({ role: "tool", tool_call_id: c.id || "", content: String(result).slice(0, 4000) });
    }
  }
  const tail = await chatCall(env, messages.concat([
    { role: "user", content: "按上面工具结果直接给用户最终答复。" },
  ]));
  return ((tail.content || "").trim()) || "查到了，但组织回答时卡住了，再问我一次？";
}

// -------------------------------------------------------------- 通道发送
async function tgSend(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function feishuToken(env) {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = await r.json();
  if (data.code !== 0) throw new Error(`飞书鉴权失败 code=${data.code} msg=${data.msg}`);
  return data.tenant_access_token;
}

async function feishuSend(env, chatId, text) {
  const token = await feishuToken(env);
  await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
}

// 飞书 text 消息 content 是 "{\"text\":\"...\"}" JSON 字符串
function feishuText(message) {
  if (!message) return "";
  if (message.message_type !== "text") return ""; // 暂只回纯文本
  try {
    return JSON.parse(message.content || "{}").text || "";
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ 入口
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response("sport-db bot bridge OK. POST /tg (Telegram) | POST /feishu (Feishu)\n");
    }

    // ---------------- Telegram webhook ----------------
    if (url.pathname === "/tg" && request.method === "POST") {
      if (env.TG_SECRET) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== env.TG_SECRET) return new Response("forbidden", { status: 403 });
      }
      let update = {};
      try { update = await request.json(); } catch { return new Response("bad update", { status: 400 }); }
      const msg = update.message || update.edited_message || {};
      const text = (msg.text || "").trim();
      const chatId = msg.chat?.id;
      if (!chatId) return new Response("no chat", { status: 200 });
      if (!text) { await tgSend(env, chatId, "发我一句话吧，比如：总结一下我最近的运动情况"); return new Response("ok"); }
      try {
        const key = `tg-${chatId}`;
        const hist = await fetchHistory(env, key);
        const reply = await runAgent(env, text, await buildSummary(env), hist, `tg:${chatId}`);
        await tgSend(env, chatId, reply.slice(0, 3500));
        await saveHistory(env, key, hist.concat([
          { role: "user", content: text.slice(0, 2000) },
          { role: "assistant", content: reply.slice(0, 2000) },
        ]));
      } catch (e) {
        await tgSend(env, chatId, `抱歉，刚才处理失败（${e.message}），请稍后重试。`);
      }
      return new Response("ok");
    }

    // ---------------- 飞书事件订阅 ----------------
    if (url.pathname === "/feishu" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { return new Response("bad event", { status: 400 }); }
      // 首次订阅验证：原样返回 challenge
      if (body.type === "url_verification") {
        return Response.json({ challenge: body.challenge });
      }
      if (body?.header?.event_type === "im.message.receive_v1") {
        const text = feishuText(body.event?.message).trim();
        const chatId = body.event?.message?.chat_id;
        if (chatId && text && !text.startsWith("[") /* 跳过卡片/系统回声 */) {
          try {
            const key = `fs-${chatId}`;
            const hist = await fetchHistory(env, key);
            const reply = await runAgent(env, text, await buildSummary(env), hist, `fs:${chatId}`);
            await feishuSend(env, chatId, reply.slice(0, 3500));
            await saveHistory(env, key, hist.concat([
              { role: "user", content: text.slice(0, 2000) },
              { role: "assistant", content: reply.slice(0, 2000) },
            ]));
          } catch (e) {
            await feishuSend(env, chatId, `抱歉，刚才处理失败（${e.message}），请稍后重试。`).catch(() => {});
          }
        }
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
