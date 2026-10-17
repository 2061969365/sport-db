// /model 命令与模型配置：解析、地址归一化、优先级、体检。切换模型是能把自己切死的操作，
// 所以这里钉的是"别让错的配置落盘"。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODELCFG_PATH, defaultCfg, formatCfg, loadCfg, normalizeEndpoint, parseModelCommand,
  probeCfg, resetCfg, saveCfg, validModelId,
} from "../src/modelcfg.ts";
import { installFetch, makeEnv, makeSql, makeStore } from "./helpers.ts";

const ENV = makeEnv({ VISION_ENDPOINT: "https://gw.example/v1/chat/completions", VISION_MODEL: "m1" });

test("默认值来自 wrangler.toml 的 vars", () => {
  const c = defaultCfg(ENV);
  assert.equal(c.endpoint, "https://gw.example/v1/chat/completions");
  assert.equal(c.model, "m1");
  assert.equal(c.streaming, false, "默认走非流式（网关流式坏了）");
  assert.equal(defaultCfg(makeEnv({ MODEL_STREAMING: "on" })).streaming, true);
});

test("命令解析：查看/列表/体检/重置/切模型/切地址/流式开关", () => {
  assert.deepEqual(parseModelCommand("/model"), { action: "show" });
  assert.deepEqual(parseModelCommand("/model list"), { action: "list" });
  assert.deepEqual(parseModelCommand("/model 测试"), { action: "test" });
  assert.deepEqual(parseModelCommand("/model reset"), { action: "reset" });
  assert.deepEqual(parseModelCommand("/model glm-5.3-flash-free"), { action: "set-model", model: "glm-5.3-flash-free" });
  assert.deepEqual(parseModelCommand("/model url gw.example"), { action: "set-url", endpoint: "gw.example" });
  assert.deepEqual(parseModelCommand("/model streaming on"), { action: "streaming", on: true });
  assert.deepEqual(parseModelCommand("/model streaming off"), { action: "streaming", on: false });
  assert.deepEqual(parseModelCommand("/model url"), { action: "help" }, "缺参数给帮助而不是崩");
  assert.deepEqual(parseModelCommand("/model streaming 也许"), { action: "help" });
});

test("地址归一化：只写域名也能用", () => {
  assert.equal(normalizeEndpoint("gw.example"), "https://gw.example/v1/chat/completions");
  assert.equal(normalizeEndpoint("https://gw.example"), "https://gw.example/v1/chat/completions");
  assert.equal(normalizeEndpoint("https://gw.example/v1"), "https://gw.example/v1/chat/completions");
  assert.equal(normalizeEndpoint("https://gw.example/v1/chat/completions"), "https://gw.example/v1/chat/completions");
  assert.equal(normalizeEndpoint("https://gw.example/v1/chat/completions/"), "https://gw.example/v1/chat/completions");
  assert.equal(normalizeEndpoint("  "), null);
  assert.equal(normalizeEndpoint("不是地址"), null, "中文域名不带协议也不该被当成合法（无点号）");
});

test("模型名白名单：挡住奇怪输入", () => {
  assert.equal(validModelId("mimo-v2.6-flash-free"), true);
  assert.equal(validModelId("a/b:c"), true);
  assert.equal(validModelId("x"), false, "太短");
  assert.equal(validModelId("坏模型"), false);
  assert.equal(validModelId(""), false);
});

test("优先级：仓里有配置就用仓里的，没有就用 env", async () => {
  const store = makeStore({});
  installFetch(store);
  const sql = makeSql();
  const envCfg = await loadCfg(ENV, sql);
  assert.equal(envCfg.source, "env");
  assert.equal(envCfg.cfg.model, "m1");

  store.seed(MODELCFG_PATH, JSON.stringify({ endpoint: "https://new.example/v1/chat/completions", model: "m2", streaming: true, by: "tg:/model" }), "s1");
  const repoCfg = await loadCfg(ENV, makeSql(), true);
  assert.equal(repoCfg.source, "repo");
  assert.equal(repoCfg.cfg.model, "m2");
  assert.equal(repoCfg.cfg.streaming, true);
});

test("损坏的配置回退到 env，不让 bot 起不来", async () => {
  const store = makeStore({});
  installFetch(store);
  store.seed(MODELCFG_PATH, "{不是合法json", "s1");
  const got = await loadCfg(ENV, makeSql(), true);
  assert.equal(got.source, "env");
  assert.equal(got.cfg.model, "m1");
});

test("非法 endpoint 的配置被拒绝（回退 env）", async () => {
  const store = makeStore({});
  installFetch(store);
  store.seed(MODELCFG_PATH, JSON.stringify({ endpoint: "ftp://x", model: "m2" }), "s1");
  const got = await loadCfg(ENV, makeSql(), true);
  assert.equal(got.source, "env");
});

test("保存：部分字段合并 + 落仓", async () => {
  const store = makeStore({});
  installFetch(store);
  const sql = makeSql();
  const r1 = await saveCfg(ENV, sql, { model: "m9" }, "tg:/model");
  assert.equal(r1.cfg.model, "m9");
  assert.equal(r1.cfg.endpoint, "https://gw.example/v1/chat/completions", "没给的字段保持原值");
  assert.match(store.text(MODELCFG_PATH), /m9/);
  const r2 = await saveCfg(ENV, sql, { streaming: true }, "tg:/model");
  assert.equal(r2.cfg.model, "m9", "切流式不该把模型弄丢");
  assert.equal(r2.cfg.streaming, true);
});

test("重置：删掉仓里的覆盖文件，回到默认", async () => {
  const store = makeStore({});
  installFetch(store);
  store.seed(MODELCFG_PATH, JSON.stringify({ model: "m2" }), "s1");
  const cfg = await resetCfg(ENV, makeSql());
  assert.equal(cfg.model, "m1");
});

test("体检：三项里任何一项失败都不能算通过", async () => {
  // 假网关：对话 OK、工具返回空、读图报错
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    if (body.tools) return Response.json({ choices: [{ message: { content: "我不会调工具" } }] });
    if (JSON.stringify(body.messages).includes("image_url")) return new Response("boom", { status: 500 });
    return Response.json({ choices: [{ message: { content: "在的" } }] });
  };
  const r = await probeCfg({ endpoint: "https://gw.example/v1/chat/completions", model: "m", streaming: false });
  assert.equal(r.ok, false, "工具不通就不能算可用");
  assert.match(r.lines.join("\n"), /工具调用/);
});

test("体检：全通时 ok=true", async () => {
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    if (body.tools) return Response.json({ choices: [{ message: { tool_calls: [{ id: "c" }] } }] });
    if (JSON.stringify(body.messages).includes("image_url")) {
      return Response.json({ choices: [{ message: { content: '{"distance_km":4.01}' } }] });
    }
    return Response.json({ choices: [{ message: { content: "在的" } }] });
  };
  const r = await probeCfg({ endpoint: "https://gw.example/v1/chat/completions", model: "m", streaming: false },
    "https://img.example/a.jpg");
  assert.equal(r.ok, true);
  assert.match(r.lines.join("\n"), /读图正常/);
});

test("摘要文案：说清来源与流式模式", () => {
  const s = formatCfg({ cfg: { endpoint: "https://gw.example/v1/chat/completions", model: "m9", streaming: false }, source: "repo", by: "tg:/model" });
  assert.match(s, /gw\.example/);
  assert.match(s, /m9/);
  assert.match(s, /非流式/);
  assert.match(s, /tg:\/model/);
});
