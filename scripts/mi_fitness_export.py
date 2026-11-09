#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小米运动健康 (com.mi.health 3.59.2) 云端个人数据导出
=====================================================
依据对 3.59.2 APK 的静态逆向结果实现：

  认证链  account.xiaomi.com/pass/serviceLogin?sid=miothealth
          -> ssecurity / serviceToken / passToken(轮换) / cUserId
  签名    RC4(signed_nonce) + SHA1 校验，nonce = 8B random + 4B 分钟时间戳
  数据域  https://hlth.io.mi.com  (cn) / https://{region}.hlth.io.mi.com
  端点    /app/v1/data/get_fitness_data_by_time
          /app/v1/data/get_aggregated_fitness_data_by_time
          /app/v1/data/get_sport_records_by_time
          /healthapp/service/gen_download_url   (FDS 运动明细/GPS)

仅用于访问你本人有权访问的账号与数据。凭证不写入任何文件（除可选 --token-file）。

依赖: requests  (pip install requests)
用法:
  python mi_fitness_export.py --start 2026-01-01 --end 2026-11-08 \
      --keys steps,calories,sleep,heart_rate,weight,spo2,stress \
      --out mi_data.json --csv-dir mi_csv
  凭证优先从环境变量 MI_USER_ID / MI_PASS_TOKEN 读取，
  否则交互式提示（passToken 隐藏输入，不进 shell history）。
