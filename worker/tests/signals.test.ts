// P1 教练信号：训练负荷 / 配速匹配心率漂移 / 睡眠口径 / 伤病期话术。
// 全部用合成行，不依赖真实 CSV；跑法：node --test tests/signals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSignals, buildSnapshot } from "../src/proactive.ts";
import { computeLoad, mergeSessions, zoneMinutes } from "../src/coachload.ts";

const NOW = Date.parse("2026-10-16T12:00:00+08:00");
const dayStr = (offset: number) =>
  new Date(NOW + offset * 864e5 + 8 * 36e5).toISOString().slice(0, 10);

// 3000 秒燃脂区 = 50 分钟 z2 = 100 TRIMP
const TRIMP100 = { hrm_fat_burning_duration: 3000 };

function row(o: {
  date: string;
  km?: number;
  hr?: number;
  pace?: number;
  dur?: number;
  start?: number;
  type?: string;
  zones?: Record<string, number>;
}) {
  const type = o.type ?? "outdoor_running";
  const dur = o.dur ?? (o.km && o.pace ? Math.round(o.km * o.pace) : 1800);
  return {
    id: `${o.date}-${type}-${o.start ?? 0}`,
    date: o.date,
    type,
    category: type,
    distance_m: String(Math.round((o.km ?? 0) * 1000)),
    duration_s: String(dur),
    avg_pace_s: String(o.pace ?? 0),
    avg_hr: String(o.hr ?? 0),
    start_utc: String(o.start ?? 0),
    value_json: JSON.stringify(o.zones ?? {}),
    _year: o.date.slice(0, 4),
  };
}

test("zoneMinutes：value_json 的区间秒数换算成分钟", () => {
  const z = zoneMinutes({
    value_json: JSON.stringify({
      hrm_warm_up_duration: 600,
      hrm_fat_burning_duration: 1200,
      hrm_aerobic_duration: 1800,
      hrm_anaerobic_duration: 300,
      hrm_extreme_duration: 60,
    }),
  });
  assert.deepEqual(z, { z1: 10, z2: 20, z3: 30, z4: 5, z5: 1 });
  assert.deepEqual(zoneMinutes({ value_json: "not-json" }), { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 });
});

test("ACWR 偏高 → 负荷偏高信号，且不再重复报 1.8× 单周涨幅", () => {
  const rows = [];
  // 近 7 天每天一次、每次 100 TRIMP；上周只有 5km 做对照
  for (let i = 1; i <= 7; i++) rows.push(row({ date: dayStr(-i), km: 5, hr: 150, pace: 300, zones: TRIMP100 }));
  const load = computeLoad(rows, NOW);
  assert.ok(load.acwr > 1.5, `acwr 应 >1.5，实际 ${load.acwr}`);
  assert.equal(load.days7, 6); // 窗口是 -6..0，7 条里只有 6 条落在窗口内

  const sig = analyzeSignals(rows, NOW);
  const high = sig.find((s) => s.key.startsWith("load-high"));
  assert.ok(high, "应触发负荷偏高");
  assert.equal(high.weight, 78);
  assert.match(high.text, /ACWR/);
  assert.match(high.text, /单调性/);
  assert.equal(sig.some((s) => s.key.startsWith("volume-spike")), false, "ACWR 已报就不该再报单周涨幅");
});

test("ACWR 偏低 → 减量期信号，话术不劝加量", () => {
  const rows = [];
  for (const i of [20, 18, 16, 14, 12, 10, 8]) {
    rows.push(row({ date: dayStr(-i), km: 5, hr: 150, pace: 300, zones: TRIMP100 }));
  }
  rows.push(row({ date: dayStr(-2), km: 5, hr: 150, pace: 300, zones: TRIMP100 }));
  const load = computeLoad(rows, NOW);
  assert.ok(load.acwr < 0.8 && load.trimp28 > 0, `acwr 应偏低，实际 ${load.acwr}`);

  const sig = analyzeSignals(rows, NOW);
  const low = sig.find((s) => s.key.startsWith("load-low"));
  assert.ok(low, "应触发负荷偏低");
  assert.equal(low.weight, 45);
  assert.match(low.text, /刻意减量/);
  assert.doesNotMatch(low.text, /加量/);
  assert.doesNotMatch(low.text, /补一次轻松跑/);
});

