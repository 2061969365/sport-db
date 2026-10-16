// GitHub 即数据库：Contents API 读写 + CSV + 三工具的数据层。
// 口径与旧 worker.js 一致：分项（跑步/骑行/步行…）、距离加权配速、CRLF 保留、sha 冲突重试。
import type { Env } from "./env";

export const RUN_TYPES = ["outdoor_running", "indoor_running", "outdoor_run_class"];

export const WORKOUT_TYPES = [
  "outdoor_running", "indoor_running", "outdoor_run_class",
  "outdoor_riding", "indoor_riding", "outdoor_walking",
  "pool_swimming", "free_training", "rope_skipping",
];

/** 规范 28 列（新年文件建表用，与 import_mi 同序）。 */
export const WORKOUT_COLS = [
  "id", "date", "start_utc", "start_beijing", "end_utc", "end_beijing",
  "type", "category", "distance_m", "duration_s", "avg_pace_s", "max_pace_s",
  "avg_speed", "max_speed", "avg_hr", "max_hr", "min_hr", "calories",
  "steps", "cadence", "avg_stride", "total_climbing",
  "uid_hash", "sid_hash", "has_track", "source", "confidence", "value_json",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkDates(args: { date_from?: string; date_to?: string }): string | null {
  for (const k of ["date_from", "date_to"] as const) {
    const v = args[k];
    if (v && !DATE_RE.test(v)) {
      return `日期格式不对（${k}=${v}），必须用 YYYY-MM-DD，例如 2026-10-01。请修正后重调，不要编造结果。`;
    }
  }
  return null;
}
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 429/5xx 重试一次（1s 退避）；404/401/403 直接按原语义处理，不重试。 */
async function ghFetch(input: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(input, init);
  if ((r.status === 429 || r.status >= 500) && (init?.method || "GET") !== "GET") {
    // 写请求不自动重试（避免 double-write），抛给调用方处理
    return r;
  }
  if (r.status === 429 || r.status >= 500) {
    await sleep(1000);
    return fetch(input, init);
  }
  return r;
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
      const r = await ghFetch(`https://api.github.com/repos/${env.REPO}/contents/${path}?ref=main`, {
        headers: ghHeaders(env),
      });
      if (r.status === 404) return null;
      if (r.status === 401 || r.status === 403) {
        throw new Error(`GitHub读 ${path} 鉴权失败 ${r.status}（PAT 过期或权限不足）`);
      }
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

/** 二进制直传（如 TG 原图）：base64 + PUT，返回短 sha。 */
export async function putBinaryFile(env: Env, path: string, bytes: ArrayBuffer, message: string): Promise<string> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，写库不可用");
  const u8 = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i += 8192) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 8192)));
  }
  const r = await ghFetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify({ message, content: btoa(bin), branch: "main" }),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error(`GitHub写 ${path} 鉴权失败 ${r.status}（PAT 过期或权限不足）`);
  }
  if (!r.ok) throw new Error(`GitHub写 ${path} 失败 ${r.status}`);
  const j = (await r.json()) as { content?: { sha?: string } };
  return j.content?.sha?.slice(0, 7) ?? "";
}

/** 写文件：需 sha（新建传空）。sha 过期抛 Conflict 错误。 */
export async function ghPutFile(env: Env, path: string, text: string, sha: string, message: string): Promise<string> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，写库不可用");
  const body: Record<string, string> = { message, content: utf8ToB64(text), branch: "main" };
  if (sha) body.sha = sha;
  const r = await ghFetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error(`GitHub写 ${path} 鉴权失败 ${r.status}（PAT 过期或权限不足）`);
  }
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

/** Vision 识别结果（截图/AI 统一形状）。 */
export interface VisionRec {
  type: string;
  distance_km: number | null;
  duration_s: number | null;
  avg_pace_s_per_km: number | null;
  avg_hr: number | null;
  calories: number | null;
  steps: number | null;
  cadence: number | null;
  start_time: string | null;
  confidence: number;
  [k: string]: unknown;
}

