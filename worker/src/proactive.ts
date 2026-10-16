// 主动教练的"该不该开口"判断：纯函数，输入运动记录，输出该提醒的信号。
// 设计原则：宁可少说也别啰嗦 —— 没信号就闭嘴；有信号也只给一条最有价值的。
// 不调模型、不花 token，模板化输出数字，避免自动消息里出现幻觉。
// 注：这里用显式 .ts 后缀，好让 node --test 直接跑测试（tsconfig 已开 allowImportingTsExtensions）。
import { RUN_TYPES, num, type Row } from "./github.ts";

export interface Signal {
  /** 去重键：同一天同一信号不重复推 */
  key: string;
  /** 严重度：越大越值得说 */
  weight: number;
  text: string;
}

const day = (iso: string): number => Date.parse(`${iso}T12:00:00+08:00`);
const CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 北京时间今天（YYYY-MM-DD） */
export function bjToday(now = Date.now()): string {
  return new Date(now + 8 * 36e5).toISOString().slice(0, 10);
}

function shift(dateStr: string, days: number): string {
  return new Date(day(dateStr) + days * 864e5).toISOString().slice(0, 10);
}

/** 两条日期差（天） */
function diffDays(a: string, b: string): number {
  return Math.round((day(a) - day(b)) / 864e5);
}

function runKm(rows: Row[]): number {
  return rows.filter((r) => RUN_TYPES.includes(r.type || ""))
    .reduce((a, w) => a + num(w.distance_m), 0) / 1000;
}

function inRange(rows: Row[], from: string, to: string): Row[] {
  return rows.filter((r) => (r.date || "") >= from && (r.date || "") <= to);
}

/**
 * 分析该不该主动开口。无信号返回空数组。
 * 阈值都偏保守：宁可漏报，也不要天天打扰。
 */
export function analyzeSignals(all: Row[], now = Date.now()): Signal[] {
  const today = bjToday(now);
  const dated = all.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date || ""));
  if (!dated.length) return [];
  const out: Signal[] = [];
  const last7 = inRange(dated, shift(today, -6), today);
  const prev7 = inRange(dated, shift(today, -13), shift(today, -7));
  const last30 = inRange(dated, shift(today, -29), today);

  // 1) 太久没动
  const lastDay = dated.map((r) => r.date).sort().at(-1) as string;
  const idle = diffDays(today, lastDay);
  if (idle >= 4) {
    out.push({
      key: `idle-${today}`,
      weight: 70 + Math.min(idle, 10),
      text: `已经 **${idle} 天**没有训练记录了（上次 ${lastDay} ${CN[new Date(day(lastDay)).getUTCDay()]}）。`
        + "如果只是没记录，把截图发我就行；如果是累了，那正好，休息也是训练的一部分。",
    });
  }

  // 2) 跑量骤降
  const km7 = runKm(last7), kmPrev = runKm(prev7);
  if (kmPrev >= 8 && km7 < kmPrev * 0.6) {
    const pct = Math.round((1 - km7 / kmPrev) * 100);
    out.push({
      key: `volume-drop-${today}`,
      weight: 60,
      text: `本周跑量 **${km7.toFixed(1)}km**，比上周（${kmPrev.toFixed(1)}km）少了 **${pct}%**。`
        + "是刻意减量还是被事情挤掉了？如果是后者，明天补一次轻松跑就能把节奏接回来。",
    });
  }

  // 3) 跑量骤增（受伤风险）
  if (kmPrev >= 5 && km7 > kmPrev * 1.8 && km7 >= 15) {
    out.push({
      key: `volume-spike-${today}`,
      weight: 75,
      text: `本周跑量 **${km7.toFixed(1)}km**，比上周（${kmPrev.toFixed(1)}km）涨了 **${Math.round((km7 / kmPrev - 1) * 100)}%**。`
        + "单周涨幅超过 10~20% 是常见的伤病诱因，注意别把长距离和强度课排在一起。",
    });
  }

  // 4) 心率漂移：最近三次 vs 30 天基线
  const runs30 = last30.filter((r) => RUN_TYPES.includes(r.type || "") && num(r.avg_hr) > 0);
  const last3 = runs30.slice(-3);
  if (last3.length === 3 && runs30.length >= 8) {
    const base = runs30.slice(0, -3).reduce((a, w) => a + num(w.avg_hr), 0) / (runs30.length - 3);
    const recent = last3.reduce((a, w) => a + num(w.avg_hr), 0) / 3;
    if (recent >= base + 8) {
      out.push({
        key: `hr-drift-${today}`,
        weight: 65,
        text: `最近三次平均心率 **${Math.round(recent)}**，比你 30 天基线（${Math.round(base)}）高了 `
          + `**${Math.round(recent - base)}** 次/分。同配速下心率抬高通常是疲劳或睡眠不足，`
          + "这周把轻松跑再放慢一点，别硬顶强度。",
      });
    }
  }

  // 5) 单月新高
  const month = today.slice(0, 7);
  const monthKm = runKm(dated.filter((r) => (r.date || "").startsWith(month)));
  const best = new Map<string, number>();
  for (const r of dated) {
    const m = (r.date || "").slice(0, 7);
    if (m === month) continue;
    best.set(m, (best.get(m) || 0) + (RUN_TYPES.includes(r.type || "") ? num(r.distance_m) : 0) / 1000);
  }
  const prevBest = Math.max(0, ...[...best.values()]);
  if (monthKm >= 20 && prevBest > 0 && monthKm > prevBest) {
    out.push({
      key: `month-record-${month}`,
      weight: 55,
      text: `本月已经跑了 **${monthKm.toFixed(1)}km**，超过了你此前最高的单月（${prevBest.toFixed(1)}km）——`
        + "训练量上了一个台阶，记得同步加上恢复。",
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}
