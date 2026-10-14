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
 * 统一逻辑：
 *   从 raw.githubusercontent.com 拉当年 + 去年
 *   data/workouts/*.csv 与 data/daily/*.csv，算近 30 天摘要，
 *   连同用户问题一起调 VISION_ENDPOINT/VISION_MODEL
 *   （默认 muse-spark-1.3-contributor-free，网关免 Key，不设 max_tokens），
 *   Telegram 经 Bot API sendMessage 回，飞书先取 tenant_access_token 再回。
 *
 * 密钥只放 Worker secrets：
 *   TG_BOT_TOKEN / TG_SECRET / FEISHU_APP_ID / FEISHU_APP_SECRET
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
  const [w0, w1, d0, d1] = await Promise.all([
    fetchText(`${base}/data/workouts/${y0}.csv`),
    fetchText(`${base}/data/workouts/${y1}.csv`),
    fetchText(`${base}/data/daily/${y0}.csv`),
    fetchText(`${base}/data/daily/${y1}.csv`),
  ]);
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
  return lines.join(String.fromCharCode(10)); // 上面数组已直接拼成 lines"\n");
}

// 会话历史：读公开仓 bot_state/tg_history/<key>.json（轮询桥回写）。
// Worker 无写权限（要回写需配 GitHub PAT，见 README），读不到按无历史处理。
async function fetchHistory(env, key) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${env.REPO}/main/bot_state/tg_history/${key}.json`);
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------- LLM
async function askModel(env, summary, question, history) {
  const r = await fetch(env.VISION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 网关免 Key：不带 Authorization；不限 max_tokens（不传该字段）。
    body: JSON.stringify({
      model: env.VISION_MODEL || "muse-spark-1.3-contributor-free",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: "你是一名懂数据的跑步教练，用简短口语中文回答（200字内）。规则：只用摘要数据说话，跑步是跑步、骑行是骑行，配速只谈跑步；先给一句话结论，再给1-2条带数字的具体建议；摘要里没有的就说不知道，不编数据；只谈训练恢复。以下是该用户近30天运动摘要：\n" + summary,
        },
        ...(history || []),
        { role: "user", content: question || "总结一下我最近的运动情况" },
      ],
    }),
  });
  if (!r.ok) throw new Error(`模型接口 ${r.status}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("模型返回为空");
  return String(text).slice(0, 3500); // Telegram 单条 4096 上限内
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
        const hist = await fetchHistory(env, `tg-${chatId}`);
        const reply = await askModel(env, await buildSummary(env), text, hist);
        await tgSend(env, chatId, reply);
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
            const hist = await fetchHistory(env, `fs-${chatId}`);
            const reply = await askModel(env, await buildSummary(env), text, hist);
            await feishuSend(env, chatId, reply);
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
