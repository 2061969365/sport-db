# 运维

## 线上地址

| 东西 | 地址 |
|---|---|
| Worker（生产） | `https://sport-db-bot.xia2061969365.workers.dev` |
| 网页版 | `https://2061969365.github.io/sport-db/` |
| 数据仓 | `2061969365/sport-db`（public，`main` 分支） |

## 部署

```bash
cd sport-db/worker
npx tsc --noEmit        # 必须 0，见下面「两个坑」
npx wrangler deploy     # 发布到生产
```

密钥只在 Worker secrets 里（**永不进仓**）：

```bash
npx wrangler secret put TG_BOT_TOKEN   # BotFather 给的
npx wrangler secret put TG_SECRET      # openssl rand -hex 16 生成，与 setWebhook 的 secret_token 一致
npx wrangler secret put GH_PAT         # 细粒度 PAT，只给该仓 Contents 读写；不配则只读
# 飞书（可选，尚未启用）：FEISHU_APP_ID / FEISHU_APP_SECRET
```

非密钥在 `wrangler.toml` 的 `[vars]`：`REPO` / `VISION_ENDPOINT` / `VISION_MODEL`
/ 可选 `HOME_CITY`（天气工具的默认城市）。

可选增强（不配也能跑）：

```bash
npx wrangler secret put ANYSEARCH_API_KEY  # 可选：AnySearch 凭据（不配走匿名，也能搜）
npx wrangler secret put TAVILY_API_KEY     # 可选：AnySearch 不可用时的备选搜索
```

### 两个坑（都真踩过）

**1. 管道会伪造 `$LASTEXITCODE = 0`。**
`npx tsc --noEmit | Select-Object -First 5; echo $LASTEXITCODE` 打出的是
`Select-Object` 的退出码，永远是 0 —— 于是「全绿」了十几次，实际一直在报错。
**看真实退出码就直接跑、不接管道**：

```powershell
npx tsc --noEmit; echo "REAL-EXIT=$LASTEXITCODE"
```

**2. tsc 报错也会照吐 JS 产物。**
单文件编译（`npx tsc src/github.ts --outDir ...`）失败时仍会写出 `.js`，
拿旧/错产物跑单测会得出错误结论。编译产物必须建立在「全量 tsc 真 0」之上。

### 冒烟

```bash
curl https://sport-db-bot.xia2061969365.workers.dev/            # 应回 sport-db bot bridge OK
curl -X POST https://sport-db-bot.xia2061969365.workers.dev/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"session":"qa-00000001","key":"kq-00000001","text":"我近30天跑步多少公里？"}'
```

## Telegram webhook

```bash
# 查状态（pending_update_count 应该接近 0；last_error_message 空）
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/getWebhookInfo"

# 重设（secret_token 必须与 TG_SECRET 一致）
curl -X POST "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://sport-db-bot.xia2061969365.workers.dev/tg","secret_token":"<TG_SECRET>","allowed_updates":["message","edited_message"]}'
```

`getWebhookInfo` 出现 `Read timeout expired` 属正常：复杂问题跑得久，Telegram
等不及。**无害** —— turn 是异步提交的，webhook 立刻返回 200，
重推会被 `claimUpdate` 去重，答复由 `onChatResponse` 跑完后推回。

### 为什么必须是异步（别改回同步）

早期 `/tg` 与 `/api/chat` 都用 `runTurn(wait)` 同步等答复，实测**稳定在 80.7 秒
断开连接**（要训练计划这类重问题必然超时），用户收到的是「什么都没有」。
现在：webhook 提交后立刻 200 → DO 队列把 turn 跑完 → `onChatResponse` 把答复推回原通道；
`/api/chat` 等 70 秒仍没完就返 `202 {pending,since}`，前端轮询 `/api/chat/result`。
**别为了「代码简单」改回同步** —— 长问题必然丢答复。

## 工作流

| 文件 | 触发 | 干什么 |
|---|---|---|
| `.github/workflows/sync.yml` | push 到 data/scripts/frontend/review/reports，或每天 22:30 UTC | 消费 `inbox/` → `build_db.py` → 生成日报 → 发布 Pages |
| `.github/workflows/pages.yml` | 只改 frontend/ | 快速预览发布（无数据步骤） |