test("没有 ACWR 预警时，1.8× 仍作为次要提示出现并引用 ACWR", () => {
  const rows = [
    row({ date: dayStr(-8), km: 3, hr: 150, pace: 300 }),
    row({ date: dayStr(-10), km: 3, hr: 150, pace: 300 }),
    row({ date: dayStr(-1), km: 12, hr: 150, pace: 300 }),
    row({ date: dayStr(-3), km: 12, hr: 150, pace: 300 }),
    row({ date: dayStr(-5), km: 10, hr: 150, pace: 300 }),
  ];
  const sig = analyzeSignals(rows, NOW);
  const spike = sig.find((s) => s.key.startsWith("volume-spike"));
  assert.ok(spike, "应触发单周涨幅提示");
  assert.match(spike.text, /单周涨幅/);
  assert.match(spike.text, /ACWR 0\.00/);
});

test("同配速心率漂移 → 正例（基线 ≥5 场，加权差 ≥6bpm）", () => {
  const rows = [];
  for (const i of [27, 25, 23, 21, 19, 17]) {
    rows.push(row({ date: dayStr(-i), km: 6, hr: 145, pace: 300, start: 1000 }));
  }
  rows.push(row({ date: dayStr(-3), km: 6, hr: 155, pace: 302, start: 1000 }));
  rows.push(row({ date: dayStr(-2), km: 6, hr: 154, pace: 298, start: 1000 }));
  rows.push(row({ date: dayStr(-1), km: 6, hr: 156, pace: 300, start: 1000 }));

  const sig = analyzeSignals(rows, NOW);
  const drift = sig.find((s) => s.key.startsWith("hr-drift"));
  assert.ok(drift, "应触发同配速心率漂移");
  assert.match(drift.text, /同配速/);
  assert.match(drift.text, /高了/);
  assert.match(drift.text, /\*\*10\*\*/);
});

test("同配速心率漂移 → 反例：匹配配速的基线不足 5 场就闭嘴", () => {
  const rows = [];
  // 只有 3 场同配速基线
  for (const i of [20, 18, 16]) {
    rows.push(row({ date: dayStr(-i), km: 6, hr: 145, pace: 300, start: 1000 }));
  }
  // 3 场配速差太远，不能算基线
  for (const i of [14, 12, 10]) {
    rows.push(row({ date: dayStr(-i), km: 6, hr: 145, pace: 420, start: 1000 }));
  }
  rows.push(row({ date: dayStr(-3), km: 6, hr: 165, pace: 302, start: 1000 }));
  rows.push(row({ date: dayStr(-2), km: 6, hr: 166, pace: 301, start: 1000 }));
  rows.push(row({ date: dayStr(-1), km: 6, hr: 167, pace: 303, start: 1000 }));

  const sig = analyzeSignals(rows, NOW);
  assert.equal(sig.some((s) => s.key.startsWith("hr-drift")), false, "基线不足不得误报");
});

test("mergeSessions：同日同 type 且间隔 <30 分钟合并，心率按时长加权", () => {
  const rows = [
    row({ date: "2026-10-10", km: 1, hr: 150, dur: 300, start: 1000 }),
    row({ date: "2026-10-10", km: 1, hr: 160, dur: 300, start: 1400 }),
    row({ date: "2026-10-10", km: 1, hr: 170, dur: 300, start: 1800 }),
    row({ date: "2026-10-10", km: 5, hr: 120, dur: 300, start: 1000, type: "outdoor_riding" }),
    row({ date: "2026-10-10", km: 2, hr: 140, dur: 300, start: 5000 }),
    row({ date: "2026-10-11", km: 2, hr: 140, dur: 300, start: 1000 }),
  ];
  const merged = mergeSessions(rows);
  assert.equal(merged.length, 4);
  const trio = merged.find((r) => r.distance_m === "3000");
  assert.ok(trio, "三段 1km 间歇应合并成一场");
  assert.equal(trio.duration_s, "900");
  assert.equal(trio.avg_hr, "160");
  assert.equal(trio.avg_pace_s, "300");
});

