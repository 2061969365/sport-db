# 架构

## 一句话

GitHub 仓库当数据库，Cloudflare Worker 上的 Agent 当大脑，Telegram / 网页当嘴。

```
                  ┌──────────── 用户 ────────────┐
                  │ Telegram 机器人   网页 chat.html │
                  └───────┬──────────────┬────────┘
                          │ webhook      │ POST /api/chat
                  ┌───────▼──────────────▼────────┐
                  │  Cloudflare Worker            │
                  │  src/server.ts  通道接线/回消息 │
                  │  src/sport-agent.ts  Think Agent│
                  │   ├─ 规则/人设（context block） │
                  │   ├─ 12 个工具                  │
                  │   ├─ 记忆（DO SQLite）          │
                  │   └─ 上下文压缩（80% 触发）      │
                  │  src/photo.ts   截图 → 识别 → 入库│
                  │  src/github.ts  CSV 读写 + 缓存  │
                  └───┬───────────────────┬───────┘
                      │ Contents API(PAT) │ Vision API
              ┌───────▼────────┐   ┌──────▼─────────┐
              │ GitHub 仓库     │   │ 多模态网关      │
              │ CSV/GPX/图片/审核│   │ muse-spark-1.3 │
              └────────────────┘   └────────────────┘
```

## 四层存储，各管各的

| 存什么 | 存哪 | 为什么 |
|---|---|---|
| 运动记录、轨迹、原图、待确认项 | **GitHub 仓库**（CSV/文件） | 公开可查、git 有历史、改错能 revert、不依赖任何数据库服务、几年后照样能读 |
| 对话历史、长期画像、教练备忘 | **Durable Object SQLite** | 只有 Agent 自己用，不入数据仓，避免污染真相源 |
| 读缓存、去重键、限流计数 | **DO SQLite** | 省 GitHub API 配额（5000/小时，是真正的瓶颈） |
| 网页版要查的 SQLite | **data.db**（CI 编译产物） | 浏览器直读，不经过 Worker |

**为什么不直接上 D1/Postgres**：数据量小（6 年 800 条）、要求「几年不崩」，
纯文本 + git 的寿命远长于任何托管数据库；而且公开仓天然自带备份和审计。

## 一次提问的数据流

1. TG 收到消息 → Worker 校验 `TG_SECRET` → 取会话对应的 Agent 实例；
2. `claimUpdate()` 认领这条 update（重复推送直接丢弃，幂等）；
3. Agent 把规则块 + 记忆块 + 历史拼成 prompt → 调模型；
4. 模型决定调工具 → 工具从 CSV 读数据（走 DO 缓存，300s 内同 turn 只读一次）；
5. 工具结果回给模型 → 生成回答 → 截断到 3500 码点 → 回 TG；
6. 用户若要改数：`update_workout` 先返回预览（**不写**），用户说「确认」后
   再调一次带 `confirmed=true` 才真正写回 GitHub（带 sha 乐观锁，冲突重试）。

## 关键设计取舍

**两阶段写入**：改/删/补录都先预览后执行。Agent 会记错、会误解，
写进 git 的错数据虽然能 revert，但用户未必发现得了 —— 让人确认一次最划算。

**GitHub 读缓存**：早期每个工具都重新拉一遍 6 个年文件，一个问题 12~18 次
读取。现在 DO 里缓存 300 秒并做否定缓存（不存在的年份不再反复问），
单问题降到 2 次以内。写回后立刻失效。

**规则进 context block 而不是 system prompt**：Think harness 一旦声明了
context block，`getSystemPrompt()` 的返回值就被忽略（freezeSystemPrompt 优先）。
所以人设/铁律都写在只读 `rules` 块里，改规则=改块内容。

**`this.sql` 只能以方法形式调用**：它内部依赖 `this.ctx`，摘出来存变量
（哪怕 bind 过、或包一层）都会在运行时抛 `Cannot read properties of undefined
(reading 'ctx')`。工具里传给 `github.ts` 的 sql 必须是箭头闭包。

**轨迹/图片进仓而不进数据库**：112MB GPX 和原图放 git 里，CSV 只存元数据
和 `has_track` 标记，避免 SQLite 膨胀，也避免 blob 拖慢克隆。

## 数据模型

`data/workouts/YYYY.csv`（28 列，按年分片）：

```
id  date  start_utc  start_beijing  end_utc  end_beijing  type  category
distance_m  duration_s  avg_pace_s  max_pace_s  avg_speed  max_speed
avg_hr  max_hr  min_hr  calories  steps  cadence  avg_stride  total_climbing
uid_hash  sid_hash  has_track  source  confidence  value_json
```

- `id` 是稳定主键，三种来源格式不同：
  - 小米导出 `mi-<起始秒>-<类型>-<uid_hash后8位>`（如 `mi-1791885408-outdoor_running-2b9bbb62`）
  - 截图识别 `image-<起始秒>-<类型>-<距离米>`（如 `image-1791970745-outdoor_running-4010`）
  - 纯文字补录 `manual-<起始秒>-<类型>-<距离米>`
- `type` 九种枚举：`outdoor_running` `indoor_running` `outdoor_run_class`
  `outdoor_riding` `indoor_riding` `outdoor_walking` `pool_swimming`
  `free_training` `rope_skipping`；
- `source`：`mi_backup`（小米导出）/ `image`（截图识别）/ `manual`（补录）/ `gpx`；
- 按年分片的理由：单文件小、diff 单行、不会长成一个几十万行的巨物。

`data/daily/YYYY.csv` 存每日指标（睡眠/体重/卡路里等），**当前 Agent 没有接入**
这套数据（用户明确说不需要），保留只是为了让网页版和日报用。