两者发布目标都是 GitHub Pages，靠 `concurrency: group: pages` 串行，不会互踩。

`build_db.py` 的校验是**自洽式**的（库内行数 == CSV 行数，且 workouts ≥ 800、
daily ≥ 14000 的卫生下限）。早期写死 806/14082 的断言会在正常入库后自杀 —— 
你那张截图入库变成 807 行时 sync 连挂两次，就是这么来的。

## 换 Cloudflare 账号 / 换域名部署

代码里**没有任何账号绑定**（`wrangler.toml` 只有 worker 名、DO 绑定、vars），
换账号就是把同一份代码重新部署一遍，约 10 分钟：

```bash
cd sport-db/worker
npx wrangler login          # 用新账号登录（或设 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID）
npx wrangler deploy         # 新账号上创建 worker；DO 迁移 v1 自动生效
# 域名变成 https://sport-db-bot.<新账号子域>.workers.dev

# 重设密钥（值不变：它们属于 Telegram 和 GitHub，跟 Cloudflare 账号无关）
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_SECRET
npx wrangler secret put GH_PAT
# 可选：ANYSEARCH_API_KEY / TAVILY_API_KEY
```

然后：

1. **重指 Telegram webhook**（`TG_SECRET` 没换的话 `secret_token` 照旧）：
   见上方 `setWebhook`，把 url 换成新域名。
   webhook 同一时间只能指向一个地址，所以新旧不会同时收消息——记得把旧 worker
   `npx wrangler delete` 收掉（`--name sport-db-bot` 加旧账号登录）。
2. **改两处硬编码 URL**：`frontend/chat.js` 的 `BOT_DEFAULT`（网页版默认 Bot 地址；
   你也可以不改，在页面「Bot 服务设置」里填新地址，存在本机 localStorage），
   以及本文档里的示例 URL。
3. **可选**：新账号的 `workers.dev` 子域不同，`/health`、`/api/chat` 冒烟跑一遍。

### 会丢什么、不会丢什么（重要）

| 东西 | 换账号后 |
|---|---|
| 运动记录 / 轨迹 / 图片 / 待确认 / 日报 | **都在**（在 GitHub 仓库里） |
| 长期画像 `profile/*.md`、训练计划 `plans/*.json` | **都在**（刻意放仓里就是为了这个） |
| 已设的提醒 `state/reminders.json` | **都在**，且新账号的 worker 启动时**自动重挂**（`onStart` 读文件恢复） |
| 对话历史、用量统计、去重键 | **会丢**（存在旧账号的 Durable Object 里，不跨账号迁移） |

提醒按**会话属主**隔离（`owner: tg-<chatId>` / `pwa-<session>`）：每个会话是独立 DO、
启动都会读这份文件，不隔离的话网页版一开就会把 TG 的提醒重挂一遍并推错地方。
合并写入时只替换自己属主的条目，别人的原样保留。

### 对话历史备份（已启用，写入私有仓）

聊天记录是私人内容，**公开数据仓里永远不会出现** —— `state.ts` 的
`chatBackupEnabled()` 是硬闸门（只有配了独立仓才允许导出），有测试专门钉这条红线。

当前配置：

- 私有仓：`2061969365/sport-db-private`（PRIVATE），密钥 `STATE_REPO` + `STATE_PAT` 已设；
- 导出时机：每轮对话结束后自动导出，**节流 5 分钟**（免得每句话提交一次 git）；
  也可以说「把我们的对话备份一下」手动触发（`chat_backup` 工具）；
- 落点：`state/chat/YYYY-MM-DD.md`，按天分文件，只记对话文本（不含工具调用与内部推理）；
- 格式：`# 2026-10-16 对话记录` + 逐条 `🧑 我` / `🤖 教练`，带北京时间。

**`state/` 整个目录都在私有仓**（提醒 + 对话）。配私有仓之前写过公开仓的
`state/reminders.json` 已经迁走并从公开仓删除——现在公开仓里没有 `state/`。

> **凭据说明**：`STATE_PAT` 用的是用户提供的细粒度 PAT，**设为永久有效（不会过期）**，
> 已验证对 `sport-db` 与 `sport-db-private` 两个仓都能读写。
> 如果哪天它失效了，表现是「对话备份静默停止 + 提醒恢复失败」，
> 换新后重设即可：`cd sport-db/worker && npx wrangler secret put STATE_PAT`。

