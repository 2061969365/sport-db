# 运动库 SportDB

小米运动健康数据 → 可查询、可对话、可长期保存的个人运动库。
**GitHub 仓库就是数据库**（公开仓，CSV 存数据、git 存历史、可 revert），
Cloudflare Worker 上的 AI Agent 负责查询、改数、收图识别。

- 聊天入口（Telegram）：[@myrtuu_bot](https://t.me/myrtuu_bot)
- 网页版：<https://2061969365.github.io/sport-db/>（首页看板 + `chat.html` 聊天）
- 数据仓：<https://github.com/2061969365/sport-db>

## 能干什么

| 你说 | 它做 |
|---|---|
| 近 30 天跑了多少 | 调工具查真实数据答，不靠记忆 |
| 2023 年第一次跑步是哪天 | 按时间查明细 |
| 我最近有进步吗 | 配速/心率/跑量趋势序列 |
| 我的 PB、最长跑了多远 | 纪录榜 |
| 这个月比上个月怎么样 | 两段对照给变化百分比 |
| 我坚持了几天 | 连击统计 |
| 把 10 月 13 号那条改成 5 公里 | **先出预览 → 你说确认 → 才写库** |
| 昨天跑了 5 公里帮我记上 | 补录，同样两步确认 |
| （直接发运动截图） | 识别 → 自动入库，看不清的进待确认队列 |

指令：`/help`（用法）· `/status`（上下文水位）· `/new`（另起话题，长期画像保留）

## 仓库结构

```
data/workouts/YYYY.csv      运动记录正文（真相源，一行一次运动，28 列）
data/daily/YYYY.csv         每日指标（睡眠/体重/卡路里等，当前 Agent 未接入）
data/raw/fitness/YYYY/MM    小米原始导出（gz）
data/clean_report.txt       导入清洗报告
tracks/gpx/YYYY/MM          轨迹文件（672 个 GPX）
tracks/download_log.csv     轨迹下载台账（URL 已脱敏，不含签名）
images/YYYY/MM              收到的运动截图原图
review/                     识别置信度不足、待人工确认的项
reports/daily/YYYY-MM-DD.md 每晚自动生成的日报
data.db                     由 CSV 编译出的 SQLite（构建产物，供网页直读）

profile/user_profile.md     长期画像（跨通道共享：TG/网页读到同一份）
profile/coaching_notes.md   教练备忘（同上）
plans/*.json                结构化训练计划（可打卡、可算完成率）
state/reminders.json        提醒备份（换账号后自动恢复；按会话属主隔离）

worker/src/server.ts        入口：TG/飞书 webhook、/api/chat、/health
worker/src/sport-agent.ts   Agent 本体：人设/规则、28 个工具、记忆、压缩、兜底
worker/src/github.ts        GitHub 即数据库：CSV 读写、缓存、数据工具
worker/src/photo.ts         截图收图链路：下载 → 入库 → Vision 识别 → 路由
worker/src/web.ts           联网：AnySearch 搜索/正文抽取、天气、抓网页
worker/src/proactive.ts     主动教练：信号判断（纯函数）
worker/src/plan.ts          训练计划状态机
worker/src/profile.ts       跨通道共享画像
worker/src/state.ts         状态备份（提醒）+ 启动恢复
worker/src/metrics.ts       用量记账
worker/tests/               62 条行为回归（CI 自动跑）

scripts/import_mi.py        小米导出 → CSV
scripts/download_gpx.py     轨迹批量下载
scripts/parse_track.py      GPX/TCX/KML → 统一 schema
scripts/ai_image.py         截图识别（本地/CI 版）
scripts/build_db.py         CSV → data.db
scripts/build_report.py     生成每日报告

frontend/                   网页版（首页看板 + 聊天页，PWA）
.github/workflows/sync.yml  每日：消费 inbox → 建库 → 日报 → 发布 Pages
archive/legacy-worker/      已废弃的旧实现（见下）
docs/                       文档，从 docs/README.md 进
```

## 文档

从 **[docs/README.md](docs/README.md)** 进：

- [架构](docs/architecture.md) — 系统怎么拼起来的、数据怎么流、关键取舍
- [Agent](docs/agent.md) — 能力、12 个工具、记忆与压缩、边界
- [运维](docs/operations.md) — 部署、密钥、工作流、排障、自检清单
- [归档说明](archive/legacy-worker/README.md) — 旧 Worker / 轮询桥为什么退役

## 隐私提醒

这是**公开仓**：原图（含 App 截图里的头像/昵称/UID/位置）、轨迹起终点城市都可见。
不想公开就改成私有仓 —— Worker 用 PAT 读写，私有仓一样能跑，只是网页版直读
`data.db` 会失效（Pages 无法读私有仓）。
