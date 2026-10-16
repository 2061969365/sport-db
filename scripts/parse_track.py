#!/usr/bin/env python3
"""Single-track parser: gpx / tcx / kml -> unified workouts schema (task-5).

Stdlib only (xml.etree / math / argparse / json / csv). No third-party deps
so GitHub Actions can run it without pip install.

Design doc: docs/archive/2026-10-14-design.md section 4.2 + 5.

  * gpx: <trkpt lat lon><ele><time> + <extensions> heart-rate,
         distance via Haversine, duration from first/last <time>.
  * tcx: <Lap StartTime><DistanceMeters><TotalTimeSeconds>
         <AverageHeartRateBpm><Value>, most accurate, taken directly.
  * kml: <coordinates> + <TimeStamp><when>, hr unavailable -> None.

Unified output columns are identical to scripts/import_mi.py WORKOUT_COLS
so rows append directly to data/workouts/YYYY.csv:

  id,date,start_utc,start_beijing,end_utc,end_beijing,type,category,
  distance_m,duration_s,avg_pace_s,max_pace_s,avg_speed,max_speed,
  avg_hr,max_hr,min_hr,calories,steps,cadence,avg_stride,total_climbing,
  uid_hash,sid_hash,has_track,source,confidence,value_json

Dedup key: start_utc + type + round(distance_m).
An existing row is overwritten (corrected), e.g. a screenshot entry fixed
by a later accurate track file.

Usage:
  python scripts/parse_track.py tracks/gpx/2026/10/<a>.gpx [<b>.tcx ...]
  python scripts/parse_track.py tracks/gpx/2026/10/*.gpx --out data/workouts/2026.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJ = timezone(timedelta(hours=8))
UTC = timezone.utc

WORKOUT_COLS = ["id", "date", "start_utc", "start_beijing", "end_utc", "end_beijing",
                "type", "category", "distance_m", "duration_s", "avg_pace_s", "max_pace_s",
                "avg_speed", "max_speed", "avg_hr", "max_hr", "min_hr", "calories",
                "steps", "cadence", "avg_stride", "total_climbing",
                "uid_hash", "sid_hash", "has_track", "source", "confidence", "value_json"]

EARTH_R_M = 6371000.0

# source accuracy ranking (higher wins on dedup overwrite)
SOURCE_CONFIDENCE = {"tcx": 1.0, "gpx": 0.95, "kml": 0.9}

TCX_SPORT_MAP = {
    "running": "outdoor_running",
    "biking": "outdoor_riding",
    "cycling": "outdoor_riding",
    "walking": "outdoor_walking",
    "swimming": "pool_swimming",
    "other": "free_training",
}

CATEGORY_MAP = {
    "outdoor_running": "running", "indoor_running": "running",
    "outdoor_run_class": "running", "trail_running": "running",
    "outdoor_riding": "outdoor_riding", "indoor_riding": "outdoor_riding",
    "outdoor_walking": "walking", "indoor_walking": "walking",
    "pool_swimming": "swimming", "open_water_swimming": "swimming",
    "free_training": "free_training",
}


# ------------------------------------------------------------- helpers
def local(tag: str) -> str:
    """Strip XML namespace: '{ns}hr' -> 'hr'."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(math.sqrt(a))


def track_distance_m(pts: list[tuple[float, float]]) -> float:
    return sum(haversine_m(a[0], a[1], b[0], b[1])
               for a, b in zip(pts, pts[1:])) if len(pts) >= 2 else 0.0


