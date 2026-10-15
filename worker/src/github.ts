// GitHub 即数据库：Contents API 读写 + CSV + 三工具的数据层。
// 口径与旧 worker.js 一致：分项（跑步/骑行/步行…）、距离加权配速、CRLF 保留、sha 冲突重试。
import type { Env } from "./env";

export const RUN_TYPES = ["outdoor_running", "indoor_running", "outdoor_run_class"];
export const EDITABLE_FIELDS = [
  "distance_m", "duration_s", "avg_pace_s", "avg_hr",
  "max_hr", "min_hr", "calories", "steps", "cadence", "type",
];

export type Row = Record<string, string> & { _year: string };

/** DO SQLite 标签函数最小形态（Think 的 this.sql 直接传进来，bind 好）。 */
export type SqlTag = (
  strings: TemplateStringsArray | string,
  ...values: unknown[]
) => Array<Record<string, unknown>>;

const CACHE_TTL_MS = 300_000;

function ensureCache(sql?: SqlTag): void {
  if (!sql) return;
  sql`CREATE TABLE IF NOT EXISTS csv_cache (path TEXT PRIMARY KEY, text TEXT, sha TEXT, updated_at INTEGER)`;
}

/** 读年文件：缓存命中（300s）直接用，否则 Contents API 拉取并回填。
 *  注意：写路径（update）必须用 ghGetFile 拿新鲜 sha，不能吃缓存。 */
async function cachedGetFile(
  env: Env, sql: SqlTag | undefined, path: string,
): Promise<{ text: string; sha: string } | null> {
  if (sql) {
    try {
      ensureCache(sql);
      const hit = sql`SELECT text, sha, updated_at FROM csv_cache WHERE path = ${path}` as
        { text: string; sha: string; updated_at: number }[];
      if (hit.length && Date.now() - hit[0].updated_at < CACHE_TTL_MS) {
        // 空文本 = 之前确认过不存在（否定缓存，CSV 不可能真空）。
        if (!hit[0].text) return null;
        return { text: hit[0].text, sha: hit[0].sha || "" };
      }
    } catch { /* 缓存坏了就当 miss */ }
  }
  const g = await ghGetFile(env, path).catch(() => null);
  if (sql) {
    try {
      ensureCache(sql);
      sql`INSERT OR REPLACE INTO csv_cache(path, text, sha, updated_at) VALUES (${path}, ${g?.text ?? ""}, ${g?.sha ?? ""}, ${Date.now()})`;
    } catch { /* 缓存写失败不影响主流程 */ }
  }
  return g;
}

function invalidateCache(sql: SqlTag | undefined, path: string): void {
  if (!sql) return;
  try {
    sql`DELETE FROM csv_cache WHERE path = ${path}`;
  } catch { /* 忽略 */ }
}

export function num(v: unknown): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
  }
  return btoa(bin);
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "sport-db-agent/2.0",
  };
  if (env.GH_PAT) h.Authorization = `Bearer ${env.GH_PAT}`;
  return h;
}

async function fetchText(url: string): Promise<string> {
  try {
    const r = await fetch(url);
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
}

/** 读文件：{text, sha}；不存在返回 null。无 GH_PAT 退回 raw。 */
export async function ghGetFile(env: Env, path: string): Promise<{ text: string; sha: string } | null> {
  if (env.GH_PAT) {
    try {
      const r = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}?ref=main`, {
        headers: ghHeaders(env),
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub读 ${path} 失败 ${r.status}`);
      const j = (await r.json()) as { type?: string; content?: string; sha?: string };
      if (j.type !== "file" || !j.content) return null;
      return { text: b64ToUtf8(j.content), sha: j.sha ?? "" };
    } catch (e) {
      if (String((e as Error).message || e).startsWith("GitHub读")) throw e;
    }
  }
  const t = await fetchText(`https://raw.githubusercontent.com/${env.REPO}/main/${path}`);
  return t ? { text: t, sha: "" } : null;
}

/** 写文件：需 sha（新建传空）。sha 过期抛 Conflict 错误。 */
export async function ghPutFile(env: Env, path: string, text: string, sha: string, message: string): Promise<string> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，写库不可用");
  const body: Record<string, string> = { message, content: utf8ToB64(text), branch: "main" };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(body),
  });
  if (r.status === 409 || r.status === 422) {
    const t = await r.text();
    throw new Error(`Conflict:${t.slice(0, 160)}`);
  }
  if (!r.ok) throw new Error(`GitHub写 ${path} 失败 ${r.status}`);
  const j = (await r.json()) as { content?: { sha?: string } };
  return j.content?.sha ?? "";
}

/** 工具语料：读全 data/workouts/*.csv。
 * 直接并行拉近 6 年文件（不存在的 404 跳过），不依赖目录列举接口——
 * 未鉴权时列举易被限流，曾导致回退只读两年（rows=454 的教训）。
 * 有 sql 时走 DO 缓存（300s TTL），同 turn 多工具只拉一次。 */
