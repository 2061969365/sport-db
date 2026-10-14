#!/usr/bin/env python3
"""Screenshot -> workout JSON via Vision model (task-5, design 4.1).

Pipeline (PWA + Actions):
  1. 前端压图: canvas 最长边缩到 1280px, 转 WebP quality 0.8, 目标 <300KB,
     POST 到 inbox/uploads/YYYYMMDD-NNN.<jpg|webp> (见 compress_spec()).
     要求 Pillow 时跑 scripts/ai_image.py --compress in.jpg out.webp 即可复刻.
  2. Actions 触发本脚本: 调 Vision 模型, 固定 Prompt 提
     type / distance_km / duration_s / avg_pace_s_per_km / avg_hr /
     calories / steps / cadence, 返回 JSON + confidence (0..1).
  3. confidence >= REVIEW_THRESHOLD (0.8): 直接写 data/workouts/YYYY.csv 一行,
     原图移 images/YYYY/MM/DD-NN.webp;
     < 0.8: 进 review/ 目录, PWA 标黄人工确认 (build_db 忽略 review).
  4. 小米截图版式已适配: 顶部距离/时长/配速, 中部心率曲线, 底部卡路里/步频.
     Keep / 悦跑圈同 Prompt 兼容 (type 映射见 WORKOUT_TYPES).

Stdlib only for the Actions path (urllib). Pillow is optional and only
needed for the local --compress helper.

Usage:
  python scripts/ai_image.py --compress inbox/uploads/20261014-001.jpg images/2026/10/14-01.webp
  python scripts/ai_image.py --route result.json --workouts data/workouts --images images --review review
  python scripts/ai_image.py --self-test
Env for live call: VISION_ENDPOINT, VISION_API_KEY, VISION_MODEL.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJ = timezone(timedelta(hours=8))

REVIEW_THRESHOLD = 0.8

# 图片压缩规范 (PWA 前端 canvas 实现, 本脚本 --compress 用 Pillow 复刻)
COMPRESS_SPEC = {
    "max_side_px": 1280,      # 最长边缩放到 1280px, 等比
    "format": "WEBP",         # 输出 WebP
    "quality": 80,            # quality 0.8
    "target_kb": 300,         # 目标 <300KB, 超了则 quality 每次 -10 重试到 50
    "strip_exif": True,       # 去 EXIF (隐私 + 体积)
    "dest_pattern": "images/YYYY/MM/DD-NN.webp",
}

WORKOUT_TYPES = [
    "outdoor_running", "indoor_running", "outdoor_run_class",
    "outdoor_riding", "outdoor_walking", "pool_swimming",
    "free_training",
]

# Vision 固定 Prompt: 强制只回 JSON, 便于解析 + 计费可控
# (用字符串拼接而不用 .format, 避免 JSON 花括号转义问题)
VISION_PROMPT = (
    "你是运动截图解析器。看这张运动 App 截图(小米运动健康 / Keep / 悦跑圈版式兼容),\n"
    "提取本次运动数据, 只返回下面 JSON, 不要多余文字:\n"
    '{"type": "<' + "|".join(WORKOUT_TYPES) + '>", "distance_km": <数字或null>, '
    '"duration_s": <秒数或null>,\n'
    ' "avg_pace_s_per_km": <秒/公里或null>, "avg_hr": <次/分或null>,\n'
    ' "calories": <千卡或null>, "steps": <步数或null>, "cadence": <步频或null>,\n'
    ' "start_time": "<YYYY-MM-DD HH:MM:SS +08:00 或null>",\n'
    ' "confidence": <0到1, 看不清/遮挡/模糊就压低>}\n'
    "规则: type 必须从候选里选最接近的; duration \"1:23:45\"/\"86:20\" 换算成秒;\n"
    "配速 5分32秒 换算成 332; 看不清的字段填 null 并降低 confidence。"
)

VISION_JSON_KEYS = ["type", "distance_km", "duration_s", "avg_pace_s_per_km",
                    "avg_hr", "calories", "steps", "cadence",
                    "start_time", "confidence"]


def compress_spec() -> dict:
    """返回图片压缩规范 (前端 canvas 与 --compress 共用同一份参数)."""
    return dict(COMPRESS_SPEC)


def compress_image(src: Path, dst: Path, spec: dict | None = None) -> Path:
    """Pillow 复刻前端压图: 最长边 1280px + WebP q80 + <300KB + 去 EXIF."""
    try:
        from PIL import Image
    except ImportError as e:
        raise SystemExit("compress 需要 Pillow: pip install pillow") from e
    spec = spec or COMPRESS_SPEC
    img = Image.open(src)
    img.thumbnail((spec["max_side_px"], spec["max_side_px"]), Image.LANCZOS)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    q = spec["quality"]
    dst.parent.mkdir(parents=True, exist_ok=True)
    while q >= 50:
        img.save(dst, "WEBP", quality=q, method=6)
        if dst.stat().st_size <= spec["target_kb"] * 1024 or q == 50:
            break
        q -= 10
    return dst


def call_vision(image_bytes: bytes, mime: str = "image/jpeg",
                endpoint: str | None = None, api_key: str | None = None,
                model: str | None = None, timeout_s: int = 60) -> dict:
    """调 OpenAI-compatible Vision 接口, 返回解析后的 JSON dict.

    Env: VISION_ENDPOINT (.../chat/completions), VISION_API_KEY, VISION_MODEL.
    只用 urllib (stdlib), actions 无需装依赖.
    """
    import urllib.request
    endpoint = endpoint or os.environ.get("VISION_ENDPOINT", "")
    api_key = api_key or os.environ.get("VISION_API_KEY", "")
    model = model or os.environ.get("VISION_MODEL", "gpt-4o-mini")
    if not endpoint:
        raise SystemExit("缺少 VISION_ENDPOINT 环境变量")
    # 注: 免 Key 网关允许 api_key 为空, 此时不带 Authorization 头。
    # User-Agent 必须显式设置: 某些网关前有 Cloudflare, 会拦截 urllib 默认 UA (1010)。
    headers = {"Content-Type": "application/json",
               "User-Agent": "sport-db/1.0 (compatible; +https://github.com)"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    b64 = base64.b64encode(image_bytes).decode()
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": VISION_PROMPT},
            {"type": "image_url",
             "image_url": {"url": f"data:{mime};base64,{b64}"}}]}],
        "max_tokens": 500, "temperature": 0,
    }).encode()
    req = urllib.request.Request(endpoint, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        resp = json.load(r)
    text = resp["choices"][0]["message"]["content"]
    return parse_vision_json(text)


def parse_vision_json(raw: str) -> dict:
    """从模型回复抠 JSON (容忍 ```json围栏/前后废话), 校验 key + confidence."""
    t = raw.strip()
    if "```" in t:
        t = t.split("```", 2)[1] if t.count("```") >= 2 else t.replace("```", "")
        t = t.replace("json", "", 1).strip() if t.lstrip().startswith("json") else t.strip()
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"Vision 回复里没有 JSON: {raw[:200]}")
    data = json.loads(t[start:end + 1])
    for k in VISION_JSON_KEYS:
        data.setdefault(k, None)
    try:
        data["confidence"] = float(data.get("confidence") or 0.0)
    except (TypeError, ValueError):
        data["confidence"] = 0.0
    data["confidence"] = min(1.0, max(0.0, data["confidence"]))
    if data.get("type") not in WORKOUT_TYPES:
        data["type"] = "free_training"
        data["confidence"] = min(data["confidence"], 0.5)
    return data


