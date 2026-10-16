# 归档：旧实现（已退役，留作参考）

这里的东西**线上不再使用**，保留是为了查历史和应急。别在它们上面加功能。

| 文件 | 曾经是什么 | 为什么退役 |
|---|---|---|
| `worker.js` | 最早期的手写 Worker：零依赖、直接 fetch GitHub raw、自己拼 prompt、会话历史写回 `bot_state/tg_history/` | 换成官方 Agents SDK（Think harness）后能力差距太大：没有工具调用纪律、没有审批、没有长期记忆、规则只能塞在 system prompt 里 |
| `tg_poll.py` | GitHub Actions 里跑的 Telegram 长轮询桥 | Worker webhook 上线后**两者互斥**：设了 webhook，`getUpdates` 一律 409。留着只会误导 |
| `bot-poll.yml` | 上面那个轮询桥的工作流 | 同上；定时已注释，只剩手动触发 —— 而手动跑也必然 409，等于纯故障源 |
| `bot_state/` | 旧桥的会话状态：`tg_offset.txt`（轮询 offset）+ 两份 tg_history | 记忆已经搬进 Durable Object SQLite（会话 + 画像 + 备忘）。注意这里当时还并存两种命名（`5896689604.json` 和 `tg-5896689604.json`），本身就是那会儿的乱象之一 |

## 现在对应的是什么

| 旧 | 新 |
|---|---|
| `worker.js` | `worker/src/{server,sport-agent,github,photo}.ts` |
| `tg_poll.py` + `bot-poll.yml` | `worker/src/server.ts` 的 `/tg` webhook |
| `bot_state/tg_history/*.json` | DO SQLite 里的会话历史与 context blocks |

## 应急：万一 webhook 彻底不通

不要回头启轮询桥（会 409）。按顺序查：

1. `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` 看 `last_error_message`；
2. 直接 `curl` Worker 根路径，确认 Worker 自己活着；
3. 确认 `TG_SECRET` 与 `setWebhook` 时的 `secret_token` 一致；
4. 都没问题就重新 `setWebhook` 一次。
