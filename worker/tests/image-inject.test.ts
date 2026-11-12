import { test } from "node:test";
import assert from "node:assert/strict";
import { hasImagePart, injectImageParts } from "../src/imageparts.ts";

const URL1 = "https://raw.githubusercontent.com/o/r/main/images/2026/11/05-tg249.jpg";

function bodyWithTool(marker: string): string {
  return JSON.stringify({
    model: "m",
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "看看这张图" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "view_repo_image", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: `图已放入：images/x.jpg\n${marker}` },
    ],
  });
}

test("工具结果里的 @@IMG@@ 会被注入成 user 图片消息", () => {
  const r = injectImageParts(bodyWithTool(`@@IMG@@${URL1}`));
  assert.equal(r.injected, 1);
  const b = JSON.parse(String(r.body));
  const last = b.messages[b.messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[1].type, "image_url");
  assert.equal(last.content[1].image_url.url, URL1);
  assert.equal(hasImagePart(r.body), true);
});

test("已经有同 URL 的图片就不重复注入", () => {
  const body = JSON.stringify({
    messages: [
      { role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: URL1 } }] },
      { role: "tool", content: `@@IMG@@${URL1}` },
    ],
  });
  const r = injectImageParts(body);
  assert.equal(r.injected, 0);
  assert.equal(r.body, body);
});

test("没有标记 / 不是 JSON 时原样返回", () => {
  const plain = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(injectImageParts(plain), { body: plain, injected: 0 });
  assert.deepEqual(injectImageParts("not json"), { body: "not json", injected: 0 });
  assert.deepEqual(injectImageParts(null), { body: null, injected: 0 });
});
