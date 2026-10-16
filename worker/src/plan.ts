// 训练计划的结构化存储与进度：把 plans/*.json 变成可打卡、可调整的状态机，
// 而不是一份只能看的 markdown。
//
// 结构（存仓库，跟画像一样跨通道共享、用户可读）：
//   plans/<slug>.json
//   { "name": "...", "goal": "...", "created": "YYYY-MM-DD",
//     "sessions": [ { "date": "YYYY-MM-DD", "type": "easy|long|tempo|interval|rest|race|other",
//                     "target": "6km @6'10", "status": "planned|done|skipped", "actual": "", "note": "" } ] }
import type { Env } from "./env.ts";
import { ghGetFile, ghPutFile, type SqlTag } from "./github.ts";

export type SessionStatus = "planned" | "done" | "skipped";
export interface Session {
  date: string;
  type: string;
  target: string;
  status: SessionStatus;
  actual?: string;
  note?: string;
}
export interface Plan {
  name: string;
  goal?: string;
  created: string;
  sessions: Session[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ["easy", "long", "tempo", "interval", "rest", "race", "other"];

export function planPath(slug: string): string | null {
  const s = String(slug || "").trim().toLowerCase();
  return SLUG_RE.test(s) ? `plans/${s}.json` : null;
}

/** 校验并规范化计划（模型给的字段可能不齐）。返回错误字符串或规范化结果。 */
export function normalizePlan(raw: unknown, today: string): Plan | string {
  const p = raw as Partial<Plan> | null;
  if (!p || typeof p !== "object") return "失败：计划内容不是对象。";
  const sessionsRaw = Array.isArray(p.sessions) ? p.sessions : [];
  if (!sessionsRaw.length) return "失败：计划里一次训练都没有。";
  if (sessionsRaw.length > 200) return "失败：计划超过 200 次训练，拆成多个计划。";
  const sessions: Session[] = [];
  for (const [i, s0] of sessionsRaw.entries()) {
    const s = s0 as Partial<Session>;
    const date = String(s.date || "").trim();
    if (!DATE_RE.test(date)) return `失败：第 ${i + 1} 次训练的日期不合法（${s.date}），要 YYYY-MM-DD。`;
    const type = TYPES.includes(String(s.type)) ? String(s.type) : "other";
    const target = String(s.target ?? "").slice(0, 120);
    const status = (["planned", "done", "skipped"] as const).includes(s.status as SessionStatus)
      ? (s.status as SessionStatus)
      : (date < today ? "skipped" : "planned");
    sessions.push({
      date, type, target, status,
      ...(s.actual ? { actual: String(s.actual).slice(0, 120) } : {}),
      ...(s.note ? { note: String(s.note).slice(0, 200) } : {}),
    });
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    name: String(p.name || "").slice(0, 80) || "训练计划",
    ...(p.goal ? { goal: String(p.goal).slice(0, 200) } : {}),
    created: DATE_RE.test(String(p.created)) ? String(p.created) : today,
    sessions,
  };
}

/** 进度摘要：完成率、已过期未打卡、下一次训练。 */
export function planProgress(plan: Plan, today: string): string {
  const total = plan.sessions.length;
  // 注意：完成率的分子分母都必须只算训练课——休息日算进分子会虚高（踩过）
  const trainingSessions = plan.sessions.filter((s) => s.type !== "rest");
  const training = trainingSessions.length;
  const done = trainingSessions.filter((s) => s.status === "done").length;
  const skipped = trainingSessions.filter((s) => s.status === "skipped").length;
  const resting = total - training;
  const missed = plan.sessions.filter((s) => s.status === "planned" && s.date < today && s.type !== "rest");
  const upcoming = plan.sessions.filter((s) => s.status === "planned" && s.date >= today).slice(0, 3);
  const pct = training ? Math.round((done / training) * 100) : 0;
  const lines = [
    `计划「${plan.name}」${plan.goal ? `（目标：${plan.goal}）` : ""}`,
    `共 ${total} 次（其中休息 ${resting} 次）：训练课已完成 ${done}，跳过 ${skipped}，`
      + `待完成 ${training - done - skipped}`,
    `完成率 ${pct}%（只按训练课算，休息日不进分母）`,
  ];
  if (missed.length) {
    lines.push(`⚠️ 有 ${missed.length} 次该练没打卡：${missed.slice(0, 5).map((s) => `${s.date} ${s.target || s.type}`).join("；")}`);
  }
  if (upcoming.length) {
    lines.push("接下来：" + upcoming.map((s) => `${s.date} ${s.target || s.type}`).join("；"));
  } else {
    lines.push("计划已到尾声，可以准备下一次了。");
  }
  return lines.join("\n");
}

/** 该练没练的信号（给主动教练用）。 */
export function planSignals(plan: Plan, today: string): { key: string; weight: number; text: string }[] {
  const missed = plan.sessions.filter((s) => s.status === "planned" && s.date < today && s.type !== "rest");
  if (!missed.length) return [];
  const last = missed[missed.length - 1];
  return [{
    key: `plan-missed-${last.date}`,
    weight: 62,
    text: `计划里 **${missed.length} 次**训练还没打卡，最近一次是 ${last.date}（${last.target || last.type}）。`
      + "是练了没记，还是没练成？练了就发我截图补上；没练的话我们把后面的安排往顺延一下。",
  }];
}

export async function readPlan(env: Env, slug: string): Promise<Plan | null> {
  const path = planPath(slug);
  if (!path) return null;
  const g = await ghGetFile(env, path).catch(() => null);
  if (!g?.text) return null;
  try {
    return JSON.parse(g.text) as Plan;
  } catch {
    return null;
  }
}

export async function writePlan(
  env: Env, slug: string, plan: Plan, actor: string, sql?: SqlTag,
): Promise<string> {
  const path = planPath(slug);
  if (!path) return "失败：计划名只能用字母数字和短横线（如 half-marathon-2026-11）。";
  const cur = await ghGetFile(env, path).catch(() => null);
  await ghPutFile(env, path, JSON.stringify(plan, null, 1), cur?.sha || "",
    `bot: 计划 ${slug}（${plan.sessions.length} 次）via ${actor}`);
  try {
    // 注意：sql 只能以方法形式调用；可选链 + tag 是非法语法（踩过）
    if (sql) sql`DELETE FROM profile_cache WHERE path = ${path}`;
  } catch { /* 忽略 */ }
  return `已保存计划「${plan.name}」（${path}，${plan.sessions.length} 次训练）。`;
}

export async function listPlans(env: Env): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/contents/plans?ref=main`, {
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "sport-db-agent/2.0",
      ...(env.GH_PAT ? { Authorization: `Bearer ${env.GH_PAT}` } : {}),
    },
  }).catch(() => null);
  if (!r) return "失败：列计划目录异常。";
  if (r.status === 404) return "还没有任何计划文件。";
  if (!r.ok) return `失败：列计划目录 ${r.status}。`;
  const list = (await r.json()) as { name?: string; path?: string }[];
  const files = (Array.isArray(list) ? list : []).filter((e) => (e.name || "").endsWith(".json"));
  if (!files.length) return "还没有任何计划文件。";
  const out: string[] = [];
  for (const f of files.slice(0, 20)) {
    const slug = (f.name || "").replace(/\.json$/, "");
    const p = await readPlan(env, slug);
    out.push(p
      ? `${slug}：${p.name}${p.goal ? `（${p.goal}）` : ""}，${p.sessions.length} 次`
      : `${slug}：（读取失败，文件可能损坏）`);
  }
  return out.join("\n");
}
