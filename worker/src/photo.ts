// TG 收图：photo 取最大尺寸 / document 限 image/*。
// 流程：getFile 下载 → 提交 images/年/月/日-tg<mid>.jpg → vision 读 raw 地址
// （?v=sha 破缓存）→ confidence 路由：≥0.8 追加 workouts 当年 CSV；
// 低的进 review。附言由调用方再跑一轮 agent 一并回答。
import type { Env } from "./env";
import { isPaused } from "./pause.ts";
import type { VisionRec } from "./github.ts";
import {
  WORKOUT_TYPES, appendRow, ghDeleteFile, ghGetFile, ghPutFile, putBinaryFile, toWorkoutRow, toolListReview,
} from "./github.ts";
import { loadCfg } from "./modelcfg.ts";
import { sseText } from "./gateway.ts";

/** 浏览器 UA：该网关对非浏览器客户端会回 403 error 1010（Cloudflare 客户端指纹拦截）。 */
export const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** 收图用的运行时模型配置（/model 切了模型，收图也跟着走）。 */
async function runtimeModelCfg(env: Env): Promise<{ endpoint: string; model: string }> {
  try {
    const loaded = await loadCfg(env);
    return { endpoint: loaded.cfg.endpoint, model: loaded.cfg.model };
  } catch {
    return { endpoint: env.VISION_ENDPOINT, model: env.VISION_MODEL };
  }
}

export const REVIEW_THRESHOLD = 0.8;
const MAX_BYTES = 12 * 1024 * 1024;

const VISION_PROMPT =
  "你是运动截图解析器。看这张运动 App 截图（小米运动健康 / Keep / 悦跑圈版式兼容），\n"
  + "提取本次运动数据，只返回下面 JSON，不要多余文字：\n"
  + `{"type": "<${WORKOUT_TYPES.join("|")}>", "distance_km": <数字或null>, "duration_s": <秒数或null>,\n`
  + ' "avg_pace_s_per_km": <秒/公里或null>, "avg_hr": <次/分或null>,\n'
  + ' "calories": <千卡或null>, "steps": <步数或null>, "cadence": <步频或null>,\n'
  + ' "start_time": "<YYYY-MM-DD HH:MM:SS +08:00 或null>",\n'
  + ' "confidence": <0到1，看不清/遮挡/模糊就压低>}\n'
  + "规则：type 必须从候选里选最接近的；duration “1:23:45”/“86:20”换算成秒；\n"
  + "配速 5分32秒换算成 332；看不清的字段填 null 并降低 confidence。\n"
  + "截图上显示的时间一般是结束时间：start_time = 结束时间 - duration_s，"
  + "按 “%Y-%m-%d %H:%M:%S +08:00”格式回；无时间显示则填 null。";

interface TgMsg {
  photo?: { file_id?: string }[];
  document?: { file_id?: string; mime_type?: string };
  caption?: string;
}

/** 挑图：照片取最大尺寸；文件形式限 image/*。返回 null 表示没图。 */
export function pickImage(msg: TgMsg): { fileId: string; isOrig: boolean } | null {
  const photos = msg.photo ?? [];
  if (photos.length) {
    const id = photos[photos.length - 1]?.file_id ?? "";
    return id ? { fileId: id, isOrig: false } : null;
  }
  const doc = msg.document;
  if (doc && (doc.mime_type || "").startsWith("image/") && doc.file_id) {
    return { fileId: doc.file_id, isOrig: true };
  }
  return null;
}

function bjNow(): Date {
  return new Date(Date.now() + 8 * 36e5);
}

/** getFile 拿下载地址并读回字节（含 12MB 上限）。 */
export async function downloadTgFile(env: Env, fileId: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const info = (await (await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  })).json()) as { ok?: boolean; result?: { file_path?: string } };
  const path = info.result?.file_path || "";
  if (!info.ok || !path) throw new Error("getFile 无 file_path");
  const r = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${path}`);
  if (!r.ok) throw new Error(`下载原图失败 ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error(`图太大（${(buf.byteLength / 1048576).toFixed(1)}MB），请压到12MB内重发`);
  const ext = (path.split(".").pop() || "jpg").toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { bytes: buf, mime };
}

/** 等图片公网可访问再交给 vision。
 *  踩过的坑：图刚 commit 完就调 vision，raw.githubusercontent.com 还没生效，
 *  网关那边抓不到图 → 模型回「我看不到截图」→ 明明识别服务没坏却记成失败。
 *  这里先自己确认能拿到 200，最多等 ~20 秒。 */
