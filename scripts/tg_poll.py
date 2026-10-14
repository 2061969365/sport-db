#!/usr/bin/env python3
"""Telegram 轮询桥 (bot-poll.yml 每 5 分钟跑一次, 免 Cloudflare)。

流程: getUpdates(带 offset, state 存 bot_state/tg_offset.txt)
  -> 新消息取 text -> data/workouts/*.csv 算近 30 天摘要
  -> 调 VISION_ENDPOINT/VISION_MODEL (默认 muse-spark-1.3-contributor-free,
     免 Key, 不限 max_tokens, UA 头与 ai_image.py 一致)
  -> sendMessage 回复 (超长按 3500 字切) -> offset 前进并由工作流回写。

Env: TG_BOT_TOKEN (Secret, 必填), VISION_ENDPOINT (必填),
     VISION_MODEL (默认见下), VISION_MAX_TOKENS (可选封顶)。
注意: webhook 与 getUpdates 互斥, 上了 Worker 后先调 deleteWebhook。
标准库 only。
"""

from __future__ import annotations

import csv
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BJ = timezone(timedelta(hours=8))
API = "https://api.telegram.org"
GATEWAY_UA = "sport-db/1.0 (compatible; +https://github.com)"
DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
RUN_TYPES = ("outdoor_running", "indoor_running", "outdoor_run_class")
STATE_FILE = REPO_ROOT / "bot_state" / "tg_offset.txt"


def tg(method: str, token: str, payload: dict | None = None,
       timeout_s: int = 60) -> dict:
    body = json.dumps(payload or {}).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{API}/bot{token}/{method}", data=body,
        headers={"Content-Type": "application/json",
                 "User-Agent": GATEWAY_UA},
        method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        return json.load(r)