export async function loadWorkouts(env: Env, sql?: SqlTag): Promise<Row[]> {
  const y = new Date().getUTCFullYear();
  const years = [y - 5, y - 4, y - 3, y - 2, y - 1, y];
  const got = await Promise.all(
    years.map(async (year) => {
      const g = await cachedGetFile(env, sql, `data/workouts/${year}.csv`).catch(() => null);
      return { year, text: g?.text ?? "" };
    }),
  );
  const out: Row[] = [];
  for (const { year, text } of got) {
    if (!text) continue;
    for (const r of parseCSV(text)) out.push({ ...r, _year: String(year) });
  }
  return out;
}

export function grpOf(t: string): string {
  if (RUN_TYPES.includes(t)) return "跑步";
  if (t.includes("riding")) return "骑行";
  if (t.includes("walk")) return "步行";
  if (t.includes("swim")) return "游泳";
  if (t.includes("skip")) return "跳绳";
  return "综合训练";
}

export function fmtPace(secPerKm: number): string {
  return `${Math.floor(secPerKm / 60)}'${String(Math.round(secPerKm % 60)).padStart(2, "0")}”/km`;
}

function bjToday(): string {
  return new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
}

/** 近 30 天画像（分项口径），拼进 system prompt。 */
export function buildProfile(all: Row[], days = 30): string {
  const cut = bjToday();
  const since = new Date(Date.parse(cut) - 29 * 864e5).toISOString().slice(0, 10);
  void days;
  const recent = all.filter((r) => (r.date || "") >= since);
  const byGrp: Record<string, Row[]> = {};
  const act = new Set<string>();
  let last: Row | null = null;
  for (const r of recent) {
    const g = grpOf(r.type || "");
    (byGrp[g] ??= []).push(r);
    if (r.date) act.add(r.date);
    if (!last || Number(r.start_utc) > Number(last.start_utc)) last = r;
  }
  const lines = [`近30天共运动${recent.length}次，活跃${act.size}天（今天${cut}）。`];
  const runs = byGrp["跑步"] ?? [];
  if (runs.length) {
    const pd = runs.reduce((a, w) => a + num(w.distance_m), 0);
    const pt = runs.reduce((a, w) => a + num(w.duration_s), 0);
    const hrs = runs.map((w) => num(w.avg_hr)).filter((x) => x);
    let seg = `跑步${runs.length}次共${(pd / 1000).toFixed(1)}km`;
    if (pd > 0 && pt > 0) seg += `，均配速${fmtPace(pt / (pd / 1000))}`;
    if (hrs.length) seg += `，均心率${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}bpm`;
    lines.push(seg + "。");
  }
  for (const name of ["骑行", "步行", "游泳", "跳绳", "综合训练"]) {
    const rs = byGrp[name] ?? [];
    if (rs.length) {
      lines.push(`${name}${rs.length}次共${(rs.reduce((a, w) => a + num(w.distance_m), 0) / 1000).toFixed(1)}km。`);
    }
  }
  if (last) {
    lines.push(`最近一次：${last.date} ${grpOf(last.type || "")} ${(num(last.distance_m) / 1000).toFixed(2)}km 用时 ${Math.round(num(last.duration_s) / 60)}min。`);
  }
  return lines.join("\n");
}

/** get_summary 工具：任意天数分项画像。 */
export function toolGetSummary(all: Row[], daysRaw: unknown): string {
  let d = parseInt(String(daysRaw ?? 30), 10);
  if (!Number.isFinite(d)) d = 30;
  d = Math.min(90, Math.max(1, d));
  const cut = bjToday();
  const since = new Date(Date.parse(cut) - (d - 1) * 864e5).toISOString().slice(0, 10);
  const recent = all.filter((r) => (r.date || "") >= since);
  if (!recent.length) return `近${d}天无运动记录。`;
  const byGrp: Record<string, Row[]> = {};
  for (const r of recent) {
    const g = grpOf(r.type || "");
    (byGrp[g] ??= []).push(r);
  }
  const lines = [`近${d}天共运动${recent.length}次。`];
  const runs = byGrp["跑步"] ?? [];
  if (runs.length) {
    const pd = runs.reduce((a, w) => a + num(w.distance_m), 0);
    const pt = runs.reduce((a, w) => a + num(w.duration_s), 0);
    const hrs = runs.map((w) => num(w.avg_hr)).filter((x) => x);
    let seg = `跑步${runs.length}次共${(pd / 1000).toFixed(1)}km`;
    if (pd > 0 && pt > 0) seg += `，均配速${fmtPace(pt / (pd / 1000))}`;
    if (hrs.length) seg += `，均心率${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}bpm`;
    lines.push(seg + "。");
  }
  for (const name of ["骑行", "步行", "游泳", "跳绳", "综合训练"]) {
    const rs = byGrp[name] ?? [];
    if (rs.length) {
      lines.push(`${name}${rs.length}次共${(rs.reduce((a, w) => a + num(w.distance_m), 0) / 1000).toFixed(1)}km。`);
    }
  }
  return lines.join("\n");
}

