// 通知层：从 turn 结果里取文本、按码点裁剪、往 Telegram 回消息。
// server.ts（同步路径）与 sport-agent.ts（异步 onChatResponse）共用，避免两份实现。
import type { Env } from "./env";

/** 按码点截断（slice 会切散 emoji/代理对），留 3500 给 TG 4096 上限。 */
export function clip(text: string, n = 3500): string {
  const units = Array.from(text);
  return units.length <= n ? text : units.slice(0, n).join("");
}

/** 从 turn 结果 / UIMessage / runTurn 返回值里取纯文本（含中间旁白）。 */
export function messageText(result: unknown): string {
  const msg = (result as { message?: { content?: unknown; parts?: { type?: string; text?: string }[] } })?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("");
  }
  return "";
}

/** 工具调用前常见的「我查一下」旁白：短、且含过程动词，才丢。 */
const CHATTER = /(稍等|稍候|马上|这就|正在|我先|让我|帮你(查|看|翻|对|拉|排|算)|我(去|来)?(查|看|翻|对)一下)/;

/**
 * 只取「最终答复」：多步 turn 里模型会在工具调用之间插旁白
 * （实测计划类回答开头会粘出「收到…我来帮你排…刚看到你的近况…」一串碎片）。
 * 这里按 step / 工具把文本切成段，丢掉非最后一段里的短旁白，其余按顺序保留。
 *
 * 关键：不能只取「最后一次工具调用之后」——模型常把完整分析写在前面，
 * 再调 set_context 存备忘，最后补一句「记好了」，那样整段分析会被丢掉，
 * 用户就只收到一句「记好了」。
 */
export function finalReplyText(result: unknown): string {
  const msg = (result as { message?: { content?: unknown; parts?: { type?: string; text?: string }[] } })?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  if (!parts.length) return "";
  const typeOf = (p: { type?: string }) => String(p?.type || "");
  const segments: string[] = [];
  let cur = "";
  for (const p of parts) {
    const t = typeOf(p);
    if (t.startsWith("text")) { cur += p.text ?? ""; continue; }
    if (t === "reasoning" || t === "source-url") continue;
    if (cur.trim()) segments.push(cur.trim());
    cur = "";
  }
  if (cur.trim()) segments.push(cur.trim());
  if (!segments.length) return "";
  const kept = segments.filter((s, i) =>
    !(i < segments.length - 1 && s.length <= 80 && CHATTER.test(s)));
  return (kept.length ? kept : segments).join("\n\n");
}

export function tgApi(env: Env, method: string, payload: unknown) {
  return fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function tgSend(env: Env, chatId: number | string, text: string): Promise<boolean> {
  // 长回复按行切成多条发，不再 clip 掉后半段（分析/计划类回答经常超过 3500 字）。
  // 429/5xx 退避重试 3 次（429 读 retry_after）；最终失败返回 false，让上层可重放。
  let allOk = true;
  for (const piece of splitForTg(text)) {
    let sent = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await tgApi(env, "sendMessage", { chat_id: chatId, text: piece }).catch(() => null);
      if (r && r.ok) { sent = true; break; }
      if (!r) {
        await new Promise((x) => setTimeout(x, 800 * (attempt + 1)));
        continue;
      }
      const body = await r.text().catch(() => "");
      console.error(`[tgSend-fail chat=${chatId}]`, r.status, body.slice(0, 200));
      if (r.status !== 429 && r.status < 500) break;
      let wait = 800 * (attempt + 1);
      try {
        const j = JSON.parse(body) as { parameters?: { retry_after?: number } };
        const ra = Number(j?.parameters?.retry_after);
        if (ra > 0) wait = Math.min(10_000, ra * 1000);
      } catch { /* 非 JSON 就按退避 */ }
      await new Promise((x) => setTimeout(x, wait));
    }
    if (!sent) allOk = false;
  }
  return allOk;
}

/** 「正在输入」指示（Telegram 侧有效约 5 秒）：长 turn 每步刷新一次，别让用户以为死了。 */
export async function tgTyping(env: Env, chatId: number | string): Promise<void> {
  await tgApi(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => null);
}

/** 长回复按行切成多条（体检报告可能超过单条上限）；超长单行按码点硬切。 */
export function splitForTg(text: string, per = 3500): string[] {
  if (Array.from(text).length <= per) return [text];
  const out: string[] = [];
  let buf = "";
  const pushBuf = () => { if (buf) { out.push(buf); buf = ""; } };
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    // 单行本身超过上限：先整行硬切，别把 4000 字的段落整段塞给 Telegram。
    while (Array.from(line).length > per) {
      pushBuf();
      const units = Array.from(line);
      out.push(units.slice(0, per).join(""));
      line = units.slice(per).join("");
    }
    if (Array.from(buf + line).length + 1 > per) {
      pushBuf();
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  pushBuf();
  return out;
}

/** 飞书回消息（先在回调里取 tenant_access_token，再按 chat_id 推）。未配置则静默跳过。 */
export async function feishuSend(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return;
  try {
    const tr = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    });
    const tok = (await tr.json()) as { code?: number; tenant_access_token?: string };
    if (tok.code !== 0 || !tok.tenant_access_token) {
      console.error("[feishu-token-fail]", tr.status, tok.code);
      return;
    }
    const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.tenant_access_token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: clip(text, 8000) }) }),
    });
    if (!r.ok) console.error(`[feishuSend-fail chat=${chatId}]`, r.status);
  } catch (e) {
    console.error("[feishuSend-error]", e instanceof Error ? e.message : String(e));
  }
}
