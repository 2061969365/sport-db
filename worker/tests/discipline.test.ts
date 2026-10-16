// 纪律不变量 + 答复整形回归。
// prompts 是最容易改坏又最难发现的东西：这里把"必须有的话"和"必须不能有的行为"钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finalReplyText, clip } from "../src/notify.ts";

const SRC = readFileSync(new URL("../src/sport-agent.ts", import.meta.url), "utf-8");

test("铁律：两阶段确认、数据铁律、工具边界都还在 prompt 里", () => {
  assert.match(SRC, /【改库铁律】/, "改库铁律被删了");
  assert.match(SRC, /confirmed=true/, "两阶段确认的第二步说明没了");
  assert.match(SRC, /【数据铁律】/, "数据铁律被删了");
  assert.match(SRC, /【工具边界】/, "工具边界被删了");
  assert.match(SRC, /【计划纪律】/, "计划纪律被删了");
  assert.match(SRC, /current_time/, "计划纪律依赖的 current_time 说明没了");
});

test("铁律：仍然明确禁止用 workspace 内置文件工具", () => {
  assert.match(SRC, /workspace 的内置文件工具/, "workspace 禁令被删了");
  assert.equal(/workspaceBash\s*=\s*true/.test(SRC), false, "workspaceBash 被误开");
});

test("铁律：失败必须如实说，不许把失败讲成没有数据", () => {
  assert.match(SRC, /绝不许编|不许编造|不编数据/, "防幻觉约束被删了");
});

test("工具集：22 个工具都注册了（少一个说明改坏了）", () => {
  const names = [
    "get_summary", "query_workouts", "stats_workouts", "trends", "records",
    "compare_periods", "streaks", "update_workout", "delete_workout",
    "append_workout", "list_review", "confirm_review",
    "current_time", "weather", "web_search", "fetch_url",
    "list_repo_dir", "read_repo_file", "write_plan",
    "set_reminder", "list_reminders", "cancel_reminder",
  ];
  for (const n of names) {
    assert.ok(new RegExp(`\\b${n}:\\s*tool\\(`).test(SRC), `工具 ${n} 没注册`);
  }
});

test("故障不静默：onChatError 兜底还在", () => {
  assert.match(SRC, /async onChatError\(/, "onChatError 没了 → 网关挂了用户会静默失联");
  assert.match(SRC, /模型服务这会儿不可用|模型服务不可用/, "故障提示文案没了");
});

test("答复整形：丢掉工具调用间隙的旁白，只留最终答复", () => {
  const msg = {
    parts: [
      { type: "text", text: "收到，我来帮你查一下。" },
      { type: "tool-query_workouts", state: "output-available" },
      { type: "reasoning", text: "内部思考不该出现" },
      { type: "text", text: "结论：近30天跑了59.9km。" },
    ],
  };
  assert.equal(finalReplyText({ message: msg }), "结论：近30天跑了59.9km。");
});

test("答复整形：没有工具调用时保留全部文本", () => {
  const msg = { parts: [{ type: "text", text: "你好" }, { type: "text", text: "，在的" }] };
  assert.equal(finalReplyText({ message: msg }), "你好，在的");
});

test("答复整形：content 字符串直通（兼容旧格式）", () => {
  assert.equal(finalReplyText({ message: { content: "纯文本" } }), "纯文本");
});

test("截断按码点，emoji 不被切碎", () => {
  const s = "🏃".repeat(10);
  const out = clip(s, 5);
  assert.equal([...out].length, 5);
  assert.equal(out, "🏃🏃🏃🏃🏃");
});
