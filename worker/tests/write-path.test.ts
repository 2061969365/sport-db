// 写路径回归：两阶段确认（预览不写 / 确认才写）、冲突中止、路径白名单。
// 这些是最不能坏的纪律——坏了会静默改错用户的运动数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendRow, loadWorkouts, toolAppendWorkout, toolDeleteWorkout, toolListDir,
  toolReadRepoFile, toolUpdateWorkout, toolWritePlan,
} from "../src/github.ts";
import { installFetch, makeEnv, makeSql, makeStore, row } from "./helpers.ts";

const HEAD = "id,date,type,category,distance_m,duration_s,avg_pace_s,avg_hr,source\n";
const RAW = HEAD + "mi-1000-outdoor_running-abc12345,2026-10-13,outdoor_running,outdoor_running,5009,1620,323,150,mi_backup\n";

function setup() {
  const store = makeStore({ "data/workouts/2026.csv": { text: RAW, sha: "s0" } });
  const sql = makeSql();
  const stats = installFetch(store);
  return { store, sql, stats, env: makeEnv() };
}

test("改数：不带 confirmed 只出预览，绝不写库", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const out = await toolUpdateWorkout(env, all, "t", { id: row().id, fields: { distance_m: 5020 } }, sql);
  assert.match(out, /预览/);
  assert.equal(stats.puts, 0, "预览阶段不能有 PUT");
  assert.match(store.text("data/workouts/2026.csv"), /5009/, "文件内容不能变");
});

test("改数：confirmed=true 才写，且只写一次", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const out = await toolUpdateWorkout(env, all, "t",
    { id: row().id, fields: { distance_m: 5020 }, confirmed: true }, sql);
  assert.match(out, /已改/);
  assert.equal(stats.puts, 1);
  assert.match(store.text("data/workouts/2026.csv"), /,5020,/);
});

test("改数：预览后字段被别人改过 → 中止而不是覆盖", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  // 模拟并发：预览快照是 5009，实际文件已被改成 5100
  store.seed("data/workouts/2026.csv", RAW.replace("5009", "5100"), "s1");
  const out = await toolUpdateWorkout(env, all, "t",
    { id: row().id, fields: { distance_m: 5020 }, confirmed: true }, sql);
  assert.match(out, /中止|改过/);
  assert.equal(stats.puts, 0, "冲突时必须放弃写入");
});

test("改数：白名单外字段直接拒绝整次修改（不是悄悄忽略）", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const out = await toolUpdateWorkout(env, all, "t",
    { id: row().id, fields: { id: "hacked" }, confirmed: true }, sql);
  assert.match(out, /不允许改/);
  assert.equal(stats.puts, 0, "含非法字段时一个字都不能写");
  assert.equal(store.text("data/workouts/2026.csv").includes("hacked"), false);
});

test("改数：合法字段正常写入（对照组）", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const out = await toolUpdateWorkout(env, all, "t",
    { id: row().id, fields: { avg_hr: 148 }, confirmed: true }, sql);
  assert.match(out, /已改/);
  assert.equal(stats.puts, 1);
  assert.match(store.text("data/workouts/2026.csv"), /,148,/);
});

test("删除：预览不删，确认才删一次", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const prev = await toolDeleteWorkout(env, all, "t", { id: row().id }, sql);
  assert.match(prev, /预览/);
  assert.equal(stats.puts, 0);
  const done = await toolDeleteWorkout(env, all, "t", { id: row().id, confirmed: true }, sql);
  assert.match(done, /已删/);
  assert.equal(stats.puts, 1);
  assert.equal(store.text("data/workouts/2026.csv").includes(row().id), false);
});

test("补录：日期非法直接拒绝，不写库", async () => {
  const { sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const out = await toolAppendWorkout(env, all, { type: "outdoor_running", date: "昨天", distance_m: 5000 }, sql);
  assert.match(out, /日期格式/);
  assert.equal(stats.puts, 0);
});

test("补录：确认后追加一行且保留表头", async () => {
  const { store, sql, stats, env } = setup();
  const all = await loadWorkouts(env, sql);
  const out = await toolAppendWorkout(env, all,
    { type: "outdoor_running", date: "2026-10-20", distance_m: 5000, duration_s: 1800, confirmed: true }, sql);
  assert.match(out, /已补录/);
  assert.equal(stats.puts, 1);
  const text = store.text("data/workouts/2026.csv");
  assert.match(text.split("\n")[0], /^id,date,/);
  assert.match(text, /manual-/);
});

test("写计划：只能写 plans/ 下的 md", async () => {
  const { sql, stats, env } = setup();
  const bad = await toolWritePlan(env, "data/workouts/2026.csv", "x".repeat(50), true, "t", sql);
  assert.match(bad, /只能写 plans/);
  assert.equal(stats.puts, 0);
  const prev = await toolWritePlan(env, "plans/a.md", "内容".repeat(30), false, "t", sql);
  assert.match(prev, /预览/);
  assert.equal(stats.puts, 0);
  const ok = await toolWritePlan(env, "plans/a.md", "内容".repeat(30), true, "t", sql);
  assert.match(ok, /已新建|已更新/);
  assert.equal(stats.puts, 1);
});

test("读文件/列目录：挡掉路径穿越", async () => {
  const { sql, env } = setup();
  const a = await toolReadRepoFile(env, "../../etc/passwd");
  assert.match(a, /不合法/);
  const b = await toolListDir(env, "../..");
  assert.match(b, /不合法/);
  void sql;
});

test("读缓存：同一 turn 第二次 load 不再打 GitHub", async () => {
  const { sql, stats, env } = setup();
  const first = await loadWorkouts(env, sql);
  assert.equal(first.length, 1);
  const getsAfterFirst = stats.gets;
  await loadWorkouts(env, sql);
  assert.equal(stats.gets, getsAfterFirst, "第二次应命中缓存（不再 GET）");
});

test("写后失效：appendRow 之后缓存被清，再读会重新拉", async () => {
  const { sql, stats, env, store } = setup();
  await loadWorkouts(env, sql);
  const before = stats.gets;
  await appendRow(env, { ...row(), id: "manual-1-outdoor_running-1000", date: "2026-10-20" }, "t", sql);
  await loadWorkouts(env, sql);
  assert.equal(stats.gets > before, true, "写后失效 → 下次读必须重新 GET");
  assert.match(store.text("data/workouts/2026.csv"), /manual-1/);
});

test("appendRow 按 id 去重：同一 id 写两次只留一行", async () => {
  const { env, store, sql } = setup();
  const r = { ...row(), id: "image-1792746646-outdoor_running-4010", date: "2026-10-23" };
  await appendRow(env, r, "t1", sql);
  await appendRow(env, { ...r, confidence: "0.95" }, "t2", sql);
  const text = store.text("data/workouts/2026.csv");
  const hits = text.split("\n").filter((l) => l.includes("image-1792746646-outdoor_running-4010"));
  assert.equal(hits.length, 1, "重复 id 只能写一行");
});
