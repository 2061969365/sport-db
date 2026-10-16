# Worker（Telegram + 飞书 + 网页版）

官方 Agents SDK（Think harness）工程。**部署、密钥、排障、自检都在
[../docs/operations.md](../docs/operations.md)**，这里只放代码结构和约定。

```
src/server.ts       入口：/tg 与 /feishu webhook、POST /api/chat、静态兜底
src/sport-agent.ts  Agent：人设与规则块、12 个工具、记忆块、上下文压缩
src/github.ts       GitHub 即数据库：CSV 解析/写回、DO 读缓存、各工具实现
src/photo.ts        收图：下载 → 提交原图 → Vision 识别 → 按置信度路由
src/env.ts          Env 类型（secrets + vars + DO 绑定）
```

跑起来：

```bash
npx tsc --noEmit        # 不加管道！管道会让退出码假成 0
npx wrangler deploy
```

## 改这个目录时必须守的约定

1. **`this.sql` 只能以方法形式调用**（`this.sql\`...\``）。它内部依赖 `this.ctx`，
   摘出来存变量、bind、或包一层都会在运行时报
   `Cannot read properties of undefined (reading 'ctx')`。
   传给 `github.ts` 的实例必须是箭头闭包：
   `const sql: SqlTag = (s, ...a) => self.sql(s as TemplateStringsArray, ...a) as ...`。
2. **数据读写只走 `github.ts`**。别在 `server.ts` / `photo.ts` 里另写一份
   CSV 解析、base64、PUT —— 曾经有三份实现，改一处漏两处。
3. **写操作一律两阶段**：`!confirmed` 只返回预览字符串，`confirmed` 才写，
   写前重新读、校验旧值、冲突重试一次。
4. **工具失败要说人话**。返回「失败：…原因…」，不要让失败看起来像「没有数据」——
   那会直接被模型当成事实说给用户听。
5. **改规则 = 改 `RULES_BLOCK`**。`getSystemPrompt()` 在声明了 context block 之后
   会被忽略（freezeSystemPrompt 优先），往那里加东西是白加。

历史实现（退役）见 [../archive/legacy-worker/README.md](../archive/legacy-worker/README.md)。
