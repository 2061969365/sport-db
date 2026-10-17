// /model 命令的入口正则与 @bot名 摘除：TG 与网页共用，写错就整条命令失灵。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelCommand } from "../src/modelcfg.ts";
import { splitForTg } from "../src/notify.ts";

const isCmd = (t) => /^\/model(@\w+)?(\s|$)/.test(t);
const strip = (t) => t.replace(/^\/model(@\w+)?/, "/model");

test("入口正则：认得各种写法，且不误伤普通消息", () => {
  assert.equal(isCmd("/model"), true);
  assert.equal(isCmd("/model list"), true);
  assert.equal(isCmd("/model@myrtuu_bot"), true, "TG 常发成 /model@bot名");
  assert.equal(isCmd("/model@myrtuu_bot list"), true);
  assert.equal(isCmd("models"), false);
  assert.equal(isCmd("/modelx"), false, "别把别的命令吃进来");
  assert.equal(isCmd("我今天用 model 训练"), false);
});

test("摘掉 @bot名 后仍能正确解析", () => {
  assert.deepEqual(parseModelCommand(strip("/model@myrtuu_bot list")), { action: "list" });
  assert.deepEqual(parseModelCommand(strip("/model@bot")), { action: "show" });
  assert.deepEqual(parseModelCommand(strip("/model@bot glm-5.3-flash-free")),
    { action: "set-model", model: "glm-5.3-flash-free" });
});

test("长报告按行切分，不破坏内容", () => {
  const long = Array.from({ length: 400 }, (_, i) => `第${i}行内容`).join("\n");
  const parts = splitForTg(long, 500);
  assert.ok(parts.length > 1, "超长必须切");
  assert.ok(parts.every((p) => p.length <= 500), "每片都不能超限");
  assert.equal(parts.join("\n"), long, "拼回去必须一模一样");
  assert.deepEqual(splitForTg("短"), ["短"]);
});
