import { test } from "node:test";
import assert from "node:assert/strict";
import { countImageParts, injectImageParts } from "../src/imageparts.ts";

const URL1 = "https://raw.githubusercontent.com/o/r/main/images/2026/11/05-tg249.jpg";

test("历史深处的旧标记不会让每一轮都重发图片", () => {
  const body = JSON.stringify({
    messages: [
      { role: "tool", content: `@@IMG@@${URL1}` },
      { role: "assistant", content: "看到了" },
      { role: "user", content: "那今天呢" },
      { role: "assistant", content: "今天没跑" },
      { role: "user", content: "哦" },
    ],
  });
  const r = injectImageParts(body);
  assert.equal(r.injected, 0);
  assert.equal(r.body, body);
  assert.equal(countImageParts(r.body), 0);
});

test("最近的标记仍然会注入", () => {
  const body = JSON.stringify({
    messages: [
      { role: "user", content: "看看图" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", content: `图已放入\n@@IMG@@${URL1}` },
    ],
  });
  const r = injectImageParts(body);
  assert.equal(r.injected, 1);
  assert.equal(countImageParts(r.body), 1);
});
