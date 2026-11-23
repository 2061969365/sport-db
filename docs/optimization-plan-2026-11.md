# sport-db 深度优化方案

> 日期：2026-11-23 · 范围：`F:\worker\sport-db` · 方式：6 路并行只读审查（数据管道、Agent 核心、可靠性/成本、前端、测试/CI/安全、训练科学），首轮 3 路空结果，补跑 2 路，前端由主审补查。所有结论尽量带 `file:line`；标「未验证」的是无法在仓库内证实的。

## 0. 一句话结论

功能已经够多，问题不在「再加什么」，而在**底座有 3 个必须止血的洞**（未鉴权的 Agent 路由、公开仓的原始健康数据、秒级明细 id 对不上），以及**教练层没有真正使用已经采到的数据**（心率区间、TRIMP/ACWR、睡眠口径、处方感知）。

---

## 1. P0：先止血（本周内）

### 1.1 关闭未鉴权的 `/agents` 兜底路由

- **证据**：`worker/src/server.ts:464` 把未匹配请求全部交给 `routeAgentRequest(request, env)`，没有 `onBeforeRequest` / `onBeforeConnect`。`@cloudflare/think` 对 `/get-messages` 直接返回全量历史；DO 名是 `tg-<chatId>`，而 chat id 硬编码在公开的 `.github/workflows/mi-sync.yml:69`。
- **影响**：任何人可 `GET /agents/.../tg-5896689604/get-messages` 读私人对话；同路由还能注入消息、烧模型额度（线上是否有 CF Access 前置**未验证**）。
- **修法**：
  1. 给 `routeAgentRequest` 传 `onBeforeRequest`/`onBeforeConnect`，校验 `ADMIN_TOKEN` 或 CF Access JWT，否则 401；
  2. 或者直接删掉这条兜底路由（Telegram/飞书/PWA 都有显式入口）；
  3. chat id 移入 secret；
  4. 加测试：无 token 访问 `/agents/*` 必须 401。

### 1.2 公开仓的数据边界需要你拍板

- **现状**：仓库公开（`README.md:4`、`wrangler.toml:20`）。已跟踪 23 张原始截图、673 个 GPX、261 个秒级 CSV（逐秒心率/步频/位置）、`data/daily`（睡眠/体重）、`profile/`。`README.md:82` 自己承认截图里可能有头像/昵称/UID/位置。
- **两条路，二选一**：
  - **A. 保持公开，但只公开聚合数据**：把 `images/`、`tracks/`、`data/series_sec/`、`data/daily/`、`profile/` 移到私有仓；公开仓只留 `workouts/*.csv` 聚合行。截图打码 + 去 EXIF；历史用 `git filter-repo` 清理后强推。
  - **B. 整仓转私有**：Worker 有 PAT 不受影响；Pages 不能直读私有仓，需要改成 Worker 代理或只发布聚合 JSON。
- **建议**：选 A。你的「public OK」更像是接受「训练数据公开」，而不是接受「身份证/位置/逐秒心率公开」。

### 1.3 秒级明细文件名和 workouts 行 id 脱节（233/261 查不到）

- **证据**：`import_mi_cloud.py` 用云端行 id 命名 `data/series_sec/<id>.csv`，但 `merge_workouts` 合并时保留旧 id；实测 261 个文件只有 28 个能在 `data/workouts/*.csv` 里找到同 id。按日期让机器人查时，233 场会「没有秒级明细」。
- **修法**：`merge_workouts` 返回 `start_utc -> 实际 row id` 映射，写文件用实际 id；对现有文件按 `start_utc` 批量改名；加一条对账命令，删除 id 不在 workouts 的孤儿文件。

### 1.4 同步失败仍报成功

- **证据**：`mi_fitness_export.py` 每个 key/workouts 失败只 `print` 后写空数组，`main` 始终 `return 0`；`mi-sync.yml` 随后照常 commit/push。
- **修法**：累计错误，关键 key/workouts 失败即非零退出；`--allow-partial` 才允许放行；失败发 Telegram 告警。

---

