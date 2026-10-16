// 可观测性：把每次 turn 的 token 用量、工具调用数、失败数落进 DO SQLite，
// 让"它到底花了多少、调了什么、失败几次"可见（以前只有 Cloudflare 日志，且会过期）。
// 纯函数部分（提取 + 格式化）独立出来，便于测试。

export interface DayMetric {
  day: string;
  turns: number;
  errors: number;
  in_tok: number;
  out_tok: number;
  tool_calls: number;
}

export interface UsageDelta {
  inTok: number;
  outTok: number;
  toolCalls: number;
  finish: string;
}

/** 从 AI SDK 的 step 结果里尽量稳妥地取用量（字段缺失/改名时返回 0，不抛）。 */
export function extractUsage(step: unknown): UsageDelta {
  const s = step as {
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    toolCalls?: unknown[];
    toolResults?: unknown[];
    finishReason?: string;
  } | null;
  const pick = (...vals: (number | undefined)[]) => {
    for (const v of vals) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
    return 0;
  };
  const inTok = pick(s?.usage?.inputTokens);
  const outTok = pick(s?.usage?.outputTokens);
  const tools = Array.isArray(s?.toolCalls) ? s.toolCalls.length
    : Array.isArray(s?.toolResults) ? s.toolResults.length : 0;
  return {
    inTok,
    outTok,
    toolCalls: tools,
    finish: String(s?.finishReason || "").slice(0, 24),
  };
}

/** 人类可读的用量报表。 */
export function formatUsage(rows: DayMetric[], today: string): string {
  if (!rows.length) return "还没有用量记录（问一句之后就有了）。";
  const sum = rows.reduce(
    (a, r) => ({
      turns: a.turns + r.turns, errors: a.errors + r.errors,
      in_tok: a.in_tok + r.in_tok, out_tok: a.out_tok + r.out_tok,
      tool_calls: a.tool_calls + r.tool_calls,
    }),
    { turns: 0, errors: 0, in_tok: 0, out_tok: 0, tool_calls: 0 },
  );
  const avgIn = sum.turns ? Math.round(sum.in_tok / sum.turns) : 0;
  const errRate = sum.turns ? ((sum.errors / sum.turns) * 100).toFixed(1) : "0.0";
  const lines = [
    `近 ${rows.length} 天：${sum.turns} 轮对话、失败 ${sum.errors} 次（${errRate}%）、`
      + `工具调用 ${sum.tool_calls} 次`,
    `token：输入 ${sum.in_tok.toLocaleString("en-US")}，输出 ${sum.out_tok.toLocaleString("en-US")}`
      + `（平均每轮输入 ${avgIn.toLocaleString("en-US")}）`,
  ];
  const recent = rows.filter((r) => r.day >= today).length ? rows.slice(0, 3) : rows.slice(0, 3);
  if (recent.length > 1) {
    lines.push("按天：" + recent.map((r) => `${r.day.slice(5)} ${r.turns}轮/${r.tool_calls}工具`).join("，"));
  }
  return lines.join("\n");
}
