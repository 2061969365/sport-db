#!/usr/bin/env python3
"""批量抢救下载小米运动 GPX 轨迹文件 (M1 task-2).

数据源: mifitness_data/20261014_2627792378_MiFitness_hlth_center_sport_track_data.csv
  列: Uid,Did,Key,Time,UpdateTime,GPX (签名 URL, Expires 约 2027-01, 过期即无法补救)

用法:
  python scripts/download_gpx.py --limit 5            # 小批量试跑前 5 个
  python scripts/download_gpx.py                        # 全量下载 (默认断点续传)
  python scripts/download_gpx.py --no-resume            # 全部重下
  python scripts/download_gpx.py --limit 5 --offset 100 # 分段补跑

输出:
  tracks/gpx/YYYY/MM/<YYYYMMDD>_<Key>_<Time>.gpx  (Time 按 UTC+8 北京日期分区)
  tracks/download_log.csv                          (每行一条下载记录)
  tracks/quarantine/<name>.error.txt               (失败条目的 URL + 错误信息)
"""
from __future__ import annotations

import argparse
import csv
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BEIJING = timezone(timedelta(hours=8))

DEFAULT_CSV = Path(
    r"F:/worker/mifitness_data/20261014_2627792378_MiFitness_hlth_center_sport_track_data.csv"
)
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "tracks" / "gpx"
DEFAULT_LOG = Path(__file__).resolve().parent.parent / "tracks" / "download_log.csv"
DEFAULT_QUARANTINE = Path(__file__).resolve().parent.parent / "tracks" / "quarantine"


def beijing_dt(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(BEIJING)


def looks_like_gpx(head: bytes) -> bool:
    low = head.lstrip()[:500].lower()
    return b"<gpx" in low or (low.startswith(b"<?xml") and b"gpx" in low)


def fetch(url: str, timeout: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (sport-db gpx-rescue)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise IOError(f"HTTP {resp.status}")
        return resp.read()


def download_one(url: str, dest: Path, retries: int, timeout: int) -> tuple[str, int, int, str]:
    """返回 (status, bytes, attempts, error)."""
    attempts = 0
    last_err = ""
    for i in range(1, retries + 1):
        attempts = i
        try:
            data = fetch(url, timeout)
            if len(data) < 200:
                raise IOError(f"suspiciously small payload ({len(data)}B)")
            if not looks_like_gpx(data):
                raise IOError("payload is not GPX (missing <gpx> marker)")
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return "ok", len(data), attempts, ""
        except Exception as e:  # noqa: BLE001 - 需要记录一切网络/IO错误
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(min(2**i, 8))
    return "failed", 0, attempts, last_err


def main() -> int:
    ap = argparse.ArgumentParser(description="批量下载 GPX 轨迹 (带重试/日志/隔离)")
    ap.add_argument("--csv", default=str(DEFAULT_CSV))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--log", default=str(DEFAULT_LOG))
    ap.add_argument("--quarantine", default=str(DEFAULT_QUARANTINE))
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--delay", type=float, default=0.2)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条 (0=全量)")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--no-resume", action="store_true", help="不跳过已存在文件")
    args = ap.parse_args()

    out_dir = Path(args.out)
    log_path = Path(args.log)
    quar_dir = Path(args.quarantine)
    out_dir.mkdir(parents=True, exist_ok=True)
    quar_dir.mkdir(parents=True, exist_ok=True)

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    total_in_csv = len(rows)
    if args.offset:
        rows = rows[args.offset:]
    if args.limit:
        rows = rows[: args.limit]

    log_path.parent.mkdir(parents=True, exist_ok=True)
    resumed = ok = failed = skipped = 0
    total_bytes = 0
    with open(log_path, "w", newline="", encoding="utf-8") as lf:
        w = csv.writer(lf)
        w.writerow(["idx", "uid", "did", "key", "time_utc", "time_beijing",
                    "url", "rel_path", "bytes", "status", "attempts", "error"])
        for n, r in enumerate(rows, start=1 + args.offset):
            url = (r.get("GPX") or "").strip()
            key = (r.get("Key") or "unknown").strip() or "unknown"
            try:
                ts = int(r.get("Time") or 0)
                dt = beijing_dt(ts)
            except (ValueError, OSError, OverflowError):
                dt = None
            if not url or dt is None:
                failed += 1
                w.writerow([n, r.get("Uid"), r.get("Did"), key, r.get("Time"), "",
                            url, "", 0, "failed", 0, "bad row: missing url/time"])
                continue
            name = f"{dt:%Y%m%d}_{key}_{ts}.gpx"
            dest = out_dir / f"{dt:%Y}" / f"{dt:%m}" / name
            rel = dest.relative_to(log_path.parent).as_posix()
            if dest.exists() and dest.stat().st_size > 0 and not args.no_resume:
                skipped += 1  # 断点续传
                resumed_bytes = dest.stat().st_size
                w.writerow([n, r.get("Uid"), r.get("Did"), key,
                            datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                            dt.isoformat(), url, rel, resumed_bytes,
                            "skipped_exists", 0, ""])
                total_bytes += resumed_bytes
                continue
            status, size, attempts, err = download_one(url, dest, args.retries, args.timeout)
            if status == "ok":
                ok += 1
                total_bytes += size
            else:
                failed += 1
                (quar_dir / (name + ".error.txt")).write_text(
                    f"idx={n} key={key} time={ts}\nurl={url}\nerror={err}\n",
                    encoding="utf-8")
            w.writerow([n, r.get("Uid"), r.get("Did"), key,
                        datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                        dt.isoformat(), url, rel, size, status, attempts, err])
            print(f"[{n}/{total_in_csv}] {status} {rel} ({size}B) {err}", flush=True)
            time.sleep(args.delay)

    print(f"DONE processed={len(rows)} ok={ok} skipped_exists={skipped} "
          f"failed={failed} bytes={total_bytes} log={log_path}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