## 2. P1：数据可信

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| 2.1 | `sleep`/`spo2` 拉到了但导入时丢弃；2026 睡眠仅 58 天，中位 100 分钟 | `import_mi_cloud.py` 的 `aggregate_daily` 无 sleep/spo2 分支 | 增加聚合；或从 `DATA_KEYS` 删除，别白拉 |
| 2.2 | 双源合并只按「日期+类型+距离±30m」配对，不看开始时间 | `import_mi_cloud.py:154-193`；同日同距离有 185 对 | 加 `start_utc` 约束（≤10 分钟）或优先 sid；无法唯一匹配就新增 |
| 2.3 | 分钟 series 用当前窗口稀疏结果整段替换 | `import_mi_cloud.py:393-426` | 按 `(workout_id,minute)` 合并，新空保留旧；`--rebuild-series` 才整段替换 |
| 2.4 | `cachedGetFile` 300s TTL 不会被 Actions 写入失效 | `worker/src/github.ts:46,55-96` | TTL 降到 30–60s；或写 `data/.version` 比对；`refresh_data` 后主动失效 |
| 2.5 | 网络异常被写成 5 分钟「文件不存在」负缓存 | `worker/src/github.ts:176-206` | 只在确认 404 时写负缓存；网络错误用 stale 或抛错 |
| 2.6 | `passToken` 写回失败不致命，并发轮换互相作废 | `mi_sync.py:166-172` | 写回失败非零退出并告警；轮换加互斥/CAS |
| 2.7 | 固定列 CSV 用 `extrasaction="ignore"`，加列被静默丢弃 | `import_mi_cloud.py:35-42,88-96` | 写回按现有表头并集，保留未知列 |

---

## 3. P1：Agent 与投递

1. **模型请求没有超时**：`sport-agent.ts:339` 的 `fetch` 无 `signal`，Think 的 stall watchdog 默认关闭 → 上游挂住时单轮永不结束，用户零反馈。修：`AbortSignal.timeout(90s)` + `chatStreamStallTimeoutMs` + 整轮 6 分钟预算。
2. **图片轮在 `send()` 里无条件改写模型**：`sport-agent.ts:316-322` 把 429 轮换、400 重试、备用网关三条兜底全部架空；备用网关还会收到它没有的 `mimo` 模型名。修：在轮换层决定模型列表，`send()` 只负责发送。
3. **备用网关不校验状态码**：`sport-agent.ts:443-454` 未判 `r.ok`，429/500 被当成功流。修：非 2xx 走统一错误文案。
4. **`/model` 体检用假 key**：`modelcfg.ts:206,236` 硬编码 `Bearer 1`，与主网关真 key 不一致；网关出事时无法自救切模型。修：传入 `env.VISION_API_KEY`；读图体检固定用 `IMAGE_MODEL`。
5. **补录「提交成功即删 review」**：`sport-agent.ts:238-249` 在异步 turn 完成前就删文件；失败时历史还被写成「识别与入库已完成」（`:986`）→ 静默丢图 + 误导模型。修：`onChatResponse` 确认成功后再删；占位文案改中性。
6. **投递 at-most-once 且顺序错**：空回复兜底在去重之前（`:1217-1239`）、`notified` 先写后发、`tgSend` 吞错、超长单行不切分（`notify.ts:82-96`）。修：先发后记账或 pending/sent 两态；超长行硬切；429 读 `retry_after` 重试。
7. **上下文压缩阈值硬编码 320k**：`sport-agent.ts:605-615`；换模型后不再匹配，压缩失败无降级，摘要与 reasoning 共享 4000 tokens。修：窗口做成 `ModelCfg` 字段；失败退化为保留最近 N 条的硬裁剪。

---

## 4. P1/P2：教练价值

1. **没有训练负荷模型**：只有「本周 > 上周×1.8 且 ≥15km」（`proactive.ts:224-232`），漏掉 11-16 周 +62% 的跳升。加 TRIMP（用每场 `value_json` 的 `hrm_*` 秒数）、7d/28d ACWR、monotony/strain；阈值 1.3/1.5。
2. **心率区间没被使用**：285/298 场的 `value_json` 已有 `hrm_warm_up/fat_burning/aerobic/anaerobic/extreme_duration`，但 Worker 只透传字符串。实测 2026 年 Z4+Z5 占 57%，与「几乎没有轻松跑」一致，却从未进入快照。加区间分布与 Z1+Z2 占比。
3. **心率漂移口径错**：`proactive.ts:234-253` 用最近 3 场均心率 vs 30 天基线，不控配速；间歇被拆成 5 行后「最近 3 场」其实是 3 个 1km。改成同一次课内的 Pa:HR 解耦，或同配速段比较。
4. **主动教练看不到处方**：`proactiveCheck` 只传 profile 和 plans 列表（`sport-agent.ts:931-940`），`coaching_notes` 只在聊天里；受伤周跑量为 0 时会触发「补一次轻松跑」模板（`proactive.ts:214-222`）。修：把处方/伤病作为独立上下文传入，cross-training 周禁用该文案。
5. **一次间歇记 5 场**：`get_summary` 按行计次数，11-22 的 4×1000m 记成 5 场；streak/破月纪录在 PFPS 下是反向激励。修：按（同日、间隔<30min、同类型）合并 session；streak 改成「连续休息达标」。
6. **教练专属数据层是空的**：没有疼痛/RPE/HRmax；计划无人打卡；`fastest_pace_3k` 不是标准化 PB。修：加 `wellness.csv`（疼痛 0-10、上下楼、RPE、睡眠感受）；计划按日期+类型自动匹配；PB 改 5k/10k 最佳分段。
7. **睡眠/RHR 口径把噪声当结论**：睡眠只接受 ≥5h 且连续 ≥4 晚才播报；RHR 带日期、>7 天不写；stress 纳入 `DailySummary`；spo2 入库或删除。

