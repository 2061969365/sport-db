// 联网与时间工具：当前时间、天气、网页搜索、抓网页（curl 的安全替代）。
// 全部免 Key（open-meteo 天气/地理编码、DuckDuckGo 搜索）；可选升级：
//   TAVILY_API_KEY  → 用 Tavily 搜索（返回干净 JSON，比解析 HTML 稳）
//   HOME_CITY       → 默认城市（不填就让模型问用户）
import type { Env } from "./env";

const UA = "Mozilla/5.0 (compatible; sport-db-bot/1.0)";
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 300_000;

function bjNow(): Date {
  return new Date(Date.now() + 8 * 36e5);
}

function withTimeout(ms = TIMEOUT_MS): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

/** 按字节上限读取，防大文件把 isolate 撑爆。 */
async function readCapped(res: Response, cap = MAX_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, cap);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) {
        await reader.cancel().catch(() => null);
        break;
      }
    }
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    if (off >= buf.length) break;
    const take = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder("utf-8").decode(buf);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/** 北京时间 + 星期 + ISO 周，支持前后偏移天数（算「下周六」用）。 */
export function toolCurrentTime(offsetDays = 0): string {
  const d = Math.trunc(Number(offsetDays) || 0);
  const base = new Date(Date.now() + d * 864e5 + 8 * 36e5);
  const iso = base.toISOString();
  const date = iso.slice(0, 10);
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][base.getUTCDay()];
  // ISO 周号
  const t = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThu.getTime()) / 864e5 - 3) / 7);
  const rel = d === 0 ? "今天" : d > 0 ? `${d} 天后` : `${-d} 天前`;
  return `${rel}：${date} ${wd} ${iso.slice(11, 16)}（北京时间），ISO 第 ${week} 周。`
    + `本月剩 ${new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate() - base.getUTCDate()} 天。`;
}