> 小提示：手动触发是在**当轮进行中**取的快照，所以那条「已备份」的回复本身要等下一次
> 导出才进文件；自动导出在 turn 结束后跑，内容是完整的。

### 换账号时状态怎么处理

提醒在 `state/reminders.json`（按会话属主隔离），对话在 `state/chat/*.md`，
两者都在上面的私有仓里：换账号后新 worker 一启动就会**自动重挂提醒**，
对话历史则以文件形式留档（不会自动灌回新 DO 的会话记忆——需要的话说一声）。

## 健康检查

```bash
curl https://sport-db-bot.xia2061969365.workers.dev/health
# {"ok":true,"ms":2335,"checks":[{"name":"gateway",...},{"name":"github",...}],"config":{...}}
```

一次看清：模型网关能不能回、GitHub PAT 有没有过期（顺带报剩余配额）、
备用网关/搜索 Key/城市等配置有没有生效。`ok:false` 时 HTTP 状态码也是 503。
**排障先打这个**，比翻日志快。

## 排障

| 现象 | 查法 |
|---|---|
| TG 没回复 | `getWebhookInfo` 看 `last_error_message`；再看 Cloudflare 面板的 Worker 日志 |
| 403 | webhook 的 `secret_token` 与 `TG_SECRET` 不一致，重设 |
| 回「只读模式」 | `GH_PAT` 过期或权限不足（细粒度 PAT 有有效期） |
| 回「数据拉取失败」 | `REPO` 写错 / 分支不是 `main` / GitHub 限流（5000 次/小时） |
| 回「模型接口 NNN」 | `VISION_ENDPOINT` 不可达或模型名不对 |
| 回答像失忆 | 发 `/status` 看水位；涨太高发 `/new` |
| 长问题（计划类）没回复 | 正常情况下 TG 会显示「正在输入」然后推答复；若始终没有，看 Worker 日志里的 `[onChatResponse-fail]` |
| 搜索总说「没联网搜到」 | 看 Worker 日志里 `[web_search]` 的降级原因；正常主路是 AnySearch，全挂才到维基 |
| 天气工具说不知道城市 | 让用户说一次城市，或设 `HOME_CITY` var |
| 答复开头粘一串「收到…我来帮你查」 | 模型在工具间隙输出了旁白。代码只取最后一次工具调用之后的文本；若又出现，检查 `notify.ts` 的 `finalReplyText` 分片判断 |
| 改数没走两步确认 | 检查 `rules` 块是否完整（改 prompt 时最容易漏） |
| SQL 报 `Cannot read properties of undefined (reading 'ctx')` | `this.sql` 被摘出来调用了，改成箭头闭包内以方法形式调 |

## 发版前自检清单

- [ ] `cd worker && npm run check`（类型 + 31 条行为测试，一条命令）；
- [ ] 前端改动：`node --check frontend/*.js`；
- [ ] CSV/数据库结构改动：本地 `python scripts/build_db.py --data data --out /tmp/t.db` 看 VERIFY OK；
- [ ] `git pull --rebase` 后再 push（bot 会自动回写提交，容易撞车）；
- [ ] 部署后 `curl .../health` 看两项都 ok，再打一次 `/api/chat` 冒烟。

CI 里 `.github/workflows/agent-tests.yml` 会在每次动 `worker/**` 时自动跑
`tsc --noEmit` + 行为测试（不需要任何密钥，GitHub 与 DO SQLite 都 mock 掉了）。

## 安全

- 密钥只放 `wrangler secret`，日志里不落密钥；
- **签名 URL 也算密钥**：小米 GPX 直链带 `Signature`/`Expires`/`GalaxyAccessKeyId`
  （有效期约一年）。公开仓里存这些等于公开私有轨迹的钥匙 ——
  `scripts/download_gpx.py` 已内置 `redact_url()` 脱敏，历史台账也清理过；
  新增任何「把外部 URL 写进仓」的逻辑都要先脱敏；
- `/api/chat` 是公开端点（带 CORS 与会话限流 60 轮/小时），别往里塞密钥类能力；
- `GH_PAT` 建议定期轮换：细粒度 PAT 只授权该仓 Contents 读写，最小权限。