function parseStart(s: unknown): Date {
  try {
    if (typeof s === "string" && s) {
      const iso = s.replace(" ", "T").replace(" +08:00", "+08:00");
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch { /* fallback now */ }
  return new Date();
}

/** Vision JSON → workouts 行（与 import_mi / parse_track 同列）。 */
export function toWorkoutRow(rec: VisionRec, imagePath: string): Record<string, string> {
  const start = parseStart(rec.start_time);
  const dur = Math.trunc(Number(rec.duration_s) || 0);
  const end = new Date(start.getTime() + dur * 1000);
  let dist = "";
  try {
    dist = rec.distance_km == null ? "" : String(Math.round(Number(rec.distance_km) * 1000));
  } catch { /* 留空 */ }
  const wtype = rec.type || "free_training";
  const bj = (d: Date) => new Date(d.getTime() + 8 * 36e5).toISOString().replace("T", " ").slice(0, 19) + " +08:00";
  return {
    id: `image-${Math.floor(start.getTime() / 1000)}-${wtype}-${dist || 0}`,
    date: bj(start).slice(0, 10),
    start_utc: String(Math.floor(start.getTime() / 1000)),
    start_beijing: bj(start),
    end_utc: String(Math.floor(end.getTime() / 1000)),
    end_beijing: bj(end),
    type: wtype, category: wtype,
    distance_m: dist, duration_s: String(dur),
    avg_pace_s: rec.avg_pace_s_per_km != null ? String(rec.avg_pace_s_per_km) : "",
    max_pace_s: "", avg_speed: "", max_speed: "",
    avg_hr: rec.avg_hr != null ? String(rec.avg_hr) : "",
    max_hr: "", min_hr: "",
    calories: rec.calories != null ? String(rec.calories) : "",
    steps: rec.steps != null ? String(rec.steps) : "",
    cadence: rec.cadence != null ? String(rec.cadence) : "",
    avg_stride: "", total_climbing: "",
    uid_hash: "", sid_hash: "",
    has_track: "0", source: "image",
    confidence: String(rec.confidence ?? 0),
    value_json: JSON.stringify({ vision: rec, image: imagePath }),
  };
}

/** 删文件（review 确认入库后清理用）。 */
export async function ghDeleteFile(env: Env, path: string, sha: string, message: string): Promise<void> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，写库不可用");
  const r = await ghFetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    method: "DELETE",
    headers: ghHeaders(env),
    body: JSON.stringify({ message, sha, branch: "main" }),
  });
  if (!r.ok) throw new Error(`GitHub删 ${path} 失败 ${r.status}`);
}

/** list_review：列待确认截图（路径+识别摘要），供模型或用户挑选确认。 */
export async function toolListReview(env: Env): Promise<string> {
  if (!env.GH_PAT) return "读 review 需要 GH_PAT（公开仓可直接看网页，这里读不了）。";
  const r = await ghFetch(`https://api.github.com/repos/${env.REPO}/contents/review?ref=main`, {
    headers: ghHeaders(env),
  }).catch(() => null);
  if (!r) return "失败：读 review 目录异常，稍后再试。";
  if (r.status === 404) return "review 为空，没有待确认项。";
  if (!r.ok) return `失败：读 review 目录 ${r.status}。`;
  const list = (await r.json()) as { name?: string; path?: string }[];
  const files = (Array.isArray(list) ? list : [])
    .filter((e) => (e.name || "").endsWith(".json"))
    .slice(0, 20);
  if (!files.length) return "review 为空，没有待确认项。";
  const out = [];
  for (const f of files) {
    const g = await ghGetFile(env, f.path || "").catch(() => null);
    let summary = "解析失败";
    try {
      const rec = JSON.parse(g?.text || "{}") as Partial<VisionRec> & { image?: string; error?: string };
      summary = rec.error
        ? `识别失败：${rec.error}（图 ${rec.image || "?"}）`
        : `${rec.type} ${rec.distance_km}km/${rec.duration_s}s（confidence ${rec.confidence}，图 ${rec.image || (rec as { vision?: { image?: string } }).vision?.image || "?"}`;
    } catch { /* 保持解析失败 */ }
    out.push({ path: f.path, summary });
  }
  return JSON.stringify({ total: out.length, items: out });
}

