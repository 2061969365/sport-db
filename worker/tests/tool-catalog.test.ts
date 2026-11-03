// 工具清单守卫：注册的工具必须都在 RULES_BLOCK 里点过名，规则块也不能超预算被截断。
// 起因：30 个工具里有 8 个从没在规则里出现过，模型只能靠猜；write_plan 和 plan_save 还有歧义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/sport-agent.ts", import.meta.url), "utf8");

function rulesText(): string {
  const i = SRC.indexOf("const RULES_BLOCK =");
  const j = SRC.indexOf("export class SportDbAgent", i);
  const block = SRC.slice(i, j);
  const strs: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) strs.push(m[1]);
  return strs.join("").replace(/\\n/g, "");
}

function toolNames(): string[] {
  const i = SRC.indexOf("getTools()");
  const j = SRC.indexOf("\n  }\n}", i);
  const body = SRC.slice(i, j);
  const out: string[] = [];
  const re = /^\s{6}([a-z_]+): tool\(\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

test("每个注册的工具都在规则里点名（不许有黑盒工具）", () => {
  const tools = toolNames();
  assert.ok(tools.length >= 28, `工具数量异常：${tools.length}`);
  const rules = rulesText();
  const missing = tools.filter((t) => !rules.includes(t));
  assert.deepEqual(missing, [], `规则里没提到的工具：${missing.join(", ")}`);
});

test("规则块不能被 maxTokens 截断", () => {
  const rules = rulesText();
  const cap = Number(/label: "rules",[\s\S]{0,200}?maxTokens: (\d+)/.exec(SRC)?.[1] || 0);
  assert.ok(cap >= 3200, `rules 的 maxTokens 太小：${cap}（会被截断，尾部规则失效）`);
  assert.ok(rules.length < cap - 100, `规则正文 ${rules.length} 字，已顶到 ${cap} 上限`);
});

test("计划只走 plan_save，write_plan 只写自由文本", () => {
  const rules = rulesText();
  assert.match(rules, /别拿它存训练计划|不要用 write_plan 存训练计划/, "计划与笔记的分工没写进规则");
  assert.match(SRC, /训练计划请用 plan_save/, "write_plan 的工具描述没说清分工");
});
