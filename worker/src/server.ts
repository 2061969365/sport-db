// 入口：Telegram webhook / 飞书事件 → 取对应 Agent 实例 → runTurn(wait) → 回平台。
// Think 默认的 WebSocket 聊天协议同时保留（routeAgentRequest兜底），供 PWA 接入。
import { routeAgentRequest, getAgentByName } from "agents";
import { SportDbAgent } from "./sport-agent";
import { ingestPhoto, pickImage } from "./photo";
import type { Env } from "./env";

export { SportDbAgent };

function tgApi(env: Env, method: string, payload: unknown) {
  return fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 按码点截断（slice 会切散 emoji/代理对），留 3500 给 TG 4096 上限。 */
function clip(text: string, n = 3500): string {
  const units = Array.from(text);
  return units.length <= n ? text : units.slice(0, n).join("");
}

async function tgSend(env: Env, chatId: number | string, text: string): Promise<void> {
  await tgApi(env, "sendMessage", { chat_id: chatId, text: clip(text) });
}

function turnText(result: unknown): string {
  const msg = (result as { message?: { content?: unknown; parts?: { type?: string; text?: string }[] } })?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("");
  }
  return "";
}

async function askAgent(env: Env, instance: string, input: string): Promise<string> {
  // runTurn(wait) 同步等答复；重推幂等靠入口的 claimUpdate（update_id 去重），
  // 这里不再假设“同值复写无害”。
  const agent = (await getAgentByName(env.SportDbAgent, instance)) as unknown as SportDbAgent;
  const result = await agent.runTurn({ input, mode: "wait" });
  const text = turnText(result).trim();
  if (result.status !== "completed" || !text) {
    const err = (result as { error?: string }).error;
    throw new Error(err ? `turn失败：${String(err).slice(0, 200)}` : `turn未完成(status=${result.status ?? "?"})`);
  }
  return clip(text);
}

