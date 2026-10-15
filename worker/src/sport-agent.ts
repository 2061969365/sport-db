// SportDbAgent：Think harness 上的运动教练 + 账本管理员。
// 记忆进 DO state/Session；运动数据仍在 GitHub（tools 经 Contents API）。
import { Think } from "@cloudflare/think";
import { tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import type { Env } from "./env";
import {
  buildProfile, loadWorkouts, toolGetSummary, toolQueryWorkouts, toolUpdateWorkout,
} from "./github";

const COACH_SYS =
  "你是一名懂数据的跑步教练，也是这个运动库的管理员，用简短口语中文回答（200字内）。"
  + "规则：只用数据说话，跑步是跑步、骑行是骑行，配速只谈跑步；"
  + "先给一句话结论，再给1-2条带数字的具体建议；"
  + "摘要里没有的就说不知道，不编数据；只谈训练恢复。"
  + "查数规则：用户问具体某条、某天、某月、某年、最早/最晚、最多/最少时，"
  + "必须先调 query_workouts（配好 date_from/date_to/type，找最早用 sort=oldest），"
  + "拿到工具结果再回答；绝不允许只看画像就说不知道；画像里没有但工具能查到的，以工具为准。"
  + "改库规则：用户说改数时，必须先调 query_workouts 找到那条的 id 再调 update_workout，"
  + "一次只改用户明确说的字段，改完用中文报出改了哪条、旧值->新值；不确定的先问。";

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
