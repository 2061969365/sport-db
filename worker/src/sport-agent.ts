// SportDbAgent：Think harness 上的运动教练 + 账本管理员。
// 记忆进 DO state/Session；运动数据仍在 GitHub（tools 经 Contents API）。
import { Think } from "@cloudflare/think";
import type { ThinkSession } from "@cloudflare/think";
import { createCompactFunction } from "agents/sessions";
import { callable } from "agents";
import { tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { Env } from "./env";
import { feishuSend, finalReplyText, tgSend, tgTyping } from "./notify";
import { analyzeSignals, bjToday } from "./proactive";
import { listPlans, normalizePlan, planPath, planProgress, planSignals, readPlan, writePlan } from "./plan";
import { extractUsage, formatUsage, type DayMetric } from "./metrics";
import {
  REMINDERS_PATH, mergeReminders, readStateJson, rearmPlan, writeStateJson, type ReminderState,
} from "./state";
import {
  NOTES_PATH, NOTES_SEED, PROFILE_PATH, PROFILE_SEED,
  profileShared, repoProfileProvider,
} from "./profile";
import { toolCurrentTime, toolFetchUrl, toolWeather, toolWebSearch } from "./web";
import {
  WORKOUT_TYPES, buildProfile, loadWorkouts,
  toolAppendWorkout, toolCompare, toolConfirmReview, toolDeleteWorkout,
  toolGetSummary, toolListDir, toolListReview, toolQueryWorkouts,
  toolReadRepoFile, toolRecords, toolStatsWorkouts, toolStreaks, toolTrends,
  toolUpdateWorkout, toolWritePlan,
  type SqlTag,
} from "./github";

const COACH_SYS =
  "你是 sport-db 运动库的教练助手。详细指令见 rules 上下文块。";

/** 压缩用摘要：同网关同模型直调，4000 token 上限（推理预留，见实测）。 */
async function summarizeText(env: Env, prompt: string): Promise<string> {
  const r = await fetch(env.VISION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "sport-db/1.0" },
    body: JSON.stringify({
      model: env.VISION_MODEL || "muse-spark-1.3-contributor-free",
      reasoning_effort: "xhigh",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`摘要模型接口 ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (j.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("摘要返回为空");
  return text;
}

const RULES_BLOCK =
  "你是一名私人教练，也是这个运动库的管理员。用户会告诉你他当前的健身水平、目标和生活习惯"
  + "（信息不够时你先问他要），你的职责是结合他的真实运动数据，运用运动科学知识、营养建议和其他相关因素，"
  + "为他制定最适合的计划和临场建议。说话像 ChatGPT 那样自然：口语亲切、有条理，先给结论再给依据，关键数字加粗；"
  + "简单问题一两句话答完；分析、计划类问题用小标题或分点展开，但不啰嗦。"
  + "问题模糊时先反问 1-2 个关键信息再答，不猜着答；多轮对话必须接上文。"
  + "用户告诉你长期事实（目标、伤病、偏好）时，用 set_context 写进 user_profile，下次先看它再给建议；"
  + "每次有效建议后，把弱项和下次提醒记进 coaching_notes。"
  + "不知道就说不知道，绝不编数据；只谈训练恢复。"
  + "【数据铁律】只用工具查到的数据说话：跑步是跑步、骑行是骑行，配速只谈跑步。"
  + "用户问具体某条、某天、某月、某年、最早/最晚、最多/最少时，"
  + "必须先调 query_workouts（配好 date_from/date_to/type，找最早用 sort=oldest），"
  + "拿到工具结果再回答；绝不允许凭印象说不知道；工具能查到的，以工具为准。"
  + "【改库铁律】改数、删除、补录统一分两步：先调对应工具（update/delete/append_workout）不带 confirmed"
  + "拿预览diff念给用户；用户明确说“确认”后，再用相同参数带 confirmed=true 调一次才写入。"
  + "一次只改用户明确说的字段，改完用中文报出改了哪条、旧值->新值；"
  + "白名单外的字段、找不到的记录，明说做不到或找不到，让用户确认，不擅自发挥。"
  + "【工具边界】运动数据只许用 get_summary/query_workouts/stats_workouts/trends/records/compare_periods/streaks/update_workout/delete_workout/append_workout/list_review/confirm_review 十二个数据工具读写；"
  + "另外有 current_time（时间）、weather（天气）、web_search（联网检索）、fetch_url（抓网页）、"
  + "list_repo_dir / read_repo_file / write_plan（看/写仓库里的日报·计划文件）、"
  + "set_reminder / list_reminders / cancel_reminder（定时提醒）这些工具可用，都是查外部信息或存计划的正路，不许假装用过。"
  + "workspace 的内置文件工具（读写删改查 + bash）一律不许碰：数据不在那里，要用文件就走 list_repo_dir/read_repo_file/write_plan。"
  + "【计划留存】给用户排好完整计划后，主动问一句要不要存进仓里；用户同意就用 write_plan 写到 plans/ 下（两步确认），"
  + "以后他要「我的计划」就读出来，别凭记忆复述。"
  + "【提醒】用户说「提醒我」「到点叫我」就用 set_reminder；时间先用 current_time 确认，"
  + "相对时间用 +2h/+1d，固定每天用 cron（如每天 7 点 = 0 7 * * *）。"
  + "【计划纪律】用户要训练计划/让他别受伤/问接下来怎么练时，按这个顺序做，不许跳步："
  + "①先调 current_time 确认今天日期（算「下周六」「还有几天」必须用它，不许自己猜）；"
  + "②调 get_summary 和 trends 看真实训练量与近期强度，别拿旧记忆当现状；"
  + "③计划含户外跑时调 weather 看降水概率和风速；"
  + "④需要外部信息（比赛日期、路线、装备参数）才调 web_search/fetch_url，搜到就标明来源，没搜到就说没联网搜到；"
  + "⑤输出计划要能直接执行：分周期/分天，每天写清距离或时长、配速区间（用他库里的真实配速换算）、强度意图，"
  + "并写清休息日与减量周；给依据（心率/跑量/恢复），不要泛泛而谈。"
  + "数据不足就先要信息（周可训练天数、目标赛事与日期、伤病），别硬编一份通用模板。"
  + "【表达纪律】只有在最终答复里说话：调工具前后不要输出「收到/我来帮你查/正在看数据」这类旁白，"
  + "用户看到的只有你最后那条答复，中间的话会变成一串碎片粘在开头。"

export class SportDbAgent extends Think<Env> {
  // 内置 workspace 的 bash 工具对本项目无用且危险，直接关闭；
  // 其余 workspace 文件工具用 rules block 约束（数据只在 GitHub 三个工具里）。
  workspaceBash = false;

  getModel() {
    // apius2 是免 Key 的 OpenAI-compatible 网关：用哑 key 占位，
    // 自定义 fetch 会剥掉 Authorization 头再发出去。
    //
    // 这一层同时负责「别让 agent 死在一个网关上」：
    //   1. 429/5xx/网络抖动 → 退避重试（最多 2 次）；
    //   2. 仍失败且配了备用网关（VISION_ENDPOINT_ALT/VISION_MODEL_ALT）→ 就地改写
    //      请求体里的 model 并换 URL 重发一次，用户无感；
    //   3. 全挂 → 抛出去，由 onChatError 明确告诉用户「模型服务不可用」，
    //      绝不静默失联。
    const env = this.env;
    const fallbackArmed = () => !!(env.VISION_ENDPOINT_ALT && env.VISION_MODEL_ALT);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const raw: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("authorization"); // 免 Key 网关：别把占位 key 发出去
      const bodyText = typeof init?.body === "string" ? init.body : null;

      const send = async (targetUrl: string, body: string | null, extra?: Record<string, string>) => {
        const h = new Headers(headers);
        if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
        return fetch(targetUrl, { ...init, headers: h, body: body ?? init?.body });
      };

      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await send(url, bodyText);
          if (r.status === 429 || r.status >= 500) {
            lastErr = new Error(`网关 ${r.status}`);
            if (attempt < 2) {
              await sleep(800 * (attempt + 1));
              continue;
            }
            break;
          }
          return r;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) {
            await sleep(800 * (attempt + 1));
            continue;
          }
        }
      }

      // 主网关彻底不可用：有备用就换过去（改写 model 字段）
      if (fallbackArmed() && bodyText) {
        try {
          const altUrl = `${String(env.VISION_ENDPOINT_ALT).replace(/\/chat\/completions\/?$/, "")}/chat/completions`;
          const parsed = JSON.parse(bodyText) as Record<string, unknown>;
          parsed.model = env.VISION_MODEL_ALT;
          const h: Record<string, string> = {};
          if (env.ALT_API_KEY) h.authorization = `Bearer ${env.ALT_API_KEY}`;
          console.error("[model-fallback]", String(lastErr).slice(0, 120));
          return await send(altUrl, JSON.stringify(parsed), h);
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(`模型服务不可用（${String((lastErr as Error)?.message || lastErr).slice(0, 120)}）`);
    }) as typeof fetch;

    const provider = createOpenAI({
      baseURL: `${this.env.VISION_ENDPOINT.replace(/\/chat\/completions\/?$/, "")}`,
      apiKey: "sportdb-no-key",
      fetch: raw,
    });
    return provider(this.env.VISION_MODEL || "muse-spark-1.3-contributor-free");
  }

  getSystemPrompt(): string {
    return COACH_SYS;
  }

  beforeTurn() {
    // 思考档 xhigh：经 AI SDK providerOptions 透传给 OpenAI-compatible 网关。
    // 注：实测当前网关收下该参数但用量无变化（档位实际由网关/模型侧决定），
    // 留在这里等网关生效，不影响现有行为。
    // 输出 token 不设限：推理模型先烧 token 再答，上限会直接腰斩长回复。
    // 真要控成本应该换档位/换模型，而不是砍上限。
    return { providerOptions: { openai: { reasoningEffort: "xhigh" as const } } };
  }

  @callable()
  async resetConversation(): Promise<string> {
    // 只清聊天记录：user_profile / coaching_notes 长期记忆保留，
    // 下一轮自动用最新 prompt 重建，不用换窗口。
    // 排队中的提交一并取消，避免旧问题在新会话里继续跑。
    await this.clearMessages();
    try {
      const subs = await this.listSubmissions();
      for (const s of subs) {
        if (s.status === "pending" || s.status === "running") {
          await this.cancelSubmission(s.submissionId, "reset").catch(() => null);
        }
      }
    } catch { /* 老版本无提交表也无妨 */ }
    return "ok";
  }

  configureSession(session: ThinkSession) {
    // 上下文满了走压缩，不直接报错：32 万 token（400k 窗口的 80%）触发，
    // 太早压没用；中间压成摘要，最近 ~2 万 token 原文保留；失败打日志跳过，不挡对话。
    session.onCompaction(createCompactFunction({
      summarize: (prompt) => summarizeText(this.env, prompt),
    }));
    session.onCompactionError((e) => {
      console.error("[compaction-fail]", e instanceof Error ? e.message : String(e));
    });
    session.compactAfter(320_000);
    return session;
  }

  /** 提醒到点：由调度器调用，把话推到当前通道。 */
  async fireReminder(payload: { text?: string; once?: boolean }): Promise<void> {
    const text = String(payload?.text || "").trim() || "该训练了。";
    const body = `⏰ 提醒：${text}`;
    try {
      const tv = this.sql`SELECT channel, chat_id FROM reply_target WHERE slot = 'current'` as
        { channel?: string; chat_id?: string }[];
      const channel = tv[0]?.channel || "";
      const chatId = tv[0]?.chat_id || "";
      if (channel === "tg" && chatId) await tgSend(this.env, chatId, body);
      else if (channel === "feishu" && chatId) await feishuSend(this.env, chatId, body);
      // 网页版没有主动推送：写进 latest，用户下次打开/轮询时能看到
      this.sql`CREATE TABLE IF NOT EXISTS pwa_reply (slot TEXT PRIMARY KEY, text TEXT, at INTEGER)`;
      this.sql`INSERT OR REPLACE INTO pwa_reply(slot, text, at) VALUES ('latest', ${body}, ${Date.now()})`;
      this.sql`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, when_spec TEXT, text TEXT, kind TEXT, at INTEGER)`;
      if (payload?.once) {
        this.sql`DELETE FROM reminders WHERE text = ${text} AND kind = 'once'`;
      }
      this.sql`CREATE TABLE IF NOT EXISTS reminder_log(id TEXT PRIMARY KEY, text TEXT, at INTEGER)`;
      this.sql`INSERT OR REPLACE INTO reminder_log(id, text, at) VALUES (${`${text}-${Date.now()}`}, ${body}, ${Date.now()})`;
      console.log(`[reminder-fired channel=${channel}] ${text}`);
    } catch (e) {
      console.error("[fireReminder-fail]", e instanceof Error ? e.message : String(e));
    }
  }

  /** 设置提醒（工具用）：支持 ISO 时间、+30m/+2h/+1d 相对量、5 段 cron。 */
  @callable()
  async addReminder(when: string, text: string): Promise<string> {
    const spec = String(when || "").trim();
    const body = String(text || "").trim();
    if (!body) return "失败：提醒内容不能为空。";
    this.sql`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, when_spec TEXT, text TEXT, kind TEXT, at INTEGER)`;
    let target: Date | string;
    let kind = "once";
    const rel = spec.match(/^\+(\d+)([mhd])$/i);
    if (rel) {
      const mul = rel[2].toLowerCase() === "m" ? 60_000 : rel[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000;
      target = new Date(Date.now() + Number(rel[1]) * mul);
    } else if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(spec)) {
      target = spec; // 5 段 cron
      kind = "cron";
    } else {
      let iso = spec.replace(" ", "T");
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(iso)) iso += "+08:00"; // 无时区按北京时间
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return `失败：时间格式认不出（${spec}）。用「2026-10-17 07:00」或「+2h」或 cron「0 7 * * *」。`;
      }
      if (d.getTime() < Date.now() - 60_000) {
        return `失败：${spec} 是过去的时间，重新确认一下（今天日期先用 current_time 查）。`;
      }
      target = d;
    }
    const s = await this.schedule(target, "fireReminder", { text: body, once: kind === "once" },
      { idempotent: kind !== "once" });
    const id = String(s?.id || "");
    const whenText = typeof target === "string" ? target : target.toISOString();
    this.sql`INSERT OR REPLACE INTO reminders(id, when_spec, text, kind, at) VALUES (${id}, ${whenText}, ${body}, ${kind}, ${Date.now()})`;
    // 落仓备份：换账号/DO 重建后能自动恢复（内容无隐私代价）
    await this.persistReminders();
    return `已设定提醒（id=${id}）：${kind === "cron" ? `按周期 ${whenText}` : whenText} 推送「${body}」。`;
  }

  /** 把提醒列表合并写进 state/reminders.json（只动自己这个会话的条目，别人的保留）。 */
  private async persistReminders(): Promise<void> {
    try {
      this.sql`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, when_spec TEXT, text TEXT, kind TEXT, at INTEGER)`;
      const rows = this.sql`SELECT id, when_spec, text, kind FROM reminders ORDER BY at DESC LIMIT 100` as
        { id: string; when_spec: string; text: string; kind: string }[];
      const mine: ReminderState[] = rows.map((r) => ({
        id: r.id,
        when: r.when_spec,
        kind: r.kind === "cron" ? "cron" : "once",
        text: r.text,
      }));
      const file = await readStateJson<{ reminders?: ReminderState[] }>(this.env, REMINDERS_PATH);
      const all = Array.isArray(file?.reminders) ? file!.reminders! : [];
      const merged = mergeReminders(all, mine, this.name);
      await writeStateJson(this.env, REMINDERS_PATH, { updated_at: Date.now(), reminders: merged },
        `bot: 提醒备份（${merged.length} 条）`);
    } catch (e) {
      console.error("[persist-reminders-fail]", e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 启动时从仓里恢复提醒（换 Cloudflare 账号 / DO 重建后，定时任务不该凭空消失）。
   * 由框架在 DO 首次激活时调用。
   */
  async onStart(): Promise<void> {
    try {
      const file = await readStateJson<{ reminders?: ReminderState[] }>(this.env, REMINDERS_PATH);
      const items = Array.isArray(file?.reminders) ? file!.reminders! : [];
      if (!items.length) return;
      // 只恢复属于本会话的（this.name）：别的通道的提醒由它们自己恢复
      const { arm, drop, keep } = rearmPlan(items, Date.now(), this.name);
      this.sql`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, when_spec TEXT, text TEXT, kind TEXT, at INTEGER)`;
      const existing = this.sql`SELECT id FROM reminders` as { id: string }[];
      const known = new Set(existing.map((r) => r.id));
      const pending = new Set<string>();
      try {
        for (const s of await this.listSchedules()) {
          const p = (s as { payload?: { id?: string } }).payload;
          if (p?.id) pending.add(String(p.id));
        }
      } catch { /* 拿不到就算了，下面幂等 */ }

      let changed = false;
      for (const it of arm) {
        if (pending.has(it.id)) continue;
        const when = it.kind === "cron" ? it.when : new Date(it.when);
        if (it.kind === "once" && Number.isNaN((when as Date).getTime())) continue;
        const s = await this.schedule(when, "fireReminder", { id: it.id, text: it.text, once: it.kind === "once" },
          { idempotent: it.kind !== "once" });
        const sid = String((s as { id?: string })?.id || it.id);
        this.sql`INSERT OR REPLACE INTO reminders(id, when_spec, text, kind, at) VALUES (${it.id}, ${it.when}, ${it.text}, ${it.kind}, ${Date.now()})`;
        void sid;
        known.add(it.id);
        changed = true;
      }
      for (const it of drop) {
        this.sql`DELETE FROM reminders WHERE id = ${it.id}`;
        changed = true;
      }
      void keep;
      if (changed) await this.persistReminders();
      console.log(`[reminder-restore] 恢复 ${arm.length} 条，清理 ${drop.length} 条`);
    } catch (e) {
      console.error("[reminder-restore-fail]", e instanceof Error ? e.message : String(e));
    }
  }

  /** 列出/取消提醒。 */
  @callable()
  async listReminders(): Promise<string> {
    this.sql`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, when_spec TEXT, text TEXT, kind TEXT, at INTEGER)`;
    const rows = this.sql`SELECT id, when_spec, text, kind FROM reminders ORDER BY at DESC LIMIT 20` as
      { id: string; when_spec: string; text: string; kind: string }[];
    if (!rows.length) return "当前没有提醒。";
    return rows.map((r) => `${r.id}｜${r.kind === "cron" ? "周期" : "一次性"} ${r.when_spec}｜${r.text}`).join("\n");
  }

  @callable()
  async cancelReminder(id: string): Promise<string> {
    const rid = String(id || "").trim();
    if (!rid) return "失败：要给 id（先 list_reminders 查）。";
    this.sql`CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, when_spec TEXT, text TEXT, kind TEXT, at INTEGER)`;
    this.sql`DELETE FROM reminders WHERE id = ${rid}`;
    // 调度器里的 id 可能和本地 id 不同（恢复时重挂过），从 payload 里找一遍
    try {
      for (const s of await this.listSchedules()) {
        const p = (s as { payload?: { id?: string } }).payload;
        const sid = String((s as { id?: string }).id || "");
        if (sid === rid || (p?.id && String(p.id) === rid)) {
          await this.cancelSchedule(sid).catch(() => null);
        }
      }
    } catch {
      await this.cancelSchedule(rid).catch(() => null);
    }
    await this.persistReminders();
    return `已取消提醒 ${rid}。`;
  }

  /** 记住这条会话的回复去处：异步 turn 完成后由 onChatResponse 推回去。 */
  @callable()
  async setReplyTarget(channel: string, chatId: string): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS reply_target (slot TEXT PRIMARY KEY, channel TEXT, chat_id TEXT, at INTEGER)`;
    this.sql`INSERT OR REPLACE INTO reply_target(slot, channel, chat_id, at) VALUES ('current', ${channel}, ${chatId}, ${Date.now()})`;
    this.armProactive();
  }

  /** 挂上主动自查（幂等：同 callback+间隔+payload 只会存在一条）。 */
  private armProactive(): void {
    try {
      void this.scheduleEvery(6 * 3600, "proactiveCheck", { v: 1 })
        .catch((e) => console.error("[proactive-arm-fail]", String(e).slice(0, 120)));
    } catch (e) {
      console.error("[proactive-arm-fail]", String(e).slice(0, 120));
    }
  }

  /**
   * 主动教练：每 6 小时自查一次数据，**只在发现值得说的信号时**才开口，
   * 且 20 小时内最多打扰一次。没有信号就静默返回（不花 token）。
   */
  async proactiveCheck(): Promise<void> {
    try {
      const tv = this.sql`SELECT channel, chat_id FROM reply_target WHERE slot = 'current'` as
        { channel?: string; chat_id?: string }[];
      const channel = tv[0]?.channel || "";
      const chatId = tv[0]?.chat_id || "";
      // 网页版没有主动推送通道：只在 TG/飞书开口
      if (!chatId || (channel !== "tg" && channel !== "feishu")) return;

      this.sql`CREATE TABLE IF NOT EXISTS proactive_log(id TEXT PRIMARY KEY, text TEXT, at INTEGER)`;
      const last = this.sql`SELECT at FROM proactive_log ORDER BY at DESC LIMIT 1` as { at: number }[];
      if (last.length && Date.now() - last[0].at < 20 * 3600_000) return;

      // 注意：sql 必须是箭头闭包、以方法形式调 this.sql（bind/摘出来都会丢 ctx）
      const self = this;
      const sql: SqlTag = (s, ...a) =>
        (self.sql(s as TemplateStringsArray, ...(a as (string | number | boolean | null)[])) as unknown as Array<Record<string, unknown>>);
      const all = await loadWorkouts(this.env, sql);
      let signals = analyzeSignals(all);

      // 计划漏练也算信号：读最近的计划，把"该练没打卡"并进来
      try {
        const listing = await listPlans(this.env);
        const slug = (listing.match(/^([a-z0-9-]+)：/m) || [])[1];
        if (slug) {
          const plan = await readPlan(this.env, slug);
          if (plan) signals = signals.concat(planSignals(plan, bjToday()));
        }
      } catch { /* 没计划就算了 */ }

      signals = signals.filter((s) => s.weight >= 55).sort((a, b) => b.weight - a.weight);
      if (!signals.length) return;

      const top = signals[0];
      const body = `📣 教练提醒\n${top.text}`;
      if (channel === "tg") await tgSend(this.env, chatId, body);
      else await feishuSend(this.env, chatId, body);
      this.sql`INSERT OR REPLACE INTO proactive_log(id, text, at) VALUES (${`${top.key}-${Date.now()}`}, ${body}, ${Date.now()})`;
      console.log(`[proactive-sent weight=${top.weight}] ${top.key}`);
    } catch (e) {
      console.error("[proactive-fail]", e instanceof Error ? e.message : String(e));
    }
  }

  /** 网页版轮询用：取 since 之后的最新回复。 */
  @callable()
  async latestReply(since: number): Promise<string> {
    this.sql`CREATE TABLE IF NOT EXISTS pwa_reply (slot TEXT PRIMARY KEY, text TEXT, at INTEGER)`;
    const rows = this.sql`SELECT text, at FROM pwa_reply WHERE slot = 'latest'` as { text: string; at: number }[];
    if (!rows.length || rows[0].at <= (Number(since) || 0)) return "";
    return rows[0].text || "";
  }

  /**
   * turn 失败时的兜底：onChatResponse 只在成功路径触发，报错走这里。
   * 不实现它 = 网关抽风时用户永远等不到任何消息（只有日志），这是最伤体验的失败模式。
   */
  async onChatError(error: unknown, ctx?: { classification?: string }): Promise<unknown> {
    const raw = error instanceof Error ? error.message : String(error);
    console.error("[chat-error]", ctx?.classification || "", raw.slice(0, 300));
    this.bumpMetrics({ errors: 1 });
    try {
      const tv = this.sql`SELECT channel, chat_id FROM reply_target WHERE slot = 'current'` as
        { channel?: string; chat_id?: string }[];
      const channel = tv[0]?.channel || "";
      const chatId = tv[0]?.chat_id || "";
      const cls = String(ctx?.classification || "");
      const hint = cls === "rate_limit"
        ? "模型服务在限流，等一两分钟再问一次就好。"
        : /模型服务不可用|网关/.test(raw)
          ? "模型服务这会儿不可用（重试过也没成），过几分钟再试；你的数据没受影响。"
          : "这次没答上来。可以再发一次，或把问题拆小一点。";
      const body = `⚠️ ${hint}\n（技术原因：${raw.slice(0, 160)}）`;
      if (channel === "tg" && chatId) await tgSend(this.env, chatId, body);
      else if (channel === "feishu" && chatId) await feishuSend(this.env, chatId, body);
      this.sql`CREATE TABLE IF NOT EXISTS pwa_reply (slot TEXT PRIMARY KEY, text TEXT, at INTEGER)`;
      this.sql`INSERT OR REPLACE INTO pwa_reply(slot, text, at) VALUES ('latest', ${body}, ${Date.now()})`;
      this.sql`CREATE TABLE IF NOT EXISTS error_log(id TEXT PRIMARY KEY, msg TEXT, at INTEGER)`;
      this.sql`INSERT OR REPLACE INTO error_log(id, msg, at) VALUES (${`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${body}, ${Date.now()})`;
    } catch (e) {
      console.error("[onChatError-fail]", e instanceof Error ? e.message : String(e));
    }
    return error;
  }

  /** 每一步开始时刷新 TG「正在输入」，顺便记 token/工具用量。 */
  async onStepFinish(step?: unknown): Promise<void> {
    try {
      const u = extractUsage(step);
      this.bumpMetrics({ inTok: u.inTok, outTok: u.outTok, toolCalls: u.toolCalls });
    } catch { /* 记账失败不影响对话 */ }
    try {
      const tv = this.sql`SELECT channel, chat_id FROM reply_target WHERE slot = 'current'` as
        { channel?: string; chat_id?: string }[];
      if (tv[0]?.channel === "tg" && tv[0]?.chat_id) {
        await tgTyping(this.env, tv[0].chat_id);
      }
    } catch { /* 指示丢了无所谓 */ }
  }

  /** 用量落库（按天聚合，一次 upsert）。 */
  private bumpMetrics(d: { inTok?: number; outTok?: number; toolCalls?: number; turns?: number; errors?: number }): void {
    try {
      this.sql`CREATE TABLE IF NOT EXISTS metrics_day (day TEXT PRIMARY KEY, turns INTEGER, errors INTEGER, in_tok INTEGER, out_tok INTEGER, tool_calls INTEGER, updated_at INTEGER)`;
      const day = bjToday();
      const turns = d.turns ?? 0, errors = d.errors ?? 0;
      const inTok = d.inTok ?? 0, outTok = d.outTok ?? 0, toolCalls = d.toolCalls ?? 0;
      this.sql`INSERT INTO metrics_day(day, turns, errors, in_tok, out_tok, tool_calls, updated_at)
        VALUES (${day}, ${turns}, ${errors}, ${inTok}, ${outTok}, ${toolCalls}, ${Date.now()})
        ON CONFLICT(day) DO UPDATE SET
          turns = turns + ${turns},
          errors = errors + ${errors},
          in_tok = in_tok + ${inTok},
          out_tok = out_tok + ${outTok},
          tool_calls = tool_calls + ${toolCalls},
          updated_at = ${Date.now()}`;
    } catch (e) {
      console.error("[metrics-fail]", e instanceof Error ? e.message : String(e));
    }
  }

  /** 用量报表（/status 与 usage_stats 工具共用）。 */
  @callable()
  async usageReport(days = 7): Promise<string> {
    let rows: DayMetric[] = [];
    try {
      this.sql`CREATE TABLE IF NOT EXISTS metrics_day (day TEXT PRIMARY KEY, turns INTEGER, errors INTEGER, in_tok INTEGER, out_tok INTEGER, tool_calls INTEGER, updated_at INTEGER)`;
      const n = Math.min(30, Math.max(1, Math.trunc(Number(days) || 7)));
      rows = (this.sql`SELECT day, turns, errors, in_tok, out_tok, tool_calls FROM metrics_day ORDER BY day DESC LIMIT ${n}` as unknown) as DayMetric[];
    } catch { /* 表还没建 */ }
    return formatUsage(rows, bjToday());
  }

  /**
   * turn 跑完（消息已落库、turn 锁已释放）后把答复推回原通道。
   * 这是异步链路的关键：webhook/HTTP 请求早就返回了，长 turn 由 DO 队列跑完，
   * 结果在这里送达 —— 解决了「重计划跑到 80 秒被掐断、用户什么都收不到」。
   * 重启后 hook 可能被重放（recovered），用 requestId 去重避免重复推送。
   */
  async onChatResponse(result: { message?: unknown; requestId?: string; status?: string; error?: string }): Promise<void> {
    try {
      const reqId = String(result?.requestId || "") || `t${Date.now()}`;
      this.sql`CREATE TABLE IF NOT EXISTS notified (id TEXT PRIMARY KEY, at INTEGER)`;
      const seen = this.sql`SELECT id FROM notified WHERE id = ${reqId}` as { id: string }[];
      if (seen.length) return;
      this.sql`INSERT OR REPLACE INTO notified(id, at) VALUES (${reqId}, ${Date.now()})`;
      this.sql`DELETE FROM notified WHERE at < ${Date.now() - 3 * 864e5}`;

      const tv = this.sql`SELECT channel, chat_id FROM reply_target WHERE slot = 'current'` as
        { channel?: string; chat_id?: string }[];
      const channel = tv[0]?.channel || "";
      const chatId = tv[0]?.chat_id || "";

      let text = finalReplyText(result).trim();
      const ok = result?.status === "completed" && !!text;
      this.bumpMetrics(ok ? { turns: 1 } : { turns: 1, errors: 1 });
      if (!ok) {
        text = result?.status === "aborted"
          ? "这次被中断了（可能你发了 /new），有需要再问一次。"
          : `这次没处理成功（${String(result?.error || result?.status || "未知原因").slice(0, 160)}），换个问法或稍后再试。`;
      }
      if (!text) return;
      if (channel === "tg" && chatId) {
        await tgSend(this.env, chatId, text);
      } else if (channel === "feishu" && chatId) {
        await feishuSend(this.env, chatId, text);
      } else {
        this.sql`CREATE TABLE IF NOT EXISTS pwa_reply (slot TEXT PRIMARY KEY, text TEXT, at INTEGER)`;
        this.sql`INSERT OR REPLACE INTO pwa_reply(slot, text, at) VALUES ('latest', ${text}, ${Date.now()})`;
      }
    } catch (e) {
      // hook 里抛错会波及框架的收尾记账，这里必须吞掉并留日志。
      console.error("[onChatResponse-fail]", e instanceof Error ? e.message : String(e));
    }
  }

  configureContext() {
    // rules：只读 block（inline provider），装 persona + 数据/改库铁律 + 工具边界——
    // 注意：配了 block 后 getSystemPrompt 会被框架忽略，所以铁律必须放在这里。
    //
    // user_profile / coaching_notes：长期记忆。默认存在**数据仓**里
    // （profile/*.md），这样 TG、飞书、网页版读的是同一份画像；设
    // PROFILE_SHARED=false 则回退成各通道独立的本机 SQLite（老行为）。
    const self = this;
    const sql: SqlTag = (s, ...a) =>
      (self.sql(s as TemplateStringsArray, ...(a as (string | number | boolean | null)[])) as unknown as Array<Record<string, unknown>>);
    const shared = profileShared(this.env);
    const repoBlock = (label: string, path: string, seed: string) => ({
      label,
      description: undefined as string | undefined,
      maxTokens: 1500,
      provider: repoProfileProvider(this.env, path, sql, seed),
    });
    return [
      {
        label: "rules",
        description: "教练人设与数据/改库铁律，每轮必读并遵守。",
        maxTokens: 2000,
        provider: { get: async () => RULES_BLOCK },
      },
      shared
        ? {
          ...repoBlock("user_profile", PROFILE_PATH, PROFILE_SEED),
          description: "跑者长期画像（跨通道共享，存在数据仓 profile/user_profile.md）：目标赛事与日期、周可训练天数、伤病史、作息偏好、装备。用户提到这类长期事实时用 set_context 更新；给计划前先看这里。",
        }
        : {
          label: "user_profile",
          description: "跑者长期画像：目标距离、伤病史、作息偏好、装备。用户提到相关事实时用 set_context 更新；给计划前先看这里。",
          maxTokens: 1500,
        },
      shared
        ? {
          ...repoBlock("coaching_notes", NOTES_PATH, NOTES_SEED),
          description: "教练观察备忘（跨通道共享，存在数据仓 profile/coaching_notes.md）：用户弱项、上次建议的执行情况、下次要提醒的事。每次有效建议后更新一条。",
        }
        : {
          label: "coaching_notes",
          description: "教练观察备忘：用户弱项、本次建议的执行情况、下次要提醒的事。每次有效建议后更新一条。",
          maxTokens: 1500,
        },
    ];
  }

  @callable()
  async claimUpdate(updateId: string): Promise<boolean> {    // TG/飞书重推去重：同实例单线程，先查后写足够；顺带清 7 天前的旧键。
    // 注意：this.sql 必须以方法形式调用（this.sql`...`），摘出来存变量再调会丢 receiver。
    this.sql`CREATE TABLE IF NOT EXISTS processed_updates (id TEXT PRIMARY KEY, at INTEGER)`;
    const seen = this.sql`SELECT id FROM processed_updates WHERE id = ${updateId}` as { id: string }[];
    if (seen.length) return false;
    this.sql`DELETE FROM processed_updates WHERE at < ${Date.now() - 7 * 864e5}`;
    this.sql`INSERT INTO processed_updates(id, at) VALUES (${updateId}, ${Date.now()})`;
    return true;
  }

  @callable()
  async status(): Promise<string> {
    // 上下文水位：消息条数 + 文本估算 token + 记忆块大小。不调模型，零 token 开销。
    const textOf = (m: unknown): string => {
      const parts = (m as { parts?: { type?: string; text?: string }[] }).parts;
      if (!Array.isArray(parts)) return "";
      return parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("");
    };
    const est = (s: string) => Math.round(s.length / 3);
    const messages = await this.getMessages().catch(() => []);
    const msgChars = messages.reduce((a, m) => a + textOf(m).length, 0);
    // 直接读 context 的 blocks（失败则显示读取失败，不编数字）
    let blockLines = "读取失败";
    try {
      const ctx = this.context as {
        getBlocks?: () => { label?: string; content?: string }[];
      };
      const bs = ctx.getBlocks?.() ?? [];
      blockLines = bs.length
        ? bs.map((b) => `${b.label ?? "?"}: 约${est(String(b.content ?? ""))}tk`).join("；")
        : "空";
    } catch {
      blockLines = "读取失败";
    }
    let usage = "";
    try {
      usage = "用量：" + (await this.usageReport(7)).split("\n").slice(0, 2).join("；");
    } catch { /* 没记账就算了 */ }
    return `上下文水位（估算，中文按3字≈1tk）：\n`
      + `消息 ${messages.length} 条，约${est(messages.reduce((a, m) => a + textOf(m), ""))}tk\n`
      + `记忆块：${blockLines}\n`
      + `窗口上限 400k，输出上限 50k；满了发 /new 另起（画像保留）。\n`
      + (usage ? usage + "\n" : "")
      + `（msgChars=${msgChars} 供调试）`;
  }

  @callable()
  async checkQuota(session: string): Promise<boolean> {
    // /api/chat 限流：每会话每小时 60 轮，超了返回 false（公开端点防刷）。
    this.sql`CREATE TABLE IF NOT EXISTS chat_quota (session TEXT PRIMARY KEY, window_start INTEGER, count INTEGER)`;
    const now = Date.now();
    const rows = this.sql`SELECT window_start, count FROM chat_quota WHERE session = ${session}` as
      { window_start: number; count: number }[];
    if (!rows.length || now - rows[0].window_start > 3600000) {
      this.sql`INSERT OR REPLACE INTO chat_quota(session, window_start, count) VALUES (${session}, ${now}, 1)`;
      return true;
    }
    if (rows[0].count >= 60) return false;
    this.sql`UPDATE chat_quota SET count = ${rows[0].count + 1} WHERE session = ${session}`;
    return true;
  }

  getTools() {
    const env = this.env;
    // 传给工具的 sql 必须是箭头闭包，每次以方法形式调 this.sql，
    // 摘出来存变量（哪怕 bind 过）也可能丢内部上下文，线上实测过坑。
    const self = this;
    const sql: SqlTag = (s, ...a) =>
      (self.sql(s as TemplateStringsArray, ...(a as (string | number | boolean | null)[])) as unknown as Array<Record<string, unknown>>);
    return {
      get_summary: tool({
        description: "查近N天分项画像（跑步/骑行分开）。任何分项或天数问题都先调它或 query_workouts，不许凭记忆答。",
        inputSchema: z.object({ days: z.number().int().min(1).max(90).default(30) }),
        execute: async ({ days }: { days: number }) => {
          const all = await loadWorkouts(env, sql);
          return toolGetSummary(all, days);
        },
      }),
      query_workouts: tool({
        description: "按条件查原始记录明细（含id）。改数据前必须先查到id；找最早记录用sort=oldest。type 只能从枚举里选，不确定就空着别填。",
        inputSchema: z.object({
          type: z.enum(WORKOUT_TYPES as [string, ...string[]]).optional(),
          date_from: z.string().optional(),
          date_to: z.string().optional(),
          sort: z.enum(["latest", "oldest"]).default("latest"),
          limit: z.number().int().min(1).max(30).default(10),
        }),
        execute: async (args: { type?: string; date_from?: string; date_to?: string; sort?: string; limit?: number }) => {
          const all = await loadWorkouts(env, sql);
          return toolQueryWorkouts(all, args);
        },
      }),
      update_workout: tool({
        description: "按id改一条记录，分两步：先不带confirmed调一次拿预览diff念给用户，用户明确说确认后，再用相同id+fields带confirmed=true调一次才真正写入。只能改用户明确说的字段，先query确认。",
        inputSchema: z.object({
          id: z.string(),
          fields: z.record(z.string(), z.union([z.string(), z.number()])),
          confirmed: z.boolean().default(false),
        }),
        execute: async (args: { id: string; fields: Record<string, string | number>; confirmed?: boolean }) => {
          const all = await loadWorkouts(env, sql);
          return toolUpdateWorkout(env, all, "think-agent", args, sql);
        },
      }),
      delete_workout: tool({
        description: "按id删一条记录，分两步：先不带confirmed调一次拿预览念给用户，用户明确说确认删除后，再带confirmed=true调一次。删后git可revert。",
        inputSchema: z.object({
          id: z.string(),
          confirmed: z.boolean().default(false),
        }),
        execute: async (args: { id: string; confirmed?: boolean }) => {
          const all = await loadWorkouts(env, sql);
          return toolDeleteWorkout(env, all, "think-agent", args, sql);
        },
      }),
      append_workout: tool({
        description: "纯文字补录一条运动（如昨天跑了5km），分两步：先不带confirmed拿预览，用户确认后再带confirmed=true写入。type从枚举选，date用YYYY-MM-DD，distance_m单位米，duration_s单位秒。",
        inputSchema: z.object({
          type: z.enum(WORKOUT_TYPES as [string, ...string[]]).default("outdoor_running"),
          date: z.string().optional(),
          distance_m: z.number().optional(),
          duration_s: z.number().optional(),
          avg_hr: z.number().optional(),
          calories: z.number().optional(),
          steps: z.number().optional(),
          cadence: z.number().optional(),
          confirmed: z.boolean().default(false),
        }),
        execute: async (args: { type?: string; date?: string; distance_m?: number; duration_s?: number; avg_hr?: number; calories?: number; steps?: number; cadence?: number; confirmed?: boolean }) => {
          const all = await loadWorkouts(env, sql);
          return toolAppendWorkout(env, all, args, sql);
        },
      }),
      stats_workouts: tool({
        description: "按月或按年聚合统计（次数/跑量/均配速/均心率），查跨度统计用它，别把几百行全拉回来。",
        inputSchema: z.object({
          group_by: z.enum(["month", "year"]).default("month"),
          type: z.enum(WORKOUT_TYPES as [string, ...string[]]).optional(),
          date_from: z.string().optional(),
          date_to: z.string().optional(),
        }),
        execute: async (args: { group_by?: string; type?: string; date_from?: string; date_to?: string }) => {
          const all = await loadWorkouts(env, sql);
          return toolStatsWorkouts(all, args);
        },
      }),
      list_review: tool({
        description: "列出待确认的截图识别项（review/）。用户问有没有没入库的图、或要确认之前没看清的图时调它。",
        inputSchema: z.object({}),
        execute: async () => toolListReview(env),
      }),
      confirm_review: tool({
        description: "把某条 review 确认入库：先不带confirmed调一次拿预览念给用户，用户明确说确认后，再用相同path带confirmed=true调一次；写入后自动删 review 文件。",
        inputSchema: z.object({
          path: z.string(),
          confirmed: z.boolean().default(false),
        }),
        execute: async (args: { path: string; confirmed?: boolean }) => {
          return toolConfirmReview(env, args.path, !!args.confirmed, "think-agent", sql);
        },
      }),
      trends: tool({
        description: "看趋势（有没有进步）：配速/心率/跑量按周或按月序列。问进步、状态、越跑越快这类必调它，别翻明细自己算。",
        inputSchema: z.object({
          metric: z.enum(["pace", "hr", "distance"]).default("pace"),
          per: z.enum(["week", "month"]).default("week"),
          date_from: z.string().optional(),
          date_to: z.string().optional(),
          limit: z.number().int().min(4).max(52).default(26),
        }),
        execute: async (args: { metric?: string; per?: string; date_from?: string; date_to?: string; limit?: number }) => {
          const all = await loadWorkouts(env, sql);
          return toolTrends(all, args);
        },
      }),
      records: tool({
        description: "PB 榜：最长单次跑、最快配速、单月最高跑量、累计总量。问PB/最佳/纪录必调它。",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await loadWorkouts(env, sql);
          return toolRecords(all);
        },
      }),
      compare_periods: tool({
        description: "两段时间对照（如本月vs上月）：次数/跑量/配速/心率及变化百分比。问对比、有没有退步必调它，给齐两段起止。",
        inputSchema: z.object({
          a_from: z.string(), a_to: z.string(), b_from: z.string(), b_to: z.string(),
        }),
        execute: async (args: { a_from?: string; a_to?: string; b_from?: string; b_to?: string }) => {
          const all = await loadWorkouts(env, sql);
          return toolCompare(all, args);
        },
      }),
      streaks: tool({
        description: "连击：当前连续运动天数、历史最长、活跃天数。问坚持、打卡、连击必调它。",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await loadWorkouts(env, sql);
          return toolStreaks(all);
        },
      }),
      current_time: tool({
        description: "当前北京时间（日期+星期+ISO周），可带偏移天数算任意一天。做计划、算「下周六」「还有几天」必须先调它，不许自己猜日期。",
        inputSchema: z.object({
          offset_days: z.number().int().min(-3650).max(3650).default(0),
        }),
        execute: async ({ offset_days }: { offset_days?: number }) => toolCurrentTime(offset_days ?? 0),
      }),
      weather: tool({
        description: "查天气（免 Key，1~7 天日预报：温度/降水概率/风速）。安排户外训练前调它；不传 city 就用配置的常驻城市，没配会要求你说城市。",
        inputSchema: z.object({
          city: z.string().optional(),
          days: z.number().int().min(1).max(7).default(3),
        }),
        execute: async (args: { city?: string; days?: number }) => toolWeather(env, args),
      }),
      web_search: tool({
        description: "联网全网搜索（AnySearch）。比赛信息、路线、装备参数、训练方法等外部资料用它；结果会标明来源，工具说没搜到就如实讲，绝不编造。",
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().int().min(1).max(8).default(5),
        }),
        execute: async (args: { query?: string; limit?: number }) => toolWebSearch(env, args),
      }),
      fetch_url: tool({
        description: "读指定网页正文（AnySearch 抽取，能读 JS 页面；只 http/https、禁内网、限大小）。已知具体网址时用它看内容。",
        inputSchema: z.object({
          url: z.string(),
          max_chars: z.number().int().min(500).max(8000).default(4000),
        }),
        execute: async (args: { url?: string; max_chars?: number }) => toolFetchUrl(env, args),
      }),
      list_repo_dir: tool({
        description: "列数据仓里的目录（只读）：plans/ 训练计划、reports/daily/ 每日报告、data/ 数据、docs/ 文档。想知道有什么文件时用它。",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }: { path?: string }) => toolListDir(env, path || ""),
      }),
      read_repo_file: tool({
        description: "读数据仓里的文本文件（日报、计划、文档、CSV）。用户问「我的计划呢」「昨天的日报」就用它。",
        inputSchema: z.object({
          path: z.string(),
          max_chars: z.number().int().min(500).max(20000).default(6000),
        }),
        execute: async (args: { path?: string; max_chars?: number }) =>
          toolReadRepoFile(env, args.path || "", args.max_chars ?? 6000),
      }),
      write_plan: tool({
        description: "把训练计划/长期笔记写进仓里的 plans/*.md（两步：先预览，用户确认后带 confirmed=true 再调一次）。只写 plans/，运动数据别用这个改。",
        inputSchema: z.object({
          path: z.string(),
          content: z.string(),
          confirmed: z.boolean().default(false),
        }),
        execute: async (args: { path?: string; content?: string; confirmed?: boolean }) =>
          toolWritePlan(env, args.path || "", args.content || "", !!args.confirmed, "think-agent", sql),
      }),
      coach_check: tool({
        description: "教练自查：看最近数据有没有值得提醒的事（中断、跑量突变、心率漂移、破月纪录）。用户问「我最近状态有什么问题」「我该注意什么」时用它；用户主动问就直接给结论，不用等他同意。",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await loadWorkouts(env, sql);
          const signals = analyzeSignals(all);
          if (!signals.length) return "自查结果：没有异常信号（训练连贯、跑量心率都正常）。不用编问题出来。";
          return "自查发现以下信号（按重要度排序）：\n"
            + signals.map((s) => `- [${s.weight}] ${s.key}\n  ${s.text}`).join("\n");
        },
      }),
      usage_stats: tool({
        description: "看这个 agent 自己的用量：对话轮数、失败次数、token 消耗、工具调用次数。用户问「你花了多少」「你用得多不多」时用它。",
        inputSchema: z.object({ days: z.number().int().min(1).max(30).default(7) }),
        execute: async ({ days }: { days?: number }) => self.usageReport(days ?? 7),
      }),
      plan_save: tool({
        description: "把排好的训练计划存成结构化计划（可打卡、可看进度）。两步：先不带 confirmed 调一次拿预览，用户确认后再带 confirmed=true。计划必须按次给出日期。",
        inputSchema: z.object({
          slug: z.string().describe("计划标识，字母数字短横线，如 half-marathon-2026-11"),
          name: z.string(),
          goal: z.string().optional(),
          sessions: z.array(z.object({
            date: z.string().describe("YYYY-MM-DD"),
            type: z.enum(["easy", "long", "tempo", "interval", "rest", "race", "other"]),
            target: z.string().describe("如 6km @6'10\"/km 或 LSD 14km"),
          })).min(1),
          confirmed: z.boolean().default(false),
        }),
        execute: async (args: {
          slug?: string; name?: string; goal?: string;
          sessions?: { date: string; type: string; target: string }[]; confirmed?: boolean;
        }) => {
          const norm = normalizePlan(
            { name: args.name, goal: args.goal, created: bjToday(), sessions: args.sessions }, bjToday());
          if (typeof norm === "string") return norm;
          const path = planPath(args.slug || "");
          if (!path) return "失败：slug 只能用字母数字和短横线（如 half-marathon-2026-11）。";
          const prev = await readPlan(env, args.slug || "");
          if (!args.confirmed) {
            return `预览（尚未写入）：${path}${prev ? "（会覆盖已有计划）" : ""}\n`
              + `${planProgress(norm, bjToday())}\n`
              + "得到用户明确说“确认”后，再用完全相同参数带 confirmed=true 调一次。";
          }
          const msg = await writePlan(env, args.slug || "", norm, "think-agent", sql);
          return msg;
        },
      }),
      plan_list: tool({
        description: "列出已有的训练计划（含名称、目标、次数）。用户问「我的计划呢」先用它。",
        inputSchema: z.object({}),
        execute: async () => listPlans(env),
      }),
      plan_progress: tool({
        description: "看某个计划的完成情况：完成率、该练没打卡的、接下来几次。用户问进度/完成得怎么样时用它。",
        inputSchema: z.object({ slug: z.string() }),
        execute: async ({ slug }: { slug?: string }) => {
          const p = await readPlan(env, slug || "");
          if (!p) return `失败：找不到计划 ${slug}（先 plan_list 看有哪些）。`;
          return planProgress(p, bjToday());
        },
      }),
      plan_mark: tool({
        description: "给计划里的某一天打卡：done（练了）/ skipped（没练）。用户说「今天练完了」「昨天没跑」时用它。这是低风险的状态更新，不用等确认，但要说清改了哪天。",
        inputSchema: z.object({
          slug: z.string(),
          date: z.string().describe("YYYY-MM-DD"),
          status: z.enum(["done", "skipped"]),
          actual: z.string().optional().describe("实际完成情况，如 6.2km @6'05\""),
        }),
        execute: async (args: { slug?: string; date?: string; status?: string; actual?: string }) => {
          const p = await readPlan(env, args.slug || "");
          if (!p) return `失败：找不到计划 ${args.slug}（先 plan_list）。`;
          const d = String(args.date || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "失败：日期要 YYYY-MM-DD。";
          const hit = p.sessions.filter((s) => s.date === d);
          if (!hit.length) {
            return `失败：这个计划里 ${d} 没有安排（可用日期：${p.sessions.slice(0, 5).map((s) => s.date).join("、")}…）。`;
          }
          for (const s of hit) {
            s.status = args.status === "done" ? "done" : "skipped";
            if (args.actual) s.actual = String(args.actual).slice(0, 120);
          }
          await writePlan(env, args.slug || "", p, "think-agent", sql);
          return `已把 ${d} 标记为${args.status === "done" ? "完成" : "跳过"}`
            + `${args.actual ? `（${args.actual}）` : ""}。\n${planProgress(p, bjToday())}`;
        },
      }),
      set_reminder: tool({
        description: "设定时提醒（到点自动推消息给用户）：支持「2026-10-17 07:00」「+2h」「+1d」或 cron「0 7 * * *」（每天 7 点）。用户说「明天提醒我跑间歇」就用它。",
        inputSchema: z.object({
          when: z.string(),
          text: z.string(),
        }),
        execute: async ({ when, text }: { when?: string; text?: string }) =>
          self.addReminder(when || "", text || ""),
      }),
      list_reminders: tool({
        description: "列出已设的提醒（含 id）。用户问「我设了哪些提醒」用它。",
        inputSchema: z.object({}),
        execute: async () => self.listReminders(),
      }),
      cancel_reminder: tool({
        description: "按 id 取消提醒（先 list_reminders 拿 id）。",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }: { id?: string }) => self.cancelReminder(id || ""),
      }),
    };
  }
}
