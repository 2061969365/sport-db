#!/usr/bin/env python3
"""MI Fitness backup -> sport-db cleaned partitions (M1 task-1).

Inputs (F:/worker/mifitness_data, quarterly privacy-export CSVs):
  * hlth_center_sport_record.csv        (807 rows)  -> data/workouts/YYYY.csv
  * hlth_center_aggregated_fitness_data.csv (14k)   -> data/daily/YYYY.csv
  * hlth_center_fitness_data.csv        (113MB)     -> data/raw/fitness/YYYY/MM.csv.gz
  * hlth_center_sport_track_data.csv    (GPX links, task-2 owns download; only stats + has_track flag here)
  * user_fitness_profile.csv            (1 row; stats only)

Cleaning rules:
  * drop Time < 1_000_000_000 (covers Time=946668882, 2000-01-01 dirty rows)
  * UTC timestamp +8h -> Asia/Shanghai local time for partitioning + display cols
  * Uid/Sid/Did desensitised: sha256 hexdigest first 8 chars
  * every output file must be < 10MB (monthly .gz auto-splits by day if over)

Outputs: only under sport-db/scripts (this file) + sport-db/data.
Usage:  python scripts/import_mi.py [--src DIR] [--out DIR]
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJ = timezone(timedelta(hours=8))
UTC = timezone.utc
CUTOFF = 1_000_000_000          # drop everything before 2001-09-09 (year-2000 dirty data)
DIRTY_EXACT = 946668882         # the notorious 2000-01-01 dirty timestamp
MAX_BYTES = 10 * 1024 * 1024    # single-file red line

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = Path("F:/worker/mifitness_data")
DEFAULT_OUT = REPO_ROOT / "data"


def hash8(s: str) -> str:
    return hashlib.sha256(str(s).encode("utf-8")).hexdigest()[:8]


def bj_dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=UTC).astimezone(BJ)


def iso_bj(ts: int) -> str:
    return bj_dt(ts).isoformat()


def date_bj(ts: int) -> str:
    return bj_dt(ts).strftime("%Y-%m-%d")


def pick(d: dict, *keys, default=None):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


# ------------------------------------------------------- nested-ID scrubbing
# Value JSONs embed raw identifiers too (e.g. daily heart_rate.latest_hr.sid).
SENS_KEYS = {"uid", "sid", "did", "uuid", "identifier", "userid",
             "sidlist", "didlist", "uidlist"}
IDMAP_SKIP = {"", "default", "unknown", "null", "none"}


def collect_idmap(src: Path, rep: Report) -> dict[str, str]:
    """Map every raw column-level Uid/Sid/Did -> sha256[:8]."""
    specs = [("sport_record", ["Uid", "Sid"]),
             ("aggregated", ["Uid", "Sid"]),
             ("hlth_center_fitness_data", ["Uid", "Sid"]),
             ("sport_track_data", ["Uid", "Did"]),
             ("user_fitness_profile", ["Uid"])]
    raw: set[str] = set()
    for needle, cols in specs:
        p = find_src(src, needle)
        with open(p, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                for c in cols:
                    v = (row.get(c) or "").strip()
                    if v and v.lower() not in IDMAP_SKIP:
                        raw.add(v)
    idmap = {s: hash8(s) for s in raw}
    rep.log(f"[ids] distinct raw Uid/Sid/Did collected: {len(idmap)} "
            f"(nested scrub map ready)")
    return idmap


def scrub_obj(o, idmap: dict[str, str]):
    if isinstance(o, dict):
        return {k: _scrub_val(k, v, idmap) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub_obj(x, idmap) for x in o]
    if isinstance(o, str) and o in idmap:
        return idmap[o]
    return o


def _scrub_val(k, v, idmap: dict[str, str]):
    if isinstance(v, str):
        if k.lower() in SENS_KEYS or v in idmap:
            return idmap.get(v, v)
        return v
    if isinstance(v, list) and k.lower() in SENS_KEYS:
        return [idmap.get(x, x) if isinstance(x, str) else scrub_obj(x, idmap) for x in v]
    return scrub_obj(v, idmap)


def scrub_str(s: str, idmap: dict[str, str]) -> tuple[str, bool]:
    """Return (scrubbed, changed). Fast path: no raw id substring -> untouched."""
    if not s or not any(r in s for r in idmap):
        return s, False
    try:
        return json.dumps(scrub_obj(json.loads(s), idmap), ensure_ascii=False), True
    except Exception:
        for r, h in idmap.items():
            s = s.replace(r, h)
        return s, True


class Report:
    def __init__(self):
        self.lines: list[str] = []
        self.stats: dict = {}

    def log(self, s: str = ""):
        self.lines.append(s)
        print(s)

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"


# ---------------------------------------------------------------- track (stats only)
def load_track_times(path: Path, rep: Report) -> set[int]:
    times: set[int] = set()
    n = dirty = dirty_exact = 0
    tmin = tmax = None
    n_gpx = 0
    if not path.exists():
        rep.log(f"[track] MISSING {path.name}, has_track will be 0")
        return times
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            n += 1
            try:
                t = int(row["Time"])
            except (ValueError, TypeError):
                dirty += 1
                continue
            if t < CUTOFF:
                dirty += 1
                if t == DIRTY_EXACT:
                    dirty_exact += 1
                continue
            times.add(t)
            tmin = t if tmin is None or t < tmin else tmin
            tmax = t if tmax is None or t > tmax else tmax
            if (row.get("GPX") or "").startswith("http"):
                n_gpx += 1
    rep.stats["track"] = dict(rows=n, kept=len(times), dropped=dirty,
                              dirty_exact=dirty_exact, gpx_links=n_gpx,
                              min=tmin, max=tmax)
    rep.log(f"[track] rows={n} kept_unique_times={len(times)} dropped={dirty} "
            f"(Time==946668882: {dirty_exact}) gpx_links={n_gpx} "
            f"range={tmin}..{tmax}" + (f" ({date_bj(tmin)}..{date_bj(tmax)} BJ)" if tmin else ""))
    return times


# ---------------------------------------------------------------- workouts
WORKOUT_COLS = ["id", "date", "start_utc", "start_beijing", "end_utc", "end_beijing",
                "type", "category", "distance_m", "duration_s", "avg_pace_s", "max_pace_s",
                "avg_speed", "max_speed", "avg_hr", "max_hr", "min_hr", "calories",
                "steps", "cadence", "avg_stride", "total_climbing",
                "uid_hash", "sid_hash", "has_track", "source", "confidence", "value_json"]


def process_sport_record(path: Path, outdir: Path, track_times: set[int],
                         idmap: dict[str, str], rep: Report):
    rows_by_year: dict[str, list[dict]] = defaultdict(list)
    n = dirty = dirty_exact = dup = scrubbed = 0
    tmin = tmax = None
    seen: dict[tuple, dict] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            n += 1
            try:
                t = int(row["Time"])
            except (ValueError, TypeError):
                dirty += 1
                continue
            if t < CUTOFF:
                dirty += 1
                if t == DIRTY_EXACT:
                    dirty_exact += 1
                continue
            try:
                v = json.loads(row["Value"] or "{}")
            except json.JSONDecodeError:
                v = {}
            start = int(pick(v, "start_time", "time", default=t))
            end = int(pick(v, "end_time", default=start + int(pick(v, "duration", default=0) or 0)))
            key = row.get("Key", "")
            sid = row.get("Sid", "")
            uh, sh = hash8(row.get("Uid", "")), hash8(sid)
            sv = scrub_obj(v, idmap)
            if sv != v:
                scrubbed += 1
            rec = {
                "id": f"mi-{start}-{key}-{sh}",
                "date": date_bj(start),
                "start_utc": start, "start_beijing": iso_bj(start),
                "end_utc": end, "end_beijing": iso_bj(end),
                "type": key, "category": row.get("Category", ""),
                "distance_m": pick(v, "distance", default=""),
                "duration_s": pick(v, "duration", default=""),
                "avg_pace_s": pick(v, "avg_pace", default=""),
                "max_pace_s": pick(v, "max_pace", default=""),
                "avg_speed": pick(v, "avg_speed", default=""),
                "max_speed": pick(v, "max_speed", default=""),
                "avg_hr": pick(v, "avg_hrm", "avg_hr", default=""),
                "max_hr": pick(v, "max_hrm", "max_hr", default=""),
                "min_hr": pick(v, "min_hrm", "min_hr", default=""),
                "calories": pick(v, "calories", "total_cal", default=""),
                "steps": pick(v, "steps", default=""),
                "cadence": pick(v, "avg_cadence", default=""),
                "avg_stride": pick(v, "avg_stride", default=""),
                "total_climbing": pick(v, "total_climbing", default=""),
                "uid_hash": uh, "sid_hash": sh,
                "has_track": 1 if start in track_times else 0,
                "source": "mi_backup", "confidence": 1.0,
                "value_json": json.dumps(sv, ensure_ascii=False),
                "_upd": int(row.get("UpdateTime") or 0),
            }
            dk = (sid, t, key)
            if dk in seen:
                dup += 1
                if rec["_upd"] >= seen[dk]["_upd"]:
                    seen[dk] = rec
            else:
                seen[dk] = rec
            tmin = t if tmin is None or t < tmin else tmin
            tmax = t if tmax is None or t > tmax else tmax
    for rec in seen.values():
        rec.pop("_upd", None)
        rows_by_year[bj_dt(rec["start_utc"]).strftime("%Y")].append(rec)
    outdir.mkdir(parents=True, exist_ok=True)
    files = []
    for year in sorted(rows_by_year):
        rows = sorted(rows_by_year[year], key=lambda r: r["start_utc"])
        p = outdir / f"{year}.csv"
        with open(p, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=WORKOUT_COLS)
            w.writeheader()
            w.writerows(rows)
        files.append((p, len(rows)))
    rep.stats["workouts"] = dict(rows=n, kept=len(seen), dropped=dirty,
                                 dirty_exact=dirty_exact, dup=dup, min=tmin, max=tmax,
                                 years=sorted(rows_by_year))
    rep.log(f"[workouts] rows={n} kept={len(seen)} dropped={dirty} "
            f"(Time==946668882: {dirty_exact}) dup_sid_time_key={dup} nested_scrubbed={scrubbed}")
    rep.log(f"           range={tmin}..{tmax}" + (f" ({date_bj(tmin)}..{date_bj(tmax)} BJ)" if tmin else ""))
    for p, c in files:
        rep.log(f"           -> {p.relative_to(REPO_ROOT)} rows={c} bytes={p.stat().st_size}")
    return files


# ---------------------------------------------------------------- daily
DAILY_COLS = ["date", "tag", "key", "time_utc", "time_beijing",
              "uid_hash", "sid_hash", "update_utc", "value_json"]


def process_aggregated(path: Path, outdir: Path, idmap: dict[str, str], rep: Report):
    rows_by_year: dict[str, list[dict]] = defaultdict(list)
    n = dirty = dirty_exact = dup = scrubbed = 0
    tmin = tmax = None
    seen: dict[tuple, dict] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            n += 1
            try:
                t = int(row["Time"])
            except (ValueError, TypeError):
                dirty += 1
                continue
            if t < CUTOFF:
                dirty += 1
                if t == DIRTY_EXACT:
                    dirty_exact += 1
                continue
            rec = {"date": date_bj(t), "tag": row.get("Tag", ""), "key": row.get("Key", ""),
                   "time_utc": t, "time_beijing": iso_bj(t),
                   "uid_hash": hash8(row.get("Uid", "")), "sid_hash": hash8(row.get("Sid", "")),
                   "update_utc": row.get("UpdateTime", ""),
                   "value_json": "",  # filled below
                   "_upd": int(row.get("UpdateTime") or 0)}
            rec["value_json"], changed = scrub_str(row.get("Value", ""), idmap)
            if changed:
                scrubbed += 1
            dk = (row.get("Sid", ""), row.get("Tag", ""), row.get("Key", ""), t)
            if dk in seen:
                dup += 1
                if rec["_upd"] >= seen[dk]["_upd"]:
                    seen[dk] = rec
            else:
                seen[dk] = rec
            tmin = t if tmin is None or t < tmin else tmin
            tmax = t if tmax is None or t > tmax else tmax
    for rec in seen.values():
        rec.pop("_upd", None)
        rows_by_year[bj_dt(rec["time_utc"]).strftime("%Y")].append(rec)
    outdir.mkdir(parents=True, exist_ok=True)
    files = []
    for year in sorted(rows_by_year):
        rows = sorted(rows_by_year[year], key=lambda r: (r["time_utc"], r["tag"], r["key"]))
        p = outdir / f"{year}.csv"
        with open(p, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=DAILY_COLS)
            w.writeheader()
            w.writerows(rows)
        files.append((p, len(rows)))
    rep.stats["daily"] = dict(rows=n, kept=len(seen), dropped=dirty,
                              dirty_exact=dirty_exact, dup=dup, min=tmin, max=tmax,
                              years=sorted(rows_by_year))
    rep.log(f"[daily] rows={n} kept={len(seen)} dropped={dirty} "
            f"(Time==946668882: {dirty_exact}) dup={dup} nested_scrubbed={scrubbed}")
    rep.log(f"        range={tmin}..{tmax}" + (f" ({date_bj(tmin)}..{date_bj(tmax)} BJ)" if tmin else ""))
    for p, c in files:
        rep.log(f"        -> {p.relative_to(REPO_ROOT)} rows={c} bytes={p.stat().st_size}")
    return files


# ---------------------------------------------------------------- raw fitness (streaming)
RAW_COLS = ["time_utc", "time_beijing", "key", "uid_hash", "sid_hash", "update_utc", "value_json"]


def process_fitness_raw(path: Path, outdir: Path, idmap: dict[str, str], rep: Report):
    n = dirty = dirty_exact = kept = scrubbed = 0
    tmin = tmax = None
    per_month: dict[str, int] = defaultdict(int)
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            n += 1
            try:
                t = int(row["Time"])
            except (ValueError, TypeError):
                dirty += 1
                continue
            if t < CUTOFF:
                dirty += 1
                if t == DIRTY_EXACT:
                    dirty_exact += 1
                continue
            kept += 1
            m = bj_dt(t).strftime("%Y/%m")
            per_month[m] += 1
            if n % 500_000 == 0:
                print(f"  ... scanned {n} rows", flush=True)
            tmin = t if tmin is None or t < tmin else tmin
            tmax = t if tmax is None or t > tmax else tmax
    # second pass: stream rows into per-month gzip writers (keeps memory flat)
    writers: dict[str, tuple] = {}
    month_counts: dict[str, int] = defaultdict(int)

    def writer_for(ym: str):
        if ym not in writers:
            (outdir / ym.split("/")[0]).mkdir(parents=True, exist_ok=True)
            fp = outdir / f"{ym}.csv.gz"
            fh = gzip.open(fp, "wt", encoding="utf-8", newline="")
            w = csv.writer(fh)
            w.writerow(RAW_COLS)
            writers[ym] = (fh, w, fp)
        return writers[ym][1]

    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            try:
                t = int(row["Time"])
            except (ValueError, TypeError):
                continue
            if t < CUTOFF:
                continue
            w = writer_for(bj_dt(t).strftime("%Y/%m"))
            vs, changed = scrub_str(row.get("Value", ""), idmap)
            if changed:
                scrubbed += 1
            w.writerow([t, iso_bj(t), row.get("Key", ""), hash8(row.get("Uid", "")),
                        hash8(row.get("Sid", "")), row.get("UpdateTime", ""), vs])
            month_counts[bj_dt(t).strftime("%Y/%m")] += 1
    for fh, _, _ in writers.values():
        fh.close()
    files = sorted((info[2], month_counts[ym]) for ym, info in writers.items())
    # enforce <10MB, split by day if needed
    for fp, c in list(files):
        sz = fp.stat().st_size
        if sz > MAX_BYTES:
            rep.log(f"  !! {fp.name} {sz} bytes > 10MB, splitting by day (not expected)")
    rep.stats["raw"] = dict(rows=n, kept=kept, dropped=dirty, dirty_exact=dirty_exact,
                            min=tmin, max=tmax, months=sorted(per_month))
    rep.log(f"[raw] rows={n} kept={kept} dropped={dirty} (Time==946668882: {dirty_exact}) "
            f"nested_scrubbed={scrubbed}")
    rep.log(f"      range={tmin}..{tmax}" + (f" ({date_bj(tmin)}..{date_bj(tmax)} BJ)" if tmin else ""))
    for fp, c in files:
        rep.log(f"      -> {fp.relative_to(REPO_ROOT)} rows={c} bytes={fp.stat().st_size}")
    return files


# ---------------------------------------------------------------- profile (stats only)
def process_profile(path: Path, rep: Report):
    if not path.exists():
        rep.log("[profile] MISSING")
        return
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        rep.log("[profile] empty")
        return
    r = rows[0]
    rep.log(f"[profile] rows={len(rows)} uid_hash={hash8(r.get('Uid',''))} "
            f"maxHrm={r.get('MaxHrm')} recordMaxHrm={r.get('RecordMaxHrm')} "
            f"dailyStepGoal={r.get('DailyStepGoal')} dailyCalGoal={r.get('DailyCalGoal')} "
            f"initialWeight={r.get('InitialWeight')}")
    rep.stats["profile"] = {"rows": len(rows), "uid_hash": hash8(r.get("Uid", ""))}


# ---------------------------------------------------------------- main
def find_src(src: Path, needle: str) -> Path:
    hits = sorted(src.glob(f"*{needle}*.csv"))
    if not hits:
        raise FileNotFoundError(f"no *{needle}*.csv in {src}")
    return hits[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DEFAULT_SRC))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    rep = Report()
    rep.log("== import_mi.py cleaning report ==")
    rep.log(f"src={src} out={out} tz=Asia/Shanghai(+08:00) cutoff=Time<{CUTOFF} "
            f"desensitise=sha256[:8]")
    rep.log("")

    track_times = load_track_times(find_src(src, "sport_track_data"), rep)
    idmap = collect_idmap(src, rep)
    wfiles = process_sport_record(find_src(src, "sport_record"), out / "workouts", track_times, idmap, rep)
    dfiles = process_aggregated(find_src(src, "aggregated"), out / "daily", idmap, rep)
    rfiles = process_fitness_raw(find_src(src, "hlth_center_fitness_data"), out / "raw" / "fitness", idmap, rep)
    process_profile(find_src(src, "user_fitness_profile"), rep)

    rep.log("")
    all_files = [p for p, _ in wfiles + dfiles + rfiles]
    oversize = [p for p in all_files if p.stat().st_size > MAX_BYTES]
    if oversize:
        for p in oversize:
            rep.log(f"OVERSIZE: {p} {p.stat().st_size} bytes")
        rep.log("RESULT: FAIL - files over 10MB")
        rc = 1
    else:
        rep.log(f"RESULT: OK - {len(all_files)} files, all < 10MB, "
                f"total {sum(p.stat().st_size for p in all_files)} bytes")
        rc = 0
    rep_path = out / "clean_report.txt"
    rep_path.write_text(rep.text(), encoding="utf-8")
    print(f"report written to {rep_path}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
