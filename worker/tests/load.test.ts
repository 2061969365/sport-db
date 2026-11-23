// P1 数据层回归：区间解析、TRIMP/ACWR、session 合并。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLoad, ghGetFile, mergeSessions, toolGetSummary, toolStreaks, workoutZoneMinutes, zoneTotals,
} from "../src/github.ts";
import type { Env } from "../src/env.ts";

const NOW = Date.parse("2026-11-23T12:00:00+08:00");

function zoneRow(date: string, z: { z1?: number; z2?: number; z3?: number; z4?: number; z5?: number }) {
  return {
    date,
    type: "outdoor_running",
    start_utc: "",
    value_json: JSON.stringify({
      hrm_warm_up_duration: (z.z1 || 0) * 60,
      hrm_fat_burning_duration: (z.z2 || 0) * 60,
      hrm_aerobic_duration: (z.z3 || 0) * 60,
      hrm_anaerobic_duration: (z.z4 || 0) * 60,
      hrm_extreme_duration: (z.z5 || 0) * 60,
    }),
  };
}

test("区间解析：秒转分钟，坏 JSON 全 0", () => {
  const r = workoutZoneMinutes(zoneRow("2026-11-22", { z1: 10, z2: 20, z3: 30, z4: 5, z5: 1 }));
  assert.deepEqual(r, { z1: 10, z2: 20, z3: 30, z4: 5, z5: 1 });
  assert.deepEqual(workoutZoneMinutes({ value_json: "not-json" }), { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 });
});

test("区间占比：合计 100%，空数据不 NaN", () => {
  const zt = zoneTotals([
    zoneRow("2026-11-21", { z1: 10, z3: 30 }),
    zoneRow("2026-11-22", { z1: 10, z3: 30 }),
  ]);
  assert.deepEqual(zt.minutes, [20, 0, 60, 0, 0]);
  assert.deepEqual(zt.pct, [25, 0, 75, 0, 0]);
  const empty = zoneTotals([]);
  assert.deepEqual(empty.pct, [0, 0, 0, 0, 0]);
});

test("负荷：28 天稳定 30 TRIMP/天 -> ACWR 1.0，单调性 0", () => {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(Date.parse("2026-11-23T00:00:00Z") - i * 864e5).toISOString().slice(0, 10);
    rows.push(zoneRow(d, { z3: 10 })); // 10min Z3 = 30 TRIMP
  }
  const l = computeLoad(rows, NOW);
  assert.equal(l.trimp7, 210);
  assert.equal(l.trimp28, 840);
  assert.equal(l.acwr, 1);
  assert.equal(l.days7, 7);
  assert.equal(l.monotony, 0);
  assert.equal(l.strain, 0);
});

test("负荷：最近一周翻倍 -> ACWR 明显 >1.5", () => {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(Date.parse("2026-11-23T00:00:00Z") - i * 864e5).toISOString().slice(0, 10);
    rows.push(zoneRow(d, { z3: i < 7 ? 20 : 10 })); // 60 vs 30
  }
  const l = computeLoad(rows, NOW);
  assert.ok(l.acwr > 1.5, `acwr=${l.acwr}`);
  assert.ok(l.trimp7 > l.trimp28 / 4);
});

test("session：同日同类型 20 分钟间隔合并，40 分钟不合并", () => {
  const base = 1795000000;
  const rows = [
    { id: "a", date: "2026-11-22", type: "outdoor_running", start_utc: String(base), distance_m: "1000", duration_s: "300", avg_hr: "150" },
    { id: "b", date: "2026-11-22", type: "outdoor_running", start_utc: String(base + 1200), distance_m: "2000", duration_s: "600", avg_hr: "170" },
    { id: "c", date: "2026-11-22", type: "outdoor_running", start_utc: String(base + 3600), distance_m: "3000", duration_s: "900", avg_hr: "160" },
  ];
  const s = mergeSessions(rows);
  assert.equal(s.length, 2);
  assert.equal(s[0].distance_m, 3000);
  assert.equal(s[0].duration_s, 900);
  assert.equal(s[0].ids.length, 2);
  assert.equal(s[0].avg_hr, Math.round(((150 * 300 + 170 * 600) / 900) * 10) / 10);
  assert.equal(s[1].distance_m, 3000);
});

test("负荷：空数据全 0，不产生 NaN/Infinity", () => {
  assert.deepEqual(computeLoad([], NOW), {
    trimp7: 0, trimp28: 0, acwr: 0, monotony: 0, strain: 0, days7: 0,
  });
});

const bjToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

test("summary：跑步次数按 session 计，新增强度分布行", () => {
  const d = bjToday();
  const t0 = Date.parse(`${d}T12:00:00+08:00`) / 1000;
  const rows = [
    { ...zoneRow(d, { z1: 10, z3: 10 }), _year: d.slice(0, 4), id: "a", start_utc: String(t0), distance_m: "2000", duration_s: "600" },
    { ...zoneRow(d, { z1: 10, z3: 10 }), _year: d.slice(0, 4), id: "b", start_utc: String(t0 + 1200), distance_m: "1000", duration_s: "600" },
  ];
  const out = toolGetSummary(rows, 30);
  assert.match(out, /跑步1次（原始2条）/);
  assert.match(out, /强度分布（近30天）：Z1 50% \/ Z2 0% \/ Z3 50% \/ Z4 0% \/ Z5 0%/);
});

test("streaks：同日重复按 1 个 session 计", () => {
  const d = bjToday();
  const t0 = Date.parse(`${d}T12:00:00+08:00`) / 1000;
  const rows = [
    { ...zoneRow(d, {}), _year: d.slice(0, 4), start_utc: String(t0) },
    { ...zoneRow(d, {}), _year: d.slice(0, 4), start_utc: String(t0 + 600) },
  ];
  const out = JSON.parse(toolStreaks(rows)) as {
    active_days: number; total_sessions: number; current_streak_days: number;
  };
  assert.equal(out.active_days, 1);
  assert.equal(out.total_sessions, 1);
  assert.equal(out.current_streak_days, 1);
});

test("ghGetFile：确认 404 返回 null，网络/5xx 抛 GitHub读", async () => {
  const orig = globalThis.fetch;
  const env = { REPO: "owner/repo" } as unknown as Env;
  try {
    globalThis.fetch = (async () => new Response("nf", { status: 404 })) as typeof fetch;
    assert.equal(await ghGetFile(env, "data/workouts/2026.csv"), null);

    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
    await assert.rejects(() => ghGetFile(env, "data/workouts/2026.csv"), /GitHub读/);

    globalThis.fetch = (async () => { throw new Error("ENOTFOUND"); }) as typeof fetch;
    await assert.rejects(() => ghGetFile(env, "data/workouts/2026.csv"), /GitHub读/);
  } finally {
    globalThis.fetch = orig;
  }
});
