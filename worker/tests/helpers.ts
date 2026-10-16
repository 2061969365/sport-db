// 测试替身：mock 掉 GitHub Contents API 与 DO 的 sql 标签模板。
// 用法：import { makeEnv, makeSql, makeStore, installFetch } from "./helpers.ts";
export const b64e = (s) => Buffer.from(s, "utf-8").toString("base64");
export const b64d = (b) => Buffer.from(b, "base64").toString("utf-8");

/** 内存版"仓库"：path -> {text, sha} */
export function makeStore(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    has: (p) => store.has(p),
    text: (p) => (store.get(p) || {}).text || "",
    keys: () => [...store.keys()],
    seed: (p, text, sha = "s0") => store.set(p, { text, sha }),
  };
}

/** 内存版 DO SQLite：只实现项目用到的表结构与语句形状 */
export function makeSql() {
  const mem = new Map();
  const calls = [];
  const sql = (strings, ...values) => {
    const q = Array.isArray(strings) ? strings.join("?") : String(strings);
    calls.push(q.split(" ").slice(0, 3).join(" "));
    if (q.startsWith("CREATE")) return [];
    if (q.startsWith("SELECT")) {
      const row = mem.get(values[0]);
      return row ? [{ ...row }] : [];
    }
    if (q.startsWith("INSERT OR REPLACE")) {
      mem.set(values[0], { text: values[1], sha: values[2], updated_at: values[3], at: values[3] });
      return [];
    }
    if (q.startsWith("DELETE")) {
      if (values.length) mem.delete(values[0]);
      return [];
    }
    if (q.startsWith("UPDATE")) return [];
    throw new Error("unhandled sql: " + q.slice(0, 60));
  };
  sql.mem = mem;
  sql.calls = calls;
  return sql;
}

/** 装一个假的 fetch，统计 GET/PUT/DELETE 次数，支持 sha 冲突模拟。 */
export function installFetch(store, opts = {}) {
  const stats = { gets: 0, puts: 0, deletes: 0, paths: [], reviewList: opts.reviewList || [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    stats.paths.push(u);
    if (u.includes("api.github.com/repos/") && u.includes("/contents/review?")) {
      return Response.json(stats.reviewList);
    }
    const m = u.match(/contents\/(.+?)(\?.*)?$/);
    if (!m) throw new Error("unexpected fetch: " + u);
    const path = decodeURIComponent(m[1]);
    const method = init.method || "GET";
    if (method === "GET") {
      stats.gets++;
      if (!store.has(path)) return new Response("not found", { status: 404 });
      const f = store.store.get(path);
      return Response.json({ type: "file", content: b64e(f.text), sha: f.sha });
    }
    if (method === "PUT") {
      stats.puts++;
      const body = JSON.parse(init.body);
      const cur = store.store.get(path);
      if (cur && body.sha !== cur.sha) return new Response("conflict", { status: 409 });
      store.store.set(path, { text: b64d(body.content), sha: "s9" });
      return Response.json({ content: { sha: "s9" } });
    }
    if (method === "DELETE") {
      stats.deletes++;
      store.store.delete(path);
      return Response.json({});
    }
    throw new Error("unhandled method " + method);
  };
  return stats;
}

export function makeEnv(extra = {}) {
  return { REPO: "owner/repo", GH_PAT: "test-pat", ...extra };
}

/** 造一行 workouts 记录（列名与真实 CSV 一致） */
export function row(over = {}) {
  const base = {
    id: "mi-1000-outdoor_running-abc12345",
    date: "2026-10-13",
    start_utc: "1000",
    type: "outdoor_running",
    category: "outdoor_running",
    distance_m: "5009",
    duration_s: "1620",
    avg_pace_s: "323",
    avg_hr: "150",
    source: "mi_backup",
    _year: "2026",
  };
  return { ...base, ...over };
}
