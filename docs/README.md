# 文档索引

四份文档，各管一摊，改代码时顺手改对应的：

| 文档 | 什么时候看 |
|---|---|
| [architecture.md](architecture.md) | 想知道系统怎么拼起来的、数据存在哪、为什么这么设计 |
| [agent.md](agent.md) | 想改 Agent 的人设/工具/记忆，或想知道它为什么这么答 |
| [operations.md](operations.md) | 要部署、换密钥、排障、发版前自检 |
| [archive/2026-10-14-design.md](archive/2026-10-14-design.md) | 最早的方案设计稿（历史，别当现状读） |

## 约定

- **真相源**：`data/*.csv` + `tracks/` + `images/`，全在 git 里，可 revert。
  `data.db` 是构建产物，别手改。
- **改数据只走两条路**：Agent 的工具（带预览确认）或 `scripts/*.py` 重新导入。
  不要直接手编 CSV —— 容易破坏列数/CRLF，Agent 读出来就是错行。
- **改 Worker 代码后必须**：`npx tsc --noEmit` 看**真实退出码**（有个管道假 0 的坑，
  见运维文档），再 `npx wrangler deploy`。
- **密钥永不进仓**：只放 `wrangler secret`。日志里也不要落签名 URL
  （`scripts/download_gpx.py` 已内置脱敏）。
