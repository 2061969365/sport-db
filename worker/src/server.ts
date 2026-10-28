// 入口：Telegram webhook / 飞书事件 / 网页版 API → 取对应 Agent 实例 → 提交 turn → 原通道回消息。
// 关键：turn 一律「异步提交 + 完成时回调推送」——重问题（比如要一份训练计划）会跑几十秒到
// 几分钟，同步等答复会撞平台超时（实测 80.7s 断连，用户什么都收不到）。所以：
//   /tg        → submitMessages 后立刻回 200，turn 跑完由 onChatResponse 推回 TG
//   /api/chat  → 先等 70s（快问题当场拿答复）；超时就回 202 + 轮询令牌
// Think 默认的 WebSocket 聊天协议同时保留（routeAgentRequest 兜底）。
import { routeAgentRequest, getAgentByName } from "agents";
import { SportDbAgent } from "./sport-agent";
import { ingestPhoto, pickImage, saveTgPhoto, writeReviewItem } from "./photo";
import { PAUSED_REPLY, isPaused } from "./pause";
import { sseText } from "./gateway";
import { UA_BROWSER } from "./photo";
import { ghHealth } from "./github";
import { clip, messageText, splitForTg, tgSend } from "./notify";
import { loadCfg } from "./modelcfg";
import type { Env } from "./env";

export { SportDbAgent };

/** 提交一个 turn（不等待），返回提交 id。
 *  image：可选的图片 data URL —— 作为 UIMessage 的 file 部件交给模型，
 *  模型在本轮里直接"看"图，不需要我们再单独打一次上网关的识图请求。 */
