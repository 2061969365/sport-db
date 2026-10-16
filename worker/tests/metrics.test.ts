// 可观测性：用量提取要能容忍字段缺失/改名，报表要能一眼看懂。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUsage, formatUsage, type DayMetric } from "../src/metrics.ts";

test("提取用量：标准 AI SDK step 结果", () => {
  const u = extractUsage({
    usage: { inputTokens: 1234, outputTokens: 567 },
    toolCalls: [{}, {}],
    finishReason: "tool-calls",
  });
  assert.deepEqual(u, { inTok: 1234, outTok: 567, toolCalls: 2, finish: "tool-calls" });
});

test("提取用量：字段缺失/异常一律返回 0，绝不抛错", () => {
  for (const bad of [undefined, null, {}, { usage: {} }, { usage: { inputTokens: -5 } }, 42]) {
    const u = extractUsage(bad);
    assert.equal(u.inTok, 0);
    assert.equal(u.outTok, 0);
    assert.equal(u.toolCalls, 0);
  }
});

test("提取用量：没有 toolCalls 时退回 toolResults 计数", () => {
  const u = extractUsage({ usage: { inputTokens: 10, outputTokens: 2 }, toolResults: [{}] });
  assert.equal(u.toolCalls, 1);
});

test("报表：汇总轮数/失败率/token/工具调用", () => {
  const rows: DayMetric[] = [
    { day: "2026-10-16", turns: 10, errors: 1, in_tok: 100000, out_tok: 20000, tool_calls: 25 },
    { day: "2026-10-15", turns: 10, errors: 0, in_tok: 60000, out_tok: 12000, tool_calls: 15 },
  ];
  const out = formatUsage(rows, "2026-10-16");
  assert.match(out, /20 轮对话/);
  assert.match(out, /失败 1 次（5.0%）/);
  assert.match(out, /工具调用 40 次/);
  assert.match(out, /输入 160,000/);
  assert.match(out, /平均每轮输入 8,000/);
});

test("报表：没有记录时给可执行的说法，不是空白", () => {
  assert.match(formatUsage([], "2026-10-16"), /还没有用量记录/);
});

test("报表：轮数为 0 时不出现除零（NaN）", () => {
  const out = formatUsage([{ day: "2026-10-16", turns: 0, errors: 0, in_tok: 0, out_tok: 0, tool_calls: 0 }], "2026-10-16");
  assert.equal(/NaN|Infinity/.test(out), false);
});
