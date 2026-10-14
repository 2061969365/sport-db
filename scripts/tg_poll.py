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
sys.path.insert(0, str(REPO_ROOT / "scripts"))
try:
    from ai_image import (append_workout, call_vision, route_result,
                          tile_image, to_workout_row)
    HAVE_VISION = True
except ImportError:
    HAVE_VISION = False
BJ = timezone(timedelta(hours=8))
API = "https://api.telegram.org"
GATEWAY_UA = "sport-db/1.0 (compatible; +https://github.com)"
DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
RUN_TYPES = ("outdoor_running", "indoor_running", "outdoor_run_class")
STATE_FILE = REPO_ROOT / "bot_state" / "tg_offset.txt"
HIST_DIR = REPO_ROOT / "bot_state" / "tg_history"
HISTORY_KEEP = 12
HISTORY_SEND = 8
HISTORY_CHARS = 6000


def load_history(chat_id: int) -> list:
    """读某会话历史。公开仓注意: 内容会进 git, 介意配 TG_HISTORY=off。"""
    if (os.environ.get("TG_HISTORY") or "").strip().lower() == "off":
        return []
    try:
        arr = json.loads((HIST_DIR / f"{chat_id}.json").read_text(encoding="utf-8"))
        return [m for m in arr if isinstance(m, dict)
                and m.get("role") in ("user", "assistant")
                and isinstance(m.get("content"), str)][-HISTORY_KEEP:]
    except (OSError, ValueError):
        return []


def save_history(chat_id: int, hist: list) -> None:
    if (os.environ.get("TG_HISTORY") or "").strip().lower() == "off":
        return
    hist = hist[-HISTORY_KEEP:]
    total = sum(len(m.get("content", "")) for m in hist)
    while len(hist) > 2 and total > HISTORY_CHARS:
        total -= len(hist.pop(0).get("content", ""))
    HIST_DIR.mkdir(parents=True, exist_ok=True)
    (HIST_DIR / f"{chat_id}.json").write_text(
        json.dumps(hist, ensure_ascii=False), encoding="utf-8")


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


def summarize_30d(data_dir: Path, days: int = 30) -> str:
    """近 30 天一句话画像 (data/workouts/YYYY.csv, 与 build_report 口径对齐)。"""
    rows = []
    for fp in sorted((data_dir / "workouts").glob("*.csv")):
        with open(fp, encoding="utf-8-sig", newline="") as f:
            rows.extend(list(csv.DictReader(f)))
    if not rows:
        return "库里还没有运动记录。"
    today = datetime.now(BJ).date()
    cutoff = today - timedelta(days=days)
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
    act_days = {r["date"] for r in recent if r.get("date")}
    out = [f"近{days}天共运动{len(recent)}次, 活跃{len(act_days)}天 (今天{today})。"]
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


EDITABLE_FIELDS = ("distance_m", "duration_s", "avg_pace_s", "avg_hr",
                   "max_hr", "min_hr", "calories", "steps", "cadence", "type")

AGENT_TOOLS = [
    {"type": "function", "function": {
        "name": "get_summary",
        "description": "查近N天分项画像(跑步/骑行分开)。画像里已有30天摘要, 要其它天数才调。",
        "parameters": {"type": "object", "properties": {
            "days": {"type": "integer", "description": "近N天, 1-90"}}}}},
    {"type": "function", "function": {
        "name": "query_workouts",
        "description": "按条件查原始记录明细(含id)。改数据前必须先查到id。",
        "parameters": {"type": "object", "properties": {
            "type": {"type": "string", "description": "如 outdoor_running, 不限填空"},
            "date_from": {"type": "string", "description": "YYYY-MM-DD"},
            "date_to": {"type": "string", "description": "YYYY-MM-DD"},
            "limit": {"type": "integer", "description": "默认10, 最多30"}}}}},
    {"type": "function", "function": {
        "name": "update_workout",
        "description": "按id改一条记录。只能改用户明确说的字段, 先query确认。",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "string", "description": "query_workouts 给的id"},
            "fields": {"type": "object",
                       "description": "字段名->新值, 允许: 距离米distance_m/秒duration_s/配速avg_pace_s/心率avg_hr,max_hr,min_hr/卡路里calories/步数steps/步频cadence/类型type"}}}}},
]

