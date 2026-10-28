/**
 * 网关暂停开关。
 *
 * 为什么需要：免费网关额度/稳定性不可控（429、530 轮着来）。暂停时不应继续打网关，
 * 但也不能丢数据——图片照存、review 照记，恢复后自动补录。
 *
 * 用法：`GATEWAY_PAUSED = "1"` 开，删掉或设 "0" 关。改完 `wrangler deploy` 生效。
 */
export function isPaused(env: { GATEWAY_PAUSED?: string }): boolean {
  const v = String(env.GATEWAY_PAUSED ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

export const PAUSED_REPLY =
  "⏸ 模型网关暂停中（正在换网关）。这期间我没法调用模型，所以：\n"
  + "• 聊天/问数据暂时不可用\n"
  + "• 截图照常收，原图会先存好并记进 review，网关恢复后我自动补录并告诉你\n\n"
  + "网关定下来我会第一时间通知你。";