/** 天气：默认用 HOME_CITY / HOME_LAT+HOME_LON，也可传城市名现场地理编码。 */
export async function toolWeather(
  env: Env, args: { city?: string; days?: number },
): Promise<string> {
  let days = Math.trunc(Number(args.days) || 3);
  if (!Number.isFinite(days)) days = 3;
  days = Math.min(7, Math.max(1, days));
  let lat = "", lon = "", place = "";
  const city = (args.city || env.HOME_CITY || "").trim();
  if (city) {
    const g = withTimeout();
    try {
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
        { headers: { "User-Agent": UA }, signal: g.signal },
      );
      const j = (await r.json()) as { results?: { name?: string; latitude?: number; longitude?: number; country?: string; admin1?: string }[] };
      const hit = j.results?.[0];
      if (!hit) return `失败：没找到城市「${city}」，换个写法（如「杭州」或「Hangzhou」）再试。`;
      lat = String(hit.latitude ?? "");
      lon = String(hit.longitude ?? "");
      place = [hit.name, hit.admin1, hit.country].filter(Boolean).join("·");
    } catch (e) {
      return `失败：城市查询异常（${(e as Error).message}），稍后再试或直接给经纬度。`;
    } finally {
      g.done();
    }
  } else if (env.HOME_LAT && env.HOME_LON) {
    lat = env.HOME_LAT;
    lon = env.HOME_LON;
    place = "已配置的常驻位置";
  } else {
    return "失败：不知道你在哪个城市。让用户说一句城市名（如「上海」），或传 city 参数再调一次。";
  }
  const t = withTimeout();
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}`
      + `&longitude=${encodeURIComponent(lon)}`
      + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max"
      + `&timezone=Asia%2FShanghai&forecast_days=${days}`,
      { headers: { "User-Agent": UA }, signal: t.signal },
    );
    if (!r.ok) return `失败：天气接口 ${r.status}。`;
    const j = (await r.json()) as {
      daily?: {
        time?: string[]; weather_code?: number[]; temperature_2m_max?: number[];
        temperature_2m_min?: number[]; precipitation_sum?: number[];
        precipitation_probability_max?: number[]; wind_speed_10m_max?: number[];
      };
    };
    const dd = j.daily;
    if (!dd?.time?.length) return "失败：天气接口没返回日预报。";
    const W = (c: number) =>
      c === 0 ? "晴" : c <= 3 ? "多云" : c <= 48 ? "雾" : c <= 67 ? "雨" : c <= 77 ? "雪" : c <= 82 ? "阵雨" : "雷雨";
    const lines = dd.time.map((day, i) => {
      const lo = dd.temperature_2m_min?.[i];
      const hi = dd.temperature_2m_max?.[i];
      const pop = dd.precipitation_probability_max?.[i];
      const pr = dd.precipitation_sum?.[i];
      const wind = dd.wind_speed_10m_max?.[i];
      return `${day} ${W(dd.weather_code?.[i] ?? 0)} ${lo}~${hi}℃`
        + `，降水${pr ?? 0}mm(概率${pop ?? 0}%)，最大风速${wind ?? "-"}km/h`;
    });
    return `${place || `${lat},${lon}`} 未来 ${days} 天：\n` + lines.join("\n")
      + "\n（数据源 open-meteo；安排户外跑时看降水概率和风速）";
  } catch (e) {
    return `失败：天气查询异常（${(e as Error).message}），稍后再试。`;
  } finally {
    t.done();
  }
}

/** 搜索：Tavily（配了 key）→ DuckDuckGo → Wikipedia（免 Key 兜底）。
 *
 * 实测（2026-10-16，从 Cloudflare 出口发起）：
 *   lite.duckduckgo.com 返回反爬挑战页、mojeek 返回验证码页 —— 免 Key 的通用搜索
 *   基本都被拦；Wikimedia API 正常。所以通用搜索想稳，得配 TAVILY_API_KEY（免费额度足够个人用）。
 * 这里仍然逐级降级，并在结果里说明来源，绝不让模型把「没搜到」演成「搜到了」。 */
export async function toolWebSearch(
  env: Env, args: { query?: string; limit?: number },
): Promise<string> {
  const q = (args.query || "").trim();
  if (!q) return "失败：query 不能为空。";
  let limit = Math.trunc(Number(args.limit) || 5);
  if (!Number.isFinite(limit)) limit = 5;
  limit = Math.min(8, Math.max(1, limit));
  const notes: string[] = [];

  if (env.TAVILY_API_KEY) {
    const got = await searchTavily(env, q, limit);
    if (typeof got === "string") return got;
    notes.push("Tavily 没返回结果");
  }

  const ddg = await searchDdg(q, limit);
  if (typeof ddg === "string") return ddg;
  notes.push(ddg.reason);

  const wiki = await searchWikipedia(q, limit);
  if (typeof wiki === "string") {
    return wiki + `\n（说明：通用搜索被反爬拦了，上面是维基百科的结果，不是全网搜索；`
      + `要全网搜索请让管理员配置 TAVILY_API_KEY。${notes.join("；")}）`;
  }
  notes.push(wiki.reason);
  return `失败：联网搜索没成功（${notes.join("；")}）。`
    + "不要编造搜索结果，就用你已有知识回答，并如实告诉用户“这次没联网搜到”。";
}

/** Tavily 搜索（需 key）。成功返回文本，未配置/无结果返回 null。 */
async function searchTavily(env: Env, q: string, limit: number): Promise<string | null> {
  const t = withTimeout(15_000);
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY, query: q, max_results: limit, search_depth: "basic",
      }),
      signal: t.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    const rows = (j.results ?? []).map((x) => `- ${x.title}\n  ${x.url}\n  ${(x.content ?? "").slice(0, 300)}`);
    return rows.length ? `“${q}”结果（Tavily · 全网搜索）：\n${rows.join("\n")}` : null;
  } catch {
    return null;
  } finally {
    t.done();
  }
}

type SearchMiss = { reason: string };

/** DuckDuckGo lite：多半会被反爬拦，拦了就返回原因交给下一级。 */
async function searchDdg(q: string, limit: number): Promise<string | SearchMiss> {
  const t = withTimeout(15_000);
  try {
    const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: t.signal,
    });
    if (!r.ok) return { reason: `DDG ${r.status}` };
    const html = await readCapped(r, 200_000);
    if (/bots use DuckDuckGo|complete the following challenge|anomaly/i.test(html)) {
      return { reason: "DDG 返回反爬挑战页" };
    }
    const items: { title: string; url: string; snippet: string }[] = [];
    const re = /<a[^>]*href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && items.length < limit) {
      let url = decodeEntities(m[1]);
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          url = decodeURIComponent(uddg[1]);
        } catch { /* 保留原样 */ }
      }
      const rest = html.slice(re.lastIndex, re.lastIndex + 1500);
      const sm = rest.match(/class='result-snippet'>([\s\S]*?)<\/td>/);
      items.push({ title: stripTags(m[2]), url, snippet: sm ? stripTags(sm[1]) : "" });
    }
    if (!items.length) return { reason: "DDG 页面结构变了，解析不出结果" };
    return `“${q}”结果（DuckDuckGo）：\n`
      + items.map((x) => `- ${x.title}\n  ${x.url}\n  ${x.snippet.slice(0, 260)}`).join("\n");
  } catch (e) {
    return { reason: `DDG 异常 ${(e as Error).message}` };
  } finally {
    t.done();
  }
}

/** Wikipedia 检索（免 Key、程序化 API，实测从 Worker 可达）。 */
async function searchWikipedia(q: string, limit: number): Promise<string | SearchMiss> {
  const t = withTimeout(15_000);
  try {
    const r = await fetch(
      "https://zh.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json"
      + `&srlimit=${limit}&srsearch=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": UA }, signal: t.signal },
    );
    if (!r.ok) return { reason: `Wikipedia ${r.status}` };
    const j = (await r.json()) as {
      query?: { search?: { title?: string; snippet?: string; size?: number }[] };
    };
    const rows = (j.query?.search ?? []).filter((x) => x.title);
    if (!rows.length) return { reason: "Wikipedia 也没有相关条目" };
    return `“${q}”检索结果（维基百科）：\n`
      + rows.map((x) => `- ${x.title}\n  https://zh.wikipedia.org/wiki/${encodeURIComponent(x.title || "")}\n`
        + `  ${stripTags(x.snippet ?? "").slice(0, 260)}`).join("\n");
  } catch (e) {
    return { reason: `Wikipedia 异常 ${(e as Error).message}` };
  } finally {
    t.done();
  }
}