AGENT_SYS = (
    "你是一名懂数据的跑步教练, 也是这个运动库的管理员, 简短口语中文回答 (200字内)。"
    "规则: 只用数据说话, 跑步是跑步、骑行是骑行, 配速只谈跑步; "
    "先给一句话结论, 再给1-2条带数字的具体建议; 没有的就说不知道, 不编数据; 只谈训练恢复。"
    "改库规则: 用户说改数时, 必须先调 query_workouts 找到那条的 id 再调 update_workout, "
    "一次只改用户明确说的字段, 改完用中文报出改了哪条、旧值->新值; 不确定的先问。"
    "用户画像(近30天摘要): ")


def read_all_rows(data_dir: Path) -> list[dict]:
    rows = []
    for fp in sorted((data_dir / "workouts").glob("*.csv")):
        with open(fp, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                r["_file"] = str(fp)
                rows.append(r)
    return rows


def tool_get_summary(args: dict) -> str:
    try:
        d = min(90, max(1, int(args.get("days") or 30)))
    except (TypeError, ValueError):
        d = 30
    return summarize_30d(REPO_ROOT / "data", days=d)


def tool_query_workouts(args: dict) -> str:
    try:
        lim = min(30, max(1, int(args.get("limit") or 10)))
    except (TypeError, ValueError):
        lim = 10
    out = []
    for r in read_all_rows(REPO_ROOT / "data"):
        if args.get("type") and r.get("type") != args["type"]:
            continue
        if args.get("date_from") and (r.get("date") or "") < args["date_from"]:
            continue
        if args.get("date_to") and (r.get("date") or "") > args["date_to"]:
            continue
        out.append({k: r.get(k, "") for k in (
            "id", "date", "type", "distance_m", "duration_s",
            "avg_pace_s", "avg_hr", "max_hr", "steps", "source")})
    out.sort(key=lambda r: (r.get("date", ""), r.get("id", "")))
    return json.dumps(out[-lim:], ensure_ascii=False)


def tool_update_workout(args: dict) -> str:
    wid = (args.get("id") or "").strip()
    fields = args.get("fields") or {}
    if not wid or not isinstance(fields, dict) or not fields:
        return "失败: 缺 id 或 fields 为空。"
    bad = [k for k in fields if k not in EDITABLE_FIELDS]
    if bad:
        return f"失败: 不允许改 {bad}, 只能改 {list(EDITABLE_FIELDS)}。"
    for fp in sorted((REPO_ROOT / "data" / "workouts").glob("*.csv")):
        with open(fp, encoding="utf-8-sig", newline="") as f:
            rd = csv.DictReader(f)
            rows = list(rd)
            cols = rd.fieldnames or []
        for r in rows:
            if r.get("id") != wid:
                continue
            old = {k: r.get(k, "") for k in fields}
            for k, v in fields.items():
                r[k] = "" if v is None else str(v)
            if "type" in fields:
                r["category"] = fields["type"]
            with open(fp, "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=cols)
                w.writeheader()
                w.writerows(rows)
            return (f"已改 {wid} ({r.get('date')} {r.get('type')}): "
                    + "; ".join(f"{k} {old[k]}->{r[k]}" for k in fields))
    return f"失败: 找不到 id={wid}, 先调 query_workouts 确认。"


def chat_call(endpoint: str, model: str, messages: list,
              tools: list | None = None) -> dict:
    body: dict = {"model": model, "messages": messages}
    if tools:
        body["tools"] = tools
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
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["choices"][0]["message"]


def run_agent(question: str, profile: str, endpoint: str,
              model: str, max_steps: int = 4,
              history: list | None = None) -> str:
    """问答 + 工具循环: 查数、改数都能干, 最多 max_steps 轮工具调用。
    history: 该会话此前 user/assistant 轮次(只取 role/content), 起承转合靠它。"""
    messages: list = [
        {"role": "system", "content": AGENT_SYS + profile},
    ]
    for m in (history or [])[-HISTORY_SEND:]:
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": question})
    fns = {"get_summary": tool_get_summary,
           "query_workouts": tool_query_workouts,
           "update_workout": tool_update_workout}
    for _ in range(max_steps):
        msg = chat_call(endpoint, model, messages, AGENT_TOOLS)
        calls = msg.get("tool_calls") or []
        text = (msg.get("content") or "").strip()
        if not calls:
            return text or "刚没想出来, 换个问法再试一次?"
        messages.append({"role": "assistant", "content": text,
                         "tool_calls": calls})
        for c in calls:
            fn = (c.get("function") or {}).get("name", "")
            try:
                argv = json.loads((c.get("function") or {}).get("arguments") or "{}")
            except ValueError:
                argv = {}
            try:
                result = fns[fn](argv) if fn in fns else f"未知工具 {fn}"
            except Exception as e:  # noqa: BLE001 - 工具失败回给模型继续
                result = f"工具 {fn} 出错: {type(e).__name__}: {e}"
            messages.append({"role": "tool", "tool_call_id": c.get("id", ""),
                             "content": str(result)[:4000]})
    tail = chat_call(endpoint, model, messages + [
        {"role": "user", "content": "按上面工具结果直接给用户最终答复。"}])
    return (tail.get("content") or "").strip() or "查到了, 但组织回答时卡住了, 再问我一次?"


def send_long(token: str, chat_id: int, text: str, reply_to: int) -> None:
    text = text or "刚没想出来, 换个问法再试一次?"
    for i in range(0, len(text), 3500):
        tg("sendMessage", token, {"chat_id": chat_id,
                                  "text": text[i:i + 3500],
                                  "reply_to_message_id": reply_to})


def pick_image_file_id(msg: dict) -> str:
    """照片取最大尺寸; 文件形式的图片按 document 收 (mime image/*)。"""
    photos = msg.get("photo") or []
    if photos:
        return photos[-1].get("file_id", "")
    doc = msg.get("document") or {}
    if (doc.get("mime_type") or "").startswith("image/"):
        return doc.get("file_id", "")
    return ""


def download_tg_file(token: str, file_id: str) -> bytes:
    info = tg("getFile", token, {"file_id": file_id})
    path = (info.get("result") or {}).get("file_path", "")
    if not path:
        raise ValueError("getFile 无 file_path")
    req = urllib.request.Request(
        f"{API}/file/bot{token}/{path}",
        headers={"User-Agent": GATEWAY_UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def handle_photo(token: str, chat_id: int, mid: int, file_id: str,
                 caption: str, profile: str, endpoint: str,
                 model: str, hist: list) -> str:
    """收图 -> 切片识别 -> 路由入库/待审, 附言一并理解。返回回复文本。"""
    if not HAVE_VISION:
        return "收图模块缺 Pillow, 已记 quarantine, 修好依赖后重发一次。"
    raw = download_tg_file(token, file_id)
    print(f"图片 {len(raw) // 1024}KB")
    tmp = REPO_ROOT / "bot_state" / f"tg-{chat_id}-{mid}.jpg"
    tmp.write_bytes(raw)
    try:
        tiles = tile_image(tmp)
        print("tiles=" + ",".join(f"{len(b) // 1024}KB" for b, _ in tiles))
        (first_b, first_m), rest = tiles[0], tiles[1:]
        rec = call_vision(first_b, first_m, endpoint=endpoint,
                          model=model, timeout_s=300, more=rest)
    finally:
        tmp.unlink(missing_ok=True)
    decision, reason = route_result(rec)
    date = ""
    try:
        date = datetime.fromisoformat(
            rec.get("start_time") or "").astimezone(BJ).strftime("%Y-%m-%d")
    except ValueError:
        date = ""
    if not date:
        date = datetime.now(BJ).strftime("%Y-%m-%d")
    y, m, d = date.split("-")
    if decision == "direct":
        img_rel = f"images/{y}/{m}/{d}-tg{mid}.jpg"
        (REPO_ROOT / img_rel).parent.mkdir(parents=True, exist_ok=True)
        (REPO_ROOT / img_rel).write_bytes(raw)
        row = to_workout_row(rec, img_rel)
        append_workout(REPO_ROOT / "data" / "workouts", row)
        line = (f"已入库: {row['date']} {rec.get('type')} "
                f"{rec.get('distance_km')}km/{rec.get('duration_s')}s "
                f"(confidence {rec.get('confidence', 0):.2f})")
    else:
        ts = datetime.now(BJ).strftime("%Y%m%d-%H%M%S")
        rp = REPO_ROOT / "review"
        rp.mkdir(parents=True, exist_ok=True)
        (rp / f"needs-review-tg{mid}-{ts}.json").write_text(
            json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        (rp / f"tg{mid}-{ts}.jpg").write_bytes(raw)
        line = f"这张没看清 ({reason}), 已进 review 等你确认, 先别删原图。"
    if caption:
        try:
            follow = run_agent(
                f"[用户发了一张运动截图并附言: {caption}]\n"
                f"[截图识别结果: {json.dumps(rec, ensure_ascii=False)}]\n"
                f"[入库情况: {line}]\n请先报入库情况, 再回答附言。",
                profile, endpoint, model, history=hist)
            return follow
        except Exception as e:  # noqa: BLE001
            return line + f" (附言理解失败 {type(e).__name__}, 图已处理)。"
    return line


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
        chat_id = msg.get("chat", {}).get("id")
        if not chat_id:
            continue
        mid = msg["message_id"]
        who = msg.get("from", {}).get("username", "?")
        file_id = pick_image_file_id(msg)
        if file_id:
            caption = (msg.get("caption") or "").strip()
            print(f"收到 @{who} 图片 {file_id[:16]}.. 附言: {caption[:60]}")
            try:
                hist = load_history(chat_id)
                answer = handle_photo(token, chat_id, mid, file_id,
                                      caption, profile, endpoint, model, hist)
            except Exception as e:  # noqa: BLE001
                answer = f"这张图处理失败 ({type(e).__name__}), 已跳过, 换张清晰的再发一次。"
            send_long(token, chat_id, answer, mid)
            hist = load_history(chat_id)
            hist += [{"role": "user",
                      "content": f"[发了一张运动截图]{(' 附言: ' + caption) if caption else ''}"[:500]},
                     {"role": "assistant", "content": answer[:2000]}]
            save_history(chat_id, hist)
            print(f"已回图 {chat_id}: {answer[:80]}")
            continue
        if not text:
            continue
        print(f"收到 @{who}: {text[:80]}")
        if text.startswith("/start"):
            send_long(token, chat_id,
                      "SportDB 教练+管理员上线!问训练按近30天数据答, "
                      "运动截图直接发图自动识别入库, 数据错了跟我说改, "
                      "如: 把昨天那条配速改成300。试试: 这周跑量能加点吗", mid)
            continue
        try:
            hist = load_history(chat_id)
            answer = run_agent(text, profile, endpoint, model, history=hist)
        except Exception as e:  # noqa: BLE001 - 单条失败不阻塞其它
            answer = f"网关开小差了 ({type(e).__name__}), 稍后重发一次试试。"
        send_long(token, chat_id, answer, mid)
        hist = load_history(chat_id)
        hist += [{"role": "user", "content": text[:2000]},
                 {"role": "assistant", "content": answer[:2000]}]
        save_history(chat_id, hist)
        print(f"已回 {chat_id}: {answer[:80]}")
    STATE_FILE.write_text(str(newest), encoding="utf-8")
    print(f"offset {offset} -> {newest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