/** confirm_review：把某条 review 确认入库（写行+删 review 文件），两阶段同样要 confirmed。 */
export async function toolConfirmReview(
  env: Env, path: string, confirmed: boolean, actor: string, sql?: SqlTag,
): Promise<string> {
  if (!env.GH_PAT) return "失败：写库未授权（Worker 缺 GH_PAT）。";
  if (!path.startsWith("review/") || !path.endsWith(".json")) {
    return "失败：path 必须是 review/ 下的 json（先调 list_review 拿路径）。";
  }
  const cur = await ghGetFile(env, path).catch(() => null);
  if (!cur?.text) return `失败：${path} 不存在或已处理，请重查 list_review。`;
  let rec: VisionRec;
  try {
    rec = JSON.parse(cur.text) as VisionRec;
  } catch {
    return `失败：${path} 不是合法 JSON，请人工处理。`;
  }
  if ((rec as { error?: string }).error || rec.distance_km == null) {
    return `这条无法自动入库（${(rec as { error?: string }).error || "缺关键数字"}），请人工看图补录，或删掉它。`;
  }
  const image = (rec as { image?: string }).image
    || (rec as { vision?: { image?: string } }).vision?.image || "";
  const row = toWorkoutRow(rec, image);
  if (!confirmed) {
    return `预览（尚未写入）：${row.date} ${row.type} ${row.distance_m ? Number(row.distance_m) / 1000 + "km" : ""}`
      + `/${row.duration_s}s（confidence ${rec.confidence}），原图 ${image}。`
      + "用户明确说“确认”后，再用相同 path 带 confirmed=true 调一次；写入后自动删除这条 review。";
  }
  await appendRow(env, row, actor, sql);
  await ghDeleteFile(env, path, cur.sha, `bot: review确认入库 ${row.date} ${row.type} via ${actor}`);
  return `已入库：${row.date} ${row.type}（id=${row.id}），review 文件已删。`;
}

/** query_workouts 工具：改数前必须先查到 id。 */
export function toolQueryWorkouts(
  all: Row[],
  args: { type?: string; date_from?: string; date_to?: string; sort?: string; limit?: number },
): string {
  let lim = Math.trunc(Number(args.limit) || 10);
  if (!Number.isFinite(lim)) lim = 10;
  lim = Math.min(30, Math.max(1, lim));
  const dateErr = checkDates(args);
  if (dateErr) return dateErr;
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

/** append 的写核：读（或新建）年文件 → 追加一行 → 写回 → 清缓存。P2 会把 photo.ts 收图并过来。 */
export async function appendRow(
  env: Env, row: Record<string, string>, actor: string, sql?: SqlTag,
): Promise<string> {
  const path = `data/workouts/${row.date.slice(0, 4)}.csv`;
  const cur = await ghGetFile(env, path).catch(() => null);
  let header = WORKOUT_COLS;
  let rows: Record<string, string>[] = [];
  if (cur?.text) {
    rows = parseCSV(cur.text);
    if (rows.length) header = Object.keys(rows[0]);
  }
  rows.push(Object.fromEntries(header.map((h) => [h, row[h] ?? ""])));
  const esc = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const eol = cur?.text?.includes("\r\n") ? "\r\n" : "\n";
  const next = header.map(esc).join(",") + eol
    + rows.map((r) => header.map((h) => esc(r[h] ?? "")).join(",")).join(eol) + eol;
  await ghPutFile(env, path, next, cur?.sha || "",
    `bot: append ${row.id} via ${actor}`);
  invalidateCache(sql, path);
  return path;
}

/** delete_workout 工具（两阶段）：预览 → confirmed=true 才删。删后 git 可 revert。 */
export async function toolDeleteWorkout(
  env: Env, all: Row[], actor: string,
  args: { id?: string; confirmed?: boolean }, sql?: SqlTag,
): Promise<string> {
  if (!env.GH_PAT) {
    return "失败：写库未授权（Worker 缺 GH_PAT，当前只读模式），删记录做不了。";
  }
  const wid = String(args.id || "").trim();
  if (!wid) return "失败：缺 id，先调 query_workouts 确认。";
  const hit = all.find((r) => r.id === wid);
  if (!hit) return `失败：找不到 id=${wid}，先调 query_workouts 确认。`;
  if (!args.confirmed) {
    return `预览（尚未删除）：${wid}（${hit.date} ${hit.type} `
      + `${Number(hit.distance_m || 0) / 1000}km/${hit.duration_s || "?"}s）`
      + "删除后 git 可 revert。得到用户明确说“确认删除”后，再用相同 id 带 confirmed=true 调一次。";
  }
  const path = `data/workouts/${hit._year}.csv`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await ghGetFile(env, path).catch(() => null);
    if (!cur?.text) {
      if (attempt === 1) return `失败：读 ${path} 连续失败，稍后再试。`;
      continue;
    }
    const parsed = parseCSV(cur.text);
    const idx = parsed.findIndex((r) => r.id === wid);
    if (idx < 0) return `失败：该条已不在库中（可能已被删），请重查。`;
    const [gone] = parsed.splice(idx, 1);
    const header = Object.keys(parsed[0] ?? gone);
    const esc = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const eol = cur.text.includes("\r\n") ? "\r\n" : "\n";
    const next = header.map(esc).join(",") + eol
      + parsed.map((r) => header.map((h) => esc(r[h] ?? "")).join(",")).join(eol) + eol;
    try {
      await ghPutFile(env, path, next, cur.sha || "", `bot: delete ${wid} via ${actor}`);
      invalidateCache(sql, path);
      return `已删 ${wid}（${gone.date} ${gone.type}）。删错了可在 GitHub 上 revert 这次提交。`;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (!msg.startsWith("Conflict:") || attempt === 1) {
        return `失败：写回异常（${msg.slice(0, 120)}），我已重试过，请稍后再试。`;
      }
    }
  }
  return "失败：连续冲突，请稍后再试。";
}

