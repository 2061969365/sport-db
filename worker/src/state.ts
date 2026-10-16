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
  /**
   * 属主 = 这个提醒属于哪个会话实例（tg-<chatId> / pwa-<session> / fs-<chatId>）。
   * 必须隔离：每个会话是独立 DO，启动时都会读这份文件；不隔离的话
   * 网页版一开就会把 TG 的提醒重挂一遍、还推到错的通道。
   */
  owner?: string;
}

/** 把"我的提醒"合并进整份列表：只替换自己这个 owner 的条目，别人的原样保留。 */
export function mergeReminders(
  all: ReminderState[], mine: ReminderState[], owner: string,
): ReminderState[] {
  const others = all.filter((r) => (r.owner || "") !== owner);
  return [...others, ...mine.map((r) => ({ ...r, owner }))];
}

/** 恢复计划：哪些要重新挂上调度、哪些已过期可以清掉。纯函数，便于测试。 */
export function rearmPlan(
  items: ReminderState[], now: number, owner?: string,
): { arm: ReminderState[]; drop: ReminderState[]; keep: ReminderState[] } {
  const arm: ReminderState[] = [];
  const drop: ReminderState[] = [];
  const keep: ReminderState[] = [];
  for (const it of items) {
    if (!it?.text) continue;
    // 只看自己的：别的会话的提醒归它们自己恢复
    if (owner !== undefined && (it.owner || "") !== owner) continue;
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

/** 写纯文本状态文件（聊天导出用 .md，不是 JSON）。同样带 sha 乐观锁。 */
export async function writeStateText(env: Env, path: string, text: string, message: string): Promise<boolean> {
  const loc = stateLoc(env);
  if (!loc) return false;
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
  }
  const b64 = btoa(bin);
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
      if (put.status === 409 || put.status === 422) continue;
      if (!put.ok) {
        console.error(`[state-text-fail] ${path} ${put.status}`);
        return false;
      }
      return true;
    } catch (e) {
      console.error("[state-text-error]", e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  return false;
}

/**
 * 聊天备份的硬闸门：**只有**配了独立仓（STATE_REPO + STATE_PAT，通常是私有仓）才允许导出。
 * 公开数据仓里绝不落聊天记录 —— 这是设计红线，不是可配置项。
 */
export function chatBackupEnabled(env: Env): boolean {
  const loc = stateLoc(env);
  return !!loc && loc.dedicated;
}

export function chatPath(day: string): string {
  return `state/chat/${String(day).slice(0, 10)}.md`;
}

/** 距上次导出不足这个间隔就跳过，免得每句话都提交一次 git。 */
export const CHAT_EXPORT_MIN_GAP_MS = 5 * 60_000;

export function shouldExportChat(lastAt: number, now: number, force = false): boolean {
  if (force) return true;
  if (!lastAt) return true;
  return now - lastAt >= CHAT_EXPORT_MIN_GAP_MS;
}

export interface TranscriptItem {
  role: string;
  text: string;
  at?: number;
}

/** 把一天的对话渲染成 markdown（只留人话，工具调用与内部推理不进备份）。 */
export function formatTranscript(items: TranscriptItem[], day: string, maxChars = 80_000): string {
  const head = `# ${day} 对话记录\n\n> 自动备份（私有仓）。只记录对话文本，不含工具调用与内部推理。\n`;
  const lines: string[] = [];
  for (const it of items) {
    const text = String(it.text || "").trim();
    if (!text) continue;
    const who = it.role === "user" ? "🧑 我" : "🤖 教练";
    const ts = it.at ? ` _${new Date(it.at + 8 * 36e5).toISOString().slice(11, 16)}_` : "";
    lines.push(`### ${who}${ts}\n\n${text}\n`);
  }
  const body = lines.join("\n");
  const out = head + "\n" + body;
  if (out.length <= maxChars) return out;
  // 太长就留最近的（更早的内容在之前的导出里）
  return head + "\n…（更早的内容已省略）\n\n" + body.slice(-maxChars);
}
