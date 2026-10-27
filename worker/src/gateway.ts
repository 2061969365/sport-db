// 网关兼容层：本网关的**流式通道**会中途断流（SSE 结尾塞一个 Responses 格式的
// `upstream_truncated` 错误事件，缺终止语义），导致 AI SDK 报 invalid_union / 类型校验失败。
// 实测（2026-10-17）所有免费模型流式都挂、非流式正常。
//
// 解决：对「要求流式」的请求，实际用**非流式**发出去，再把 JSON 结果合成为一段
// 合法的 chat.completions SSE 交回给 SDK。SDK 拿到的仍是流，用户拿到的仍是完整答复，
// 只是不再逐字到达（本项目的回复本来就等 turn 结束才推送，无体验损失）。
// 网关流式恢复后，把 MODEL_STREAMING 设为 "on" 即可走原生流式。

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
