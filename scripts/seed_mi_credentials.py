#!/usr/bin/env python3
"""把小米凭证写进私有仓（只需跑一次，之后 Action 自己维护轮换）。

哪里拿 passToken：浏览器登录 https://account.xiaomi.com 后，DevTools →
Application → Cookies → account.xiaomi.com，复制 `userId` 和 `passToken`
（也可以用 report/extract_credentials.py 从 HAR 里提取）。

用法：
  python scripts/seed_mi_credentials.py                 # 交互输入（隐藏 passToken）
  python scripts/seed_mi_credentials.py --verify        # 写完顺手验证一次登录
  MI_USER_ID=… MI_PASS_TOKEN=… python scripts/seed_mi_credentials.py

凭证只会写到私有仓 2061969365/sport-db-private/config/mi_credentials.json。
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = os.environ.get("MI_STATE_REPO", "2061969365/sport-db-private")
PATH = os.environ.get("MI_STATE_PATH", "config/mi_credentials.json")


def gh_token() -> str:
    t = os.environ.get("MI_SYNC_PAT") or os.environ.get("GITHUB_TOKEN")
    if t:
        return t
    try:
        return subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        return ""


def api(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "sportdb-seed",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


def put_creds(token: str, creds: dict) -> None:
    url = f"https://api.github.com/repos/{REPO}/contents/{PATH}"
    sha = None
    try:
        sha = api("GET", url, token).get("sha")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    body = {
        "message": "config: 小米云端凭证",
        "content": base64.b64encode(json.dumps(creds, ensure_ascii=False, indent=2).encode()).decode(),
    }
    if sha:
        body["sha"] = sha
    api("PUT", url, token, body)
    print(f"[seed] 已写入 {REPO}/{PATH}")


def verify(creds: dict) -> bool:
    tmp = Path(tempfile.gettempdir()) / "mi_seed_creds.json"
    out = Path(tempfile.gettempdir()) / "mi_seed_probe.json"
    # 教训：这两个路径绝不能相同——导出会覆盖凭证，导致轮换后的 token 丢失。
    if out == tmp:
        raise RuntimeError("creds/out 路径冲突")
    tmp.write_text(json.dumps(creds), encoding="utf-8")
    from datetime import datetime, timedelta, timezone
    bj = timezone(timedelta(hours=8))
    end = datetime.now(bj).date()
    start = end - timedelta(days=1)
    rc = subprocess.call([
        sys.executable, str(ROOT / "scripts" / "mi_fitness_export.py"),
        "--start", str(start), "--end", str(end), "--keys", "steps",
        "--token-file", str(tmp), "--out", str(out),
    ])
    if rc != 0:
        print("[seed] 验证失败：passToken 无效或账号登不上", file=sys.stderr)
        return False
    rotated = json.loads(tmp.read_text(encoding="utf-8"))
    if rotated.get("pass_token") != creds.get("pass_token"):
        print("[seed] 登录成功，passToken 已轮换，写回")
        put_creds(gh_token(), rotated)
    tmp.unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", default=os.environ.get("MI_USER_ID"))
    ap.add_argument("--pass-token", default=os.environ.get("MI_PASS_TOKEN"))
    ap.add_argument("--region", default=os.environ.get("MI_REGION", "cn"))
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--cookie", help='直接粘贴 "userId=…; passToken=…"（从 HAR/DevTools 复制）')
    a = ap.parse_args()

    token = gh_token()
    if not token:
        print("[seed] 没有可用的 GitHub token（gh auth login 或设 MI_SYNC_PAT）", file=sys.stderr)
        return 2

    uid = (a.user_id or "").strip()
    pt = (a.pass_token or "").strip()
    if a.cookie:
        for part in a.cookie.replace("\n", " ").split(";"):
            if "=" not in part:
                continue
            k, v = part.split("=", 1)
            k = k.strip().lower()
            if k == "userid":
                uid = v.strip()
            elif k == "passtoken":
                pt = v.strip()
    if not uid:
        uid = input("小米账号 userId: ").strip()
    if not pt:
        pt = getpass.getpass("passToken（隐藏输入）: ").strip()
    if not uid or not pt:
        print("[seed] userId / passToken 不能为空", file=sys.stderr)
        return 2

    creds = {"user_id": uid, "pass_token": pt, "region": a.region}
    put_creds(token, creds)
    if a.verify:
        os.environ["MI_SYNC_PAT"] = token
        return 0 if verify(creds) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
