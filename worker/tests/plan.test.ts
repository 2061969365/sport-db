// 训练计划状态机：校验、进度、拖延信号、打卡写回。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listPlans, normalizePlan, planPath, planProgress, planSignals, readPlan, writePlan,
} from "../src/plan.ts";
import { installFetch, makeEnv, makeSql, makeStore } from "./helpers.ts";

const TODAY = "2026-10-16";

test("slug 白名单：挡掉路径穿越与怪字符", () => {
  assert.equal(planPath("half-marathon-2026-11"), "plans/half-marathon-2026-11.json");
  assert.equal(planPath("../../etc/passwd"), null);
  assert.equal(planPath("a"), null, "太短");
  assert.equal(planPath("有中文"), null);
});

test("规范化：日期非法直接拒绝，并指出第几条", () => {
  const bad = normalizePlan({ name: "x", sessions: [{ date: "下周一", type: "easy", target: "5km" }] }, TODAY);
  assert.equal(typeof bad, "string");
  assert.match(bad as string, /第 1 次/);
});

test("规范化：未知类型归为 other；过去的未打卡自动算 skipped", () => {
  const p = normalizePlan({
    name: "半马", goal: "2:05", created: TODAY,
    sessions: [
      { date: "2026-10-10", type: "easy", target: "5km" },
      { date: "2026-10-20", type: "unknown-type", target: "6km" },
    ],
  }, TODAY);
  assert.equal(typeof p, "object");
  const plan = p as ReturnType<typeof normalizePlan> & { sessions: { status: string; type: string }[] };
  assert.equal(plan.sessions[0].status, "skipped", "过去的计划默认跳过，避免永远挂着");
  assert.equal(plan.sessions[1].type, "other");
});

test("规范化：会话按日期排序（模型给乱序也要能用）", () => {
  const p = normalizePlan({
    name: "x", created: TODAY,
    sessions: [
      { date: "2026-10-25", type: "long", target: "14km" },
      { date: "2026-10-18", type: "easy", target: "6km" },
    ],
  }, TODAY) as { sessions: { date: string }[] };
  assert.deepEqual(p.sessions.map((s) => s.date), ["2026-10-18", "2026-10-25"]);
});

test("进度：完成率只按训练课算，休息日不算分母", () => {
  const plan = {
    name: "半马", created: TODAY,
    sessions: [
      { date: "2026-10-10", type: "easy", target: "5km", status: "done" },
      { date: "2026-10-12", type: "rest", target: "休息", status: "done" },
      { date: "2026-10-14", type: "tempo", target: "8km", status: "skipped" },
      { date: "2026-10-20", type: "long", target: "14km", status: "planned" },
    ],
  } as never;
  const out = planProgress(plan, TODAY);
  // 训练课 3 次（easy done / tempo skipped / long planned），完成 1 次 → 33%
  // 休息日不算分母、也不算分子（否则会虚高）
  assert.match(out, /完成率 33%/);
  assert.match(out, /接下来：2026-10-20/);
});

test("进度：该练没打卡要单独列出来", () => {
  const plan = {
    name: "半马", created: TODAY,
    sessions: [
      { date: "2026-10-12", type: "easy", target: "5km", status: "planned" },
      { date: "2026-10-20", type: "long", target: "14km", status: "planned" },
    ],
  } as never;
  const out = planProgress(plan, TODAY);
  assert.match(out, /该练没打卡/);
  assert.match(out, /2026-10-12/);
});

test("拖延信号：有未打卡就提醒，次数与最近一次都要说清", () => {
  const plan = {
    sessions: [
      { date: "2026-10-12", type: "easy", target: "5km", status: "planned" },
      { date: "2026-10-14", type: "tempo", target: "8km", status: "planned" },
      { date: "2026-10-13", type: "rest", target: "休息", status: "planned" },
    ],
  } as never;
  const sig = planSignals(plan, TODAY);
  assert.equal(sig.length, 1);
  assert.match(sig[0].text, /2 次/, "休息日不算漏练");
  assert.match(sig[0].text, /2026-10-14/);
});

test("写计划 → 读回来 → 打卡 → 进度变化", async () => {
  const store = makeStore({});
  installFetch(store);
  const env = makeEnv();
  const plan = normalizePlan({
    name: "半马 11 月", goal: "2:05", created: TODAY,
    sessions: [
      { date: "2026-10-20", type: "easy", target: "6km @6'10" },
      { date: "2026-10-22", type: "long", target: "14km" },
    ],
  }, TODAY) as never;
  await writePlan(env, "half-2026-11", plan, "t", makeSql());
  assert.match(store.text("plans/half-2026-11.json"), /半马 11 月/);

  const back = await readPlan(env, "half-2026-11");
  assert.equal(back?.sessions.length, 2);

  back!.sessions[0].status = "done";
  back!.sessions[0].actual = "6.2km @6'05";
  await writePlan(env, "half-2026-11", back!, "t", makeSql());
  const again = await readPlan(env, "half-2026-11");
  assert.equal(again?.sessions[0].status, "done");
  assert.match(planProgress(again!, TODAY), /完成率 50%/);
});

test("列计划：没文件时说清楚，不报错", async () => {
  const store = makeStore({});
  installFetch(store);
  const out = await listPlans(makeEnv());
  assert.match(out, /还没有任何计划/);
});
