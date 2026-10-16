// 状态备份：提醒落仓 + 换账号后能恢复（哪些该重挂、哪些该清）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { REMINDERS_PATH, readStateJson, rearmPlan, stateLoc, writeStateJson } from "../src/state.ts";
import { makeEnv } from "./helpers.ts";

const NOW = Date.parse("2026-10-16T12:00:00+08:00");
const iso = (offsetMin) => new Date(NOW + offsetMin * 60_000).toISOString();

/** 假 GitHub：按 repo 分开存，记录写到了哪个仓 */
function fakeGit() {
  const repos = new Map();
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = u.match(/repos\/([^/]+\/[^/]+)\/contents\/(.+?)(\?|$)/);
    if (!m) throw new Error("unexpected " + u);
    const [, repo, path] = m;
    if (!repos.has(repo)) repos.set(repo, new Map());
    const store = repos.get(repo);
    const method = init.method || "GET";
    if (method === "GET") {
      if (!store.has(path)) return new Response("nf", { status: 404 });
      return Response.json({ content: store.get(path).b64, sha: "s1" });
    }
    log.push(`${repo}:${path}`);
    const body = JSON.parse(init.body);
    store.set(path, { b64: body.content });
    return Response.json({ content: { sha: "s2" } });
  };
  return { repos, log };
}

test("默认写到数据仓", () => {
  const loc = stateLoc(makeEnv());
  assert.equal(loc?.repo, "owner/repo");
  assert.equal(loc?.dedicated, false);
});

test("配了 STATE_REPO+STATE_PAT 就走独立（私有）仓", () => {
  const loc = stateLoc(makeEnv({ STATE_REPO: "me/sport-db-private", STATE_PAT: "pat2" }));
  assert.equal(loc?.repo, "me/sport-db-private");
  assert.equal(loc?.dedicated, true);
});

test("没 PAT 就没法备份（返回 null，不抛）", () => {
  assert.equal(stateLoc({ REPO: "o/r" } as never), null);
});

test("往返：写进去能读回来；文件不存在返回 null", async () => {
  fakeGit();
  const env = makeEnv();
  assert.equal(await readStateJson(env, REMINDERS_PATH), null);
  const payload = { updated_at: 1, reminders: [{ id: "r1", when: iso(60), kind: "once", text: "喝水" }] };
  assert.equal(await writeStateJson(env, REMINDERS_PATH, payload, "bot: 测试"), true);
  assert.deepEqual(await readStateJson(env, REMINDERS_PATH), payload);
});

test("敏感状态只写私有仓，不落公开数据仓", async () => {
  const git = fakeGit();
  const env = makeEnv({ STATE_REPO: "me/sport-db-private", STATE_PAT: "pat2" });
  await writeStateJson(env, "state/chat/2026-10.md", { note: "私人对话" }, "bot: 聊天备份");
  assert.equal(git.log.some((l) => l.startsWith("owner/repo:")), false, "公开仓里不该出现聊天备份");
  assert.equal(git.log.some((l) => l.startsWith("me/sport-db-private:")), true);
});

test("恢复计划：未来的重挂，过期坏掉的清掉，cron 永远保留", () => {
  const items = [
    { id: "a", when: iso(60), kind: "once", text: "未来" },
    { id: "b", when: iso(-120), kind: "once", text: "过去" },
    { id: "c", when: "0 7 * * *", kind: "cron", text: "每天7点" },
    { id: "d", when: "不是时间", kind: "once", text: "坏数据" },
    { id: "e", when: iso(-0.2), kind: "once", text: "刚过点" },
  ] as never[];
  const { arm, drop, keep } = rearmPlan(items, NOW);
  assert.deepEqual(arm.map((x) => x.id).sort(), ["a", "c"]);
  assert.deepEqual(drop.map((x) => x.id), ["d"]);
  assert.deepEqual(keep.map((x) => x.id).sort(), ["b", "e"]);
});

test("恢复计划：空列表和脏数据都不炸", () => {
  assert.deepEqual(rearmPlan([], NOW).arm, []);
  const r = rearmPlan([{ id: "x", when: iso(10), kind: "once", text: "" }] as never[], NOW);
  assert.equal(r.arm.length, 0, "没内容的提醒不该被重挂");
});
