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
import {
  WORKOUT_TYPES, buildProfile, loadWorkouts,
  toolAppendWorkout, toolCompare, toolConfirmReview, toolDeleteWorkout,
  toolGetSummary, toolListReview, toolQueryWorkouts, toolRecords,
  toolStatsWorkouts, toolStreaks, toolTrends, toolUpdateWorkout,
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
  + "【工具边界】运动数据只许用 get_summary/query_workouts/stats_workouts/trends/records/compare_periods/streaks/update_workout/delete_workout/append_workout/list_review/confirm_review 十二个工具读写；"
  + "workspace 的文件工具（读写删改查）一律不许碰，数据不在那里。"

export class SportDbAgent extends Think<Env> {
  // 内置 workspace 的 bash 工具对本项目无用且危险，直接关闭；
  // 其余 workspace 文件工具用 rules block 约束（数据只在 GitHub 三个工具里）。
  workspaceBash = false;

  getModel() {
    // apius2 是免 Key 的 OpenAI-compatible 网关：用哑 key 占位，
    // 下面的自定义 fetch 会剥掉 Authorization 头再发出去。
    const provider = createOpenAI({
      baseURL: `${this.env.VISION_ENDPOINT.replace(/\/chat\/completions\/?$/, "")}`,
      apiKey: "sportdb-no-key",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        return fetch(url, { ...init, headers });
      }) as typeof fetch,
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

  configureContext() {    // 不传 provider → 自动落 durable per-agent SQLite，且经 set_context 可写。
    // user_profile：认得“人”（目标/伤病/偏好）；coaching_notes：记得“事”（弱项/执行/下次提醒）。
    // rules：只读 block（inline provider），装 persona + 数据/改库铁律 + 工具边界——
    // 注意：配了 block 后 getSystemPrompt 会被框架忽略，所以铁律必须放在这里。
    return [
      {
        label: "rules",
        description: "教练人设与数据/改库铁律，每轮必读并遵守。",
        maxTokens: 2000,
        provider: { get: async () => RULES_BLOCK },
      },
      {
        label: "user_profile",
        description: "跑者长期画像：目标距离、伤病史、作息偏好、装备。用户提到相关事实时用 set_context 更新；给计划前先看这里。",
        maxTokens: 1500,
      },
      {
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
    return `上下文水位（估算，中文按3字≈1tk）：\n`
      + `消息 ${messages.length} 条，约${est(messages.reduce((a, m) => a + textOf(m), ""))}tk\n`
      + `记忆块：${blockLines}\n`
      + `窗口上限 400k，输出上限 50k；满了发 /new 另起（画像保留）。\n`
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
    };
  }
}
