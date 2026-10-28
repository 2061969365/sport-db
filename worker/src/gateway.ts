// 网关兼容层。
//
// 2026-10-28 修正：之前"流式坏了"的结论是被 `reasoning_effort: xhigh` 污染的
// （该上游不支持 xhigh，直接 400，流式里表现为 upstream_truncated）。
// 改成 high 后流式可用，且**本网关对非流式请求更容易回 429/530**，
// 所以现在对话、识图、摘要、体检**一律走流式**（MODEL_STREAMING=on）。
//
// 这里保留非流式→合成 SSE 的适配（`sseFromResponse`）作为兜底：哪天必须用非流式，
// 打开 MODEL_STREAMING=off 就能退回旧路径。
//
// `sseText()` 则相反：把一段 SSE 正文收成纯文本，给"自己发流式请求"的地方用
// （识图 / 摘要 / 体检），这样它们也能享受流式通道。

export interface ChatCompletionLike {
  id?: string;
  model?: string;
  created?: number;
  choices?: {
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        index?: number;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: Record<string, unknown> | null;
}

const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** 把一个非流式 chat.completion 合成成 SSE 文本（纯函数，便于测试）。 */
export function nonStreamToSse(json: ChatCompletionLike, includeUsage = false): string {
  const id = json?.id || `chatcmpl_${Date.now().toString(36)}`;
  const model = json?.model || "unknown";
  const created = json?.created || Math.floor(Date.now() / 1000);
  const choice = (json?.choices || [])[0];
  if (!choice) return ""; // 交给调用方按"网关返回异常"处理

  const base = { id, object: "chat.completion.chunk", created, model };
  const frames: string[] = [];

  // 角色帧（SDK 需要它来起头）
  frames.push(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));

  const msg = choice.message || {};
  // 工具的 arguments 必须是字符串；上游偶尔给对象，这里兜一下
  const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
    index: typeof tc.index === "number" ? tc.index : i,
    id: tc.id || `call_${i}`,
    type: tc.type || "function",
    function: {
      name: tc.function?.name || "",
      arguments: typeof tc.function?.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? {}),
    },
  }));

  if (msg.content) {
    frames.push(chunk({ ...base, choices: [{ index: 0, delta: { content: String(msg.content) }, finish_reason: null }] }));
  }
  if (toolCalls.length) {
    frames.push(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] }));
  }

  const finish = choice.finish_reason || (toolCalls.length ? "tool_calls" : "stop");
  frames.push(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
  if (includeUsage && json.usage) {
    frames.push(chunk({ ...base, choices: [], usage: json.usage }));
  }
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

/** 网关返回体异常（没有 choices）时，取出可读原因。 */
export function gatewayError(json: unknown): string {
  const j = json as { error?: { message?: string }; response?: { error?: { message?: string } }; message?: string };
  const msg = j?.error?.message || j?.response?.error?.message || j?.message;
  return String(msg || "响应里没有 choices").slice(0, 200);
}

/**
 * 把一次**非流式**响应转成 SSE Response。
 * 只读一次 body（踩过：先 synthesize 再 r.clone().json() → "ReadableStream is locked"）。
 * 返回 error 时调用方应重试或切备用网关。
 */
export async function sseFromResponse(
  r: Response, includeUsage = false,
): Promise<{ res?: Response; error?: string }> {
  let json: ChatCompletionLike;
  try {
    json = (await r.json()) as ChatCompletionLike;
  } catch {
    return { error: `网关响应不是 JSON（HTTP ${r.status}）` };
  }
  const sse = nonStreamToSse(json, includeUsage);
  if (!sse) return { error: gatewayError(json) };
  return {
    res: new Response(sse, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }),
  };
}

/**
 * 把一段 SSE 正文收成纯文本（给"自己发流式请求"的地方用：识图 / 摘要 / 体检）。
 *
 * 兼容三种情况：
 * ① 正常 SSE：逐条 data: {...}，累加 choices[0].delta.content
 * ② 对方忽略 stream 直接回 JSON：按 message.content 取
 * ③ 混着 reasoning_content：只取正文，思考过程不算答案
 */
export function sseText(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  // ② 直接是 JSON
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as ChatCompletionLike;
      const msg = j.choices?.[0]?.message;
      if (msg && typeof msg.content === "string") return msg.content;
    } catch { /* 继续按 SSE 解 */ }
  }
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith(":") || !s.startsWith("data:")) continue; // ": keep-alive" 之类跳过
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    if (payload.startsWith("{")) {
      try {
        const j = JSON.parse(payload) as ChatCompletionLike;
        const d = j.choices?.[0] as { delta?: { content?: string | null }; message?: { content?: string | null } };
        const piece = d?.delta?.content ?? d?.message?.content;
        if (typeof piece === "string") out += piece;
      } catch { /* 坏行跳过，别整段失败 */ }
    }
  }
  return out;
}
