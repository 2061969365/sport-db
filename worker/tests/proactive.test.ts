// 主动教练信号回归：这些规则决定"它会不会主动找你"，错报=骚扰，漏报=没用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSignals, bjToday } from "../src/proactive.ts";

const NOW = Date.parse("2026-10-16T12:00:00+08:00");
const dayStr = (offset) => new Date(NOW + offset * 864e5 + 8 * 36e5).toISOString().slice(0, 10);

function run(date, km, hr = 150, type = "outdoor_running") {
  return {
    id: `x-${date}-${km}`, date, type, category: type,
    distance_m: String(Math.round(km * 1000)), duration_s: "1800",
    avg_hr: String(hr), source: "mi_backup", _year: date.slice(0, 4),
  };
}

test("bjToday 用北京时间而不是 UTC", () => {
  // 北京时间 2026-10-16 00:30 = UTC 2026-10-15 16:30，不能算成 15 号
  assert.equal(bjToday(Date.parse("2026-10-15T16:30:00Z")), "2026-10-16");
});

test("没信号时闭嘴（正常训练节奏不该被打扰）", () => {
  const rows = [
    run(dayStr(-1), 6), run(dayStr(-3), 6), run(dayStr(-5), 5),
    run(dayStr(-8), 6), run(dayStr(-10), 6), run(dayStr(-12), 5),
  ];
  const sig = analyzeSignals(rows, NOW);
  assert.equal(sig.some((s) => s.key.startsWith("idle")), false);
  assert.equal(sig.some((s) => s.key.startsWith("volume-drop")), false);
  assert.equal(sig.some((s) => s.key.startsWith("volume-spike")), false);
});

test("超过 4 天没动 → 提醒，并报出天数", () => {
  const rows = [run(dayStr(-6), 5), run(dayStr(-8), 5)];
  const sig = analyzeSignals(rows, NOW);
  const idle = sig.find((s) => s.key.startsWith("idle"));
  assert.ok(idle, "应当触发中断提醒");
  assert.match(idle.text, /6 天/);
});

test("本周跑量骤降 → 提醒并给出百分比", () => {
  const rows = [
    // 上周 20km
    run(dayStr(-8), 7), run(dayStr(-10), 7), run(dayStr(-12), 6),
    // 本周只有 5km
    run(dayStr(-2), 5),
  ];
  const sig = analyzeSignals(rows, NOW);
  const drop = sig.find((s) => s.key.startsWith("volume-drop"));
  assert.ok(drop, "应当触发跑量骤降");
  assert.match(drop.text, /75%/);
});

test("本周跑量暴涨 → 触发受伤风险提示", () => {
  const rows = [
    run(dayStr(-8), 3), run(dayStr(-10), 3),
    run(dayStr(-1), 12), run(dayStr(-3), 12), run(dayStr(-5), 10),
  ];
  const sig = analyzeSignals(rows, NOW);
  assert.ok(sig.some((s) => s.key.startsWith("volume-spike")), "应当提示涨幅过大");
});

test("心率漂移 → 对比 30 天基线并给出差值", () => {
  const rows = [];
  for (let i = 26; i >= 9; i -= 2) rows.push(run(dayStr(-i), 6, 148));
  rows.push(run(dayStr(-3), 6, 163), run(dayStr(-2), 6, 165), run(dayStr(-1), 6, 162));
  const sig = analyzeSignals(rows, NOW);
  const hr = sig.find((s) => s.key.startsWith("hr-drift"));
  assert.ok(hr, "应当触发心率漂移");
  assert.match(hr.text, /高了/);
});

test("信号按重要度排序，且一天内每种信号只有一个键", () => {
  const rows = [run(dayStr(-9), 5)]; // 长期中断
  const sig = analyzeSignals(rows, NOW);
  const weights = sig.map((s) => s.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
  const keys = sig.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("空库不报错也不乱报", () => {
  assert.deepEqual(analyzeSignals([], NOW), []);
});

test("骑行数据不混进跑步跑量", () => {
  const rows = [
    run(dayStr(-8), 20, 150, "outdoor_riding"),
    run(dayStr(-2), 6),
  ];
  const sig = analyzeSignals(rows, NOW);
  // 上周骑车 20km 不该被当成"上周跑步跑量"从而误报骤降
  assert.equal(sig.some((s) => s.key.startsWith("volume-drop")), false);
});
