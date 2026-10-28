// 网关暂停开关：暂停时不能打模型，但也不能丢数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPaused, PAUSED_REPLY } from "../src/pause.ts";

test("暂停开关认 1/on/true/yes，其余都算开", () => {
  assert.equal(isPaused({ GATEWAY_PAUSED: "1" }), true);
  assert.equal(isPaused({ GATEWAY_PAUSED: " ON " }), true);
  assert.equal(isPaused({ GATEWAY_PAUSED: "true" }), true);
  assert.equal(isPaused({ GATEWAY_PAUSED: "0" }), false);
  assert.equal(isPaused({}), false);
});

test("暂停提示要说清：聊天不可用、截图照收、恢复后自动补录", () => {
  assert.match(PAUSED_REPLY, /暂停/);
  assert.match(PAUSED_REPLY, /截图照常收/);
  assert.match(PAUSED_REPLY, /自动补录/);
});