/** query_workouts 工具：改数前必须先查到 id。 */
export function toolQueryWorkouts(
  all: Row[],
  args: { type?: string; date_from?: string; date_to?: string; sort?: string; limit?: number },
): string {
  let lim = Math.trunc(Number(args.limit) || 10);
  if (!Number.isFinite(lim)) lim = 10;
  lim = Math.min(30, Math.max(1, lim));
  const out = [];
  for (const r of all) {
    if (args.type && r.type !== args.type) continue;
    if (args.date_from && (r.date || "") < args.date_from) continue;
    if (args.date_to && (r.date || "") > args.date_to) continue;
    out.push({
      id: r.id, date: r.date, type: r.type, distance_m: r.distance_m,
      duration_s: r.duration_s, avg_pace_s: r.avg_pace_s, avg_hr: r.avg_hr,
      max_hr: r.max_hr, steps: r.steps, source: r.source,
    });
  }
  out.sort((a, b) => (a.date ?? "") < (b.date ?? "") ? -1 : 1);
  const rows = args.sort === "oldest" ? out.slice(0, lim) : out.slice(-lim);
  return JSON.stringify({ total: out.length, rows });
}

function stringifyCSV(head: string[], rows: Record<string, string>[], eol: string): string {
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return head.map(esc).join(",") + eol
    + rows.map((r) => head.map((h) => esc(r[h])).join(",")).join(eol) + eol;
}

/** update_workout 工具（两阶段）：缺 confirmed 时只出预览不写库；
 * confirmed=true 时新鲜读→校验旧值→写→清缓存。sha 冲突自重试一次。 */
export async function toolUpdateWorkout(
  env: Env, all: Row[], actor: string,
  args: { id?: string; fields?: Record<string, unknown>; confirmed?: boolean },
  sql?: SqlTag,
): Promise<string> {
  if (!env.GH_PAT) {
    return "失败：写库未授权（Worker 缺 GH_PAT，当前只读模式）。"
      + "请明确告诉用户：改数功能需要先配好写权限——去 GitHub 建细粒度 PAT"
      + "（仅 sport-db 的 Contents 读写），再 wrangler secret put GH_PAT；"
      + "配好之前不要让用户重复发送同样的改数指令。";
  }
  const wid = String(args.id || "").trim();
  const fields = args.fields || {};
  if (!wid || typeof fields !== "object" || !Object.keys(fields).length) {
    return "失败：缺 id 或 fields 为空。";
  }
  const bad = Object.keys(fields).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (bad.length) return `失败：不允许改 ${bad.join(",")}，只能改 ${EDITABLE_FIELDS.join(",")}。`;
  const hit = all.find((r) => r.id === wid);
  if (!hit) return `失败：找不到 id=${wid}，先调 query_workouts 确认。`;
  const preview = Object.keys(fields)
    .map((k) => `${k} ${(hit[k] ?? "")}->${fields[k] == null ? "" : String(fields[k])}`)
    .join("；");
  if (!args.confirmed) {
    return `预览（尚未写入）：${wid}（${hit.date} ${hit.type}）：${preview}。`
      + "请把这条预览念给用户，得到用户明确说“确认”后，再用完全相同的 id+fields 调一次并带 confirmed=true。";
  }
  const path = `data/workouts/${hit._year}.csv`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await ghGetFile(env, path).catch(() => null);
    if (!cur?.text) {
      if (attempt === 1) return `失败：读 ${path} 连续失败，稍后再试。`;
      continue;
    }
    const parsed = parseCSV(cur.text);
    if (!parsed.length) return `失败：${path} 为空或解析失败。`;
    const header = Object.keys(parsed[0]);
    const idx = parsed.findIndex((r) => r.id === wid);
    if (idx < 0) return `失败：${path} 里找不到 id=${wid}（可能刚被改动），请重查。`;
    const row = parsed[idx];
    const stale = Object.keys(fields).filter((k) => String(row[k] ?? "") !== String(hit[k] ?? ""));
    if (stale.length) {
      return `中止：${wid} 的 ${stale.join(",")} 在预览后被人改过（以库为准），`
        + "请重查最新值、重新出预览再让用户确认。";
    }
    const old: Record<string, string> = {};
    for (const k of Object.keys(fields)) old[k] = row[k] ?? "";
    for (const [k, v] of Object.entries(fields)) row[k] = v == null ? "" : String(v);
    if (fields.type !== undefined) row.category = String(fields.type);
    const eol = cur.text.includes("\r\n") ? "\r\n" : "\n";
    const next = stringifyCSV(header, parsed, eol);
    try {
      await ghPutFile(env, path, next, cur.sha || "",
        `bot: update ${wid} ${Object.keys(fields).join(",")} via ${actor}`);
      invalidateCache(sql, path);
      return `已改 ${wid}（${row.date} ${row.type}）：`
        + Object.keys(fields).map((k) => `${k} ${old[k]}->${row[k]}`).join("；");
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (!msg.startsWith("Conflict:") || attempt === 1) {
        return `失败：写回异常（${msg.slice(0, 120)}），我已重试过，请稍后再试。`;
      }
    }
  }
  return "失败：连续冲突，请稍后再试。";
}