/** append_workout 工具（两阶段）：纯文字补录，如“昨天跑了5km帮我记上”。 */
export async function toolAppendWorkout(
  env: Env, all: Row[],
  args: {
    type?: string; date?: string; distance_m?: number; duration_s?: number;
    avg_hr?: number; calories?: number; steps?: number; cadence?: number;
    confirmed?: boolean;
  },
  sql?: SqlTag,
): Promise<string> {
  void all;
  if (!env.GH_PAT) {
    return "失败：写库未授权（Worker 缺 GH_PAT，当前只读模式），补录做不了。";
  }
  const wtype = args.type || "outdoor_running";
  if (!WORKOUT_TYPES.includes(wtype)) {
    return `失败：type 只能是 ${WORKOUT_TYPES.join("/")}，不确定就空着（默认 outdoor_running）。`;
  }
  const today = new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
  const date = args.date || today;
  if (!DATE_RE.test(date)) {
    return `日期格式不对（${args.date}），必须用 YYYY-MM-DD，例如 ${today}。`;
  }
  const distM = Math.trunc(Number(args.distance_m) || 0);
  const dur = Math.trunc(Number(args.duration_s) || 0);
  if (distM <= 0 && dur <= 0) {
    return "失败：距离和时长至少要给一个能用的数字（distance_m 单位米，duration_s 单位秒）。";
  }
  const startUtc = Math.floor(Date.parse(`${date}T12:00:00+08:00`) / 1000);
  const numOr = (v: unknown) => (v == null || v === "" ? "" : String(Math.trunc(Number(v) || 0)));
  const row: Record<string, string> = {
    id: `manual-${startUtc}-${wtype}-${distM}`,
    date,
    start_utc: String(startUtc),
    start_beijing: `${date} 12:00:00 +08:00`,
    end_utc: String(startUtc + dur),
    end_beijing: `${date} 12:${String(Math.floor(dur / 60)).padStart(2, "0")}:${String(dur % 60).padStart(2, "0")} +08:00`,
    type: wtype, category: wtype,
    distance_m: distM ? String(distM) : "", duration_s: dur ? String(dur) : "",
    avg_pace_s: "", max_pace_s: "", avg_speed: "", max_speed: "",
    avg_hr: numOr(args.avg_hr), max_hr: "", min_hr: "",
    calories: numOr(args.calories), steps: numOr(args.steps), cadence: numOr(args.cadence),
    avg_stride: "", total_climbing: "",
    uid_hash: "", sid_hash: "",
    has_track: "0", source: "manual",
    confidence: "1.0",
    value_json: JSON.stringify({ manual: { type: wtype, date, distance_m: distM, duration_s: dur } }),
  };
  if (!args.confirmed) {
    return `预览（尚未写入）：${date} ${wtype} ${distM ? distM / 1000 + "km" : "距离未知"}/${dur ? dur + "s" : "时长未知"}`
      + "（纯文字补录，无轨迹）。得到用户明确说“确认”后，再用完全相同参数带 confirmed=true 调一次。";
  }
  const path = await appendRow(env, row, "think-agent", sql);
  void path;
  return `已补录：${date} ${wtype} ${distM ? distM / 1000 + "km" : ""}${dur ? "/" + dur + "s" : ""}（id=${row.id}）。`;
}