"""

from __future__ import annotations

import argparse
import base64
import csv
import getpass
import hashlib
import json
import os
import struct
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse

import requests

# ---------------------------------------------------------------------------
# 常量（来自逆向 / 开源适配器印证）
# ---------------------------------------------------------------------------
LOGIN_PREFIX = b"&&&START&&&"
LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=miothealth"
ALLOWED_REDIRECT_SUFFIXES = ("xiaomi.com", "mi.com")
KNOWN_REGIONS = ("ru", "cn", "de", "i2", "sg", "us")

DATA_KEYS = (
    "steps", "calories", "sleep", "heart_rate", "weight",
    "spo2", "stress", "abnormal_heart_beat",
)

# ---------------------------------------------------------------------------
# RC4 + 签名协议
# ---------------------------------------------------------------------------
def rc4(key: bytes, data: bytes) -> bytes:
    s = list(range(256))
    j = 0
    kl = len(key)
    for i in range(256):
        j = (j + s[i] + key[i % kl]) & 0xFF
        s[i], s[j] = s[j], s[i]
    i = j = 0
    out = bytearray()
    for ch in data:
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        out.append(ch ^ s[(s[i] + s[j]) & 0xFF])
    # RC4-drop1024（小米用的是丢前 1024 字节的变体）
    return bytes(out)


def rc4_drop(key: bytes, data: bytes) -> bytes:
    """小米使用 RC4-drop-1024：先用同一密钥流丢弃 1024 字节再异或。"""
    s = list(range(256))
    j = 0
    kl = len(key)
    for i in range(256):
        j = (j + s[i] + key[i % kl]) & 0xFF
        s[i], s[j] = s[j], s[i]
    i = j = 0

    def nxt():
        nonlocal i, j
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        return s[(s[i] + s[j]) & 0xFF]

    for _ in range(1024):
        nxt()
    out = bytearray()
    for ch in data:
        out.append(ch ^ nxt())
    return bytes(out)


def gen_nonce() -> bytes:
    return os.urandom(8) + struct.pack(">I", int(time.time() // 60))


def signed_nonce(ssecurity: bytes, nonce: bytes) -> bytes:
    return hashlib.sha256(ssecurity + nonce).digest()


def gen_signature(method: str, path: str, values: dict, sn: bytes) -> str:
    base = method + "&" + path + "&data=" + values["data"]
    if "rc4_hash__" in values:
        base += "&rc4_hash__=" + values["rc4_hash__"]
    base += "&" + base64.b64encode(sn).decode()
    return base64.b64encode(hashlib.sha1(base.encode()).digest()).decode()


# ---------------------------------------------------------------------------
# 客户端
# ---------------------------------------------------------------------------
class MiFitnessClient:
    def __init__(self, user_id: str, pass_token: str, region: str = "cn",
                 token_file: str | None = None, timeout: float = 20.0):
        self.user_id = user_id
        self.pass_token = pass_token
        self.region = region or "cn"
        self.token_file = token_file
        self.timeout = timeout
        self.ssecurity = b""
        self.cookies = ""
        self.session = requests.Session()
        # 国内服务直连，绕开系统代理残留
        self.session.trust_env = False

    # -- 认证 ---------------------------------------------------------------
    def login(self) -> None:
        r = self.session.get(
            LOGIN_URL,
            headers={"Cookie": f"userId={self.user_id}; passToken={self.pass_token}"},
            timeout=self.timeout,
        )
        r.raise_for_status()
        if not r.text.startswith(LOGIN_PREFIX.decode()):
            raise RuntimeError("unexpected Xiaomi login response (missing &&&START&&&)")
        payload = json.loads(r.text[len(LOGIN_PREFIX):])
        for k in ("passToken", "userId", "ssecurity", "location"):
            if not payload.get(k):
                raise RuntimeError(f"login response missing field: {k}")

        new_token = str(payload["passToken"])
        new_uid = str(payload["userId"])
        for val in (new_token, new_uid):
            if any(c.isspace() or ord(c) < 32 or c == ";" for c in val):
                raise RuntimeError("login response contains invalid auth field")

        self.ssecurity = base64.b64decode(payload["ssecurity"], validate=True)
        location = payload["location"]
        if not self._safe_redirect(location):
            raise RuntimeError("refusing untrusted login redirect location")

        rotated = new_token != self.pass_token
        self.pass_token = new_token
        self.user_id = new_uid
        if rotated:
            print(f"[*] passToken 已轮换，旧 token 已失效（cUserId={payload.get('cUserId','')}）")
            if self.token_file:
                self._save_token()

        rr = self.session.get(location, timeout=self.timeout, allow_redirects=False)
        rr.raise_for_status()
        # requests.Session 会自动归并 Set-Cookie 到 cookie jar，优先用它（最稳）
        parts = [f"{c.name}={c.value}" for c in self.session.cookies if c.value]
        # 兜底：直接从原始响应头逐条取（兼容 jar 未捕获的情况）
        if not any(p.startswith("serviceToken=") for p in parts):
            raw = rr.raw.headers
            hdrs = raw.getlist("Set-Cookie") if hasattr(raw, "getlist") else []
            parts = [h.split(";", 1)[0] for h in hdrs if h]
        if not parts:
            sc = rr.headers.get("Set-Cookie", "")
            if sc:
                parts = [sc.split(";", 1)[0]]
        if not any(p.startswith("serviceToken=") and p != "serviceToken=" for p in parts):
            raise RuntimeError("login redirect did not issue serviceToken cookie")
        self.cookies = "; ".join(p for p in parts if p)
        print(f"[+] 登录成功 serviceToken 已获取（region={self.region}）")

    @staticmethod
    def _safe_redirect(url: str) -> bool:
        if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url):
            return False
        u = urlparse(url)
        if u.scheme != "https" or u.username or u.password or u.port not in (None, 443):
            return False
        host = (u.hostname or "").lower()
        return any(host == d or host.endswith("." + d) for d in ALLOWED_REDIRECT_SUFFIXES)

    def _save_token(self):
        try:
            with open(self.token_file, "w", encoding="utf-8") as f:
                json.dump({"user_id": self.user_id, "pass_token": self.pass_token,
                           "region": self.region}, f)
            print(f"[*] 轮换后的凭证已写入 {self.token_file}（请妥善保管）")
        except OSError as e:
            print(f"[!] 凭证写回失败: {e}")

    # -- 签名请求 -----------------------------------------------------------
    @property
    def base_url(self) -> str:
        return ("https://hlth.io.mi.com" if self.region in ("", "cn")
                else f"https://{self.region}.hlth.io.mi.com")

    def request(self, api_path: str, payload: dict, sign_path: str | None = None) -> dict:
        sp = sign_path or api_path
        form = {"data": json.dumps(payload, separators=(",", ":"))}
        nonce = gen_nonce()
        sn = signed_nonce(self.ssecurity, nonce)
        form["rc4_hash__"] = gen_signature("POST", sp, form, sn)

        enc = {k: base64.b64encode(rc4_drop(sn, v.encode())).decode() for k, v in form.items()}
        enc["signature"] = gen_signature("POST", sp, enc, sn)
        enc["_nonce"] = base64.b64encode(nonce).decode()

        r = self.session.post(
            self.base_url + api_path,
            headers={"Cookie": self.cookies,
                     "Content-Type": "application/x-www-form-urlencoded"},
            data=urlencode(enc),
            timeout=self.timeout,
        )
        r.raise_for_status()
        plaintext = rc4_drop(sn, base64.b64decode(r.text))
        body = json.loads(plaintext)
        if body.get("code") != 0:
            raise RuntimeError(f"API error code={body.get('code')} msg={body.get('message')}")
        return body.get("result", {})

    # -- 时间 ---------------------------------------------------------------
    def tz(self) -> timezone:
        return timezone(timedelta(hours=8)) if self.region in ("", "cn") else timezone.utc

    def ts_range(self, start_date: str, end_date: str) -> tuple[int, int]:
        tz = self.tz()
        a = datetime.fromisoformat(start_date).replace(tzinfo=tz)
        b = datetime.fromisoformat(end_date + "T23:59:59").replace(tzinfo=tz)
        return int(a.timestamp()), int(b.timestamp())

    # -- 取数 ---------------------------------------------------------------
    def fetch_key(self, key: str, start: str, end: str) -> list[dict]:
        st, et = self.ts_range(start, end)
        nk, items, seen, page = None, [], set(), 0
        while True:
            page += 1
            if page > 200:
                raise RuntimeError("pagination exceeded safety limit")
            p = {"start_time": st, "end_time": et, "key": key}
            if nk:
                p["next_key"] = nk
            res = self.request("/app/v1/data/get_fitness_data_by_time", p)
            items.extend(res.get("data_list", []))
            if not res.get("has_more") or not res.get("next_key"):
                break
            c = str(res["next_key"])
            if c in seen:
                raise RuntimeError("pagination cursor loop")
            seen.add(c)
            nk = c
        return items

    def fetch_sleep_daily_reports(self, start: str, end: str) -> list[dict]:
        st, et = self.ts_range(start, end)
        nk, out, seen = None, [], set()
        for _ in range(200):
            p = {"key": "sleep", "tag": "daily_report", "limit": 100,
                 "start_time": st, "end_time": et}
            if nk:
                p["next_key"] = nk
            res = self.request("/app/v1/data/get_aggregated_fitness_data_by_time", p)
            out.extend(res.get("data_list", []))
            if not res.get("has_more"):
                return out
            c = res.get("next_key")
            if not isinstance(c, str) or not c or c in seen:
                raise RuntimeError("invalid daily-report cursor")
            seen.add(c)
            nk = c
        raise RuntimeError("daily-report pagination exceeded limit")

    def fetch_workouts(self, start: str, end: str) -> list[dict]:
        st, et = self.ts_range(start, end)
        nk, out, seen, page = None, [], set(), 0
        while True:
            page += 1
            if page > 200:
                raise RuntimeError("sport pagination exceeded limit")
            p = {"start_time": st, "end_time": et, "limit": 50}
            if nk:
                p["next_key"] = nk
            res = self.request("/app/v1/data/get_sport_records_by_time", p)
            out.extend(res.get("sport_records", []))
            if not res.get("has_more") or not res.get("next_key"):
                break
            c = str(res["next_key"])
            if c in seen:
                raise RuntimeError("sport cursor loop")
            seen.add(c)
            nk = c
        return out

    def gen_download_url(self, did: str, items: list[dict]) -> dict:
        """FDS 运动明细 / GPS 轨迹下载链接；签名路径需剥离 /healthapp 前缀。"""
        return self.request(
            "/healthapp/service/gen_download_url",
            {"did": did, "items": items},
            sign_path="/service/gen_download_url",
        )


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------
def write_json(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[+] JSON -> {path}")


def write_csv_dir(d: str, data: dict) -> None:
    os.makedirs(d, exist_ok=True)
    for name, rows in data.items():
        if not rows:
            continue
        p = os.path.join(d, f"{name}.csv")
        flat = []
        for row in rows:
            flat.append({k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
                         for k, v in row.items()})
        cols = sorted({k for r in flat for k in r})
        with open(p, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(flat)
        print(f"[+] CSV  -> {p} ({len(rows)} rows)")


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="小米运动健康云端个人数据导出")
    ap.add_argument("--user-id", default=os.environ.get("MI_USER_ID"))
    ap.add_argument("--pass-token", default=os.environ.get("MI_PASS_TOKEN"))
    ap.add_argument("--token-file", help="可选：passToken 轮换时写回此 JSON 文件")
    ap.add_argument("--region", default=os.environ.get("MI_REGION", "cn"),
                    help="cn/ru/de/i2/sg/us，默认 cn")
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD")
    ap.add_argument("--keys", default=",".join(DATA_KEYS),
                    help="逗号分隔: " + ",".join(DATA_KEYS))
    ap.add_argument("--workouts", action="store_true", help="额外拉取运动记录列表")
    ap.add_argument("--sleep-daily", action="store_true", help="额外拉取每日聚合睡眠报告(补睡眠评分)")
    ap.add_argument("--out", default="mi_fitness.json")
    ap.add_argument("--csv-dir", help="可选：每类数据额外导出 CSV 的目录")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args()

    uid = args.user_id
    pt = args.pass_token
    if args.token_file and os.path.exists(args.token_file) and (not uid or not pt):
        try:
            t = json.load(open(args.token_file, encoding="utf-8"))
            uid = uid or t.get("user_id")
            pt = pt or t.get("pass_token")
            if not args.region or args.region == "cn":
                args.region = t.get("region", args.region)
        except Exception as e:
            print(f"[!] 读取 token-file 失败: {e}")
    if not uid:
        uid = input("小米账号 userId: ").strip()
    if not pt:
        pt = getpass.getpass("passToken (隐藏输入): ").strip()
    if not uid or not pt:
        print("缺少凭证", file=sys.stderr)
        return 2

    c = MiFitnessClient(uid, pt, args.region, args.token_file, args.timeout)
    try:
        c.login()
    except Exception as e:
        print(f"[x] 登录失败: {e}", file=sys.stderr)
        return 1

    result: dict = {
        "meta": {
            "user_id": c.user_id, "region": c.region,
            "start": args.start, "end": args.end,
            "base_url": c.base_url,
            "exported_at": datetime.now().isoformat(),
        }
    }
    keys = [k.strip() for k in args.keys.split(",") if k.strip()]
    for k in keys:
        try:
            rows = c.fetch_key(k, args.start, args.end)
            result[k] = rows
            print(f"[+] {k}: {len(rows)} 条")
        except Exception as e:
            print(f"[!] {k} 失败: {e}")
            result[k] = []

    if args.workouts:
        try:
            w = c.fetch_workouts(args.start, args.end)
            result["workouts"] = w
            print(f"[+] workouts: {len(w)} 条")
        except Exception as e:
            print(f"[!] workouts 失败: {e}")

    if args.sleep_daily:
        try:
            s = c.fetch_sleep_daily_reports(args.start, args.end)
            result["sleep_daily_reports"] = s
            print(f"[+] sleep_daily_reports: {len(s)} 条")
        except Exception as e:
            print(f"[!] sleep_daily_reports 失败: {e}")

    write_json(args.out, result)
    if args.csv_dir:
        write_csv_dir(args.csv_dir, {k: v for k, v in result.items() if k != "meta"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