def parse_time(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except ValueError:
        return None


def child_text(el: ET.Element, *names: str) -> str | None:
    """First matching direct-child text, namespace-insensitive."""
    want = {n.lower() for n in names}
    for c in el:
        if local(c.tag).lower() in want and c.text and c.text.strip():
            return c.text.strip()
    return None


def find_hr(el: ET.Element) -> float | None:
    """Heart-rate inside <extensions>, namespace-insensitive.

    Accepts Garmin TrackPointExtension <hr>, <HeartRateBpm><Value>,
    and bare <hr>/<heartRate> numbers.
    """
    for node in el.iter():
        ln = local(node.tag).lower()
        if ln in ("hr", "heartrate", "heartratebpm", "averageheartratebpm",
                  "maximumheartratebpm"):
            v = (node.text or "").strip()
            if v.replace(".", "", 1).isdigit():
                return float(v)
            # <AverageHeartRateBpm><Value>123</Value></...>
            inner = child_text(node, "value")
            if inner and inner.replace(".", "", 1).isdigit():
                return float(inner)
    return None


def guess_type(path: Path, trk_type: str | None = None) -> str:
    if trk_type and trk_type.strip():
        t = trk_type.strip().lower().replace("-", "_").replace(" ", "_")
        if "ride" in t or "bik" in t or "cycl" in t:
            return "outdoor_riding"
        if "walk" in t:
            return "outdoor_walking"
        if "run" in t:
            return "outdoor_running"
        return t
    name = path.name.lower()
    if "riding" in name or "cycling" in name or "biking" in name:
        return "outdoor_riding"
    if "walking" in name:
        return "outdoor_walking"
    if "run_class" in name or "running" in name or "run" in name:
        return "outdoor_running"
    if "swim" in name:
        return "pool_swimming"
    return "outdoor_running"


def build_row(*, start: datetime, end: datetime, wtype: str,
              distance_m: float, avg_hr=None, max_hr=None, min_hr=None,
              calories=None, steps=None, cadence=None, source: str,
              file_path: str, extra: dict | None = None) -> dict:
    start_utc = int(start.timestamp())
    end_utc = int(end.timestamp())
    duration = max(0, end_utc - start_utc)
    dist = int(round(distance_m))
    avg_pace = round(duration / distance_m * 1000) if distance_m > 0 and duration else ""
    avg_speed = round(distance_m / duration, 6) if duration > 0 else ""
    bj = start.astimezone(BJ)
    return {
        "id": f"{source}-{start_utc}-{wtype}-{dist}",
        "date": bj.strftime("%Y-%m-%d"),
        "start_utc": start_utc,
        "start_beijing": bj.isoformat(),
        "end_utc": end_utc,
        "end_beijing": end.astimezone(BJ).isoformat(),
        "type": wtype, "category": CATEGORY_MAP.get(wtype, wtype),
        "distance_m": dist, "duration_s": duration,
        "avg_pace_s": avg_pace, "max_pace_s": "",
        "avg_speed": avg_speed, "max_speed": "",
        "avg_hr": avg_hr if avg_hr is not None else "",
        "max_hr": max_hr if max_hr is not None else "",
        "min_hr": min_hr if min_hr is not None else "",
        "calories": calories if calories is not None else "",
        "steps": steps if steps is not None else "",
        "cadence": cadence if cadence is not None else "",
        "avg_stride": "", "total_climbing": "",
        "uid_hash": "", "sid_hash": "",
        "has_track": 1, "source": source,
        "confidence": SOURCE_CONFIDENCE.get(source, 0.9),
        "value_json": json.dumps(extra or {}, ensure_ascii=False),
    }


# ------------------------------------------------------------- gpx
def parse_gpx(path: Path) -> dict:
    root = ET.parse(path).getroot()
    trk_type = None
    for el in root.iter():
        if local(el.tag) == "type" and el.text and el.text.strip():
            trk_type = el.text.strip()
            break
    pts: list[tuple[float, float]] = []
    times: list[datetime] = []
    hrs: list[float] = []
    for pt in root.iter():
        if local(pt.tag) != "trkpt":
            continue
        try:
            lat, lon = float(pt.attrib["lat"]), float(pt.attrib["lon"])
        except (KeyError, ValueError):
            continue
        pts.append((lat, lon))
        t = parse_time(child_text(pt, "time"))
        if t:
            times.append(t)
        hr = find_hr(pt)
        if hr:
            hrs.append(hr)
    if not pts:
        raise ValueError(f"{path}: no <trkpt> points")
    distance = track_distance_m(pts)
    start = times[0] if times else datetime.now(UTC)
    end = times[-1] if len(times) >= 2 else start
    wtype = guess_type(path, trk_type)
    extra = {"points": len(pts), "hr_samples": len(hrs),
             "track_type_tag": trk_type or "",
             "file": path.name}
    return build_row(
        start=start, end=end, wtype=wtype, distance_m=distance,
        avg_hr=round(sum(hrs) / len(hrs)) if hrs else None,
        max_hr=round(max(hrs)) if hrs else None,
        min_hr=round(min(hrs)) if hrs else None,
        source="gpx", file_path=str(path), extra=extra)


# ------------------------------------------------------------- tcx
def _tcx_num(lap: ET.Element, *names: str) -> float | None:
    t = child_text(lap, *names)
    try:
        return float(t) if t is not None else None
    except ValueError:
        return None


def parse_tcx(path: Path) -> dict:
    root = ET.parse(path).getroot()
    acts = [el for el in root.iter() if local(el.tag) == "Activity"]
    if not acts:
        raise ValueError(f"{path}: no <Activity>")
    act = acts[0]
    sport = (act.attrib.get("Sport") or "Other").lower()
    wtype = TCX_SPORT_MAP.get(sport, "free_training")
    total_dist = 0.0
    total_time = 0.0
    hr_weighted = 0.0
    hr_weight = 0.0
    max_hr = None
    calories = 0.0
    start: datetime | None = parse_time(child_text(act, "Id"))
    for lap in act.iter():
        if local(lap.tag) != "Lap":
            continue
        d = _tcx_num(lap, "DistanceMeters") or 0.0
        t = _tcx_num(lap, "TotalTimeSeconds") or 0.0
        total_dist += d
        total_time += t
        lap_start = parse_time(lap.attrib.get("StartTime"))
        if start is None:
            start = lap_start
        avg_el = next((e for e in lap.iter()
                       if local(e.tag) == "AverageHeartRateBpm"), None)
        if avg_el is not None:
            hv = child_text(avg_el, "Value")
            try:
                hr_weighted += float(hv) * (t or 1.0)
                hr_weight += (t or 1.0)
            except (TypeError, ValueError):
                pass
        max_el = next((e for e in lap.iter()
                       if local(e.tag) == "MaximumHeartRateBpm"), None)
        if max_el is not None:
            try:
                mh = float(child_text(max_el, "Value"))
                max_hr = mh if max_hr is None else max(max_hr, mh)
            except (TypeError, ValueError):
                pass
        cal = _tcx_num(lap, "Calories")
        if cal:
            calories += cal
    if start is None:
        raise ValueError(f"{path}: no Lap StartTime / Id")
    end = start + timedelta(seconds=total_time)
    avg_hr = round(hr_weighted / hr_weight) if hr_weight else None
    extra = {"tcx_sport": sport, "laps": sum(1 for e in act.iter() if local(e.tag) == "Lap"),
             "file": path.name}
    return build_row(
        start=start, end=end, wtype=guess_type(path, wtype)
        if wtype == "free_training" and "riding" in path.name.lower()
        else wtype,
        distance_m=total_dist,
        avg_hr=avg_hr, max_hr=round(max_hr) if max_hr else None,
        calories=int(calories) if calories else None,
        source="tcx", file_path=str(path), extra=extra)


# ------------------------------------------------------------- kml
def parse_kml(path: Path) -> dict:
    root = ET.parse(path).getroot()
    coords: list[tuple[float, float]] = []
    for el in root.iter():
        if local(el.tag) != "coordinates":
            continue
        for chunk in (el.text or "").strip().split():
            parts = chunk.split(",")
            if len(parts) >= 2:
                try:
                    lon, lat = float(parts[0]), float(parts[1])
                except ValueError:
                    continue
                coords.append((lat, lon))
    whens = [parse_time(el.text) for el in root.iter()
             if local(el.tag) == "when" and el.text]
    whens = [w for w in whens if w]
    ts_single = None
    for el in root.iter():
        if local(el.tag) == "TimeStamp":
            # <TimeStamp><when>..</when></TimeStamp> or bare <TimeStamp>..</TimeStamp>
            ts_single = parse_time(child_text(el, "when")) or parse_time(el.text)
            if ts_single:
                break
    if not coords:
        raise ValueError(f"{path}: no <coordinates>")
    distance = track_distance_m(coords)
    if len(whens) >= 2:
        start, end = whens[0], whens[-1]
    elif ts_single:
        start = end = ts_single
    else:
        start = end = datetime.now(UTC)
    extra = {"points": len(coords), "hr_samples": 0, "file": path.name}
    return build_row(start=start, end=end, wtype=guess_type(path),
                     distance_m=distance, source="kml",
                     file_path=str(path), extra=extra)


PARSERS = {".gpx": parse_gpx, ".tcx": parse_tcx, ".kml": parse_kml}


def parse_file(path: Path) -> dict:
    fn = PARSERS.get(path.suffix.lower())
    if fn is None:
        raise ValueError(f"{path}: unsupported suffix (want .gpx/.tcx/.kml)")
    return fn(path)


# ------------------------------------------------------------- dedup
def dedup_key(rec: dict) -> str:
    """去重键: start_time + type + distance (design 4.2)."""
    return f"{rec['start_utc']}|{rec['type']}|{rec['distance_m']}"


def dedup_merge(rows: list[dict]) -> dict[str, dict]:
    """Merge rows by dedup key; later / higher-confidence source overwrites."""
    merged: dict[str, dict] = {}
    order = {"tcx": 3, "gpx": 2, "kml": 1, "image": 0, "mi_backup": 0}
    for r in rows:
        k = dedup_key(r)
        old = merged.get(k)
        if old is None or order.get(r.get("source", ""), 0) >= order.get(old.get("source", ""), 0):
            merged[k] = r
    return merged


# ------------------------------------------------------------- cli
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Parse gpx/tcx/kml to workouts schema (stdlib only).")
    ap.add_argument("files", nargs="+", help=".gpx/.tcx/.kml files")
    ap.add_argument("--out", default="", help="optional CSV to append-merge (dedup by start_time+type+distance)")
    args = ap.parse_args(argv)

    rows: list[dict] = []
    for f in args.files:
        p = Path(f)
        try:
            rec = parse_file(p)
        except (ValueError, ET.ParseError) as e:
            print(f"SKIP {p}: {e}", file=sys.stderr)
            continue
        rows.append(rec)
        print(f"OK {p.name}: type={rec['type']} distance={rec['distance_m']}m "
              f"duration={rec['duration_s']}s avg_pace={rec['avg_pace_s']}s/km "
              f"avg_hr={rec['avg_hr'] or '-'} start={rec['start_beijing']}")
    print(json.dumps(rows, ensure_ascii=False, indent=1))

    if args.out:
        out = Path(args.out)
        old: list[dict] = []
        if out.exists():
            with open(out, encoding="utf-8", newline="") as fh:
                old = list(csv.DictReader(fh))
        merged = dedup_merge(old + rows)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=WORKOUT_COLS)
            w.writeheader()
            for r in sorted(merged.values(), key=lambda r: int(r["start_utc"])):
                w.writerow({c: r.get(c, "") for c in WORKOUT_COLS})
        print(f"merged {len(old)} existing + {len(rows)} new -> {len(merged)} rows -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
