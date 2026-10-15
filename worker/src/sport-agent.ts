// SportDbAgent：Think harness 上的运动教练 + 账本管理员。
// 记忆进 DO state/Session；运动数据仍在 GitHub（tools 经 Contents API）。
import { Think } from "@cloudflare/think";
import { callable } from "agents";
import { tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { Env } from "./env";
import {
  buildProfile, loadWorkouts, toolGetSummary, toolQueryWorkouts, toolUpdateWorkout,
} from "./github";

const COACH_SYS =
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
  + "拿到工具结果再回答；绝不允许只看画像就说不知道；画像里没有但工具能查到的，以工具为准。"
  + "【改库铁律】用户说改数时，必须先调 query_workouts 找到那条的 id 再调 update_workout，"
  + "一次只改用户明确说的字段，改完用中文报出改了哪条、旧值->新值；"
  + "白名单外的字段、找不到的记录，明说做不到或找不到，让用户确认，不擅自发挥。"

export class SportDbAgent extends Think<Env> {
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
    return { providerOptions: { openai: { reasoningEffort: "xhigh" as const } } };
  }

  @callable()
  async resetConversation(): Promise<string> {
    // 只清聊天记录：user_profile / coaching_notes 长期记忆保留，
    // 下一轮自动用最新 prompt 重建，不用换窗口。
    await this.clearMessages();
    return "ok";
  }

  configureContext() {
    // 不传 provider → 自动落 durable per-agent SQLite，且经 set_context 可写。
    // user_profile：认得“人”（目标/伤病/偏好）；coaching_notes：记得“事”（弱项/执行/下次提醒）。
    return [
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

  getTools() {
    const env = this.env;
    return {
      get_summary: tool({
        description: "查近N天分项画像（跑步/骑行分开）。画像里已有30天摘要，要其它天数才调。",
        inputSchema: z.object({ days: z.number().int().min(1).max(90).default(30) }),
        execute: async ({ days }: { days: number }) => {
          const all = await loadWorkouts(env);
          return toolGetSummary(all, days);
        },
      }),
      query_workouts: tool({
        description: "按条件查原始记录明细（含id）。改数据前必须先查到id；找最早记录用sort=oldest。type 只能从枚举里选，不确定就空着别填。",
        inputSchema: z.object({
          type: z.enum(["outdoor_running", "indoor_running", "outdoor_run_class", "outdoor_riding", "indoor_riding", "outdoor_walking", "pool_swimming", "free_training", "rope_skipping"]).optional(),
          date_from: z.string().optional(),
          date_to: z.string().optional(),
          sort: z.enum(["latest", "oldest"]).default("latest"),
          limit: z.number().int().min(1).max(30).default(10),
        }),
        execute: async (args: { type?: string; date_from?: string; date_to?: string; sort?: string; limit?: number }) => {
          const all = await loadWorkouts(env);
          return toolQueryWorkouts(all, args);
        },
      }),
      update_workout: tool({
        description: "按id改一条记录。只能改用户明确说的字段，先query确认。",
        inputSchema: z.object({
          id: z.string(),
          fields: z.record(z.string(), z.union([z.string(), z.number()])),
        }),
        execute: async (args: { id: string; fields: Record<string, string | number> }) => {
          const all = await loadWorkouts(env);
          return toolUpdateWorkout(env, all, "think-agent", args);
        },
      }),
    };
  }
}
