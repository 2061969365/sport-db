// 跨通道共享画像：核心断言是「A 通道写的，B 通道能读到」。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTES_PATH, PROFILE_PATH, PROFILE_SEED, profileShared, repoProfileProvider,
} from "../src/profile.ts";
import { installFetch, makeEnv, makeSql, makeStore } from "./helpers.ts";

test("共享开关：默认开，显式 false 关闭，没 PAT 自动关", () => {
  assert.equal(profileShared(makeEnv()), true);
  assert.equal(profileShared(makeEnv({ PROFILE_SHARED: "false" })), false);
  assert.equal(profileShared(makeEnv({ PROFILE_SHARED: "FALSE" })), false);
  assert.equal(profileShared({ REPO: "o/r" } as never), false, "没 GH_PAT 就没法共享");
});

test("文件不存在时给种子文案（模型知道该往里写什么）", async () => {
  const store = makeStore({});
  installFetch(store);
  const p = repoProfileProvider(makeEnv(), PROFILE_PATH, makeSql(), PROFILE_SEED);
  assert.equal(await p.get(), PROFILE_SEED);
});

test("A 通道写 → B 通道读得到（跨通道共享的核心）", async () => {
  const store = makeStore({});
  installFetch(store);
  const env = makeEnv();
  const writer = repoProfileProvider(env, PROFILE_PATH, makeSql(), PROFILE_SEED);
  await writer.set("目标：2026-11-15 半马；右膝旧伤，避免下坡冲刺。");
  assert.match(store.text(PROFILE_PATH), /半马/);

  // 另一个"通道"= 另一个 DO：独立缓存，只能从仓库读
  const reader = repoProfileProvider(env, PROFILE_PATH, makeSql(), PROFILE_SEED);
  assert.equal(await reader.get(), "目标：2026-11-15 半马；右膝旧伤，避免下坡冲刺。");
});

test("60 秒内命中缓存，不再打 GitHub", async () => {
  const store = makeStore({ [PROFILE_PATH]: { text: "旧画像", sha: "s0" } });
  const stats = installFetch(store);
  const p = repoProfileProvider(makeEnv(), PROFILE_PATH, makeSql(), PROFILE_SEED);
  await p.get();
  const afterFirst = stats.gets;
  await p.get();
  assert.equal(stats.gets, afterFirst, "第二次应命中缓存");
});

test("写回时用最新 sha（拿陈旧缓存会被 409 挡下）", async () => {
  const store = makeStore({ [PROFILE_PATH]: { text: "v1", sha: "s0" } });
  const stats = installFetch(store);
  const p = repoProfileProvider(makeEnv(), PROFILE_PATH, makeSql(), PROFILE_SEED);
  await p.get(); // 缓存写入 sha
  store.seed(PROFILE_PATH, "v2", "s1"); // 别的通道改了
  await p.set("v3");
  assert.equal(stats.puts, 1, "应重读最新 sha 后一次写成功");
  assert.equal(store.text(PROFILE_PATH), "v3");
});

test("画像文件是明文 markdown 路径（用户能自己看/改）", () => {
  assert.equal(PROFILE_PATH, "profile/user_profile.md");
  assert.equal(NOTES_PATH, "profile/coaching_notes.md");
});