def route_result(rec: dict, threshold: float = REVIEW_THRESHOLD) -> tuple[str, str]:
    """confidence 路由: >=阈值 direct 入库, <阈值 review 人工确认.

    Returns (decision, reason); decision in {"direct", "review"}.
    """
    conf = float(rec.get("confidence") or 0.0)
    if conf >= threshold:
        return "direct", f"confidence {conf:.2f} >= {threshold}"
    missing = [k for k in ("distance_km", "duration_s", "type") if rec.get(k) is None]
    return ("review",
            f"confidence {conf:.2f} < {threshold}"
            + (f", 缺字段 {missing}" if missing else ""))


def to_workout_row(rec: dict, image_path: str = "") -> dict:
    """Vision JSON -> workouts schema 行 (与 import_mi.py / parse_track.py 同列)."""
    from datetime import datetime as _dt
    st = rec.get("start_time")
    try:
        start = _dt.fromisoformat(st) if st else _dt.now(BJ)
        if start.tzinfo is None:
            start = start.replace(tzinfo=BJ)
    except ValueError:
        start = _dt.now(BJ)
    dur = int(rec.get("duration_s") or 0)
    end = start + timedelta(seconds=dur)
    try:
        dist_m = int(round(float(rec["distance_km"]) * 1000)) if rec.get("distance_km") is not None else ""
    except (TypeError, ValueError):
        dist_m = ""
    wtype = rec.get("type") or "free_training"
    return {
        "id": f"image-{int(start.timestamp())}-{wtype}-{dist_m if dist_m != '' else 0}",
        "date": start.astimezone(BJ).strftime("%Y-%m-%d"),
        "start_utc": int(start.timestamp()),
        "start_beijing": start.astimezone(BJ).isoformat(),
        "end_utc": int(end.timestamp()),
        "end_beijing": end.astimezone(BJ).isoformat(),
        "type": wtype, "category": wtype,
        "distance_m": dist_m, "duration_s": dur,
        "avg_pace_s": rec.get("avg_pace_s_per_km") or "",
        "max_pace_s": "", "avg_speed": "",
        "max_speed": "", "avg_hr": rec.get("avg_hr") or "",
        "max_hr": "", "min_hr": "",
        "calories": rec.get("calories") or "",
        "steps": rec.get("steps") or "",
        "cadence": rec.get("cadence") or "",
        "avg_stride": "", "total_climbing": "",
        "uid_hash": "", "sid_hash": "",
        "has_track": 0, "source": "image",
        "confidence": rec.get("confidence", 0.0),
        "value_json": json.dumps({"vision": rec, "image": image_path}, ensure_ascii=False),
    }


