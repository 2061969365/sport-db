// 数据快照：模型每轮都能拿到真实数字，不用靠工具来回查、也不凭印象编。
import { test } from "node:test";
import assert from "node:assert/strict";
import { bjHour, buildSnapshot, shouldStaySilent } from "../src/proactive.ts";

const NOW = Date.parse("2026-11-03T10:00:00+08:00");

function row(date: string, km: number, sec: number, hr: number) {
  return {
    id: `${date}-${km}`,
    date,
    type: "outdoor_running",
    distance_m: String(km * 1000),
    duration_s: String(Math.round(km * sec)),
    avg_hr: String(hr),
  } as never;
}

test("快照：给出今天、近7/30天、最近5次和配速", () => {
  const rows = [
    row("2026-10-28", 5, 300, 160),
    row("2026-10-31", 6, 300, 158),
    row("2026-11-02", 4, 310, 152),
  ];
  const s = buildSnapshot(rows, NOW);
  assert.match(s, /今天：2026-11-03/);
  assert.match(s, /近 7 天/);
  assert.match(s, /近 30 天/);
  assert.match(s, /最近 5 次/);
  assert.match(s, /5'00"\/km/);
});

test("快照：指出碎片和疑似重复（教练要能主动挑问题）", () => {
  const rows = [
    row("2026-11-01", 0.38, 120, 150),
    row("2026-11-01", 0.38, 120, 150),
    row("2026-11-01", 0.38, 120, 150),
    row("2026-11-02", 5, 300, 150),
  ];
  const s = buildSnapshot(rows, NOW);
  assert.match(s, /数据质量/);
  assert.match(s, /碎片|重复/);
});

test("快照：空库也要能说话，不编数字", () => {
  const s = buildSnapshot([], NOW);
  assert.match(s, /还没有任何训练记录/);
});

test("bjHour 按北京时间算（不是 UTC）", () => {
  assert.equal(bjHour(Date.parse("2026-11-03T02:00:00+08:00")), 2);
  assert.equal(bjHour(Date.parse("2026-11-03T22:30:00+08:00")), 22);
});

test("快照：每个窗口都带明确日期，本周从周一起算", () => {
  const rows = [row("2026-11-02", 5, 300, 150), row("2026-10-27", 4, 300, 150)];
  const s = buildSnapshot(rows, NOW);
  // 2026-11-03 是周二，本周一 = 11-02
  assert.match(s, /本周（2026-11-02~2026-11-03）/);
  assert.match(s, /上周（2026-10-26~2026-11-01）/);
  assert.match(s, /近 7 天（2026-10-28~2026-11-03）/);
  assert.match(s, /近 30 天（\d{4}-\d{2}-\d{2}~2026-11-03）/);
});

test("快照：设备日报有就报，没有就不提（不许编）", () => {
  const rows = [row("2026-11-02", 5, 300, 150)];
  const withDaily = buildSnapshot(rows, NOW, {
    sleepDate: "2026-11-02", sleepMin: 440, sleepScore: 82,
    sleep7AvgMin: 410, rhrLast: 69, rhr7Avg: 71,
  });
  assert.match(withDaily, /睡 7小时20分/);
  assert.match(withDaily, /评分 82/);
  assert.match(withDaily, /静息心率 69/);

  const without = buildSnapshot(rows, NOW);
  assert.doesNotMatch(without, /身体状态/);
  assert.doesNotMatch(without, /静息心率/);
});

test("模型可以选择不打扰：SILENT 判定", () => {
  assert.equal(shouldStaySilent("SILENT"), true);
  assert.equal(shouldStaySilent("  silent，今天没什么值得说的"), true);
  assert.equal(shouldStaySilent("今天该休息。"), false);
  assert.equal(shouldStaySilent(""), false);
});
