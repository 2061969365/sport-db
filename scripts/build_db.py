#!/usr/bin/env python3
"""CSV partitions -> sport-db/data.db (task-4).

Inputs (produced by scripts/import_mi.py, task-1):
  data/workouts/YYYY.csv   (806 data rows total)
    header: id,date,start_utc,start_beijing,end_utc,end_beijing,type,category,
            distance_m,duration_s,avg_pace_s,max_pace_s,avg_speed,max_speed,
            avg_hr,max_hr,min_hr,calories,steps,cadence,avg_stride,
            total_climbing,uid_hash,sid_hash,has_track,source,confidence,value_json
  data/daily/YYYY.csv      (14082 data rows total)
    header: date,tag,key,time_utc,time_beijing,uid_hash,sid_hash,update_utc,value_json
    tag/key combos: daily_report/{steps,calories,sleep,heart_rate,stress,spo2,
                    intensity,valid_stand} carry the numeric payloads;
                    daily_mark/* and daily_fitness/goal are presence/goal rows.

Output (default): <repo-root>/data.db  (single-file SQLite, also committed to git)
  tables:
    workouts(id PK, date, start_time, start_beijing, end_time, end_beijing,
             type, category, distance_m, distance_km, duration_s,
             avg_pace_s, max_pace_s, avg_hr, max_hr, min_hr,
             calories, steps, cadence,
             uid_hash, sid_hash, has_track,
             source, file_path, confidence, note)
      -- column names cover the task-4 contract:
         date/start_time/type/distance/duration/pace/hr/cal/steps/source/file/confidence
      -- distance_km (= distance_m/1000.0) exists so the frontend's reserved
         query `SELECT date, type, distance_km, duration_s, source FROM workouts
         WHERE date BETWEEN ? AND ?` works verbatim (see frontend/app.js).
      -- file_path is NULL for mi_backup rows; future parse_track.py fills it
         (tracks/gpx|tcx|kml/...). confidence is 1.0 for mi_backup rows.
    daily_metrics(date PK, steps, distance_m, calories,
                  sleep_min, sleep_score,
                  stress_avg, resting_hr, avg_hr, max_hr, min_hr,
                  spo2_avg, intensity_min, stand_count)
      -- pivoted from daily_report rows per date (see _pivot_daily).
    meta(key PK, value)   -- schema_version, built_at, counts, ranges, goals.
    files(path PK, sha256, bytes, imported_at) -- every source CSV consumed.
  indexes: idx_workouts_date, idx_workouts_type (required),
           idx_workouts_start_time (dedup key start_time+type+distance, task-5).

Tuning for sql.js-httpvfs (design doc section 8): page_size=1024,
journal_mode=DELETE (single file, git friendly), VACUUM at the end.

Stdlib only (sqlite3/csv/json/hashlib/pathlib/argparse).
Usage:  python scripts/build_db.py [--data DIR] [--out FILE]
Idempotent: drops and rebuilds all four tables on every run.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = REPO_ROOT / "data"
DEFAULT_OUT = REPO_ROOT / "data.db"  # task-4 contract: sport-db/data.db

SCHEMA_VERSION = "1"

# --------------------------------------------------------------------------
# tiny converters: "" -> None, else int/float (CSV stores everything as text)


def to_int(v) -> int | None:
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def to_float(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# workouts


WORKOUT_COLS = (
    "id, date, start_time, start_beijing, end_time, end_beijing,"
    " type, category, distance_m, distance_km, duration_s,"
    " avg_pace_s, max_pace_s, avg_hr, max_hr, min_hr,"
    " calories, steps, cadence,"
    " uid_hash, sid_hash, has_track,"
    " source, file_path, confidence, note"
)


def load_workouts(data_dir: Path) -> tuple[list[tuple], list[Path]]:
    files = sorted((data_dir / "workouts").glob("*.csv"))
    if not files:
        raise SystemExit(f"no workouts CSVs under {data_dir / 'workouts'}")
    rows: list[tuple] = []
    for fp in files:
        with open(fp, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                dist_m = to_float(r.get("distance_m"))
                rows.append(
                    (
                        r.get("id"),
                        r.get("date"),
                        to_int(r.get("start_utc")),
                        r.get("start_beijing") or None,
                        to_int(r.get("end_utc")),
                        r.get("end_beijing") or None,
                        r.get("type"),
                        r.get("category") or None,
                        dist_m,
                        (dist_m / 1000.0) if dist_m is not None else None,
                        to_int(r.get("duration_s")),
                        to_float(r.get("avg_pace_s")),
                        to_float(r.get("max_pace_s")),
                        to_float(r.get("avg_hr")),
                        to_float(r.get("max_hr")),
                        to_float(r.get("min_hr")),
                        to_float(r.get("calories")),
                        to_int(r.get("steps")),
                        to_float(r.get("cadence")),
                        r.get("uid_hash") or None,
                        r.get("sid_hash") or None,
                        to_int(r.get("has_track")) or 0,
                        r.get("source") or "mi_backup",
                        None,  # file_path: filled by parse_track.py later
                        to_float(r.get("confidence")) if (r.get("confidence") or "") != "" else 1.0,
                        "",  # note
                    )
                )
    return rows, files


# --------------------------------------------------------------------------
# daily pivot


def _num(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, (int, float)):
            return v
    return None


def _pivot_daily(data_dir: Path) -> tuple[dict[str, dict], list[Path]]:
    files = sorted((data_dir / "daily").glob("*.csv"))
    if not files:
        raise SystemExit(f"no daily CSVs under {data_dir / 'daily'}")
    per_date: dict[str, dict] = {}

    def cell(date: str) -> dict:
        return per_date.setdefault(
            date,
            {
                "steps": None, "distance_m": None, "calories": None,
                "sleep_min": None, "sleep_score": None,
                "stress_avg": None, "resting_hr": None,
                "avg_hr": None, "max_hr": None, "min_hr": None,
                "spo2_avg": None, "intensity_min": None, "stand_count": None,
            },
        )

    for fp in files:
        with open(fp, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("tag") != "daily_report":
                    continue  # daily_mark/* are presence flags, goal is a target
                date = r.get("date")
                key = r.get("key")
                try:
                    d = json.loads(r.get("value_json") or "{}")
                except json.JSONDecodeError:
                    continue
                if not isinstance(d, dict):
                    continue
                c = cell(date)
                if key == "steps":
                    c["steps"] = _num(d, "steps") if c["steps"] is None else c["steps"]
                    c["distance_m"] = _num(d, "distance") if c["distance_m"] is None else c["distance_m"]
                    if c["calories"] is None:
                        c["calories"] = _num(d, "calories")
                elif key == "calories":
                    if c["calories"] is None:
                        c["calories"] = _num(d, "calories")
                elif key == "sleep":
                    if c["sleep_min"] is None:
                        tot = _num(d, "total_duration")
                        c["sleep_min"] = tot
                    if c["sleep_score"] is None:
                        c["sleep_score"] = _num(d, "sleep_score")
                elif key == "heart_rate":
                    c["avg_hr"] = _num(d, "avg_hr")
                    c["max_hr"] = _num(d, "max_hr")
                    c["min_hr"] = _num(d, "min_hr")
                    c["resting_hr"] = c["min_hr"]
                elif key == "stress":
                    c["stress_avg"] = _num(d, "avg_stress")
                elif key == "spo2":
                    c["spo2_avg"] = _num(d, "avg_spo2")
                elif key == "intensity":
                    c["intensity_min"] = _num(d, "duration")
                elif key == "valid_stand":
                    c["stand_count"] = _num(d, "count")
                # weight has no daily_report payload (only daily_mark flags) -> stays NULL
    return per_date, files


# --------------------------------------------------------------------------
# build


DDL = """
DROP TABLE IF EXISTS workouts;
CREATE TABLE workouts(
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  start_beijing TEXT,
  end_time INTEGER,
  end_beijing TEXT,
  type TEXT,
  category TEXT,
  distance_m REAL,
  distance_km REAL,
  duration_s INTEGER,
  avg_pace_s REAL,
  max_pace_s REAL,
  avg_hr REAL,
  max_hr REAL,
  min_hr REAL,
  calories REAL,
  steps INTEGER,
  cadence REAL,
  uid_hash TEXT,
  sid_hash TEXT,
  has_track INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'mi_backup',
  file_path TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  note TEXT NOT NULL DEFAULT ''
);
DROP TABLE IF EXISTS daily_metrics;
CREATE TABLE daily_metrics(
  date TEXT PRIMARY KEY,
  steps INTEGER,
  distance_m INTEGER,
  calories INTEGER,
  sleep_min INTEGER,
  sleep_score INTEGER,
  stress_avg INTEGER,
  resting_hr INTEGER,
  avg_hr INTEGER,
  max_hr INTEGER,
  min_hr INTEGER,
  spo2_avg INTEGER,
  intensity_min INTEGER,
  stand_count INTEGER
);
DROP TABLE IF EXISTS meta;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
DROP TABLE IF EXISTS files;
CREATE TABLE files(path TEXT PRIMARY KEY, sha256 TEXT, bytes INTEGER, imported_at TEXT);
"""


def build(data_dir: Path, out: Path) -> dict:
    workouts, w_files = load_workouts(data_dir)
    per_date, d_files = _pivot_daily(data_dir)
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    imported_at = built_at

    if out.exists():
        out.unlink()  # fresh file so PRAGMA page_size applies
    out.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(out))
    try:
        con.execute("PRAGMA page_size=1024;")
        con.execute("PRAGMA journal_mode=DELETE;")
        con.executescript(DDL)
        con.executemany(f"INSERT OR REPLACE INTO workouts({WORKOUT_COLS}) "
                        f"VALUES ({', '.join('?' * 26)})", workouts)
        con.executemany(
            "INSERT OR REPLACE INTO daily_metrics(date, steps, distance_m, calories,"
            " sleep_min, sleep_score, stress_avg, resting_hr, avg_hr, max_hr, min_hr,"
            " spo2_avg, intensity_min, stand_count)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(d, *[c[k] if not isinstance(c[k], float) or not c[k].is_integer() or k in () else int(c[k])
                    for k in ("steps", "distance_m", "calories", "sleep_min", "sleep_score",
                              "stress_avg", "resting_hr", "avg_hr", "max_hr", "min_hr",
                              "spo2_avg", "intensity_min", "stand_count")])
             for d, c in per_date.items()],
        )
        dates = sorted({w[1] for w in workouts if w[1]})
        meta_rows = {
            "schema_version": SCHEMA_VERSION,
            "built_at": built_at,
            "build_tool": "scripts/build_db.py (task-4)",
            "workouts_rows": str(len(workouts)),
            "daily_rows": str(len(per_date)),
            "daily_source_rows": str(sum(1 for _ in _iter_daily_rows(data_dir))),
            "workouts_range": f"{dates[0]}..{dates[-1]}" if dates else "",
            "daily_range": f"{min(per_date)}..{max(per_date)}" if per_date else "",
            "step_goal": "6000",
            "cal_goal": "400",
            "max_hr_record": "190",
            "initial_weight_kg": "60",
        }
        con.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)",
                        list(meta_rows.items()))
        file_rows = []
        for fp in w_files + d_files:
            rel = fp.relative_to(REPO_ROOT).as_posix()
            file_rows.append((rel, sha256_of(fp), fp.stat().st_size, imported_at))
        con.executemany("INSERT OR REPLACE INTO files(path, sha256, bytes, imported_at)"
                        " VALUES (?,?,?,?)", file_rows)
        con.execute("CREATE INDEX idx_workouts_date ON workouts(date);")
        con.execute("CREATE INDEX idx_workouts_type ON workouts(type);")
        con.execute("CREATE INDEX idx_workouts_start_time ON workouts(start_time);")
        con.commit()
        con.execute("VACUUM;")
        # ---- verify
        counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("workouts", "daily_metrics", "meta", "files")}
        sample = con.execute("SELECT id, date, type, distance_m, distance_km, duration_s,"
                             " source FROM workouts ORDER BY date LIMIT 2").fetchall()
        today = con.execute("SELECT date, steps, calories FROM daily_metrics"
                            " ORDER BY date DESC LIMIT 1").fetchone()
    finally:
        con.close()
    size = out.stat().st_size
    return {"counts": counts, "bytes": size, "sample": sample,
            "latest_daily": today, "built_at": built_at,
            "csv_workouts": len(workouts), "csv_daily_dates": len(per_date)}


def _iter_daily_rows(data_dir: Path):
    for fp in sorted((data_dir / "daily").glob("*.csv")):
        with open(fp, encoding="utf-8-sig", newline="") as f:
            r = csv.DictReader(f)
            for _ in r:
                yield 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build sport-db/data.db from data/*/*.csv")
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    a = ap.parse_args(argv)
    data_dir, out = Path(a.data), Path(a.out)
    res = build(data_dir, out)
    c = res["counts"]
    mb = res["bytes"] / (1024 * 1024)
    print(f"[build_db] out={out} built_at={res['built_at']}")
    print(f"[build_db] workouts={c['workouts']} (csv data rows={res['csv_workouts']})")
    print(f"[build_db] daily_metrics={c['daily_metrics']} distinct dates"
          f" (csv pivoted dates={res['csv_daily_dates']})")
    print(f"[build_db] meta={c['meta']} files={c['files']}")
    print(f"[build_db] size={res['bytes']} bytes ({mb:.2f} MB)")
    print(f"[build_db] sample_workouts={res['sample']}")
    print(f"[build_db] latest_daily={res['latest_daily']}")
    ok = (c["workouts"] == res["csv_workouts"] == 806
          and res["csv_daily_dates"] == c["daily_metrics"])
    # daily source rows are fixed by task-1's report: 14082 kept
    n_src = sum(1 for _ in _iter_daily_rows(data_dir))
    print(f"[build_db] daily_source_rows={n_src} (expect 14082)")
    ok = ok and (n_src == 14082)
    if not ok:
        print("[build_db] VERIFY FAILED: row counts differ from 806/14082 contract",
              file=sys.stderr)
        return 1
    print("[build_db] VERIFY OK: 806 workouts + 14082 daily source rows, "
          "indexes idx_workouts_date/type(+start_time), vacuumed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
