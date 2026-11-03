// 纪律不变量 + 答复整形回归。
// prompts 是最容易改坏又最难发现的东西：这里把"必须有的话"和"必须不能有的行为"钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finalReplyText, clip } from "../src/notify.ts";

const SRC = readFileSync(new URL("../src/sport-agent.ts", import.meta.url), "utf-8");

test("底线还在：预览确认、不编数字、安全优先、工具边界", () => {
  // 人设可以放松，这四条是职业底线，删了就会出事
  assert.match(SRC, /先给预览/, "改数据的预览要求没了");
  assert.match(SRC, /等他说确认再写/, "两阶段确认没了");
  assert.match(SRC, /绝不编/, "防幻觉约束没了");
  assert.match(SRC, /疼、晕、胸闷、夜间心悸永远压过任何训练计划/, "安全优先被删了");
  assert.match(SRC, /【工具边界】/, "工具清单没了");
  assert.match(SRC, /current_time/, "相对日期依赖的 current_time 说明没了");
});

test("铁律：仍然明确禁止用 workspace 内置文件工具", () => {
  assert.match(SRC, /workspace 的内置文件工具/, "workspace 禁令被删了");
  assert.equal(/workspaceBash\s*=\s*true/.test(SRC), false, "workspaceBash 被误开");
});

test("铁律：失败必须如实说，不许把失败讲成没有数据", () => {
  assert.match(SRC, /绝不编|不许编造|不编数据|查不到就说查不到/, "防幻觉约束被删了");
});

test("工具集：30 个工具都注册了（少一个说明改坏了）", () => {
  const names = [
    "get_summary", "query_workouts", "stats_workouts", "trends", "records",
    "compare_periods", "streaks", "update_workout", "delete_workout",
    "append_workout", "list_review", "confirm_review", "retry_review",
    "current_time", "weather", "web_search", "fetch_url",
    "list_repo_dir", "read_repo_file", "write_plan",
    "set_reminder", "list_reminders", "cancel_reminder", "coach_check",
    "plan_save", "plan_list", "plan_progress", "plan_mark", "usage_stats",
    "chat_backup",
  ];
  for (const n of names) {
    assert.ok(new RegExp(`\\b${n}:\\s*tool\\(`).test(SRC), `工具 ${n} 没注册`);
  }
});

test("故障不静默：onChatError 兜底还在", () => {
  assert.match(SRC, /async onChatError\(/, "onChatError 没了 → 网关挂了用户会静默失联");
  assert.match(SRC, /模型服务这会儿不可用|模型服务不可用/, "故障提示文案没了");
});

test("主动教练：定时自查、静默时段、频率闸门都还在", () => {
  assert.match(SRC, /scheduleEvery\(\s*6 \* 3600/, "主动自查的定时没挂上");
  assert.match(SRC, /8 \* 3600_000/, "频率闸门被删了 → 会变骚扰");
  assert.match(SRC, /hour < 8 \|\| hour >= 22/, "静默时段没了 → 会半夜推送（踩过：凌晨 2 点提醒）");
  assert.match(SRC, /channel !== "tg" && channel !== "feishu"/, "网页版不该走主动推送");
  assert.match(SRC, /composeCoachNote/, "主动消息应交给模型生成，而不是固定模板");
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
