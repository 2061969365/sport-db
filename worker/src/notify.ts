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

/**
 * 只取「最终答复」：多步 turn 里模型会在工具调用之间插旁白
 * （实测计划类回答开头会粘出「收到…我来帮你排…刚看到你的近况…」一串碎片），
 * 这里丢掉最后一次工具调用之前的文本，只留收尾的正式答复。
 */
export function finalReplyText(result: unknown): string {
  const msg = (result as { message?: { content?: unknown; parts?: { type?: string; text?: string }[] } })?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  if (!parts.length) return "";
  const typeOf = (p: { type?: string }) => String(p?.type || "");
  const textOf = (p: { type?: string; text?: string }) => (typeOf(p).startsWith("text") ? p.text ?? "" : "");
  let lastTool = -1;
  parts.forEach((p, i) => {
    const t = typeOf(p);
    if (t && !t.startsWith("text") && t !== "reasoning" && t !== "source-url" && t !== "step-start") {
      lastTool = i;
    }
  });
  const tail = parts.slice(lastTool + 1).map(textOf).join("");
  if (tail.trim()) return tail;
  return parts.map(textOf).join("");
}

export function tgApi(env: Env, method: string, payload: unknown) {
  return fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function tgSend(env: Env, chatId: number | string, text: string): Promise<void> {
  // Telegram 侧失败不抛：异步路径里抛了也没人接，只会丢日志。
  const r = await tgApi(env, "sendMessage", { chat_id: chatId, text: clip(text) }).catch(() => null);
  if (r && !r.ok) {
    console.error(`[tgSend-fail chat=${chatId}]`, r.status, (await r.text().catch(() => "")).slice(0, 200));
  }
}

/** 「正在输入」指示（Telegram 侧有效约 5 秒）：长 turn 每步刷新一次，别让用户以为死了。 */
export async function tgTyping(env: Env, chatId: number | string): Promise<void> {
  await tgApi(env, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => null);
}

/** 长回复按行切成多条（体检报告可能超过单条上限）。 */
export function splitForTg(text: string, per = 3500): string[] {
  if (text.length <= per) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if ((buf + line).length + 1 > per) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
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
      body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: clip(text) }) }),
    });
    if (!r.ok) console.error(`[feishuSend-fail chat=${chatId}]`, r.status);
  } catch (e) {
    console.error("[feishuSend-error]", e instanceof Error ? e.message : String(e));
  }
}