/** 仓库内文件路径白名单：只允许相对路径 + 常见字符，挡掉 ../ 与绝对路径。 */
function safeRepoPath(p: string): string | null {
  const path = String(p || "").trim().replace(/^\/+/, "");
  if (!path || path.length > 200) return null;
  if (path.includes("..") || path.includes("//")) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(path)) return null;
  return path;
}

/** list_repo_dir：列仓库目录（只读），用来看 plans/、reports/daily/、data/ 里有什么。 */
export async function toolListDir(env: Env, dir: string): Promise<string> {
  const path = safeRepoPath(dir);
  if (path === null) return "失败：目录路径不合法（用相对路径，如 plans 或 reports/daily）。";
  if (!env.GH_PAT) return "失败：列目录需要 GH_PAT。";
  const r = await ghFetch(`https://api.github.com/repos/${env.REPO}/contents/${path}?ref=main`, {
    headers: ghHeaders(env),
  }).catch(() => null);
  if (!r) return "失败：列目录异常，稍后再试。";
  if (r.status === 404) return `目录 ${path} 不存在（或为空）。`;
  if (!r.ok) return `失败：列目录 ${r.status}。`;
  const list = (await r.json()) as { path?: string; type?: string; size?: number }[];
  if (!Array.isArray(list)) return `失败：${path} 是文件不是目录，用 read_repo_file 读它。`;
  const rows = list.slice(0, 100).map((e) =>
    `${e.type === "dir" ? "📁" : "📄"} ${e.path}${e.type === "file" ? ` (${e.size ?? 0}B)` : ""}`);
  return `${path} 下 ${list.length} 项：\n${rows.join("\n")}`;
}

/** read_repo_file：读仓库里的文本文件（日报、文档、计划、CSV 都行）。 */
export async function toolReadRepoFile(env: Env, file: string, maxChars = 6000): Promise<string> {
  const path = safeRepoPath(file);
  if (path === null) return "失败：文件路径不合法。";
  let mc = Math.trunc(Number(maxChars) || 6000);
  if (!Number.isFinite(mc)) mc = 6000;
  mc = Math.min(20000, Math.max(500, mc));
  const g = await ghGetFile(env, path).catch(() => null);
  if (!g?.text) return `失败：读不到 ${path}（不存在，或是图片等二进制文件）。`;
  const text = g.text.slice(0, mc);
  return `${path}（共 ${g.text.length} 字符，已给前 ${text.length}）：\n${text}`
    + (text.length >= mc ? "\n…（截断，需要更多可提高 max_chars）" : "");
}

/** write_plan：把训练计划写进 plans/（两阶段确认）。只允许写这个目录，绝不碰 data/。 */
export async function toolWritePlan(
  env: Env, file: string, content: string, confirmed: boolean, actor: string, sql?: SqlTag,
): Promise<string> {
  if (!env.GH_PAT) return "失败：写库未授权（缺 GH_PAT）。";
  const path = safeRepoPath(file);
  if (path === null) return "失败：文件路径不合法（示例：plans/2026-11-half-marathon.md）。";
  if (!path.startsWith("plans/") || !path.endsWith(".md")) {
    return "失败：只能写 plans/ 下的 .md 文件，运动数据不在这里改。";
  }
  const body = String(content || "");
  if (body.length < 20) return "失败：内容太短，像是没写完，先把完整计划写出来。";
  if (body.length > 60000) return "失败：内容太长（>6 万字符），拆成多个文件。";
  const cur = await ghGetFile(env, path).catch(() => null);
  if (!confirmed) {
    return `预览（尚未写入）：${cur ? "覆盖" : "新建"} ${path}，共 ${body.length} 字符。`
      + `开头：${body.slice(0, 120).replace(/\n/g, " ")}…\n`
      + "得到用户明确说“确认”后，再用相同 path+content 带 confirmed=true 调一次。";
  }
  await ghPutFile(env, path, body, cur?.sha || "", `bot: plan ${path} via ${actor}`);
  invalidateCache(sql, path);
  return `已${cur ? "更新" : "新建"} ${path}（${body.length} 字符）。以后用户问“我的计划呢”就用 read_repo_file 读它。`;
}

