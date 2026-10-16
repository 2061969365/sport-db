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

非密钥在 `wrangler.toml` 的 `[vars]`：`REPO` / `VISION_ENDPOINT` / `VISION_MODEL`。

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
等不及。**无害** —— 重推会被 `claimUpdate` 去重，不会重复执行、不会重复写库。
想根治要改成异步 `submit` 模式（尚未做，属已知待办）。

## 工作流

| 文件 | 触发 | 干什么 |
|---|---|---|
| `.github/workflows/sync.yml` | push 到 data/scripts/frontend/review/reports，或每天 22:30 UTC | 消费 `inbox/` → `build_db.py` → 生成日报 → 发布 Pages |
| `.github/workflows/pages.yml` | 只改 frontend/ | 快速预览发布（无数据步骤） |

两者发布目标都是 GitHub Pages，靠 `concurrency: group: pages` 串行，不会互踩。

`build_db.py` 的校验是**自洽式**的（库内行数 == CSV 行数，且 workouts ≥ 800、
daily ≥ 14000 的卫生下限）。早期写死 806/14082 的断言会在正常入库后自杀 —— 
你那张截图入库变成 807 行时 sync 连挂两次，就是这么来的。

## 排障

| 现象 | 查法 |
|---|---|
| TG 没回复 | `getWebhookInfo` 看 `last_error_message`；再看 Cloudflare 面板的 Worker 日志 |
| 403 | webhook 的 `secret_token` 与 `TG_SECRET` 不一致，重设 |
| 回「只读模式」 | `GH_PAT` 过期或权限不足（细粒度 PAT 有有效期） |
| 回「数据拉取失败」 | `REPO` 写错 / 分支不是 `main` / GitHub 限流（5000 次/小时） |
| 回「模型接口 NNN」 | `VISION_ENDPOINT` 不可达或模型名不对 |
| 回答像失忆 | 发 `/status` 看水位；涨太高发 `/new` |
| 改数没走两步确认 | 检查 `rules` 块是否完整（改 prompt 时最容易漏） |
| SQL 报 `Cannot read properties of undefined (reading 'ctx')` | `this.sql` 被摘出来调用了，改成箭头闭包内以方法形式调 |

## 发版前自检清单

- [ ] `npx tsc --noEmit` **不加管道**，真实退出码为 0；
- [ ] 前端改动：`node --check frontend/*.js`；
- [ ] 涉及写库的改动：跑一遍 mock 单测（预览不写、确认才写、冲突中止三条）；
- [ ] CSV/数据库结构改动：本地 `python scripts/build_db.py --data data --out /tmp/t.db` 看 VERIFY OK；
- [ ] `git pull --rebase` 后再 push（bot 会自动回写提交，容易撞车）；
- [ ] 部署后打一次 `/api/chat` 冒烟。

## 安全

- 密钥只放 `wrangler secret`，日志里不落密钥；
- **签名 URL 也算密钥**：小米 GPX 直链带 `Signature`/`Expires`/`GalaxyAccessKeyId`
  （有效期约一年）。公开仓里存这些等于公开私有轨迹的钥匙 ——
  `scripts/download_gpx.py` 已内置 `redact_url()` 脱敏，历史台账也清理过；
  新增任何「把外部 URL 写进仓」的逻辑都要先脱敏；
- `/api/chat` 是公开端点（带 CORS 与会话限流 60 轮/小时），别往里塞密钥类能力；
- `GH_PAT` 建议定期轮换：细粒度 PAT 只授权该仓 Contents 读写，最小权限。
