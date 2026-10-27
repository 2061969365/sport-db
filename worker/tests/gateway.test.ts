// 网关适配层：非流式结果 → 合法 SSE。网关流式坏了（见 gateway.ts 注释），这层是命门。
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayError, nonStreamToSse, sseFromResponse } from "../src/gateway.ts";

const parseSse = (sse) => sse.split("\n\n").filter((s) => s.startsWith("data: "))
  .map((s) => s.replace(/^data: /, "")).filter((s) => s !== "[DONE]").map((s) => JSON.parse(s));

test("普通文本：角色帧 + 内容帧 + 终止帧 + DONE", () => {
  const sse = nonStreamToSse({
    id: "x1", model: "m", created: 1,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "你好" } }],
  });
  assert.ok(sse.includes("data: [DONE]"));
  const frames = parseSse(sse);
  assert.equal(frames[0].choices[0].delta.role, "assistant", "首帧要带 role");
  assert.equal(frames[1].choices[0].delta.content, "你好");
  assert.equal(frames[2].choices[0].finish_reason, "stop");
});

test("工具调用：finish_reason 自动补成 tool_calls，arguments 保持字符串", () => {
  const sse = nonStreamToSse({
    id: "x2", model: "m",
    choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_summary", arguments: '{"days":30}' } }] } }],
  });
  const frames = parseSse(sse);
  const tc = frames.find((f) => f.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls;
  assert.equal(tc[0].function.name, "get_summary");
  assert.equal(tc[0].function.arguments, '{"days":30}');
  assert.equal(tc[0].index, 0, "必须带 index，SDK 靠它聚合");
  assert.equal(frames.at(-1).choices[0].finish_reason, "tool_calls");
});

test("工具参数若是对象，自动序列化成字符串（上游偶尔这么干）", () => {
  const sse = nonStreamToSse({
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
      { id: "c", function: { name: "f", arguments: { days: 7 } } }] } }],
  } as never);
  const frames = parseSse(sse);
  const tc = frames.find((f) => f.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls;
  assert.equal(tc[0].function.arguments, '{"days":7}');
});

test("usage：只有要求时才附上", () => {
  const base = { choices: [{ finish_reason: "stop", message: { content: "a" } }], usage: { total_tokens: 9 } };
  const withU = parseSse(nonStreamToSse(base as never, true));
  const withoutU = parseSse(nonStreamToSse(base as never, false));
  assert.ok(withU.some((f) => f.usage), "要求 usage 时应带上");
  assert.equal(withoutU.some((f) => f.usage), false);
});

test("没有 choices（网关报错）→ 返回空串，由调用方按失败处理", () => {
  assert.equal(nonStreamToSse({ response: { error: { message: "boom" } } } as never), "");
  assert.equal(nonStreamToSse({} as never), "");
});

test("错误信息提取：Responses 格式与普通格式都能读出来", () => {
  assert.match(gatewayError({ response: { error: { message: "upstream_truncated" } } }), /upstream_truncated/);
  assert.match(gatewayError({ error: { message: "rate limited" } }), /rate limited/);
  assert.match(gatewayError({}), /没有 choices/);
});

test("空回复也要能合成合法流（不能崩）", () => {
  const sse = nonStreamToSse({ choices: [{ finish_reason: "stop", message: { content: "" } }] } as never);
  const frames = parseSse(sse);
  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
});

test("sseFromResponse：只读一次 body，且能拿到 SSE", async () => {
  const r = Response.json({ id: "a", model: "m", choices: [{ finish_reason: "stop", message: { content: "你好" } }] });
  const got = await sseFromResponse(r);
  assert.ok(got.res, "应成功");
  const txt = await got.res.text();
  assert.match(txt, /你好/);
  assert.match(txt, /\[DONE\]/);
  // 再读一次必须失败：证明 body 只被消费一次（否则会出 "stream locked"）
  await assert.rejects(() => r.text());
});

test("sseFromResponse：网关回错误体时给出原因而不是抛异常", async () => {
  const r = Response.json({ response: { error: { message: "Upstream response was not valid JSON" } } });
  const got = await sseFromResponse(r);
  assert.equal(got.res, undefined);
  assert.match(String(got.error), /not valid JSON/);
});

test("sseFromResponse：非 JSON 响应也不崩", async () => {
  const r = new Response("<html>502</html>", { status: 200 });
  const got = await sseFromResponse(r);
  assert.equal(got.res, undefined);
  assert.match(String(got.error), /不是 JSON/);
});
