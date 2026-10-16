// 对话备份：**绝不能**把聊天写进公开仓（这是红线），以及节流与渲染。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_EXPORT_MIN_GAP_MS, chatBackupEnabled, chatPath, formatTranscript, shouldExportChat,
} from "../src/state.ts";
import { makeEnv } from "./helpers.ts";

test("红线：没配私有仓时，聊天备份必须关着", () => {
  assert.equal(chatBackupEnabled(makeEnv()), false, "只有数据仓 → 不能备份聊天");
  assert.equal(chatBackupEnabled({ REPO: "o/r" } as never), false);
});

test("红线：只在配了 STATE_REPO+STATE_PAT（独立仓）时才开", () => {
  assert.equal(chatBackupEnabled(makeEnv({ STATE_REPO: "me/p", STATE_PAT: "pat" })), true);
});

test("只给 STATE_REPO 没给 PAT 也不开（避免半配置状态误写）", () => {
  assert.equal(chatBackupEnabled(makeEnv({ STATE_REPO: "me/p" })), false);
  assert.equal(chatBackupEnabled(makeEnv({ STATE_PAT: "pat" })), false);
});

test("备份路径按天分文件", () => {
  assert.equal(chatPath("2026-10-16"), "state/chat/2026-10-16.md");
});

test("节流：刚备份过就不再写，force 可强制", () => {
  const now = 1_000_000_000;
  assert.equal(shouldExportChat(0, now), true, "从没备份过 → 立刻备份");
  assert.equal(shouldExportChat(now - 1000, now), false, "1 秒前刚备份 → 跳过");
  assert.equal(shouldExportChat(now - CHAT_EXPORT_MIN_GAP_MS - 1, now), true);
  assert.equal(shouldExportChat(now - 1000, now, true), true, "force 应无视节流");
});

test("渲染：只留对话文本，工具/思考不进备份", () => {
  const md = formatTranscript([
    { role: "user", text: "我近30天跑了多少？" },
    { role: "assistant", text: "27 次、59.9km。" },
  ], "2026-10-16");
  assert.match(md, /# 2026-10-16 对话记录/);
  assert.match(md, /🧑 我/);
  assert.match(md, /🤖 教练/);
  assert.match(md, /59\.9km/);
  assert.equal(/tool|reasoning/i.test(md), false);
});

test("渲染：空内容跳过；超长时保留最近的部分", () => {
  const md = formatTranscript([
    { role: "user", text: "" },
    { role: "assistant", text: "有内容" },
  ], "2026-10-16");
  assert.equal(md.split("###").length, 2, "空消息不该产生小节");

  const long = formatTranscript(
    [{ role: "user", text: "开头" }, { role: "assistant", text: "x".repeat(1000) }],
    "2026-10-16", 300);
  assert.ok(long.length < 500, "应被截断");
  assert.match(long, /更早的内容已省略/);
});

test("渲染：带时间戳（北京时间）", () => {
  // 2026-10-16T02:30:00Z = 北京 10:30
  const md = formatTranscript([{ role: "user", text: "早", at: Date.parse("2026-10-16T02:30:00Z") }], "2026-10-16");
  assert.match(md, /10:30/);
});
