// 收图 vision 的韧性：图没生效/网关抖动时不能直接判"识别失败"。
// 现场：图刚 commit，raw CDN 还没生效 → 网关抓不到 → 模型回「我看不到截图」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVisionJson, recognizePhoto, retryReview, waitForImage } from "../src/photo.ts";
import { installFetch, makeEnv, makeStore } from "./helpers.ts";

test("无 JSON 的回复必须抛错（不能让上层当成功）", () => {
  assert.throws(() => parseVisionJson("抱歉，我这边看不到你上传的运动截图，无法读取其中的数据。"),
    /没有 JSON/);
  assert.throws(() => parseVisionJson(""), /没有 JSON/);
});

test("有 JSON 时容忍围栏与废话", () => {
  const a = parseVisionJson('```json\n{"type":"outdoor_riding","distance_km":52.54,"duration_s":8872,"avg_hr":136,"confidence":0.98}\n```');
  assert.equal(a.distance_km, 52.54);
  assert.equal(a.type, "outdoor_riding");
  assert.equal(a.confidence, 0.98);
  const b = parseVisionJson('好的，结果如下：{"type":"outdoor_running","distance_km":4.01,"confidence":0.9} 以上。');
  assert.equal(b.distance_km, 4.01);
});

test("未知类型降级为 free_training 且压低置信度（避免脏数据直接入库）", () => {
  const r = parseVisionJson('{"type":"外星运动","distance_km":5,"confidence":0.95}');
  assert.equal(r.type, "free_training");
  assert.ok(r.confidence <= 0.5);
});

test("置信度被钳在 0~1", () => {
  assert.equal(parseVisionJson('{"type":"outdoor_running","confidence":9}').confidence, 1);
  assert.equal(parseVisionJson('{"type":"outdoor_running","confidence":-3}').confidence, 0);
});

test("waitForImage：HEAD 不行时退化成 Range 取一小段", async () => {
  let headCalls = 0;
  globalThis.fetch = async (_u, init = {}) => {
    if (init.method === "HEAD") { headCalls++; return new Response(null, { status: 405 }); }
    return new Response("x", { status: 206 });
  };
  const ok = await waitForImage(makeEnv(), "https://img.example/a.jpg", 2, 1);
  assert.equal(ok, true, "HEAD 被拒但 Range 能拿到也算可访问");
  assert.equal(headCalls, 1);
});

test("waitForImage：一直 404 就老实返回 false（不假装成功）", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  const ok = await waitForImage(makeEnv(), "https://img.example/a.jpg", 3, 1);
  assert.equal(ok, false);
});

test("recognizePhoto：第一轮看不到图、第二轮正常 → 应当成功（这就是本次现场）", async () => {
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "HEAD") return new Response(null, { status: 200 });
    calls++;
    if (calls === 1) {
      return Response.json({ choices: [{ message: { content: "抱歉，我这边看不到你上传的运动截图。" } }] });
    }
    return Response.json({ choices: [{ message: { content: '{"type":"outdoor_riding","distance_km":52.54,"duration_s":8872,"avg_hr":136,"confidence":0.98}' } }] });
  };
  const rec = await recognizePhoto(makeEnv(), "https://img.example/a.jpg", undefined, 3);
  assert.equal(rec.distance_km, 52.54, "重试后应拿到真实数据");
  assert.equal(calls, 2);
});

test("recognizePhoto：三轮都不行才抛错（错误信息带上最后一次原因）", async () => {
  let calls = 0;
  globalThis.fetch = async (_u, init = {}) => {
    if (init.method === "HEAD") return new Response(null, { status: 200 });
    calls++;
    return Response.json({ choices: [{ message: { content: "看不到图" } }] });
  };
  await assert.rejects(() => recognizePhoto(makeEnv(), "https://img.example/a.jpg", undefined, 3), /没有 JSON/);
  assert.equal(calls, 3, "应该刚好试三轮");
});

test("recognizePhoto：模型接口 500 也会重试", async () => {
  let calls = 0;
  globalThis.fetch = async (_u, init = {}) => {
    if (init.method === "HEAD") return new Response(null, { status: 200 });
    calls++;
    if (calls < 2) return new Response("boom", { status: 500 });
    return Response.json({ choices: [{ message: { content: '{"type":"outdoor_running","distance_km":4.01,"confidence":0.9}' } }] });
  };
  const rec = await recognizePhoto(makeEnv(), "https://img.example/a.jpg", undefined, 3);
  assert.equal(rec.distance_km, 4.01);
});

test("retryReview：路径必须限定在 review/，否则拒绝（防误删别的文件）", async () => {
  const r = await retryReview(makeEnv({ GH_PAT: "p" }), "data/workouts/2026.csv", false, "t");
  assert.match(r, /必须是 review\//);
});

test("retryReview：原图读不到就老实说失败，不动任何文件", async () => {
  const store = makeStore();
  store.seed("review/needs-review-tg1.json",
    JSON.stringify({ image: "images/2026/10/17-tg1.jpg", error: "vision失败" }), "s1");
  const stats = installFetch(store);
  const real = globalThis.fetch; // 保留 GitHub API 的桩
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("raw.githubusercontent.com")) return new Response("nope", { status: 404 });
    return real(url, init);
  };
  const r = await retryReview(makeEnv({ GH_PAT: "p" }), "review/needs-review-tg1.json", false, "t");
  assert.match(r, /现在也读不到/, `实际：${r}`);
  assert.equal(stats.deletes, 0, "失败时绝不能删文件");
});
