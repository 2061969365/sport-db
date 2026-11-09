#!/usr/bin/env python3
"""小米云端同步（GitHub Actions / 本地都能跑）。

做四件事：
 1. 从私有仓取凭证（userId + passToken）；本地也可用 --creds 指定文件；
 2. 调 scripts/mi_fitness_export.py 拉最近 N 天（默认 7 天）；
 3. 调 scripts/import_mi_cloud.py 合并进 data/workouts + data/daily；
 4. passToken 轮换后写回私有仓（否则下次登录会失效）。

凭证文件格式（私有仓 config/mi_credentials.json）：
  {"user_id": "…", "pass_token": "…", "region": "cn"}

环境变量：
  MI_SYNC_PAT   读写私有仓的 PAT（Actions 里是 secret，本地可用 GITHUB_TOKEN）
  MI_STATE_REPO 默认 2061969365/sport-db-private
  MI_STATE_PATH 默认 config/mi_credentials.json

用法：
  python scripts/mi_sync.py --days 7
  python scripts/mi_sync.py --days 365          # 全量回填
  python scripts/mi_sync.py --creds ./mi_credentials.json
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJ = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPO = "2061969365/sport-db-private"
DEFAULT_PATH = "config/mi_credentials.json"


def api(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "sportdb-mi-sync",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


def fetch_creds(repo: str, path: str, token: str) -> tuple[dict, str | None]:
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    d = api("GET", url, token)
    raw = base64.b64decode(d["content"])
    return json.loads(raw.decode("utf-8")), d.get("sha")


def push_creds(repo: str, path: str, token: str, creds: dict, sha: str | None, reason: str) -> bool:
    """写回私有仓；失败重试 3 次（409 说明被别处改过，重取 sha 再来）。"""
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    body = {
        "message": f"bot: {reason}",
        "content": base64.b64encode(
            json.dumps(creds, ensure_ascii=False, indent=2).encode()).decode(),
    }
    for attempt in range(3):
        try:
            cur = sha
            if cur is None:
                cur = api("GET", url, token).get("sha")
            payload = dict(body)
            if cur:
                payload["sha"] = cur
            api("PUT", url, token, payload)
            return True
        except urllib.error.HTTPError as e:
            if e.code in (409, 422):
                sha = None  # 重新取 sha
            elif e.code in (401, 403):
                print(f"[mi-sync] 写回凭证失败：PAT 无权限（HTTP {e.code}）", file=sys.stderr)
                return False
            if attempt == 2:
                print(f"[mi-sync] 写回凭证失败：HTTP {e.code}", file=sys.stderr)
                return False
            time.sleep(2 * (attempt + 1))
        except Exception as e:
            if attempt == 2:
                print(f"[mi-sync] 写回凭证失败：{e}", file=sys.stderr)
                return False
            time.sleep(2 * (attempt + 1))
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7, help="回溯天数（含今天）")
    ap.add_argument("--creds", help="本地凭证 JSON；不填则从私有仓取")
    ap.add_argument("--state-repo", default=os.environ.get("MI_STATE_REPO", DEFAULT_REPO))
    ap.add_argument("--state-path", default=os.environ.get("MI_STATE_PATH", DEFAULT_PATH))
    ap.add_argument("--keep-json", action="store_true", help="保留导出的 mi_fitness.json")
    a = ap.parse_args()

    token = os.environ.get("MI_SYNC_PAT") or os.environ.get("GITHUB_TOKEN") or ""
    sha = None
    if a.creds:
        creds_path = Path(a.creds)
        if not creds_path.exists():
            print(f"[mi-sync] 找不到凭证文件 {creds_path}", file=sys.stderr)
            return 2
        creds = json.loads(creds_path.read_text(encoding="utf-8"))
        creds_file = creds_path
    else:
        if not token:
            print("[mi-sync] 缺少 MI_SYNC_PAT（读写私有仓的 PAT）", file=sys.stderr)
            return 2
        try:
            creds, sha = fetch_creds(a.state_repo, a.state_path, token)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"[mi-sync] 私有仓里没有 {a.state_path} —— 先在本地跑 "
                      f"`python scripts/seed_mi_credentials.py` 种子化凭证", file=sys.stderr)
                return 2
            print(f"[mi-sync] 取凭证失败：HTTP {e.code}", file=sys.stderr)
            return 2
        tmpdir = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir())
        creds_file = tmpdir / "mi_credentials.json"
        creds_file.write_text(json.dumps(creds), encoding="utf-8")

    if not creds.get("user_id") or not creds.get("pass_token"):
        print("[mi-sync] 凭证文件缺 user_id / pass_token", file=sys.stderr)
        return 2

    before = hashlib.sha256(creds_file.read_bytes()).hexdigest()
    end = datetime.now(BJ).date()
    start = end - timedelta(days=max(0, a.days - 1))
    out = Path(tempfile.gettempdir()) / "mi_fitness.json"

    print(f"[mi-sync] 拉取 {start} ~ {end}（region={creds.get('region', 'cn')}）")
    cmd = [sys.executable, str(ROOT / "scripts" / "mi_fitness_export.py"),
           "--start", str(start), "--end", str(end),
           "--workouts", "--sleep-daily",
           "--token-file", str(creds_file), "--out", str(out)]
    rc = subprocess.call(cmd)

    # 登录只要成功就可能轮换 token，所以「先写回、再导入」：
    # 否则导入一失败，新的 passToken 就丢了，下次直接登不上。
    after_bytes = creds_file.read_bytes()
    if hashlib.sha256(after_bytes).hexdigest() != before:
        try:
            new_creds = json.loads(after_bytes.decode("utf-8"))
        except Exception:
            new_creds = {}
        if new_creds.get("user_id") and new_creds.get("pass_token"):
            new_creds.setdefault("region", creds.get("region", "cn"))
            if a.creds:
                print("[mi-sync] passToken 已轮换，写回本地凭证文件")
            elif push_creds(a.state_repo, a.state_path, token, new_creds, sha,
                            f"更新小米 passToken {datetime.now(BJ):%Y-%m-%d}"):
                print("[mi-sync] passToken 已轮换，已写回私有仓")
            env_file = os.environ.get("GITHUB_ENV")
            if env_file:
                with open(env_file, "a", encoding="utf-8") as f:
                    f.write("MI_TOKEN_CHANGED=1\n")
        else:
            print("[mi-sync] 凭证文件被改写但字段不完整，跳过写回", file=sys.stderr)
    else:
        print("[mi-sync] passToken 未变化")

    if rc != 0:
        print(f"[mi-sync] 导出失败（退出码 {rc}）——passToken 可能已失效，"
              f"重新跑 scripts/seed_mi_credentials.py", file=sys.stderr)
        return rc

    rc = subprocess.call([sys.executable, str(ROOT / "scripts" / "import_mi_cloud.py"),
                          "--src", str(out)])
    if rc != 0:
        print(f"[mi-sync] 导入失败（退出码 {rc}）", file=sys.stderr)
        return rc

    if not a.keep_json:
        out.unlink(missing_ok=True)
    print("[mi-sync] 完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