WORKOUT_COLS = ["id", "date", "start_utc", "start_beijing", "end_utc", "end_beijing",
                "type", "category", "distance_m", "duration_s", "avg_pace_s", "max_pace_s",
                "avg_speed", "max_speed", "avg_hr", "max_hr", "min_hr", "calories",
                "steps", "cadence", "avg_stride", "total_climbing",
                "uid_hash", "sid_hash", "has_track", "source", "confidence", "value_json"]


def append_workout(workouts_dir: Path, row: dict) -> Path:
    year = row["date"][:4]
    out = workouts_dir / f"{year}.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    exists = out.exists()
    with open(out, "a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=WORKOUT_COLS)
        if not exists:
            w.writeheader()
        w.writerow({c: row.get(c, "") for c in WORKOUT_COLS})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AI screenshot ingest (compress/vision/route).")
    ap.add_argument("--compress", nargs=2, metavar=("SRC", "DST"),
                    help="Pillow 复刻前端压图 (1280px/WebP q80)")
    ap.add_argument("--route", default="", help="Vision 结果 JSON 文件, 按 confidence 路由")
    ap.add_argument("--vision", default="", help="单张图片: 直接调 Vision 模型得 JSON (需 VISION_ENDPOINT/VISION_API_KEY/VISION_MODEL)")
    ap.add_argument("--out", default="", help="--vision 结果 JSON 落盘路径 (可选)")
    ap.add_argument("--workouts", default="data/workouts", help="direct 入库目录")
    ap.add_argument("--review", default="review", help="<0.8 人工确认目录")
    ap.add_argument("--images", default="", help="原图归档路径 (可选, 一并记录)")
    ap.add_argument("--self-test", action="store_true", help="离线自检 (解析+路由, 不调模型)")
    args = ap.parse_args(argv)

    if args.compress:
        dst = compress_image(Path(args.compress[0]), Path(args.compress[1]))
        print(f"compressed -> {dst} ({dst.stat().st_size // 1024}KB, spec={COMPRESS_SPEC})")
        return 0

    if args.self_test:
        hi = {"type": "outdoor_running", "distance_km": 5.12, "duration_s": 1995,
              "avg_pace_s_per_km": 390, "avg_hr": 172, "calories": 460,
              "steps": 5549, "cadence": 167, "start_time": "2023-11-23 17:56:27+08:00",
              "confidence": 0.93}
        lo = dict(hi, confidence=0.42, distance_km=None)
        for rec in (hi, lo):
            decision, reason = route_result(rec)
            row = to_workout_row(rec, "images/2023/11/23-01.webp")
            print(f"{decision}: {reason} -> id={row['id']} "
                  f"distance={row['distance_m']}m duration={row['duration_s']}s")
        print(f"spec={COMPRESS_SPEC} threshold={REVIEW_THRESHOLD}")
        return 0

    if args.vision:
        src = Path(args.vision)
        mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".png": "image/png", ".webp": "image/webp"}.get(
                    src.suffix.lower(), "image/jpeg")
        rec = call_vision(src.read_bytes(), mime)
        print(json.dumps(rec, ensure_ascii=False))
        if args.out:
            Path(args.out).write_text(
                json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"vision -> {args.out}")
        return 0

    if args.route:
        rec = json.loads(Path(args.route).read_text(encoding="utf-8"))
        rec = parse_vision_json(json.dumps(rec)) if isinstance(rec, dict) else rec
        decision, reason = route_result(rec)
        print(f"{decision}: {reason}")
        if decision == "direct":
            row = to_workout_row(rec, args.images)
            out = append_workout(Path(args.workouts), row)
            print(f"appended -> {out} id={row['id']}")
        else:
            rp = Path(args.review)
            rp.mkdir(parents=True, exist_ok=True)
            ts = datetime.now(BJ).strftime("%Y%m%d-%H%M%S")
            p = rp / f"needs-review-{ts}.json"
            p.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"queued -> {p} (PWA 标黄人工确认)")
        return 0

    ap.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
