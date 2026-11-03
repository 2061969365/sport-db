// 数据快照：模型每轮都能拿到真实数字，不用靠工具来回查、也不凭印象编。
import { test } from "node:test";
import assert from "node:assert/strict";
import { bjHour, buildSnapshot } from "../src/proactive.ts";

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
