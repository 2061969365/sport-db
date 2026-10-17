// 运行时可切换的模型配置：网关 URL + 模型名 + 是否用原生流式。
//
// 为什么放仓里：模型是**全局设置**（不分用户/通道），存仓里各通道共享、换账号也在、
// 你自己能打开看和改（config/model.json）。DO 里再放一份 30 秒缓存，省 GitHub 调用。
//
// 安全：不存任何密钥（免 Key 网关），所以放公开仓没问题。
import type { Env } from "./env.ts";
import { ghGetFile, ghPutFile, type SqlTag } from "./github.ts";

export const MODELCFG_PATH = "config/model.json";
const CACHE_TTL_MS = 30_000;

export interface ModelCfg {
  /** 网关 chat/completions 地址 */
  endpoint: string;
  /** 模型名 */
  model: string;
  /** 是否走原生流式（默认 false：网关流式坏了，走非流式+合成 SSE） */
  streaming: boolean;
}

/** wrangler.toml 里的默认值。 */
export function defaultCfg(env: Env): ModelCfg {
  return {
    endpoint: env.VISION_ENDPOINT,
    model: env.VISION_MODEL || "mimo-v2.6-flash-free",
    streaming: String(env.MODEL_STREAMING || "off").toLowerCase() === "on",
  };
}

export interface LoadedCfg {
  cfg: ModelCfg;
  source: "repo" | "env";
  savedAt?: number;
  by?: string;
}

