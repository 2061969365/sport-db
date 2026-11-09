#!/usr/bin/env python3
"""Mi Health 云端导出 -> sport-db 清洗后分区（workouts + daily）。

数据来源：新接口（hlth.io.mi.com 云端 API）导出的 mi_fitness.json
（见 F:/worker/work/mihealth/report/mihealth-3.59.2-DATA-API.md）。

规则：
 * 运动记录按「同一天 + 同类型 + 距离相差 ≤30m」与现有行对齐：
   对齐上的补全/纠正字段（真实起止时间、心率、步数、配速），保留原 id；
   对不上的作为新行追加，id = mi-<sid_hash>-<start_utc>-<type>。
 * 每日睡眠报告按 (date, tag, key) 覆盖写入 data/daily/YYYY.csv。
 * sid 脱敏：sha256 前 8 位（与 import_mi.py 一致）。
 * 幂等：重复执行不会产生重复行。

用法：
  python scripts/import_mi_cloud.py --src F:/worker/work/mihealth/report/exports/mi_fitness.json
  python scripts/import_mi_cloud.py --src ... --dry-run
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJ = timezone(timedelta(hours=8))
UTC = timezone.utc
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = Path("F:/worker/work/mihealth/report/exports/mi_fitness.json")

WORKOUT_COLS = ["id", "date", "start_utc", "start_beijing", "end_utc", "end_beijing",
                "type", "category", "distance_m", "duration_s", "avg_pace_s", "max_pace_s",
                "avg_speed", "max_speed", "avg_hr", "max_hr", "min_hr", "calories",
                "steps", "cadence", "avg_stride", "total_climbing",
                "uid_hash", "sid_hash", "has_track", "source", "confidence", "value_json"]
DAILY_COLS = ["date", "tag", "key", "time_utc", "time_beijing",
              "uid_hash", "sid_hash", "update_utc", "value_json"]

# 云端 key -> 仓库 type
TYPE_MAP = {
    "outdoor_running": "outdoor_running",
    "indoor_running": "indoor_running",
    "outdoor_riding": "outdoor_riding",
    "indoor_riding": "indoor_riding",
    "outdoor_walking": "outdoor_walking",
    "pool_swimming": "pool_swimming",
    "free_training": "free_training",
    "rope_skipping": "rope_skipping",
}


def hash8(s: str) -> str:
    return hashlib.sha256(str(s).encode("utf-8")).hexdigest()[:8]


def bj_dt(ts: int) -> datetime:
    return datetime.fromtimestamp(int(ts), tz=UTC).astimezone(BJ)


def date_bj(ts: int) -> str:
    return bj_dt(ts).strftime("%Y-%m-%d")


def iso_bj(ts: int) -> str:
    return bj_dt(ts).strftime("%Y-%m-%d %H:%M:%S +08:00")


def num(v, default=""):
    try:
        f = float(v)
        return int(f) if f == int(f) else round(f, 3)
    except (TypeError, ValueError):
        return default


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, cols: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})
    tmp.replace(path)


def cloud_row(w: dict) -> dict | None:
    try:
        v = json.loads(w.get("value") or "{}")
        start = int(v.get("start_time") or w.get("time") or 0)
    except Exception:
        return None
    if start < 1_000_000_000:
        return None
    wtype = TYPE_MAP.get(str(w.get("key") or ""), "")
    if not wtype:
        return None
    dist = num(v.get("distance"), 0) or 0
    dur = num(v.get("duration"), 0) or num(v.get("valid_duration"), 0) or 0
    end = int(v.get("end_time") or (start + dur))
    sid = str(w.get("sid") or "")
    avg_pace = round(dur * 1000 / dist) if dist > 0 and dur > 0 else ""
    max_pace = num(v.get("max_pace"), "")
    min_pace = num(v.get("min_pace"), "")
    if max_pace != "" and min_pace != "":
        max_pace = min(max_pace, min_pace)  # 秒数越小越快
    return {
        "id": f"mi-{hash8(sid)}-{start}-{wtype}",
        "date": date_bj(start),
        "start_utc": str(start),
        "start_beijing": iso_bj(start),
        "end_utc": str(end),
        "end_beijing": iso_bj(end),
        "type": wtype,
        "category": wtype,
        "distance_m": str(int(dist)),
        "duration_s": str(int(dur)),
        "avg_pace_s": str(avg_pace),
        "max_pace_s": str(max_pace),
        "avg_speed": str(round(dist / dur * 3.6, 3)) if dist and dur else "",
        "max_speed": str(num(v.get("max_speed"), "")),
        "avg_hr": str(num(v.get("avg_hrm"), "")),
        "max_hr": str(num(v.get("max_hrm"), "")),
        "min_hr": str(num(v.get("min_hrm"), "")),
        "calories": str(num(v.get("calories"), "")),
        "steps": str(num(v.get("steps"), "")),
        "cadence": "",
        "avg_stride": "",
        "total_climbing": str(num(v.get("total_climbing"), "")),
        "uid_hash": "",
        "sid_hash": hash8(sid),
        "has_track": "0",
        "source": "mihealth-cloud",
        "confidence": "1.0",
        "value_json": json.dumps(v, ensure_ascii=False, separators=(",", ":")),
    }


def merge_workouts(rows: list[dict], clouds: list[dict], rep: dict) -> list[dict]:
    # 索引：date|type|距离桶 -> [行号...]；一条现有记录只能被一条云端记录认领，
    # 否则同一天两次距离相近的跑会被并成一条（实测发生过）。
    idx: dict[tuple, list[int]] = {}
    for i, r in enumerate(rows):
        try:
            key = (r.get("date", ""), r.get("type", ""), int(float(r.get("distance_m") or 0)) // 10)
        except ValueError:
            continue
        idx.setdefault(key, []).append(i)
    used: set[int] = set()

    for c in clouds:
        try:
            d = int(float(c["distance_m"]))
        except ValueError:
            d = 0
        hit = None
        for delta in (0, -1, 1, -2, 2, -3, 3):  # ±30m
            for cand in idx.get((c["date"], c["type"], d // 10 + delta), []):
                if cand not in used:
                    hit = cand
                    break
            if hit is not None:
                break
        if hit is None:
            rows.append(c)
            rep["added"] += 1
            continue
        used.add(hit)
        old = rows[hit]
        rep["merged"] += 1
        # 云端数据更权威：补全/纠正这些字段，但保留原 id 与 note 语义
        for f in ("start_utc", "start_beijing", "end_utc", "end_beijing", "duration_s",
                  "avg_pace_s", "max_pace_s", "avg_speed", "max_speed",
                  "avg_hr", "max_hr", "min_hr", "calories", "steps", "total_climbing"):
            if c.get(f) not in ("", None):
                old[f] = c[f]
        old["sid_hash"] = old.get("sid_hash") or c["sid_hash"]
        old["source"] = c["source"]
        old["confidence"] = "1.0"
        if c.get("value_json"):
            old["value_json"] = c["value_json"]
    return rows


def dedupe_workouts(rows: list[dict], rep: dict) -> list[dict]:
    """同一天、同类型、距离/时长相同、且开始时间相差 ≤3 分钟的，视为重复。

    典型来源：同一张截图被收了两遍（06:21:08 / 06:22:08）。同一天两次
    距离时长恰好相同的间歇跑开始时间通常差得远，不会被误合并。
    """
    def t(r: dict) -> int:
        try:
            return int(float(r.get("start_utc") or 0))
        except ValueError:
            return 0

    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        key = (r.get("date", ""), r.get("type", ""),
               (r.get("distance_m") or "").strip(), (r.get("duration_s") or "").strip())
        groups.setdefault(key, []).append(r)

    def score(x: dict) -> tuple:
        return (x.get("source") == "mihealth-cloud",
                len(x.get("value_json") or ""),
                len([v for v in x.values() if v]))

    out: list[dict] = []
    for key, items in groups.items():
        if len(items) == 1 or "" in key[2:]:
            out.extend(items)
            continue
        items.sort(key=t)
        kept: list[dict] = []
        for r in items:
            if kept and abs(t(r) - t(kept[-1])) <= 180:
                rep["deduped"] += 1
                if score(r) > score(kept[-1]):
                    kept[-1] = r
            else:
                kept.append(r)
        out.extend(kept)
    return out


def merge_daily(rows: list[dict], reports: list[dict], rep: dict) -> list[dict]:
    idx = {(r.get("date", ""), r.get("tag", ""), r.get("key", "")): i for i, r in enumerate(rows)}
    for w in reports:
        try:
            t = int(w.get("time") or 0)
        except (TypeError, ValueError):
            continue
        if t < 1_000_000_000:
            continue
        date = date_bj(t)
        key = str(w.get("key") or "")
        tag = str(w.get("tag") or "daily_report")
        if not key:
            continue
        row = {
            "date": date, "tag": tag, "key": key,
            "time_utc": str(t), "time_beijing": iso_bj(t),
            "uid_hash": "", "sid_hash": hash8(str(w.get("sid") or "")),
            "update_utc": "",
            "value_json": w.get("value") if isinstance(w.get("value"), str)
            else json.dumps(w.get("value") or {}, ensure_ascii=False, separators=(",", ":")),
        }
        k = (date, tag, key)
        if k in idx:
            rows[idx[k]] = row
            rep["daily_updated"] += 1
        else:
            idx[k] = len(rows)
            rows.append(row)
            rep["daily_added"] += 1
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DEFAULT_SRC))
    ap.add_argument("--out", default=str(REPO_ROOT / "data"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    src = Path(a.src)
    if not src.exists():
        print(f"[mi-cloud] 找不到导出文件：{src}", file=sys.stderr)
        return 2
    data = json.loads(src.read_text(encoding="utf-8"))
    workouts = data.get("workouts") or []
    daily_reports = data.get("sleep_daily_reports") or []
    print(f"[mi-cloud] 来源 {src.name}: workouts={len(workouts)} sleep_reports={len(daily_reports)}")

    by_year: dict[str, list[dict]] = defaultdict(list)
    skipped = 0
    for w in workouts:
        r = cloud_row(w)
        if not r:
            skipped += 1
            continue
        by_year[r["date"][:4]].append(r)
    print(f"[mi-cloud] 解析 {sum(len(v) for v in by_year.values())} 条，跳过 {skipped} 条")

    out = Path(a.out)
    total = {"added": 0, "merged": 0, "daily_added": 0, "daily_updated": 0}
    for year in sorted(by_year):
        p = out / "workouts" / f"{year}.csv"
        rows = read_csv(p)
        rep = {"added": 0, "merged": 0, "deduped": 0}
        rep["deduped"] = 0
        # 先去重（截图重复入库的），再合并云端数据：合并会把 start 改成云端时间，
        # 之后就没法按"开始时间相差 3 分钟"认出那对重复了。
        rows = dedupe_workouts(rows, rep)
        rows = merge_workouts(rows, by_year[year], rep)
        rows.sort(key=lambda r: (r.get("date", ""), int(float(r.get("start_utc") or 0))))
        print(f"[mi-cloud] {year}: 新增 {rep['added']}，补全 {rep['merged']}，"
              f"去重 {rep['deduped']} -> {len(rows)} 行")
        total["added"] += rep["added"]
        total["merged"] += rep["merged"]
        if not a.dry_run:
            write_csv(p, WORKOUT_COLS, rows)

    if daily_reports:
        p = out / "daily" / f"{date_bj(int(daily_reports[0].get('time') or 0))[:4]}.csv"
        rows = read_csv(p)
        rep = {"daily_added": 0, "daily_updated": 0}
        rows = merge_daily(rows, daily_reports, rep)
        rows.sort(key=lambda r: (r.get("date", ""), r.get("key", "")))
        print(f"[mi-cloud] daily: 新增 {rep['daily_added']}，更新 {rep['daily_updated']} "
              f"-> {len(rows)} 行（{p.name}）")
        total["daily_added"] += rep["daily_added"]
        total["daily_updated"] += rep["daily_updated"]
        if not a.dry_run:
            write_csv(p, DAILY_COLS, rows)

    print(f"[mi-cloud] 完成{'（dry-run，未写文件）' if a.dry_run else ''}：{total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