test("睡眠口径：单晚 99 分钟或不足 4 晚都不下结论", () => {
  const rows = [row({ date: dayStr(-1), km: 5, hr: 150, pace: 300 })];
  const tooShort = buildSnapshot(rows, NOW, {
    sleepDate: dayStr(-1), sleepMin: 99, sleepDays7: 7,
  });
  assert.doesNotMatch(tooShort, /睡/);

  const tooFewNights = buildSnapshot(rows, NOW, {
    sleepDate: dayStr(-1), sleepMin: 420, sleepDays7: 3,
  });
  assert.doesNotMatch(tooFewNights, /睡/);

  const ok = buildSnapshot(rows, NOW, {
    sleepDate: dayStr(-1), sleepMin: 420, sleepDays7: 4, sleepScore: 80,
  });
  assert.match(ok, /睡 7小时/);
  assert.match(ok, /近 7 天 4 晚有数据/);
  assert.match(ok, /评分 80/);
});

test("静息心率：超过 7 天或没有日期都不显示，新鲜的带日期", () => {
  const rows = [row({ date: dayStr(-1), km: 5, hr: 150, pace: 300 })];
  assert.doesNotMatch(
    buildSnapshot(rows, NOW, { rhrLast: 50, rhrDate: dayStr(-10) }),
    /静息心率/,
  );
  assert.doesNotMatch(buildSnapshot(rows, NOW, { rhrLast: 50 }), /静息心率/);
  const fresh = buildSnapshot(rows, NOW, { rhrLast: 50, rhrDate: dayStr(-2), stressLast: 42 });
  assert.match(fresh, /静息心率 50/);
  assert.match(fresh, new RegExp(dayStr(-2)));
  assert.match(fresh, /压力均值 42/);
});

test("crossTraining / 膝伤处方 → 跑量骤降改成恢复导向，不劝补轻松跑", () => {
  const rows = [
    row({ date: dayStr(-8), km: 7, hr: 150, pace: 300 }),
    row({ date: dayStr(-10), km: 7, hr: 150, pace: 300 }),
    row({ date: dayStr(-12), km: 6, hr: 150, pace: 300 }),
    row({ date: dayStr(-2), km: 5, hr: 150, pace: 300 }),
  ];

  const normal = analyzeSignals(rows, NOW).find((s) => s.key.startsWith("volume-drop"));
  assert.ok(normal);
  assert.match(normal.text, /补一次轻松跑/);

  const cross = analyzeSignals(rows, NOW, { crossTraining: true })
    .find((s) => s.key.startsWith("volume-drop"));
  assert.ok(cross);
  assert.match(cross.text, /按当前处方继续交叉训练/);
  assert.doesNotMatch(cross.text, /补一次轻松跑/);
  assert.equal(cross.weight, 60);

  const injury = analyzeSignals(rows, NOW, { coaching: "PFPS 复发，全改骑" })
    .find((s) => s.key.startsWith("volume-drop"));
  assert.ok(injury);
  assert.match(injury.text, /等疼痛稳定再评估复跑/);
  assert.doesNotMatch(injury.text, /补一次轻松跑/);

  const unrelated = analyzeSignals(rows, NOW, { coaching: "最近工作忙" })
    .find((s) => s.key.startsWith("volume-drop"));
  assert.ok(unrelated);
  assert.match(unrelated.text, /补一次轻松跑/);
});