function normalize(raw: unknown, fallback: ModelCfg): ModelCfg | null {
  const o = raw as Partial<ModelCfg> | null;
  if (!o || typeof o !== "object") return null;
  const endpoint = String(o.endpoint || "").trim() || fallback.endpoint;
  const model = String(o.model || "").trim() || fallback.model;
  if (!/^https?:\/\//.test(endpoint)) return null;
  return { endpoint, model, streaming: o.streaming === undefined ? fallback.streaming : !!o.streaming };
}

/** 读配置：仓里有就用仓里的，否则用 wrangler.toml 的默认值。 */
export async function loadCfg(env: Env, sql?: SqlTag, force = false): Promise<LoadedCfg> {
  const fallback = defaultCfg(env);
  if (sql && !force) {
    try {
      sql`CREATE TABLE IF NOT EXISTS cfg_cache (path TEXT PRIMARY KEY, text TEXT, updated_at INTEGER)`;
      const rows = sql`SELECT text, updated_at FROM cfg_cache WHERE path = ${MODELCFG_PATH}` as
        { text: string; updated_at: number }[];
      if (rows.length && Date.now() - rows[0].updated_at < CACHE_TTL_MS) {
        try {
          const j = JSON.parse(rows[0].text || "{}") as { cfg?: unknown; source?: string; savedAt?: number; by?: string };
          const cfg = normalize(j.cfg, fallback);
          if (cfg) {
            return { cfg, source: (j.source as "repo" | "env") || "repo", savedAt: j.savedAt, by: j.by };
          }
        } catch { /* 缓存坏了就当没有 */ }
      }
    } catch { /* 缓存不可用不影响 */ }
  }

  const g = await ghGetFile(env, MODELCFG_PATH).catch(() => null);
  let out: LoadedCfg;
  if (g?.text) {
    try {
      const j = JSON.parse(g.text) as Record<string, unknown>;
      const cfg = normalize(j, fallback);
      out = cfg
        ? { cfg, source: "repo", savedAt: Number(j.savedAt) || undefined, by: String(j.by || "") || undefined }
        : { cfg: fallback, source: "env" };
    } catch {
      out = { cfg: fallback, source: "env" };
    }
  } else {
    out = { cfg: fallback, source: "env" };
  }
  if (sql) {
    try {
      sql`INSERT OR REPLACE INTO cfg_cache(path, text, updated_at) VALUES (${MODELCFG_PATH}, ${JSON.stringify(out)}, ${Date.now()})`;
    } catch { /* 忽略 */ }
  }
  return out;
}

/** 写配置（部分字段合并），返回合并后的完整配置。 */
export async function saveCfg(
  env: Env, sql: SqlTag | undefined, patch: Partial<ModelCfg>, by: string,
): Promise<LoadedCfg> {
  const cur = await loadCfg(env, sql, true);
  const merged: ModelCfg = {
    endpoint: String(patch.endpoint ?? cur.cfg.endpoint).trim(),
    model: String(patch.model ?? cur.cfg.model).trim(),
    streaming: patch.streaming === undefined ? cur.cfg.streaming : !!patch.streaming,
  };
  const payload = { ...merged, savedAt: Date.now(), by };
  const old = await ghGetFile(env, MODELCFG_PATH).catch(() => null);
  await ghPutFile(env, MODELCFG_PATH, JSON.stringify(payload, null, 1), old?.sha || "",
    `bot: 模型配置改为 ${merged.model}@${new URL(merged.endpoint).host}`);
  if (sql) {
    try {
      sql`DELETE FROM cfg_cache WHERE path = ${MODELCFG_PATH}`;
    } catch { /* 忽略 */ }
  }
  return { cfg: merged, source: "repo", savedAt: payload.savedAt, by };
}

/** 恢复成 wrangler.toml 的默认值（删掉仓里的覆盖文件）。 */
export async function resetCfg(env: Env, sql?: SqlTag): Promise<ModelCfg> {
  const g = await ghGetFile(env, MODELCFG_PATH).catch(() => null);
  if (g?.sha) {
    await fetch(`https://api.github.com/repos/${env.REPO}/contents/${MODELCFG_PATH}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sport-db-agent/2.0",
        Authorization: `Bearer ${env.GH_PAT}`,
      },
      body: JSON.stringify({ message: "bot: 模型配置恢复默认", sha: g.sha, branch: "main" }),
    }).catch(() => null);
  }
  if (sql) {
    try {
      sql`DELETE FROM cfg_cache WHERE path = ${MODELCFG_PATH}`;
    } catch { /* 忽略 */ }
  }
  return defaultCfg(env);
}

const EP_RE = /^https?:\/\/[-A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%]+$/;
const MODEL_RE = /^[A-Za-z0-9._:\/-]{2,80}$/;

/** 归一化网关地址：允许只填到域名，自动补 /v1/chat/completions。 */
export function normalizeEndpoint(input: string): string | null {
  const s = String(input || "").trim();
  if (!s) return null;
  const withProto = /^https?:\/\//.test(s) ? s : `https://${s}`;
  if (!EP_RE.test(withProto)) return null;
  if (/\/chat\/completions\/?$/.test(withProto)) return withProto.replace(/\/$/, "");
  if (/\/v1\/?$/.test(withProto)) return `${withProto.replace(/\/$/, "")}/chat/completions`;
  return `${withProto.replace(/\/$/, "")}/v1/chat/completions`;
}

export function validModelId(id: string): boolean {
  return MODEL_RE.test(String(id || "").trim());
}

/** 解析 /model 命令。纯函数，便于测试。 */
export type ModelCmd =
  | { action: "show" } | { action: "list" } | { action: "test" } | { action: "reset" }
  | { action: "set-model"; model: string }
  | { action: "set-url"; endpoint: string }
  | { action: "streaming"; on: boolean }
  | { action: "help" };

export function parseModelCommand(text: string): ModelCmd {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  // parts[0] 是 /model 本身
  const sub = (parts[1] || "").toLowerCase();
  if (!sub) return { action: "show" };
  if (sub === "list" || sub === "ls" || sub === "列表") return { action: "list" };
  if (sub === "test" || sub === "测试") return { action: "test" };
  if (sub === "reset" || sub === "default" || sub === "重置") return { action: "reset" };
  if (sub === "url" || sub === "endpoint" || sub === "网关") {
    return parts[2] ? { action: "set-url", endpoint: parts[2] } : { action: "help" };
  }
  if (sub === "streaming" || sub === "流式") {
    const v = (parts[2] || "").toLowerCase();
    if (v === "on" || v === "off") return { action: "streaming", on: v === "on" };
    return { action: "help" };
  }
  if (sub === "help" || sub === "帮助" || sub === "?") return { action: "help" };
  return { action: "set-model", model: parts[1] };
}

/** 列网关可用模型（免 Key，直接 GET /v1/models）。 */
export async function listGatewayModels(cfg: ModelCfg): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const base = cfg.endpoint.replace(/\/chat\/completions\/?$/, "");
  try {
    const r = await fetch(`${base}/models`, { headers: { "User-Agent": "sport-db/1.0" } });
    if (!r.ok) return { ok: false, models: [], error: `HTTP ${r.status}` };
    const j = (await r.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
    const ids = (j.data || j.models || []).map((x) => String(x.id || "")).filter(Boolean);
    const free = ids.filter((m) => /free/i.test(m));
    return { ok: true, models: (free.length ? free : ids).sort() };
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message.slice(0, 100) };
  }
}

export interface ProbeResult {
  ok: boolean;
  lines: string[];
}

/** 三项体检：对话 / 工具调用 / 读图（读图需要一张可访问的图）。 */
export async function probeCfg(cfg: ModelCfg, imgUrl?: string): Promise<ProbeResult> {
  const lines: string[] = [];
  let ok = true;

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "sport-db/1.0" },
      body: JSON.stringify({ model: cfg.model, stream: false, ...body }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 100)}`);
    return JSON.parse(text) as {
      choices?: { message?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }[];
      error?: { message?: string };
      response?: { error?: { message?: string } };
    };
  };

  try {
    const j = await post({ messages: [{ role: "user", content: "只回两个字：在的" }], max_tokens: 64 });
    const c = (j.choices?.[0]?.message?.content || "").trim();
    if (c) lines.push(`✅ 对话通（回：${c.slice(0, 20)}）`);
    else { lines.push("❌ 对话通了但回复为空"); ok = false; }
  } catch (e) {
    lines.push(`❌ 对话失败：${(e as Error).message.slice(0, 120)}`);
    ok = false;
  }

  try {
    const j = await post({
      messages: [{ role: "user", content: "查一下我近30天跑了多少" }],
      tools: [{ type: "function", function: {
        name: "get_summary", description: "查运动画像",
        parameters: { type: "object", properties: { days: { type: "integer" } }, required: ["days"] } } }],
    });
    const tc = j.choices?.[0]?.message?.tool_calls;
    if (tc && tc.length) lines.push("✅ 工具调用正常");
    else { lines.push("❌ 不支持工具调用（这个模型不能用来当 agent）"); ok = false; }
  } catch (e) {
    lines.push(`❌ 工具调用失败：${(e as Error).message.slice(0, 120)}`);
    ok = false;
  }

  if (imgUrl) {
    try {
      const j = await post({ messages: [{ role: "user", content: [
        { type: "text", text: "这张运动截图的距离是多少？只回 JSON {\"distance_km\":..}" },
        { type: "image_url", image_url: { url: imgUrl } }] }] });
      const c = (j.choices?.[0]?.message?.content || "");
      if (/distance|km|\d/.test(c)) lines.push(`✅ 读图正常（${c.replace(/\s+/g, " ").slice(0, 40)}）`);
      else { lines.push("⚠️ 读图回复可疑（收图可能不准）"); }
    } catch (e) {
      lines.push(`⚠️ 读图失败：${(e as Error).message.slice(0, 100)}（收图会受影响）`);
    }
  }
  return { ok, lines };
}

/** 给人看的一行配置摘要。 */
export function formatCfg(loaded: LoadedCfg, extra?: { imageUrl?: string }): string {
  const c = loaded.cfg;
  const host = (() => {
    try {
      return new URL(c.endpoint).host;
    } catch {
      return c.endpoint;
    }
  })();
  return [
    `网关：${host}`,
    `路径：${c.endpoint.replace(/^https?:\/\/[^/]+/, "")}`,
    `模型：${c.model}`,
    `流式：${c.streaming ? "原生流式" : "非流式+合成SSE（网关流式坏了，默认）"}`,
    `来源：${loaded.source === "repo" ? `仓里 config/model.json（${loaded.by || "未知"} 改）` : "wrangler.toml 默认值"}`,
    extra?.imageUrl ? `读图探针：${extra.imageUrl.split("/").slice(-3).join("/")}` : "",
  ].filter(Boolean).join("\n");
}