---

## 5. P2：前端与工程

1. **前端 4 个占位**：趋势图、日历、当月列表、年报（`frontend/index.html:94-124`）。建议先做趋势图（Chart.js，按周/月跑量+均配），再做日历热力。
2. **DO 无回收**：每个 `pwa-*` 会话都建 DO，且都排 15 分钟 review 扫描（`sport-agent.ts:205-224`）；`error_log`/`metrics_day` 无上限。修：只对 `tg-/fs-` arm 扫描；pwa 30 天回收；日志按天清理。
3. **Actions 成本**：`sync.yml` 全历史 clone（`fetch-depth: 0`）、每次 push 重建日报、无 `timeout-minutes`；`pages.yml` 与 `sync.yml` 重复构建。修：浅克隆、日报只在 schedule 跑、加超时、合并构建。
4. **Python 管道零测试**：`agent-tests.yml` 的 paths 只覆盖 `worker/**`；`parse_track`/`build_db`/`mi_sync` 直接改真相源。加 pytest：解析去重、建库行数/列数、token 轮换失败回滚。
5. **供应链**：`pip install requests cryptography` 无版本/无 hash；Action 未锁 SHA；无 secret 扫描。加 `requirements.txt` + `--require-hashes`、Action 锁 SHA、gitleaks + Dependabot。
6. **HTTP 面零测试**：没有 TG/飞书 webhook 校验、`/api/chat` 鉴权、CORS 的测试。用 Miniflare 补：正确 secret→200，缺失/错误→401/403。

---

## 6. 分阶段路线图

### 第 1 周：止血
- 关闭或鉴权 `/agents` 路由；chat id 移 secret。
- 公开仓数据边界决策并执行（建议 A 方案）。
- 秒级 id 修复 + 孤儿对账。
- 同步失败非零退出 + TG 告警。
- `cachedGetFile` TTL 降到 60s。

**验收**：无 token 访问 `/agents/*` 返回 401；`series_sec` id 100% 匹配；同步失败会让 workflow 红。

### 第 2–3 周：可信
- sleep/spo2 入库或删除；睡眠播报门槛（≥5h、≥4 晚）。
- 双源配对加 `start_utc`；series 按分钟合并。
- 模型请求超时 + 备用网关状态码校验；图片轮模型列表上移。
- `/model` 用真 key；投递失败可重放；超长行硬切。

**验收**：网关挂起 90s 内返回可读错误；图片轮 429 能切模型；发送失败后重放不丢消息。

### 第 4–6 周：教练
- TRIMP/ACWR/monotony/strain + 区间分布进快照。
- session 合并（次数/连击/漂移都按 session）。
- 处方/伤病感知的主动提醒。
- `wellness.csv`（疼痛/RPE）+ 计划依从率 + 5k/10k PB。

**验收**：全骑车周不出现「补轻松跑」；快照含 ACWR 与 Z1+Z2 占比；间歇按 1 场计。

### 第 7–8 周：体验与工程
- 趋势图 + 日历热力。
- DO 回收、日志上限、Actions 降本。
- Python pytest + gitleaks + Action 锁 SHA + HTTP 面测试。

---

## 7. 需要你拍板的 3 件事

1. **公开仓边界**：A（只公开聚合）还是 B（整仓私有）？我建议 A。
2. **秒级数据保留**：全量保留（6.2MB/年，持续增长）还是只留最近 90 天、旧的只留分钟级？
3. **工具数量**：33 个工具是否按场景分层（核心 10 个 + 长尾），还是保持现状只改描述？

---

## 8. 审查覆盖与局限

- 已覆盖：数据管道、可靠性/成本、训练科学、Agent 核心、测试/CI/安全；前端由主审补查。
- 未验证：线上是否有 CF Access 前置；`/model` 假 key 在主网关上的实际返回；秒级 `distance_m` 的确切单位（疑似分米）；`@cloudflare/think` 钩子签名（仓库无 `node_modules`）。
- 首轮 3 路空结果（Agent 核心/前端/测试安全），已补跑 2 路；前端未再派子代理，由主审直接读 `frontend/` 得出。
