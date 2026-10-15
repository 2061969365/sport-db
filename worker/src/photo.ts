// TG 收图：photo 取最大尺寸 / document 限 image/*。
// 流程：getFile 下载 → 提交 images/年/月/日-tg<mid>.jpg → vision 读 raw 地址
// （?v=sha 破缓存）→ confidence 路由：≥0.8 追加 workouts 当年 CSV；
// 低的进 review。附言由调用方再跑一轮 agent 一并回答。
import type { Env } from "./env";
import { WORKOUT_TYPES, appendRow, ghPutFile, putBinaryFile, toWorkoutRow } from "./github";
import type { VisionRec } from "./github";

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

/** 调 vision（https 图片地址），返回解析 JSON。 */
export async function recognizePhoto(env: Env, imgUrl: string): Promise<VisionRec> {
  // max_tokens 不设限：推理模型先烧 token 再答，上限会腰斩长回复；成本靠档位控制。
  const body: Record<string, unknown> = {
    model: env.VISION_MODEL || "muse-spark-1.3-contributor-free",
    reasoning_effort: "xhigh",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: VISION_PROMPT },
        { type: "image_url", image_url: { url: imgUrl } },
      ],
    }],
  };
  const r = await fetch(env.VISION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "sport-db/1.0" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`模型接口 ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return parseVisionJson(j.choices?.[0]?.message?.content ?? "");
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
 * 收图主流程（调用方在 server.ts 里接 history/附言）。
 * 返回给用户的回复文本；抛错由调用方转统一文案。
 */
export async function ingestPhoto(
  env: Env, fileId: string, isOrig: boolean, mid: number | string,
): Promise<{ rec: VisionRec; line: string }> {
  if (!env.GH_PAT) throw new Error("未配 GH_PAT，收图入库不可用（问数不受影响）");
  const { bytes } = await downloadTgFile(env, fileId);
  const day = bjNow().toISOString().slice(0, 10);
  const [y, m, d] = day.split("-");
  const imgPath = `images/${y}/${m}/${d}-tg${mid}.jpg`;
  const sha = await putBinaryFile(env, imgPath, bytes, `bot: TG收图 ${imgPath}`);
  const imgUrl = `https://raw.githubusercontent.com/${env.REPO}/main/${imgPath}?v=${sha}`;
  let rec: VisionRec;
  try {
    rec = await recognizePhoto(env, imgUrl);
  } catch (e) {
    // vision 挂了也不能让图变孤儿：进 review，人工看图补录
    const ts0 = bjNow().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rp0 = `review/needs-review-tg${mid}-${ts0}.json`;
    await ghPutFile(env, rp0, JSON.stringify({
      image: imgPath, error: `vision调用失败：${(e as Error).message}`,
    }, null, 1), "",
      `bot: TG收图vision失败转人工 ${rp0}`);
    return {
      rec: { type: "free_training", distance_km: null, duration_s: null, avg_pace_s_per_km: null, avg_hr: null, calories: null, steps: null, cadence: null, start_time: null, confidence: 0 },
      line: `识别服务暂时不可用（${(e as Error).message}），原图已存、已进 review，稍后人工补录，先别删原图。`,
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