/** stats_workouts 工具：按月/年聚合，替代把几百行全拉回来的查法。 */
export function toolStatsWorkouts(
  all: Row[],
  args: { group_by?: string; type?: string; date_from?: string; date_to?: string },
): string {
  const dateErr = checkDates(args);
  if (dateErr) return dateErr;
  const mode = args.group_by === "year" ? "year" : "month";
  const len = mode === "year" ? 4 : 7;
  const groups = new Map<string, Row[]>();
  for (const r of all) {
    if (args.type && r.type !== args.type) continue;
    if (args.date_from && (r.date || "") < args.date_from) continue;
    if (args.date_to && (r.date || "") > args.date_to) continue;
    const k = (r.date || "").slice(0, len);
    if (!/^\d/.test(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  if (groups.size > 36) {
    return `区间太大（${groups.size} 个${mode === "year" ? "年" : "月"}），请缩小 date_from/date_to 再查。`;
  }
  const out = [...groups.entries()].sort().map(([k, rs]) => {
    const runs = rs.filter((r) => RUN_TYPES.includes(r.type || ""));
    const pd = runs.reduce((a, w) => a + num(w.distance_m), 0);
    const pt = runs.reduce((a, w) => a + num(w.duration_s), 0);
    const hrs = runs.map((w) => num(w.avg_hr)).filter((x) => x);
    return {
      period: k, count: rs.length,
      run_count: runs.length, run_km: +(pd / 1000).toFixed(1),
      avg_pace: pd > 0 && pt > 0 ? fmtPace(pt / (pd / 1000)) : null,
      avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    };
  });
  return JSON.stringify({ total_periods: out.length, rows: out });
}

/** 周一日期（YYYY-MM-DD）作为周 key。 */
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return dateStr.slice(0, 7);
  const bj = new Date(d.getTime() + 8 * 36e5);
  const wd = (bj.getUTCDay() + 6) % 7;
  const mon = new Date(bj.getTime() - wd * 864e5);
  return mon.toISOString().slice(0, 10);
}

/** trends 工具：“有没有进步”看这个——配速/心率/跑量随时间序列，不用翻明细。 */
export function toolTrends(
  all: Row[],
  args: { metric?: string; per?: string; date_from?: string; date_to?: string; limit?: number },
): string {
  const dateErr = checkDates(args);
  if (dateErr) return dateErr;
  const metric = ["pace", "hr", "distance"].includes(args.metric || "") ? args.metric! : "pace";
  const per = args.per === "month" ? "month" : "week";
  let lim = Math.trunc(Number(args.limit) || 26);
  if (!Number.isFinite(lim)) lim = 26;
  lim = Math.min(52, Math.max(4, lim));
  const groups = new Map<string, Row[]>();
  for (const r of all) {
    if (!RUN_TYPES.includes(r.type || "")) continue;
    if (args.date_from && (r.date || "") < args.date_from) continue;
    if (args.date_to && (r.date || "") > args.date_to) continue;
    const k = per === "month" ? (r.date || "").slice(0, 7) : mondayOf(r.date || "");
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const keys = [...groups.keys()].sort().slice(-lim);
  const points = keys.map((k) => {
    const rs = groups.get(k)!;
    const pd = rs.reduce((a, w) => a + num(w.distance_m), 0);
    const pt = rs.reduce((a, w) => a + num(w.duration_s), 0);
    const hrs = rs.map((w) => num(w.avg_hr)).filter((x) => x);
    return {
      period: k, count: rs.length,
      run_km: +(pd / 1000).toFixed(1),
      avg_pace: pd > 0 && pt > 0 ? fmtPace(pt / (pd / 1000)) : null,
      avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    };
  });
  const pick = (p: (typeof points)[number]) =>
    metric === "hr" ? p.avg_hr : metric === "distance" ? p.run_km : p.avg_pace;
  const vals = points.map(pick).filter((v) => v != null) as (string | number)[];
  return JSON.stringify({ metric, per, points, note: `共${points.length}个点，数值列见 ${metric}（配速越小越快）` , values: vals });
}

/** records 工具：PB 榜——最长单次、最快配速、月最高跑量、累计。 */
export function toolRecords(all: Row[]): string {
  const runs = all.filter((r) => RUN_TYPES.includes(r.type || "") && num(r.distance_m) > 0);
  if (!runs.length) return "库里还没有跑步记录。";
  const byDist = [...runs].sort((a, b) => num(b.distance_m) - num(a.distance_m))[0];
  const paced = runs
    .map((r) => ({ r, p: num(r.duration_s) > 0 ? num(r.duration_s) / (num(r.distance_m) / 1000) : 0 }))
    .filter((x) => x.p > 0 && num(x.r.distance_m) >= 3000)
    .sort((a, b) => a.p - b.p)[0];
  const byMonth = new Map<string, number>();
  for (const r of runs) {
    const k = (r.date || "").slice(0, 7);
    byMonth.set(k, (byMonth.get(k) || 0) + num(r.distance_m));
  }
  const bestMonth = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0];
  const totalKm = runs.reduce((a, w) => a + num(w.distance_m), 0) / 1000;
  return JSON.stringify({
    longest_run: { date: byDist.date, km: +(num(byDist.distance_m) / 1000).toFixed(2) },
    fastest_pace_3k: paced
      ? { date: paced.r.date, km: +(num(paced.r.distance_m) / 1000).toFixed(2), pace: fmtPace(paced.p) }
      : null,
    best_month: bestMonth ? { month: bestMonth[0], km: +(bestMonth[1] / 1000).toFixed(1) } : null,
    total_runs: runs.length, total_km: +totalKm.toFixed(1),
  });
}

function summarizeSpan(all: Row[], from?: string, to?: string) {
  const rs = all.filter((r) =>
    (!from || (r.date || "") >= from) && (!to || (r.date || "") <= to));
  const runs = rs.filter((r) => RUN_TYPES.includes(r.type || ""));
  const pd = runs.reduce((a, w) => a + num(w.distance_m), 0);
  const pt = runs.reduce((a, w) => a + num(w.duration_s), 0);
  const hrs = runs.map((w) => num(w.avg_hr)).filter((x) => x);
  return {
    count: rs.length, run_count: runs.length, run_km: +(pd / 1000).toFixed(1),
    avg_pace_s: pd > 0 && pt > 0 ? Math.round(pt / (pd / 1000)) : null,
    avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
  };
}

/** compare 工具：两段时间对照（本月vs上月），直接给变化百分比。 */
export function toolCompare(
  all: Row[],
  args: { a_from?: string; a_to?: string; b_from?: string; b_to?: string },
): string {
  const dateErr = checkDates({ date_from: args.a_from, date_to: args.a_to })
    || checkDates({ date_from: args.b_from, date_to: args.b_to });
  if (dateErr) return dateErr;
  if (!args.a_from || !args.a_to || !args.b_from || !args.b_to) {
    return "失败：要给齐两段区间的起止（a_from/a_to/b_from/b_to，YYYY-MM-DD），如本月和上月。";
  }
  const a = summarizeSpan(all, args.a_from, args.a_to);
  const b = summarizeSpan(all, args.b_from, args.b_to);
  const delta = (x: number | null, y: number | null) =>
    x == null || y == null || y === 0 ? null : +(((x - y) / y) * 100).toFixed(1);
  return JSON.stringify({
    a: { range: `${args.a_from}~${args.a_to}`, ...a },
    b: { range: `${args.b_from}~${args.b_to}`, ...b },
    delta_pct: {
      run_km: delta(a.run_km, b.run_km),
      run_count: delta(a.run_count, b.run_count),
      avg_pace_s: delta(a.avg_pace_s, b.avg_pace_s),
      avg_hr: delta(a.avg_hr, b.avg_hr),
    },
    note: "配速delta为负=变快（秒数减少），心率delta为正=同强度更累，供教练解读",
  });
}

/** streaks 工具：连击——当前连续天数、历史最长、活跃天数。 */
export function toolStreaks(all: Row[]): string {
  const days = [...new Set(all.map((r) => r.date || "").filter(Boolean))].sort();
  if (!days.length) return "库里还没有记录。";
  const today = new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
  const set = new Set(days);
  let cur = 0;
  let d = today;
  if (!set.has(d)) {
    d = new Date(Date.parse(`${d}T12:00:00+08:00`) - 864e5).toISOString().slice(0, 10);
  }
  while (set.has(d)) {
    cur++;
    d = new Date(Date.parse(`${d}T12:00:00+08:00`) - 864e5).toISOString().slice(0, 10);
  }
  let best = 0, run = 1;
  for (let i = 1; i < days.length; i++) {
    const gap = Math.round((Date.parse(`${days[i]}T12:00:00+08:00`) - Date.parse(`${days[i - 1]}T12:00:00+08:00`)) / 864e5);
    run = gap === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  best = Math.max(best, run, cur);
  return JSON.stringify({ today, current_streak_days: cur, longest_streak_days: best, active_days: days.length });
}