async function submitTurn(
  env: Env, instance: string, channel: string, target: string, text: string, idemKey: string,
  image?: { dataUrl: string; mediaType?: string },
): Promise<string> {
  const agent = (await getAgentByName(env.SportDbAgent, instance)) as unknown as SportDbAgent;
  await agent.setReplyTarget(channel, target);
  const parts: Record<string, unknown>[] = [{ type: "text", text }];
  if (image?.dataUrl) {
    parts.push({
      type: "file",
      mediaType: image.mediaType || "image/jpeg",
      filename: "workout-screenshot.jpg",
      url: image.dataUrl,
    });
  }
  const res = await agent.submitMessages(
    [{ id: crypto.randomUUID(), role: "user", parts }] as never,
    { idempotencyKey: idemKey },
  );
  return res?.submissionId || "";
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
      return new Response("sport-db think agent OK. POST /tg (Telegram) | POST /feishu (Feishu) | GET /health\n");
    }

    // ---------------- 健康检查：一眼看清依赖是否都在 ----------------
    if (request.method === "GET" && url.pathname === "/health") {
      const t0 = Date.now();
      const check = async (name: string, fn: () => Promise<string>) => {
        try {
          return { name, ok: true, detail: await fn() };
        } catch (e) {
          return { name, ok: false, detail: String((e as Error).message || e).slice(0, 160) };
        }
      };
      const gateway = async () => {
        // 暂停期间不真的打网关（否则健康检查自己就把额度烧了）
        if (isPaused(env)) return "已暂停（待选新网关）";
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12_000);
        try {
          // 用运行时配置（/model 改过的）而不是 env 静态值，否则健康检查会"检查旧网关"。
          const loaded = await loadCfg(env).catch(() => null);
          const ep = loaded?.cfg.endpoint || env.VISION_ENDPOINT;
          const model = loaded?.cfg.model || env.VISION_MODEL;
          const r = await fetch(ep, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": UA_BROWSER,
              Accept: "text/event-stream",
              Authorization: `Bearer ${env.VISION_API_KEY || "1"}`,
            },
            body: JSON.stringify({
              // 注意：该网关要求 max_tokens >= 16，写 8 会被 400 拒掉（踩过）
              model, max_tokens: 32, stream: true,
              messages: [{ role: "user", content: "ping" }],
            }),
            signal: ctl.signal,
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const gotText = sseText(await r.text()).trim();
          if (!gotText && !(r.status === 200)) throw new Error("流式回包为空");
          const host = (() => {
            try {
              return new URL(ep).host;
            } catch {
              return "?";
            }
          })();
          return `主网关 OK（${model} @ ${host}）`;
        } finally {
          clearTimeout(timer);
        }
      };
      const github = async () => {
        if (!env.GH_PAT) return "未配 GH_PAT（只读模式）";
        return `Contents API ${await ghHealth(env)}`;
      };
      const results = await Promise.all([
        check("gateway", gateway),
        check("github", github),
      ]);
      const cfg = {
        repo: env.REPO,
        fallback_model: !!(env.VISION_ENDPOINT_ALT && env.VISION_MODEL_ALT),
        anysearch_key: !!env.ANYSEARCH_API_KEY,
        tavily_key: !!env.TAVILY_API_KEY,
        home_city: env.HOME_CITY || null,
        telegram: !!env.TG_BOT_TOKEN,
        feishu: !!(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET),
      };
      const ok = results.every((r) => r.ok);
      return Response.json(
        { ok, ms: Date.now() - t0, checks: results, config: cfg },
        { status: ok ? 200 : 503 },
      );
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
      if (text === "/start" || text === "/help" || text === "帮助" || text === "你能干什么") {
        await tgSend(env, chatId,
          "我是你的跑步教练+运动账本管理员，会查你库里真实数据说话。\n\n"
          + "直接问：近30天跑了多少 / 2023年第一次跑步哪天 / 今年每月跑量\n"
          + "发图记账：运动截图直接发（文件方式最清晰），自动识别入库\n"
          + "改数：跟我说哪条改成多少，我先出预览，你说确认才写\n"
          + "补录：如“昨天跑了5km帮我记上”；删除同理，先预览后执行\n"
          + "指令：/status 上下文水位 · /new 另起话题 · /model 换模型或网关");
        return new Response("ok");
      }
      // /model：运行时切换模型与网关，全部在对话框里完成（含切换前体检）
      // 注意 TG 会把命令发成 /model@botname，得把 @bot名 摘掉再解析
      if (/^\/model(@\w+)?(\s|$)/.test(text)) {
        try {
          const agent = (await getAgentByName(env.SportDbAgent, `tg-${chatId}`)) as unknown as SportDbAgent;
          const out = await agent.modelCommand(text.replace(/^\/model(@\w+)?/, "/model"));
          for (const piece of splitForTg(out)) await tgSend(env, chatId, piece);
        } catch (e) {
          await tgSend(env, chatId, `换模型失败（${(e as Error).message}）。`);
        }
        return new Response("ok");
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
          // 只存图，不自己调识图接口：图片作为消息部件交给模型，让它在对话里直接看。
          const saved = await saveTgPhoto(env, picked.fileId, picked.isOrig, mid);
          const guide =
            `[用户发来一张运动截图，已存档为 ${saved.imgPath}，图片就在这条消息里]\n`
            + "请先看清图上的数据（类型/距离/时长/配速/心率/日期），再按规则入库：\n"
            + "1) 用 append_workout 入库，date 用图上日期，source 写 image，note 里带上图片路径；\n"
            + "2) 任何一项看不清或不确定就别猜：把不确定的字段留空，并在回复里说明；\n"
            + "3) 图上不是运动记录（聊天/广告/无关图片）就直接告诉我不入库；\n"
            + "4) 同一次训练已经有记录（同日同距离）就别重复写，提醒我一声；\n"
            + "5) 回复用一两句话报清楚：入库了什么、哪些没把握。";
          const text = caption ? `${guide}\n\n[用户附言] ${caption}` : guide;
          try {
            await submitTurn(env, `tg-${chatId}`, "tg", String(chatId), text,
              `tg-${update.update_id ?? `${chatId}-${mid}`}`, saved);
          } catch (e) {
            // 图已存好，只是这一轮没跑起来（多半是网关抖动）：
            // 记进 review，后台会自动重新提交给模型读，用户不用重发。
            await writeReviewItem(env, saved.imgPath, mid, `提交失败：${(e as Error).message}`, `tg:${chatId}`)
              .catch(() => null);
            await tgSend(env, chatId,
              `图已存好，但这会儿没能识别（${(e as Error).message}）。我会在后台自动重试，成功就告诉你，不用重发。`);
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
      if (isPaused(env)) {
        await tgSend(env, chatId, PAUSED_REPLY);
        return new Response("ok");
      }
      try {
        // 异步提交：长 turn 跑完由 onChatResponse 推回 TG，webhook 立刻 200。
        await submitTurn(env, `tg-${chatId}`, "tg", String(chatId), text,
          `tg-${update.update_id ?? `${chatId}-${msg.message_id ?? Date.now()}`}`);
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
            // 同样异步：跑完由 onChatResponse 经飞书 API 推回去（飞书未配置时静默无回复，属未验证路径）。
            await agent0.setReplyTarget("feishu", chatId);
            await agent0.submitMessages(
              [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }] as never,
              { idempotencyKey: `fs-${chatId}-${msgId}` },
            );
          } catch (e) {
            console.error(`[feishu-reply-fail chat=${chatId}]`, (e as Error).message);
            /* 飞书回失败不抛，避免重试风暴（已打日志） */
          }
        }
      }
      return new Response("ok");
    }

    // ---------------- PWA 聊天（经 Worker 走 Agent：工具+记忆+规则全套） ----------------
    if (url.pathname === "/api/chat") {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: cors });
      }
      let body: { session?: string; key?: string; text?: string; image?: string } = {};
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "JSON 解析失败" }, { status: 400, headers: cors });
      }
      const session = String(body.session || "");
      const key = String(body.key || "");
      const text = String(body.text || "").trim().slice(0, 2000);
      // image：data URL（data:image/jpeg;base64,...）。有图时 text 可以只给一句指令。
      const image = String(body.image || "").trim();
      const validImage = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image) && image.length < 8_000_000;
      if (!/^[A-Za-z0-9-]{8,64}$/.test(session) || !/^[A-Za-z0-9-]{8,64}$/.test(key)
        || (!text && !validImage)) {
        return Response.json({ error: "参数不对（session/key/text 或 image）" }, { status: 400, headers: cors });
      }
      try {
        const agent = (await getAgentByName(env.SportDbAgent, `pwa-${session}`)) as unknown as SportDbAgent;
        if (!(await agent.checkQuota(session))) {
          return Response.json({ error: "问太快了，每小时 60 轮，歇会再来" }, { status: 429, headers: cors });
        }
        if (!(await agent.claimUpdate(`pwa-${key}`))) {
          return Response.json({ error: "重复提交（请用新 key 重试）" }, { status: 409, headers: cors });
        }
        // /model 之类的本地指令直接处理，不进模型（TG 与网页共用同一套）。
        if (/^\/model(@\w+)?(\s|$)/.test(text) || /^\/(模型)(\s|$)/.test(text)) {
          const out = await agent.modelCommand(text.replace(/^\/模型/, "/model").replace(/^\/model(@\w+)?/, "/model"));
          return Response.json({ reply: out, pending: false }, { headers: cors });
        }
        // 网关暂停：只放行本地指令，其余直接回维护提示（不打模型）
        if (isPaused(env)) {
          return Response.json({ reply: PAUSED_REPLY, pending: false }, { headers: cors });
        }
        // 快问题当场给答复；重问题（计划类）等在 70s 以内，超时回 202 让前端轮询。
        await agent.setReplyTarget("pwa", session);
        const since = Date.now();
        const parts: Record<string, unknown>[] = [{ type: "text", text: text || "请读取这张图并按规则入库。" }];
        if (validImage) {
          const mediaType = image.slice(5, image.indexOf(";"));
          parts.push({ type: "file", mediaType, filename: "upload.jpg", url: image });
        }
        const sub = await agent.submitMessages(
          [{ id: crypto.randomUUID(), role: "user", parts }] as never,
          { idempotencyKey: `pwa-${key}` },
        );
        const done = await agent.waitForSubmission(sub.submissionId, { timeoutMs: 70_000 }).catch(() => null);
        if (done?.status === "completed") {
          const reply = (await agent.latestReply(since)).trim();
          if (reply) return Response.json({ reply }, { headers: cors });
          // 落库动作可能比 hook 早一点点，交给前端轮询
        }
        if (done?.status === "error") {
          return Response.json(
            { error: `处理失败（${String(done.error || "").slice(0, 200) || "未知原因"}）` },
            { status: 500, headers: cors },
          );
        }
        return Response.json({ pending: true, since, submissionId: sub.submissionId }, { status: 202, headers: cors });
      } catch (e) {
        return Response.json({ error: `处理失败（${(e as Error).message}），请稍后重试` }, { status: 500, headers: cors });
      }
    }

    // ---------------- 网页版轮询：长 turn 完成后来这里取答复 ----------------
    if (url.pathname === "/api/chat/result" && request.method === "GET") {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      const session = String(url.searchParams.get("session") || "");
      const since = Number(url.searchParams.get("since") || 0) || 0;
      if (!/^[A-Za-z0-9-]{8,64}$/.test(session)) {
        return Response.json({ error: "session 不对" }, { status: 400, headers: cors });
      }
      try {
        const agent = (await getAgentByName(env.SportDbAgent, `pwa-${session}`)) as unknown as SportDbAgent;
        const reply = await agent.latestReply(since);
        return Response.json(reply ? { reply } : { pending: true }, { headers: cors });
      } catch (e) {
        return Response.json({ error: `查询失败（${(e as Error).message}）` }, { status: 500, headers: cors });
      }
    }

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// 飞书回消息已移到 notify.ts（异步 onChatResponse 里推送）。