const BLOCKED_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[?::1\]?$)|\.(internal|local|localhost)$/i;

/** 抓网页（curl 的安全替代）：只 http(s)、禁内网、限大小与时长、HTML 转纯文本。 */
export async function toolFetchUrl(
  env: Env, args: { url?: string; max_chars?: number },
): Promise<string> {
  void env;
  const raw = (args.url || "").trim();
  if (!raw) return "失败：url 不能为空。";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `失败：url 不合法（${raw}）。要带协议，如 https://example.com/。`;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return "失败：只支持 http/https 抓取。";
  }
  if (BLOCKED_HOST.test(u.hostname)) {
    return "失败：内网/本机地址不允许抓取。";
  }
  let mc = Math.trunc(Number(args.max_chars) || 4000);
  if (!Number.isFinite(mc)) mc = 4000;
  mc = Math.min(8000, Math.max(500, mc));

  // 手动跟最多 3 跳，每跳都重新校验（防用跳转绕过内网限制）
  let cur = u;
  for (let hop = 0; hop < 4; hop++) {
    const t = withTimeout();
    try {
      const r = await fetch(cur.toString(), {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
        redirect: "manual",
        signal: t.signal,
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return `失败：${r.status} 跳转但没给 location。`;
        const next = new URL(loc, cur);
        if (BLOCKED_HOST.test(next.hostname) || !/^https?:$/.test(next.protocol)) {
          return "失败：跳转到了不允许的地址。";
        }
        cur = next;
        continue;
      }
      if (!r.ok) return `失败：抓取返回 ${r.status}。`;
      const ct = r.headers.get("content-type") || "";
      const body = await readCapped(r, 250_000);
      const text = /json|text\/plain|csv/.test(ct) ? body : stripTags(body);
      const out = text.slice(0, mc);
      return `来自 ${cur.href}（${ct || "未知类型"}，共 ${body.length} 字符，已截取前 ${out.length}）：\n${out}`
        + (out.length >= mc ? "\n…（截断，需要更多内容可提高 max_chars）" : "");
    } catch (e) {
      return `失败：抓取异常（${(e as Error).message}）。`;
    } finally {
      t.done();
    }
  }
  return "失败：跳转次数过多（>3）。";
}