def summarize_30d(data_dir: Path) -> str:
    """近 30 天一句话画像 (data/workouts/YYYY.csv, 与 build_report 口径对齐)。"""
    rows = []
    for fp in sorted((data_dir / "workouts").glob("*.csv")):
        with open(fp, encoding="utf-8-sig", newline="") as f:
            rows.extend(list(csv.DictReader(f)))
    if not rows:
        return "库里还没有运动记录。"
    today = datetime.now(BJ).date()
    cutoff = today - timedelta(days=30)
    recent = [r for r in rows if r.get("date", "") >= cutoff.isoformat()]
    if not recent:
        return f"近 30 天无运动 (库共 {len(rows)} 条, 最新 {max(r['date'] for r in rows)}), 今天 {today}。"
    def num(v) -> float:
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    def grp(r) -> str:
        t = r.get("type") or ""
        if t in RUN_TYPES:
            return "跑步"
        if "riding" in t:
            return "骑行"
        if "walk" in t:
            return "步行"
        if "swim" in t:
            return "游泳"
        if "skip" in t:
            return "跳绳"
        return "综合训练"

    def fmt_pace(s: float) -> str:
        return "%d'%02d\"/km" % (int(s // 60), int(s % 60))

    by_grp: dict[str, list] = {}
    for r in recent:
        by_grp.setdefault(grp(r), []).append(r)
    days = {r["date"] for r in recent if r.get("date")}
    out = [f"近30天共运动{len(recent)}次, 活跃{len(days)}天 (今天{today})。"]
    runs = by_grp.get("跑步", [])
    if runs:
        pd = sum(num(r["distance_m"]) for r in runs)
        pt = sum(num(r["duration_s"]) for r in runs)
        hrs = [num(r["avg_hr"]) for r in runs if num(r["avg_hr"])]
        seg = f"跑步{len(runs)}次共{pd / 1000.0:.1f}km"
        if pd > 0 and pt > 0:
            seg += f", 均配速{fmt_pace(pt / (pd / 1000.0))}"
        if hrs:
            seg += f", 均心率{sum(hrs) / len(hrs):.0f}bpm"
        out.append(seg + "。")
    for name in ("骑行", "步行", "游泳", "跳绳", "综合训练"):
        rs = by_grp.get(name, [])
        if rs:
            out.append(f"{name}{len(rs)}次共{sum(num(r['distance_m']) for r in rs) / 1000.0:.1f}km。")
    steps = sum(int(num(r["steps"])) for r in recent)
    if steps:
        out.append(f"累计步数{steps}。")
    last = max(recent, key=lambda r: (r.get("date", ""), r.get("start_utc", "0")))
    out.append(f"最近一次: {last.get('date')} {grp(last)}"
               f"{num(last.get('distance_m')) / 1000:.2f}km"
               f"用时{num(last.get('duration_s')) / 60:.0f}分钟。")
    return "\n".join(out)


def ask_gateway(question: str, profile: str, endpoint: str,
                model: str, timeout_s: int = 300) -> str:
    body: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": (
                "你是一名懂数据的跑步教练, 简短口语中文回答 (200字内)。"
                "规则: 只用画像数据说话, 跑步是跑步、骑行是骑行, "
                "配速只谈跑步; 先给一句话结论, 再给1-2条带数字的具体建议; "
                "画像里没有的就说不知道, 不编数据; 只谈训练恢复。"
                "用户画像: " + profile)},
            {"role": "user", "content": question},
        ],
    }
    cap = (os.environ.get("VISION_MAX_TOKENS") or "").strip()
    if cap:
        try:
            body["max_tokens"] = int(cap)
        except ValueError:
            pass
    req = urllib.request.Request(
        endpoint, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": GATEWAY_UA})
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        resp = json.load(r)
    return (resp["choices"][0]["message"].get("content") or "").strip()


def send_long(token: str, chat_id: int, text: str, reply_to: int) -> None:
    text = text or "刚没想出来, 换个问法再试一次?"
    for i in range(0, len(text), 3500):
        tg("sendMessage", token, {"chat_id": chat_id,
                                  "text": text[i:i + 3500],
                                  "reply_to_message_id": reply_to})


def main() -> int:
    token = os.environ.get("TG_BOT_TOKEN", "")
    endpoint = os.environ.get("VISION_ENDPOINT", "")
    model = os.environ.get("VISION_MODEL", "") or DEFAULT_MODEL
    if not token or not endpoint:
        print("缺少 TG_BOT_TOKEN / VISION_ENDPOINT, 跳过")
        return 0
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        offset = int(STATE_FILE.read_text(encoding="utf-8").strip() or "0")
    except (OSError, ValueError):
        offset = 0
    updates = tg("getUpdates", token,
                 {"offset": offset, "timeout": 0}).get("result", [])
    if not updates:
        print(f"无新消息 (offset={offset})")
        return 0
    profile = summarize_30d(REPO_ROOT / "data")
    print("画像:", profile)
    newest = offset
    for u in updates:
        newest = max(newest, int(u.get("update_id", 0)) + 1)
        msg = u.get("message") or u.get("edited_message") or {}
        text = (msg.get("text") or "").strip()
        if not text:
            continue
        chat_id = msg["chat"]["id"]
        mid = msg["message_id"]
        who = msg.get("from", {}).get("username", "?")
        print(f"收到 @{who}: {text[:80]}")
        if text.startswith("/start"):
            send_long(token, chat_id,
                      "SportDB 教练上线!直接问训练问题, 我按你库里近30天数据回答。"
                      "如: 这周跑量能加点吗 / 心率偏高怎么办", mid)
            continue
        try:
            answer = ask_gateway(text, profile, endpoint, model)
        except Exception as e:  # noqa: BLE001 - 单条失败不阻塞其它
            answer = f"网关开小差了 ({type(e).__name__}), 稍后重发一次试试。"
        send_long(token, chat_id, answer, mid)
        print(f"已回 {chat_id}: {answer[:80]}")
    STATE_FILE.write_text(str(newest), encoding="utf-8")
    print(f"offset {offset} -> {newest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