function feishuText(message: unknown): string {
  const m = message as { message_type?: string; content?: string } | null;
  if (!m || m.message_type !== "text") return "";
  try {
    return (JSON.parse(m.content || "{}") as { text?: string }).text || "";
  } catch {
    return "";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response("sport-db think agent OK. POST /tg (Telegram) | POST /feishu (Feishu)\n");
    }

    // ---------------- Telegram webhook ----------------
    if (url.pathname === "/tg" && request.method === "POST") {
      if (env.TG_SECRET) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== env.TG_SECRET) return new Response("forbidden", { status: 403 });
      }
      let update: {
        update_id?: number;
        message?: {
          message_id?: number; text?: string; caption?: string;
          photo?: { file_id?: string }[];
          document?: { file_id?: string; mime_type?: string };
          chat?: { id?: number }; from?: { username?: string };
        };
        edited_message?: {
          message_id?: number; text?: string; caption?: string;
          photo?: { file_id?: string }[];
          document?: { file_id?: string; mime_type?: string };
          chat?: { id?: number }; from?: { username?: string };
        };
      } = {};
      try {
        update = await request.json();
      } catch {
        return new Response("bad update", { status: 400 });
      }
      const msg = update.message || update.edited_message || {};
      const text = (msg.text || "").trim();
      const chatId = msg.chat?.id;
      if (!chatId) return new Response("no chat", { status: 200 });
      // 重推去重：同 update_id 只处理一次（claimUpdate 原子认领）。
      try {
        const agent0 = (await getAgentByName(env.SportDbAgent, `tg-${chatId}`)) as unknown as SportDbAgent;
        if (!(await agent0.claimUpdate(`tg-${update.update_id ?? `${chatId}-${msg.message_id ?? Date.now()}`}`))) {
          return new Response("ok-duplicate", { status: 200 });
        }
      } catch {
        /* 认领失败不挡路，继续处理 */
      }
      if (text === "/status" || text === "水位" || text === "上下文") {
        try {
          const agent = (await getAgentByName(env.SportDbAgent, `tg-${chatId}`)) as unknown as SportDbAgent;
          await tgSend(env, chatId, await agent.status());
        } catch (e) {
          await tgSend(env, chatId, `水位读取失败（${(e as Error).message}）。`);
        }
        return new Response("ok");
      }
      if (text === "/new" || text === "重新开始" || text === "新对话") {
        try {
          const agent = (await getAgentByName(env.SportDbAgent, `tg-${chatId}`)) as unknown as SportDbAgent;
          await agent.resetConversation();
          await tgSend(env, chatId, "已清空本窗聊天记录，从头开始吧。画像记忆（目标/伤病/偏好）还留着。");
        } catch (e) {
          await tgSend(env, chatId, `重置失败（${(e as Error).message}），直接换个新群/话题聊也一样。`);
        }
        return new Response("ok");
      }
      const mid = msg.message_id ?? Date.now();
      const picked = pickImage(msg);
      if (picked) {
        const caption = (msg.caption || "").trim();
        try {
          const { rec, line } = await ingestPhoto(env, picked.fileId, picked.isOrig, mid);
          if (!caption) {
            await tgSend(env, chatId, line);
          } else {
            const follow = await askAgent(env, `tg-${chatId}`,
              `[用户发了一张运动截图并附言：${caption}]\n`
              + `[截图识别结果：${JSON.stringify(rec)}]\n`
              + `[入库情况：${line}]\n请先报入库情况，再回答附言。`);
            await tgSend(env, chatId, follow);
          }
        } catch (e) {
          await tgSend(env, chatId, `这张图处理失败（${(e as Error).message}），换张清晰的再发一次。`);
        }
        return new Response("ok");
      }
      if (!text) {
        await tgSend(env, chatId, "发我一句话吧，比如：总结一下我最近的运动情况");
        return new Response("ok");
      }
      try {
        const reply = await askAgent(env, `tg-${chatId}`, text);
        await tgSend(env, chatId, reply);
      } catch (e) {
        await tgSend(env, chatId, `抱歉，刚才处理失败（${(e as Error).message}），请稍后重试。`);
      }
      return new Response("ok");
    }

    // ---------------- 飞书事件订阅 ----------------
    if (url.pathname === "/feishu" && request.method === "POST") {
      let body: {
        type?: string;
        challenge?: string;
        header?: { event_type?: string };
        event?: { message?: unknown; sender?: { sender_id?: { open_id?: string } } };
      } = {};
      try {
        body = await request.json();
      } catch {
        return new Response("bad event", { status: 400 });
      }
      if (body.type === "url_verification") {
        return Response.json({ challenge: body.challenge });
      }
      if (body?.header?.event_type === "im.message.receive_v1") {
        const ev = body.event as { message?: { chat_id?: string; message_id?: string } } | undefined;
        const text = feishuText(ev?.message).trim();
        const chatId = ev?.message?.chat_id;
        if (chatId && text && !text.startsWith("[")) {
          try {
            const agent0 = (await getAgentByName(env.SportDbAgent, `fs-${chatId}`)) as unknown as SportDbAgent;
            const msgId = (ev?.message as { message_id?: string })?.message_id ?? `${Date.now()}`;
            const first = await agent0.claimUpdate(`fs-${chatId}-${msgId}`).catch(() => true);
            if (!first) return new Response("ok-duplicate", { status: 200 });
            const reply = await askAgent(env, `fs-${chatId}`, text);
            const token = await feishuToken(env);
            await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: reply }) }),
            });
          } catch (e) {
            console.error(`[feishu-reply-fail chat=${chatId}]`, (e as Error).message);
            /* 飞书回失败不抛，避免重试风暴（已打日志） */
          }
        }
      }
      return new Response("ok");
    }

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function feishuToken(env: Env): Promise<string> {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = (await r.json()) as { code?: number; msg?: string; tenant_access_token?: string };
  if (data.code !== 0) throw new Error(`飞书鉴权失败 code=${data.code} msg=${data.msg}`);
  return data.tenant_access_token ?? "";
}