export async function waitForImage(env: Env, url: string, tries = 7, gapMs = 3000): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": "sport-db/1.0" } });
      if (r.ok) return true;
      // 某些 CDN 不认 HEAD：退化成只取前一小段
      const g = await fetch(url, { headers: { "User-Agent": "sport-db/1.0", Range: "bytes=0-64" } });
      if (g.ok || g.status === 206) return true;
    } catch { /* 继续等 */ }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}

/** 免费网关限流时按模型换着试：不同模型额度独立，一个 429 不代表全都不可用。
 *  这几个都实测能读运动截图（2026-10-28 在 zen 网关上验过）。 */
export const VISION_FALLBACK_MODELS = ["deepseek-v4.1-flash-free", "nemotron-3.5-super-vl-free"];

export interface VisionOpts {
  tries?: number;
  /** 候选模型链，默认 [主模型, ...VISION_FALLBACK_MODELS] */
  models?: string[];
  /** 总时长上限：收图是在 TG webhook 里同步等的，不能拖太久 */
  deadlineMs?: number;
  /** 重试间隔（测试里调小） */
  gapMs?: number;
}

/** 进程内节流：免费网关额度极小，连续请求必被限流。
 *  同一 isolate 里两次识图之间至少间隔 3 秒。 */
let lastVisionAt = 0;
async function visionGate(minGapMs = 3000): Promise<void> {
  const wait = lastVisionAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastVisionAt = Date.now();
}

/** 调 vision（https 图片地址），返回解析 JSON。模型/网关走运行时配置（/model 可切）。
 *  韧性三层：①图没生效就等（waitForImage）②429 按限流退避 ③一个模型不行换下一个模型。 */
export async function recognizePhoto(
  env: Env, imgUrl: string, cfg?: { endpoint: string; model: string }, opts: VisionOpts = {},
): Promise<VisionRec> {
  const ep = cfg?.endpoint || env.VISION_ENDPOINT;
  const tries = Math.max(1, opts.tries ?? 2);
  const gap = opts.gapMs ?? 2500;
  const deadline = opts.deadlineMs ?? 40_000;
  const primary = cfg?.model || env.VISION_MODEL || "mimo-v2.6-flash-free";
  const models = (opts.models || [primary, ...VISION_FALLBACK_MODELS])
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const started = Date.now();
  let lastErr: unknown = null;
  const tried: string[] = [];

  let quotaHit = false;
  for (const model of models) {
    for (let i = 0; i < tries; i++) {
      if (Date.now() - started > deadline) break;
      // max_tokens 不设限：推理模型先烧 token 再答，上限会腰斩长回复；成本靠档位控制。
      // stream: true —— 本网关对非流式请求更容易回 429/530，识图必须走流式。
      const body: Record<string, unknown> = {
        model,
        reasoning_effort: "high",
        stream: true,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: imgUrl } },
          ],
        }],
      };
      if (!tried.includes(model)) tried.push(model);
      const t0 = Date.now();
      if (!opts.gapMs) await visionGate(); // 测试里传 gapMs 就跳过节流
      try {
        const r = await fetch(ep, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA_BROWSER,
            Accept: "text/event-stream",
            Authorization: `Bearer ${env.VISION_API_KEY || "1"}`,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.log("[vision-attempt]", model, r.status, `${Date.now() - t0}ms`, txt.slice(0, 80).replace(/\s+/g, " "));
          lastErr = new Error(`模型接口 ${r.status}${/usage limit|rate limit/i.test(txt) ? "（限流）" : ""}`);
        } else {
          const raw = await r.text();
          const content = sseText(raw);
          console.log("[vision-attempt]", model, 200, `${Date.now() - t0}ms`, `len=${raw.length} text=${content.length}`);
          return parseVisionJson(content);
        }
      } catch (e) {
        console.log("[vision-attempt]", model, "ERR", `${Date.now() - t0}ms`, String((e as Error)?.message || e).slice(0, 80));
        lastErr = e;
      }
      const quota = /429|限流|usage limit|rate limit|530|502|503/i.test(String((lastErr as Error)?.message || ""));
      if (quota) {
        // 额度类错误：**绝不能**换模型硬试。实测免费网关额度很小，
        // 一个模型 429 后继续打别的模型，只会把窗口烧穿、连 530 一起出来。
        // 正确做法：等一个窗口（~8 秒）后同模型再试一次；还不行就交给后台重试。
        if (i === 0) {
          await new Promise((res) => setTimeout(res, 8000));
          continue;
        }
        quotaHit = true;
        break;
      }
      if (i < tries - 1) await waitForImage(env, imgUrl, 2, gap);
    }
    if (quotaHit) break; // 别再换模型了
    if (Date.now() - started <= deadline) await waitForImage(env, imgUrl, 1, Math.min(gap, 2000));
  }
  const msg = String((lastErr as Error)?.message || lastErr || "未知错误");
  throw new Error(`${msg}（试过：${tried.join(" / ")}）`);
}

