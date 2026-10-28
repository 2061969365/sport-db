// 后台自动重试：网关抽风时不该让用户重发图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRetryReviews } from "../src/photo.ts";
import { installFetch, makeEnv, makeStore } from "./helpers.ts";

const ENV = makeEnv({
  GH_PAT: "p",
  VISION_ENDPOINT: "https://gw.example/v1/chat/completions",
  VISION_MODEL: "m1",
});

test("只重试 vision 失败的项，置信度不足的不动", async () => {
  const store = makeStore();
  store.seed("review/a.json", JSON.stringify({ image: "images/x/a.jpg", error: "vision调用失败：模型接口 429" }), "s1");
  store.seed("review/b.json", JSON.stringify({ image: "images/x/b.jpg", type: "outdoor_running", distance_km: 5, confidence: 0.4 }), "s2");
  store.seed("review/c.json", JSON.stringify({ image: "images/x/c.jpg", error: "vision调用失败：模型接口 530", chat: "tg:42" }), "s3");
  const gh = installFetch(store, { reviewList: [
    { name: "a.json", path: "review/a.json" },
    { name: "b.json", path: "review/b.json" },
    { name: "c.json", path: "review/c.json" },
  ] });
  const ghFetch = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("chat/completions")) {
      models.push(JSON.parse(String(init.body || "{}")).model);
      return new Response('{"error":{"message":"Free usage limit reached"}}', { status: 429 });
    }
    if (u.includes("raw.githubusercontent.com")) return new Response("img", { status: 200 });
    return ghFetch(url, init);
  };
  const out = await autoRetryReviews(ENV, 3);
  assert.equal(out.some((x) => x.path === "review/b.json"), false, "置信度不足的不该重试");
  assert.ok(out.length >= 2, `两条失败项都应尝试，实际 ${out.length}`);
  assert.ok(models.length > 0, "确实调了模型");
  assert.equal(out.every((x) => !x.ok), true, "网关全 429 时不该谎报成功");
  assert.equal(gh.deletes, 0, "失败时不能删 review 文件");
});

test("网关恢复后能自动入库并带上来源通道", async () => {
  const store = makeStore();
  store.seed("review/a.json",
    JSON.stringify({ image: "images/x/a.jpg", error: "vision调用失败：模型接口 530", chat: "tg:42" }), "s1");
  const gh = installFetch(store, { reviewList: [{ name: "a.json", path: "review/a.json" }] });
  const ghFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("chat/completions")) {
      return Response.json({ choices: [{ message: { content: '{"type":"outdoor_running","distance_km":5.2,"duration_s":1700,"confidence":0.95}' } }] });
    }
    if (u.includes("raw.githubusercontent.com")) return new Response("img", { status: 200 });
    return ghFetch(url, init);
  };
  const out = await autoRetryReviews(ENV, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true, `应入库成功：${out[0]?.text}`);
  assert.equal(out[0].chat, "tg:42", "要记住通知哪个会话");
  assert.equal(gh.deletes, 1, "入库后删掉 review 文件");
});
