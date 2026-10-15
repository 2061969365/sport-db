# sport-db Bot桥 Worker（Telegram + 飞书双接入）

官方 Agents SDK（Think harness）工程：`src/server.ts`（双通道接线）+ `src/sport-agent.ts`
（Agent：prompt/工具/记忆）+ `src/github.ts`（GitHub 即数据库）+ `src/photo.ts`（收图）。
问答流程：TG/飞书 webhook → 按会话取 Agent 实例 → runTurn → 工具读写 GitHub CSV → 原通道回消息。
记忆在 DO SQLite（会话 + user_profile/coaching_notes），运动数据仍在 GitHub CSV。

## 1. Telegram 建 Bot + 设 webhook

1. 私聊 [@BotFather](https://t.me/BotFather)，`/newbot` 按提示取名，拿到 `TG_BOT_TOKEN`。
2. 自己生成一个随机校验串作 `TG_SECRET`，例如：
   `openssl rand -hex 16`
3. 先发布 Worker（见第 3 节），假设域名为 `https://sport-db-bot.<账号>.workers.dev`，再设 webhook
   （`secret_token` 必须与后面的 `TG_SECRET` 一致）：
   ```bash
   curl -X POST "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://sport-db-bot.<账号>.workers.dev/tg","secret_token":"<TG_SECRET>","allowed_updates":["message","edited_message"]}'
   ```
   成功返回 `{"ok":true,...}`。换 Bot 或改域名时重调一次即可；删除用
   `deleteWebhook`。
4. `getUpdates` 长轮询兜底说明：调试 webhook 不通时可临时删除 webhook
   后用 `curl https://api.telegram.org/bot<TOKEN>/getUpdates` 看 Telegram
   是否收到消息，以区分是 Telegram 侧还是 Worker 侧问题。**注意两者互斥**：
   设了 webhook 后 `getUpdates` 永远为空，查完记得重新 `setWebhook`。

## 2. 飞书建应用 + 权限 + 事件订阅

1. [开放平台](https://open.feishu.cn/app) → 创建企业自建应用，拿到
   `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。
2. 权限管理 → 开通以下权限后**发布版本**（不发布不生效）：
   - `im:message:readonly`（收消息事件）
   - `im:message:send_as_bot`（以机器人身份回消息）
   - `im:chat:readonly`（可选，读群聊 id 用）
3. 事件订阅 → 订阅方式选 **长连接 / Webhook 二选一**：
   - 推荐 Webhook：`Request URL` 填
     `https://sport-db-bot.<账号>.workers.dev/feishu`，
     订阅事件勾选 `im.message.receive_v1`。首次保存时飞书发
     `url_verification`，Worker 会原样回 `challenge`（代码已处理），
     通过后才算订阅成功。
   - 私聊机器人、群里 @机器人 都会触发 `receive_v1`；Worker 只回纯文本
     消息，其他类型（图片/文件/卡片）暂忽略。
4. 回消息原理：Worker 用 App ID/Secret 换 `tenant_access_token`
   后调 `im/v1/messages` 按 `chat_id` 回复，无需额外部署。

## 3. 密钥与发布（密钥只放 Worker secrets，永不进仓）

```bash
cd sport-db/worker
npm i -g wrangler        # 一次即可
wrangler login

# 按实际改 REPO 与 VISION_ENDPOINT（wrangler.toml [vars]）
wrangler secret put TG_BOT_TOKEN
wrangler secret put TG_SECRET
wrangler secret put GH_PAT   # 细粒度 PAT，仅 sport-db 的 Contents 读写（方案A直写库用；不配则只读不写）
wrangler secret put FEISHU_APP_ID
wrangler secret put FEISHU_APP_SECRET
# VISION 网关免 Key：不存任何 Key secret

wrangler deploy          # 发布 -> 得到 workers.dev 域名
```

校验：

```bash
node --check worker.js   # 语法检查（CI/本地通用）
curl https://sport-db-bot.<账号>.workers.dev/   # 应回 sport-db bot bridge OK
```

给 Telegram 发一句话（如“总结一下我最近的运动情况”），应收到带近 30
天数字（次数/公里/配速/心率/最近一次）的中文回复；飞书同理。

## 4. 常见问题

| 现象 | 查法 |
|---|---|
| Telegram 没回复 | 先 `getWebhookInfo` 看 `last_error_message`；再看 Worker → Observability 日志 |
| 403 forbidden | webhook 的 `secret_token` 与 `wrangler secret` 的 `TG_SECRET` 不一致，重设 |
| 飞书订阅保存失败 | `challenge` 未通过：确认 URL 能公网访问且返回 200（先 `wrangler deploy` 再保存） |
| 回复“数据拉取失败” | `REPO` 写错或分支不是 `main`；公开仓 raw 限流时稍后重试 |
| 回复“模型接口 NNN” | `VISION_ENDPOINT` 不可达或模型名不对，检查 `[vars]` |
