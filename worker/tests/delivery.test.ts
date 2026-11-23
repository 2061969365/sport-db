// P1 投递层回归：超长单行硬切、429 重试、4xx 不重试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForTg, tgSend } from "../src/notify.ts";
import { makeEnv } from "./helpers.ts";

test("splitForTg：超长单行按码点硬切，拼回原文", () => {
  const text = "跑".repeat(9000);
  const parts = splitForTg(text, 3500);
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(Array.from(p).length <= 3500);
  assert.equal(parts.join(""), text);
});

test("splitForTg：正常多行不切碎", () => {
  const text = Array.from({ length: 100 }, (_, i) => `第${i}行`).join("\n");
  const parts = splitForTg(text, 3500);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], text);
});

test("tgSend：429 退避后重试成功", async () => {
  let n = 0;
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) {
      return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 0 } }), { status: 429 });
    }
    return Response.json({ ok: true });
  };
  try {
    const ok = await tgSend(makeEnv({ TG_BOT_TOKEN: "t" }), 1, "hi");
    assert.equal(ok, true);
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = old;
  }
});

test("tgSend：400 不重试，返回 false", async () => {
  let n = 0;
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    n++;
    return new Response("bad", { status: 400 });
  };
  try {
    const ok = await tgSend(makeEnv({ TG_BOT_TOKEN: "t" }), 1, "hi");
    assert.equal(ok, false);
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = old;
  }
});
