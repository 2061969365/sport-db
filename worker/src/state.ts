// 状态备份：把"只存在 Durable Object 里、换账号就丢"的东西落到 git。
//
// 为什么要分开处理：
//   * 提醒、计划、画像 —— 没有隐私代价（内容就是"明早7点提醒我跑步"），放数据仓最省事；
//   * 聊天历史 —— 是私人对话，放进公开仓等于公开聊天记录。要么不备份，
//     要么用 STATE_REPO + STATE_PAT 指到一个**私有仓**。
//
// 默认行为：状态写进数据仓的 state/ 目录；一旦配了 STATE_REPO + STATE_PAT，
// 所有状态（含以后的聊天备份）都改走那个私有仓，数据仓里不再落敏感内容。
import type { Env } from "./env.ts";

export interface StateLoc {
  repo: string;
  pat: string;
  /** 是否走了独立（通常是私有）仓 */
  dedicated: boolean;
}

/** 状态写到哪：优先 STATE_REPO，否则回落到数据仓。 */
export function stateLoc(env: Env): StateLoc | null {
  const repo = String(env.STATE_REPO || "").trim();
  const pat = String(env.STATE_PAT || "").trim();
  if (repo && pat) return { repo, pat, dedicated: true };
  if (env.REPO && env.GH_PAT) return { repo: env.REPO, pat: env.GH_PAT, dedicated: false };
  return null;
}

function headers(loc: StateLoc): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "sport-db-agent/2.0",
    Authorization: `Bearer ${loc.pat}`,
  };
}

const API = "https://api.github.com/repos";

/** 读 JSON 状态文件；不存在/损坏都返回 null（调用方按"没有"处理）。 */
export async function readStateJson<T>(env: Env, path: string): Promise<T | null> {
  const loc = stateLoc(env);
  if (!loc) return null;
  try {
    const r = await fetch(`${API}/${loc.repo}/contents/${path}?ref=main`, { headers: headers(loc) });
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    const bin = atob(j.content.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** 写 JSON 状态文件（带 sha 乐观锁，冲突重试一次）。失败只记日志，不影响主流程。 */
export async function writeStateJson(env: Env, path: string, value: unknown, message: string): Promise<boolean> {
  const loc = stateLoc(env);
  if (!loc) return false;
  const body = JSON.stringify(value, null, 1);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cur = await fetch(`${API}/${loc.repo}/contents/${path}?ref=main`, { headers: headers(loc) });
      let sha = "";
      if (cur.ok) {
        const j = (await cur.json()) as { sha?: string };
        sha = j.sha || "";
      }
      const put = await fetch(`${API}/${loc.repo}/contents/${path}`, {
        method: "PUT",
        headers: headers(loc),
        body: JSON.stringify({ message, content: b64, branch: "main", ...(sha ? { sha } : {}) }),
      });
      if (put.status === 409 || put.status === 422) continue; // sha 过期：重读再写
      if (!put.ok) {
        console.error(`[state-write-fail] ${path} ${put.status}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error("[state-write-error]", e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  return false;
}

export interface ReminderState {
  id: string;
  /** 触发时间：ISO 字符串（cron 型存表达式） */
  when: string;
  kind: "once" | "cron";
  text: string;
}

/** 恢复计划：哪些要重新挂上调度、哪些已过期可以清掉。纯函数，便于测试。 */
export function rearmPlan(
  items: ReminderState[], now: number,
): { arm: ReminderState[]; drop: ReminderState[]; keep: ReminderState[] } {
  const arm: ReminderState[] = [];
  const drop: ReminderState[] = [];
  const keep: ReminderState[] = [];
  for (const it of items) {
    if (!it?.text) continue;
    if (it.kind === "cron") {
      arm.push(it); // 周期提醒永远有效
      continue;
    }
    const t = Date.parse(it.when);
    if (!Number.isFinite(t)) {
      drop.push(it); // 时间坏掉的记录清掉，别留着恶心人
      continue;
    }
    if (t > now + 30_000) arm.push(it);
    else keep.push(it); // 刚过点的留着（可能正在触发），下次启动再清
  }
  return { arm, drop, keep };
}

export const REMINDERS_PATH = "state/reminders.json";