/** 抠 JSON（容忍围栏/废话），补全字段并钳制 confidence。 */
export function parseVisionJson(raw: string): VisionRec {
  let t = raw.trim();
  if (t.includes("```")) {
    const parts = t.split("```");
    t = (parts.length >= 3 ? parts[1] : t.replace(/```/g, "")).trim();
    if (t.startsWith("json")) t = t.slice(4).trim();
  }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`Vision 回复里没有 JSON：${raw.slice(0, 120)}`);
  const data = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
  const rec = {
    type: "", distance_km: null, duration_s: null, avg_pace_s_per_km: null,
    avg_hr: null, calories: null, steps: null, cadence: null,
    start_time: null, confidence: 0, ...data,
  } as VisionRec;
  let conf = Number(rec.confidence) || 0;
  conf = Math.min(1, Math.max(0, conf));
  rec.confidence = conf;
  if (!WORKOUT_TYPES.includes(rec.type)) {
    rec.type = "free_training";
    rec.confidence = Math.min(conf, 0.5);
  }
  return rec;
}

/** parseStart/toWorkoutRow 已收归 github.ts（confirm_review 共用），此处不再重复实现。 */

/**
 * 重试识别一条 review。
 * 存在的意义：vision 失败往往是一次性抖动（比如图刚提交、raw CDN 还没生效，
 * 网关抓不到图 → 模型说"我看不到截图"）。原图还在，就该能重试，而不是让用户重传。
 */
export async function retryReview(
  env: Env, path: string, confirmed: boolean, actor: string,
): Promise<string> {
  if (!env.GH_PAT) return "失败：写库未授权（Worker 缺 GH_PAT）。";
  if (!path.startsWith("review/") || !path.endsWith(".json")) {
    return "失败：path 必须是 review/ 下的 json（先调 list_review 拿路径）。";
  }
  const cur = await ghGetFile(env, path).catch(() => null);
  if (!cur?.text) return `失败：${path} 不存在或已处理。`;
  let meta: { image?: string } = {};
  try {
    meta = JSON.parse(cur.text) as { image?: string };
  } catch {
    return `失败：${path} 不是合法 JSON，请人工处理。`;
  }
  const image = String(meta.image || "");
  if (!image) return `失败：这条记录里没有原图路径，只能人工补录。`;

  const url = `https://raw.githubusercontent.com/${env.REPO}/main/${image}`;
  const reachable = await waitForImage(env, url, 3, 2000);
  if (!reachable) return `失败：原图 ${image} 现在也读不到，稍后再试或人工补录。`;

  let rec: VisionRec;
  try {
    rec = await recognizePhoto(env, url, await runtimeModelCfg(env), { tries: 2, deadlineMs: 60_000 });
  } catch (e) {
    return `重试仍然失败：${(e as Error).message}。原图和 review 都没动。`;
  }
  const row = toWorkoutRow(rec, image);
  if (!confirmed) {
    return `重新识别成功，预览（尚未写入）：${row.date} ${rec.type} `
      + `${rec.distance_km}km/${rec.duration_s}s，心率 ${rec.avg_hr ?? "?"}，confidence ${rec.confidence}。`
      + `\n原图 ${image}。用户确认后，再用相同 path 带 confirmed=true 重试一次。`;
  }
  if (rec.confidence < REVIEW_THRESHOLD) {
    return `识别出来了但置信度只有 ${rec.confidence}（低于 ${REVIEW_THRESHOLD}），没入库。`
      + `数据：${row.date} ${rec.type} ${rec.distance_km}km/${rec.duration_s}s。`
      + `确认无误的话，用 append_workout 补录。`;
  }
  await appendRow(env, row, actor);
  await ghDeleteFile(env, path, cur.sha, `bot: 重试识别后入库 ${row.date} ${rec.type} via ${actor}`);
  return `已重新识别并入库：${row.date} ${rec.type} ${rec.distance_km}km/${rec.duration_s}s`
    + `（id=${row.id}），review 文件已删。`;
}

/**
 * 后台自动重试：扫 review 里"vision 失败"的那些，重试识别；成功的自动入库。
 * 为什么需要：免费网关会整站抽风（429/502/530），失败与否取决于"你上传那一刻它活着没"。
 * 有了这个，用户不用重发图，网关恢复后自动补上。
 * 返回每条的结果，交给调用方决定要不要通知用户。
 */
export async function autoRetryReviews(
  env: Env, limit = 5,
): Promise<{ path: string; ok: boolean; text: string; chat?: string }[]> {
  if (!env.GH_PAT) return [];
  if (isPaused(env)) return []; // 网关暂停中：别打网关
  const listed = await toolListReview(env).catch(() => "");
  let files: { path: string }[] = [];
  try {
    files = (JSON.parse(listed) as { items?: { path: string }[] }).items || [];
  } catch {
    return [];
  }
  const out: { path: string; ok: boolean; text: string; chat?: string }[] = [];
  for (const f of files.slice(0, 20)) {
    if (out.filter((x) => x.ok).length >= limit) break;
    const path = f.path || "";
    if (!path) continue;
    const g = await ghGetFile(env, path).catch(() => null);
    if (!g?.text) continue;
    let meta: { error?: string; chat?: string; image?: string } = {};
    try {
      meta = JSON.parse(g.text) as { error?: string; chat?: string; image?: string };
    } catch {
      continue;
    }
    // 只重试"识别失败"的；置信度不足属于数据问题，重试没意义
    if (!meta.error || !/vision|429|502|503|530|模型接口|没有 JSON|提交失败/i.test(meta.error)) continue;
    if (/提交失败/.test(meta.error)) {
      // 新链路（图交给模型读）提交失败：这里不自己识图，交给调用方重新提交多模态消息
      out.push({ path, ok: false, text: `待重新提交：${meta.error}`, chat: meta.chat });
      continue;
    }
    const text = await retryReview(env, path, true, "auto:vision-retry").catch((e) => `失败：${(e as Error).message}`);
    out.push({ path, ok: text.startsWith("已重新识别并入库"), text, chat: meta.chat });
  }
  return out;
}

/** 把仓库里的图读成 data URL（给"重新提交给模型读"用）。 */
export async function imageDataUrl(env: Env, imgPath: string): Promise<string | null> {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${env.REPO}/main/${imgPath}`, {
      headers: { "User-Agent": UA_BROWSER },
    });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    const mediaType = buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : "image/jpeg";
    return `data:${mediaType};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

/** 记一条 review（图已存、但没能入库时用），返回文件路径。 */
export async function writeReviewItem(
  env: Env, imgPath: string, mid: number | string, error: string, chat?: string,
): Promise<string> {
  const ts = bjNow().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const path = `review/needs-review-tg${mid}-${ts}.json`;
  await ghPutFile(env, path, JSON.stringify({
    image: imgPath, error, ...(chat ? { chat } : {}),
  }, null, 1), "", `bot: 收图待补录 ${path}`);
  return path;
}

/**
 * 收图第一步（不识别）：下载 → 提交到仓 → 返回图片 data URL。
 *
 * 为什么不在这里识别：识图应该由**模型在本轮对话里直接看图**完成
 * （图片作为 UIMessage 的 file 部件），而不是我们另发一次上网关的请求。
 * 少一次请求 = 少一次限流机会，而且模型能结合上下文判断。
 */
export async function saveTgPhoto(
  env: Env, fileId: string, isOrig: boolean, mid: number | string,
): Promise<{ imgPath: string; dataUrl: string; mediaType: string }> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，收图入库不可用（问数不受影响）");
  const { bytes } = await downloadTgFile(env, fileId);
  const raw = new Uint8Array(bytes);
  const day = bjNow().toISOString().slice(0, 10);
  const [y, m, d] = day.split("-");
  const mediaType = raw[0] === 0x89 && raw[1] === 0x50 ? "image/png" : "image/jpeg";
  const ext = mediaType === "image/png" ? "png" : "jpg";
  const imgPath = `images/${y}/${m}/${d}-tg${mid}.${ext}`;
  await putBinaryFile(env, imgPath, bytes, `bot: TG收图 ${imgPath}`);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < raw.length; i += chunk) {
    bin += String.fromCharCode(...raw.subarray(i, i + chunk));
  }
  const b64 = btoa(bin);
  return { imgPath, dataUrl: `data:${mediaType};base64,${b64}`, mediaType };
}

/**
 * 收图主流程（旧路径：代码自己调识图接口）。
 *
 * ⚠️ 已不再被 server.ts 使用 —— 现在走「图片当消息部件交给模型读」。
 * 保留是因为 retry_review / 后台补录 / 测试还在用它，且作为模型读图失败时的兜底。
 * chat：来源通道（如 "tg:123456"），写进 review 记录，后台重试成功后好通知回去。
 */
export async function ingestPhoto(
  env: Env, fileId: string, isOrig: boolean, mid: number | string, chat?: string,
): Promise<{ rec: VisionRec; line: string }> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，收图入库不可用（问数不受影响）");
  const { bytes } = await downloadTgFile(env, fileId);
  const day = bjNow().toISOString().slice(0, 10);
  const [y, m, d] = day.split("-");
  const imgPath = `images/${y}/${m}/${d}-tg${mid}.jpg`;
  const sha = await putBinaryFile(env, imgPath, bytes, `bot: TG收图 ${imgPath}`);
  const imgUrl = `https://raw.githubusercontent.com/${env.REPO}/main/${imgPath}?v=${sha}`;
  // 网关暂停：图照存（不丢），但不调模型——直接进 review，恢复后自动补录。
  if (isPaused(env)) {
    const ts0 = bjNow().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rp0 = `review/needs-review-tg${mid}-${ts0}.json`;
    await ghPutFile(env, rp0, JSON.stringify({
      image: imgPath, error: "网关暂停中（待切换），恢复后自动重试", ...(chat ? { chat } : {}),
    }, null, 1), "", `bot: TG收图（网关暂停）${rp0}`);
    return {
      rec: {
        type: "free_training", distance_km: null, duration_s: null, avg_pace_s_per_km: null,
        avg_hr: null, calories: null, steps: null, cadence: null, start_time: null, confidence: 0,
      },
      line: `收到图并已存好（网关暂停中，暂不识别）。恢复后我会自动补录并告诉你，不用重发。`,
    };
  }
  // 先等图能公网访问（否则网关抓不到图，模型会说"我看不到截图"）
  await waitForImage(env, imgUrl, 10, 2500);
  let rec: VisionRec;
  try {
    rec = await recognizePhoto(env, imgUrl, await runtimeModelCfg(env));
  } catch (e) {
    // vision 挂了也不能让图变孤儿：进 review，人工看图补录
    const ts0 = bjNow().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rp0 = `review/needs-review-tg${mid}-${ts0}.json`;
    await ghPutFile(env, rp0, JSON.stringify({
      image: imgPath, error: `vision调用失败：${(e as Error).message}`, ...(chat ? { chat } : {}),
    }, null, 1), "",
      `bot: TG收图vision失败转人工 ${rp0}`);
    return {
      rec: { type: "free_training", distance_km: null, duration_s: null, avg_pace_s_per_km: null, avg_hr: null, calories: null, steps: null, cadence: null, start_time: null, confidence: 0 },
      line: `识别服务暂时不可用（${(e as Error).message}），原图已存、已进 review。`
        + `我会在后台每 15 分钟自动重试识别，成功就直接入库并告诉你，不用你重新发。`,
    };
  }
  if (rec.confidence >= REVIEW_THRESHOLD) {
    const row = toWorkoutRow(rec, imgPath);
    await appendRow(env, row, `tg:${mid}`);
    const line = `已入库：${row.date} ${rec.type} ${rec.distance_km}km/${rec.duration_s}s（confidence ${rec.confidence.toFixed(2)}）`;
    return { rec, line };
  }
  const ts = bjNow().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rp = `review/needs-review-tg${mid}-${ts}.json`;
  await ghPutFile(env, rp, JSON.stringify(rec, null, 1), "",
    `bot: TG收图待审 ${rp}`);
  let line = `这张没看清（confidence ${rec.confidence.toFixed(2)}<0.8），已进 review 等你确认，先别删原图。`;
  if (!isOrig) {
    line += "另外你是直接拍照发的：TG 会把长截图压到最长边1280，字糊了才看不清。重发时点回形针选“文件”方式发原图。";
  }
  return { rec, line };
}
