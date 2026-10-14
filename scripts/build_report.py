#!/usr/bin/env python3
"""每日运动日报生成器 (task-7).

流程:
  1. 读 data/workouts/*.csv + data/daily/*.csv (import_mi.py 产出的分区);
  2. 以 --date (默认北京时间今天) 为锚点, 算近 7 天 / 近 30 天统计
     (跑量 km / 运动次数 / 均配速 / 均心率 / 日均步数 / 睡眠均值);
  3. 拼中文教练 prompt, 调 VISION_ENDPOINT / VISION_MODEL
     (默认 muse-spark-1.3-contributor-free, 网关免 Key, 无 Key 概念);
  4. 结果写 reports/daily/YYYY-MM-DD.md
     (标题 + 一句话总结 + 3 条具体建议 + 风险提示).

只用标准库 (argparse/csv/json/urllib/datetime/pathlib)。
Vision 调用风格与 scripts/ai_image.py::call_vision 保持一致:
  OpenAI-compatible POST {model, messages}, 显式 User-Agent 头
  (过 Cloudflare 网关用), 默认不发 max_tokens (不限, 走网关默认上限;
  如需封顶设 VISION_MAX_TOKENS), VISION_API_KEY 有则带、无则不带。

用法:
  python scripts/build_report.py [--date YYYY-MM-DD] [--workouts DIR]
      [--daily DIR] [--out DIR|--out-file FILE] [--no-ai] [--timeout S]
  python scripts/build_report.py --print-prompt [--date YYYY-MM-DD]
  python scripts/build_report.py --help

无网 / 无 VISION_ENDPOINT 时允许降级: 写占位 md 并在文末注明
"(降级占位: 未调用模型, 原因 ...)"。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJ = timezone(timedelta(hours=8))

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKOUTS = REPO_ROOT / "data" / "workouts"
DEFAULT_DAILY = REPO_ROOT / "data" / "daily"
DEFAULT_OUT_DIR = REPO_ROOT / "reports" / "daily"

DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
UA = "sport-db/1.0 (compatible; +https://github.com)"

RUN_TYPES = ("outdoor_running", "indoor_running", "outdoor_run_class")


# ---------------------------------------------------------------- utils

def to_float(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return float(str(v).strip())
    except ValueError:
        return None


def to_int(v):
    f = to_float(v)
    return None if f is None else int(f)


def fmt_pace(sec_per_km) -> str:
    """秒/公里 -> 5'32"/km, 无数据返回 '--'."""
    if sec_per_km is None or sec_per_km <= 0 or sec_per_km > 3600:
        return "--"
    m = int(sec_per_km // 60)
    s = int(round(sec_per_km - m * 60))
    if s == 60:
        m += 1
        s = 0
    return f"{m}'{s:02d}\"/km"


def fmt_km(km: float) -> str:
    return f"{km:.1f} km"


def parse_date(s: str):
    return datetime.strptime(s, "%Y-%m-%d").date()


# ---------------------------------------------------------------- load

def load_workouts(workouts_dir: Path) -> list[dict]:
    rows: list[dict] = []
    if not workouts_dir.is_dir():
        return rows
    for f in sorted(workouts_dir.glob("*.csv")):
        try:
            with open(f, encoding="utf-8", newline="") as fh:
                for r in csv.DictReader(fh):
                    d = (r.get("date") or "").strip()
                    if len(d) != 10:
                        continue
                    try:
                        dt = parse_date(d)
                    except ValueError:
                        continue
                    dist = to_float(r.get("distance_m"))
                    dur = to_float(r.get("duration_s"))
                    pace = to_float(r.get("avg_pace_s"))
                    # import_mi 行常缺 avg_pace_s: 用 duration/dist 补算
                    if pace is None and dist and dist > 0 and dur and dur > 0:
                        pace = dur / (dist / 1000.0)
                    rows.append({
                        "date": d,
                        "d": dt,
                        "type": (r.get("type") or "").strip(),
                        "distance_m": dist,
                        "duration_s": dur,
                        "pace": pace,
                        "hr": to_float(r.get("avg_hr")),
                        "steps": to_float(r.get("steps")),
                    })
        except FileNotFoundError:
            continue
    return rows


def load_daily(daily_dir: Path):
    """返回 (steps_by_date, sleep_by_date, rest_hr_by_date).

    steps_by_date: date -> int 步数 (daily_report/steps.value.steps)
    sleep_by_date: date -> (sleep_min, sleep_score)
      (daily_report/sleep.value.total_duration 分钟 + sleep_score)
    rest_hr_by_date: date -> 静息/日均心率
      (daily_report/heart_rate.value.avg_rhr || avg_hr)
    同一日期多行取最后一行 (文件已按年切分、行内按时间顺序, 后写覆盖)。
    """
    steps: dict[str, int] = {}
    sleep: dict[str, tuple[float | None, float | None]] = {}
    rest_hr: dict[str, float] = {}
    if not daily_dir.is_dir():
        return steps, sleep, rest_hr
    for f in sorted(daily_dir.glob("*.csv")):
        try:
            with open(f, encoding="utf-8", newline="") as fh:
                for r in csv.DictReader(fh):
                    if r.get("tag") != "daily_report":
                        continue
                    d = (r.get("date") or "").strip()
                    if len(d) != 10:
                        continue
                    key = (r.get("key") or "").strip()
                    try:
                        v = json.loads(r.get("value_json") or "{}")
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(v, dict):
                        continue
                    if key == "steps":
                        s = to_int(v.get("steps"))
                        if s is not None:
                            steps[d] = s
                    elif key == "sleep":
                        mins = to_float(v.get("total_duration"))
                        score = to_float(v.get("sleep_score"))
                        sleep[d] = (mins, score)
                    elif key == "heart_rate":
                        # 只取静息心率 avg_rhr; avg_hr 是全天均值(含运动时段),
                        # 回退用它会污染成 120+, 缺 avg_rhr 就记无数据。
                        hr = to_float(v.get("avg_rhr"))
                        if hr is not None:
                            rest_hr[d] = hr
        except FileNotFoundError:
            continue
    return steps, sleep, rest_hr


# ---------------------------------------------------------------- stats

def window_stats(workouts: list[dict], steps, sleep, rest_hr,
                 target, days: int) -> dict:
    lo = target - timedelta(days=days - 1)
    w = [r for r in workouts if lo <= r["d"] <= target]
    runs = [r for r in w if r["type"] in RUN_TYPES]
    run_km = sum(r["distance_m"] for r in runs if r["distance_m"]) / 1000.0
    all_km = sum(r["distance_m"] for r in w if r["distance_m"]) / 1000.0
    # 均配速: 跑步距离加权 (总时长/总距离, 只计有距离+时长的跑步)
    pd = sum(r["distance_m"] for r in runs
             if r["distance_m"] and r["duration_s"]) / 1000.0
    pt = sum(r["duration_s"] for r in runs
             if r["distance_m"] and r["duration_s"])
    avg_pace = (pt / pd) if pd > 0 else None
    hrs = [r["hr"] for r in runs if r["hr"]]
    if not hrs:  # 跑步无心率则退到全部运动
        hrs = [r["hr"] for r in w if r["hr"]]
    avg_hr = sum(hrs) / len(hrs) if hrs else None
    # 日均步数 / 睡眠: 按自然日平均 (只平均有数据的天, 缺数天不计入分母)
    day_list = [target - timedelta(days=i) for i in range(days)]
    day_keys = [d.isoformat() for d in day_list]
    s_vals = [steps[k] for k in day_keys if k in steps]
    avg_steps = sum(s_vals) / len(s_vals) if s_vals else None
    sl_vals = [sleep[k][0] for k in day_keys
               if k in sleep and sleep[k][0]]
    avg_sleep_h = (sum(sl_vals) / len(sl_vals) / 60.0) if sl_vals else None
    sc_vals = [sleep[k][1] for k in day_keys
               if k in sleep and sleep[k][1]]
    avg_score = sum(sc_vals) / len(sc_vals) if sc_vals else None
    rh_vals = [rest_hr[k] for k in day_keys if k in rest_hr]
    avg_rest = sum(rh_vals) / len(rh_vals) if rh_vals else None
    return {
        "days": days,
        "range": f"{lo.isoformat()}~{target.isoformat()}",
        "workout_count": len(w),
        "run_count": len(runs),
        "run_km": round(run_km, 2),
        "all_km": round(all_km, 2),
        "avg_pace_s": round(avg_pace, 1) if avg_pace else None,
        "avg_pace_str": fmt_pace(avg_pace),
        "avg_hr": round(avg_hr, 1) if avg_hr else None,
        "avg_steps": int(avg_steps) if avg_steps else None,
        "steps_days": len(s_vals),
        "avg_sleep_h": round(avg_sleep_h, 2) if avg_sleep_h else None,
        "sleep_days": len(sl_vals),
        "avg_sleep_score": round(avg_score, 1) if sc_vals else None,
        "avg_rest_hr": round(avg_rest, 1) if rh_vals else None,
    }


# ---------------------------------------------------------------- prompt

def build_prompt(target_s: str, s7: dict, s30: dict,
                 today_workouts: list[dict]) -> str:
    if today_workouts:
        today_lines = "\n".join(
            f"- {r['type']} {((r['distance_m'] or 0) / 1000.0):.2f}km "
            f"{int(r['duration_s'] or 0) // 60}分{int(r['duration_s'] or 0) % 60}秒 "
            f"配速{fmt_pace(r['pace'])} 心率{r['hr'] or '--'}"
            for r in today_workouts)
    else:
        today_lines = "- (今日暂无运动记录, 按休息日给建议)"
    stats_json = json.dumps({"date": target_s, "last7": s7, "last30": s30},
                            ensure_ascii=False, indent=1)
    return (
        "你是跑步教练, 看下面 JSON (近 7 天 / 近 30 天运动与睡眠统计, "
        "配速 M'SS\"/km, 睡眠小时), 给一份中文每日运动日报。\n"
        f"统计 JSON:\n{stats_json}\n今日明细:\n{today_lines}\n\n"
        "要求: 只返回 Markdown 正文, 不要代码围栏, 结构必须包含:\n"
        f"# {target_s} 运动日报\n"
        "> 一句话总结: (一句话点评今日/近况, <=40 字)\n"
        "## 训练建议 (恰好 3 条, 每条具体可执行, 带配速/距离/心率数字, "
        "结合近 7 天跑量与睡眠, 不要空话)\n"
        "## 风险提示 (1-3 条: 过度训练/睡眠不足/心率异常等, 无风险就写"
        "\"暂无明显风险, 注意热身与补水\")\n"
        "语气亲切专业, 总长度 200-450 字。"
    )


# ---------------------------------------------------------------- vision (文本版 call_vision, 与 ai_image.py 同风格)

def call_text_vision(prompt: str,
                     endpoint: str | None = None,
                     model: str | None = None,
                     timeout_s: int = 120) -> tuple[str, str, str]:
    """调 OpenAI-compatible 文本接口, 返回 (markdown, endpoint, model).

    Env: VISION_ENDPOINT (.../chat/completions), VISION_MODEL,
         VISION_API_KEY (可选, 网关免 Key, 为空则不带 Authorization 头),
         VISION_MAX_TOKENS (可选封顶, 默认不限即不发 max_tokens 字段)。
    只用 urllib; UA 头显式设置 (Cloudflare 会拦 urllib 默认 UA)。
    """
    endpoint = endpoint or os.environ.get("VISION_ENDPOINT", "").strip()
    model = model or os.environ.get("VISION_MODEL", "").strip() or DEFAULT_MODEL
    if not endpoint:
        raise SystemExit("缺少 VISION_ENDPOINT 环境变量 (可用 --no-ai 降级写占位)");
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    api_key = os.environ.get("VISION_API_KEY", "").strip()
    if api_key:  # 免 Key 网关允许为空, 此时不带该头
        headers["Authorization"] = f"Bearer {api_key}"
    body_req: dict = {"model": model,
                      "messages": [{"role": "user", "content": prompt}]}
    cap = (os.environ.get("VISION_MAX_TOKENS") or "").strip()
    if cap:
        try:
            body_req["max_tokens"] = int(cap)
        except ValueError:
            pass
    body = json.dumps(body_req).encode()
    req = urllib.request.Request(endpoint, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        resp = json.load(r)
    text = resp["choices"][0]["message"]["content"]
    if not isinstance(text, str) or not text.strip():
        raise ValueError(f"模型返回为空 (finish={resp['choices'][0].get('finish_reason')})")
    return text.strip(), endpoint, model


# ---------------------------------------------------------------- markdown

def sleep_cell(s: dict) -> str:
    """睡眠均值格: 样本不足半数时标注天数, 免得 1 天午睡平均误导人."""
    if s["avg_sleep_h"] is None:
        return "--"
    if s["sleep_days"] < s["days"] / 2:
        return f"{s['avg_sleep_h']} h (仅{s['sleep_days']}天)"
    return f"{s['avg_sleep_h']} h"


def normalize_ai_markdown(target_s: str, text: str,
                          s7: dict, s30: dict,
                          endpoint: str, model: str) -> str:
    """保证标题/三段结构存在; 缺标题则补, 文末追加统计附录与来源注脚."""
    t = text.strip().replace("\r\n", "\n")
    if f"{target_s}" not in t.split("\n", 1)[0]:
        t = f"# {target_s} 运动日报\n\n" + t
    appendix = (
        "\n\n---\n\n## 数据一览\n\n"
        f"| 区间 | 运动次数 | 跑步次数 | 跑量 | 均配速 | 运动均心率 | 日均步数 | 睡眠均值 |\n"
        f"|---|---|---|---|---|---|---|---|\n"
        f"| 近 7 天 ({s7['range']}) | {s7['workout_count']} | {s7['run_count']} | "
        f"{s7['run_km']:.1f} km | {s7['avg_pace_str']} | "
        f"{s7['avg_hr'] if s7['avg_hr'] is not None else '--'} | "
        f"{s7['avg_steps'] if s7['avg_steps'] is not None else '--'} | "
        f"{sleep_cell(s7)} |\n"
        f"| 近 30 天 ({s30['range']}) | {s30['workout_count']} | {s30['run_count']} | "
        f"{s30['run_km']:.1f} km | {s30['avg_pace_str']} | "
        f"{s30['avg_hr'] if s30['avg_hr'] is not None else '--'} | "
        f"{s30['avg_steps'] if s30['avg_steps'] is not None else '--'} | "
        f"{sleep_cell(s30)} |\n"
        f"\n_由 {model} 生成 ({endpoint}), "
        f"{datetime.now(BJ).strftime('%Y-%m-%d %H:%M %Z')}_"
    )
    return t.rstrip() + "\n" + appendix + "\n"


def fallback_markdown(target_s: str, s7: dict, s30: dict, reason: str) -> str:
    """离线降级占位: 规则模板建议, 如实注明未调模型."""
    tips: list[str] = []
    if s7["run_km"] == 0 and s7["workout_count"] == 0:
        tips = ["明天安排一次 3-5 km 轻松跑, 配速比平时慢 30 秒, 跑后拉伸 10 分钟。",
                "把日均步数先补到 8000 步, 通勤/午休各加 10 分钟快走。",
                "今晚 23 点前睡, 睡前 1 小时不看手机, 连续 3 天补回 7 小时睡眠。"]
    else:
        rk = s7["run_km"]
        pace_note = s7["avg_pace_str"] if s7["avg_pace_str"] != "--" else "6'30\"/km"
        if rk >= 40:
            tips.append(f"近 7 天跑量 {rk:.1f} km 偏高, 本周减量 20%, "
                        "用有氧慢跑替代一次强度课, 配速放慢到 7'00\"/km。",
                        )
        else:
            tips.append(f"保持周跑量 {max(rk, 10):.0f} km 左右, 下次跑 "
                        f"5-8 km 有氧跑, 配速 {pace_note}, 心率控制 150 以下。")
        if s7["sleep_days"] >= 2 and (s7["avg_sleep_h"] or 8) < 7:
            tips.append("近 7 天睡眠不足 7 小时, 今晚提前 30 分钟上床, "
                        "避免睡前剧烈运动与咖啡因。")
        elif s7["sleep_days"] >= 2:
            tips.append("睡眠达标, 继续保持 7-8 小时; 大强度课放在睡眠充足的次日。")
        else:
            tips.append("手环睡眠记录较少, 先保证 23 点前睡、睡够 7-8 小时, "
                        "连续记录 3 天后再评估强度。")
        tips.append("跑后做 10 分钟拉伸+补水 300-500 ml, 本周加一次核心训练 15 分钟。")
    risks = []
    if (s7["avg_hr"] or 0) >= 165:
        risks.append("运动均心率偏高, 留意疲劳累积, 强度日后必须接休息日。")
    if s7["sleep_days"] >= 2 and (s7["avg_sleep_h"] or 8) < 6.5:
        risks.append("睡眠偏少会拉高静息心率与受伤风险, 近期不加量、不测 PB。")
    if not risks:
        risks.append("暂无明显风险, 注意热身与补水。")
    risk_md = "\n".join(f"- {r}" for r in risks)
    tip_md = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(tips[:3]))
    summary = (f"近 7 天跑 {s7['run_km']:.1f} km、日均 "
               f"{s7['avg_steps'] or '--'} 步, 睡眠{sleep_cell(s7)}。"
               if s7["workout_count"] else "近 7 天暂无运动记录, 先恢复规律活动。")
    return (
        f"# {target_s} 运动日报\n\n"
        f"> 一句话总结: {summary}\n\n"
        f"## 训练建议\n\n{tip_md}\n\n"
        f"## 风险提示\n\n{risk_md}\n\n"
        f"---\n\n## 数据一览\n\n"
        f"| 区间 | 运动次数 | 跑步次数 | 跑量 | 均配速 | 运动均心率 | 日均步数 | 睡眠均值 |\n"
        f"|---|---|---|---|---|---|---|---|\n"
        f"| 近 7 天 ({s7['range']}) | {s7['workout_count']} | {s7['run_count']} | "
        f"{s7['run_km']:.1f} km | {s7['avg_pace_str']} | "
        f"{s7['avg_hr'] if s7['avg_hr'] is not None else '--'} | "
        f"{s7['avg_steps'] if s7['avg_steps'] is not None else '--'} | "
        f"{sleep_cell(s7)} |\n"
        f"| 近 30 天 ({s30['range']}) | {s30['workout_count']} | {s30['run_count']} | "
        f"{s30['run_km']:.1f} km | {s30['avg_pace_str']} | "
        f"{s30['avg_hr'] if s30['avg_hr'] is not None else '--'} | "
        f"{s30['avg_steps'] if s30['avg_steps'] is not None else '--'} | "
        f"{sleep_cell(s30)} |\n"
        f"\n_(降级占位: 未调用模型, 原因: {reason})_\n"
    )


# ---------------------------------------------------------------- main

def build_args(argv=None):
    ap = argparse.ArgumentParser(
        description="每日运动日报: 统计近7/30天 -> 调 Vision 模型 -> 写 reports/daily/YYYY-MM-DD.md "
                    "(无 VISION_ENDPOINT 或 --no-ai 则降级写占位)。")
    ap.add_argument("--date", default="",
                    help="日报日期 YYYY-MM-DD, 默认北京时间今天")
    ap.add_argument("--workouts", default=str(DEFAULT_WORKOUTS),
                    help="data/workouts 分区目录")
    ap.add_argument("--daily", default=str(DEFAULT_DAILY),
                    help="data/daily 分区目录")
    ap.add_argument("--out", default=str(DEFAULT_OUT_DIR),
                    help="报告输出目录 (默认 reports/daily)")
    ap.add_argument("--out-file", default="",
                    help="直接指定输出 md 文件 (覆盖 --out/--date 推导)")
    ap.add_argument("--endpoint", default="",
                    help="覆盖 VISION_ENDPOINT")
    ap.add_argument("--model", default="",
                    help="覆盖 VISION_MODEL")
    ap.add_argument("--timeout", type=int, default=120,
                    help="模型请求超时秒 (默认 120)")
    ap.add_argument("--no-ai", action="store_true",
                    help="强制降级: 不调模型, 直接写规则占位 md")
    ap.add_argument("--print-prompt", action="store_true",
                    help="只打印拼好的教练 prompt, 不写文件不调模型")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = build_args(argv)

    if args.date:
        try:
            target = parse_date(args.date)
        except ValueError:
            print(f"--date 须为 YYYY-MM-DD, 得: {args.date}", file=sys.stderr)
            return 2
    else:
        target = datetime.now(BJ).date()
    target_s = target.isoformat()

    workouts = load_workouts(Path(args.workouts))
    steps, sleep, rest_hr = load_daily(Path(args.daily))
    s7 = window_stats(workouts, steps, sleep, rest_hr, target, 7)
    s30 = window_stats(workouts, steps, sleep, rest_hr, target, 30)
    today_w = [r for r in workouts if r["d"] == target]
    prompt = build_prompt(target_s, s7, s30, today_w)

    if args.print_prompt:
        print(prompt)
        return 0

    out_path = Path(args.out_file) if args.out_file else Path(args.out) / f"{target_s}.md"

    mode, note = "ai", ""
    try:
        if args.no_ai:
            raise RuntimeError("--no-ai 强制降级")
        md, ep, md_model = call_text_vision(
            prompt,
            endpoint=args.endpoint or None,
            model=args.model or None,
            timeout_s=args.timeout)
        md = normalize_ai_markdown(target_s, md, s7, s30, ep, md_model)
        mode = f"ai({md_model})"
    except SystemExit as e:  # 缺 VISION_ENDPOINT 等配置问题 -> 降级
        md = fallback_markdown(target_s, s7, s30, str(e))
        mode = "fallback"
        note = str(e)
    except Exception as e:  # 无网/网关错误/空回 -> 降级, 不阻塞调度
        md = fallback_markdown(target_s, s7, s30, f"{type(e).__name__}: {e}")
        mode = "fallback"
        note = f"{type(e).__name__}: {e}"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(md, encoding="utf-8")
    lines = md.count("\n") + 1
    print(f"date={target_s} mode={mode} "
          f"7d: {s7['workout_count']}次/{s7['run_km']:.1f}km/{s7['avg_pace_str']} "
          f"30d: {s30['workout_count']}次/{s30['run_km']:.1f}km/{s30['avg_pace_str']} "
          f"steps7={s7['avg_steps']} sleep7={s7['avg_sleep_h']} "
          f"-> {out_path} ({lines}行)"
          + (f" [{note}]" if note else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
