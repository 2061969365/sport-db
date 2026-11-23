// 主动教练的"该不该开口"判断：纯函数，输入运动记录，输出该提醒的信号。
// 设计原则：宁可少说也别啰嗦 —— 没信号就闭嘴；有信号也只给一条最有价值的。
// 不调模型、不花 token，模板化输出数字，避免自动消息里出现幻觉。
// 注：这里用显式 .ts 后缀，好让 node --test 直接跑测试（tsconfig 已开 allowImportingTsExtensions）。
import { RUN_TYPES, num, type Row } from "./github.ts";
import { computeLoad, mergeSessions } from "./coachload.ts";

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

/** 北京时间的小时（0-23） */
export function bjHour(now = Date.now()): number {
  return new Date(now + 8 * 36e5).getUTCHours();
}

/** 北京时间的「周几」中文 */
export function bjWeekday(now = Date.now()): string {
  return CN[new Date(now + 8 * 36e5).getUTCDay()];
}

function fmtPace(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${String(s).padStart(2, "0")}"`;
}

function agg(rows: Row[]) {
  const runs = rows.filter((r) => RUN_TYPES.includes(r.type || ""));
  const km = runs.reduce((a, r) => a + num(r.distance_m), 0) / 1000;
  const dur = runs.reduce((a, r) => a + num(r.duration_s), 0);
  const hr = runs.filter((r) => num(r.avg_hr) > 0);
  const rides = rows.filter((r) => (r.type || "").includes("riding"));
  return {
    runs: runs.length,
    km,
    pace: km > 0 ? dur / km : 0,
    hr: hr.length ? hr.reduce((a, r) => a + num(r.avg_hr), 0) / hr.length : 0,
    rides: rides.length,
    rideKm: rides.reduce((a, r) => a + num(r.distance_m), 0) / 1000,
  };
}

/**
 * 主动消息的"闭嘴"约定：模型如果判断现在不值得打扰，只回 SILENT。
 * 抽成函数是为了能测——这条路径以前根本不存在（模型没有拒绝发言的权利）。
 */
export function shouldStaySilent(text: string): boolean {
  return /^\s*SILENT\b/i.test(String(text || ""));
}

/** 设备日报摘要（来自 data/daily/*.csv，没有就是 undefined）。 */
export interface DailySummary {
  sleepDate?: string;
  sleepMin?: number;
  sleepScore?: number;
  sleep7AvgMin?: number;
  /** 近 7 天真正有睡眠数据的天数（不足 4 天不拿单晚数据下结论） */
  sleepDays7?: number;
  rhrLast?: number;
  rhr7Avg?: number;
  /** 静息心率对应的日期（YYYY-MM-DD）；超过 7 天就不显示，避免拿旧值当现状 */
  rhrDate?: string;
  /** 最近一次压力均值 */
  stressLast?: number;
  stepsDate?: string;
  stepsLast?: number;
  steps7Avg?: number;
  caloriesLast?: number;
  hrDayAvg?: number;
}

/** 本周一（北京时间今天所在周的周一） */
function mondayOf(dateStr: string): string {
  const d = new Date(day(dateStr));
  const w = d.getUTCDay(); // 0=周日
  return shift(dateStr, -(w === 0 ? 6 : w - 1));
}

function fmtHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}小时${m}分` : `${h}小时`;
}

/**
 * 每轮注入的「实时数据快照」：让模型一开始就有数字可用，
 * 不用为了回答"最近怎么样"来回调工具，也避免它凭印象编。
 *
 * 关键：每个窗口都必须**带明确日期**。以前只写"上周（-14~-8 天）"，
 * 结果模型把"本周"和"近 7 天"混着用，同一轮里出现 9km 和 0km 两个说法。
 * 纯函数，好测。
 */
export function buildSnapshot(all: Row[], now = Date.now(), daily?: DailySummary): string {
  const today = bjToday(now);
  const dated = all.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") && (r.date || "") <= today);
  const head = `今天：${today} ${bjWeekday(now)}（北京时间，以下日期均为北京时间）`;
  if (!dated.length) return `${head}\n库里还没有任何训练记录。`;

  const sorted = [...dated].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const mon = mondayOf(today);
  const sun = shift(mon, -1);
  const prevMon = shift(mon, -7);
  const l7 = agg(inRange(sorted, shift(today, -6), today));
  const l30 = agg(inRange(sorted, shift(today, -29), today));
  const thisWeek = agg(inRange(sorted, mon, today));
  const lastWeek = agg(inRange(sorted, prevMon, sun));

  const line = (label: string, a: ReturnType<typeof agg>) =>
    `${label}：跑 ${a.runs} 次 / ${a.km.toFixed(1)}km / 均配 ${fmtPace(a.pace)} / 均心率 ${a.hr ? Math.round(a.hr) : "—"}`
    + (a.rides ? `；骑行 ${a.rides} 次 / ${a.rideKm.toFixed(1)}km` : "");

  const out: string[] = [head];
  out.push(line(`本周（${mon}~${today}）`, thisWeek));
  if (lastWeek.runs || lastWeek.km) out.push(line(`上周（${prevMon}~${sun}）`, lastWeek));
  out.push(line(`近 7 天（${shift(today, -6)}~${today}）`, l7));
  out.push(line(`近 30 天（${shift(today, -29)}~${today}）`, l30));

  // 身体状态：设备日报（睡眠/静息心率），有就报，没有就不提
  const body: string[] = [];
  // 睡眠：单晚 < 5 小时或近 7 天不足 4 晚有数据都不下结论（可能是设备没戴/没同步）。
  const sleepMin = num(daily?.sleepMin);
  const sleepDays7 = num(daily?.sleepDays7);
  if (sleepMin >= 300 && sleepDays7 >= 4) {
    body.push(`${daily?.sleepDate || "最近一晚"} 睡 ${fmtHours(sleepMin)}`
      + (daily?.sleepScore ? `（评分 ${daily.sleepScore}）` : "")
      + `（近 7 天 ${sleepDays7} 晚有数据）`);
    if (daily?.sleep7AvgMin) body.push(`近 7 天均睡 ${fmtHours(daily.sleep7AvgMin)}`);
  }
  // 静息心率：必须带日期且不超过 7 天，否则宁可不提。
  const rhrDate = daily?.rhrDate || "";
  const rhrAge = /^\d{4}-\d{2}-\d{2}$/.test(rhrDate) ? diffDays(today, rhrDate) : Infinity;
  if (daily?.rhrLast && rhrAge >= 0 && rhrAge <= 7) {
    body.push(`静息心率 ${daily.rhrLast}（${rhrDate}`
      + `${daily.rhr7Avg ? `，7 日均 ${Math.round(daily.rhr7Avg)}` : ""}）`);
  }
  if (daily?.stressLast != null) body.push(`压力均值 ${daily.stressLast}`);
  if (daily?.stepsLast) {
    const when = daily.stepsDate === today ? "今天" : (daily.stepsDate || "最近");
    body.push(`${when}步数 ${daily.stepsLast}${daily.steps7Avg ? `（7 日均 ${Math.round(daily.steps7Avg)}）` : ""}`);
  }
  if (daily?.caloriesLast) body.push(`活动消耗 ${daily.caloriesLast} kcal`);
  if (daily?.hrDayAvg) body.push(`日均心率 ${daily.hrDayAvg}`);
  if (body.length) out.push(`身体状态：${body.join("；")}`);

  const last = sorted.slice(-5).reverse();
  out.push("最近 5 次：");
  for (const r of last) {
    const km = num(r.distance_m) / 1000;
    const dur = num(r.duration_s);
    out.push(`- ${r.date} ${r.type} ${km.toFixed(2)}km${dur ? ` ${Math.round(dur / 60)}分钟` : ""}`
      + `${km > 0 && dur > 0 ? ` ${fmtPace(dur / km)}/km` : ""}`
      + `${num(r.avg_hr) ? ` HR${num(r.avg_hr)}` : ""}`);
  }

  // 数据质量：碎片（<0.5km 的跑步）与同日同距离疑似重复
  const last30 = inRange(sorted, shift(today, -29), today);
  const frags = last30.filter((r) => RUN_TYPES.includes(r.type || "")
    && num(r.distance_m) > 0 && num(r.distance_m) < 500);
  const seen = new Map<string, number>();
  for (const r of last30) {
    const k = `${r.date}|${num(r.distance_m)}|${r.type}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dups = [...seen.values()].filter((n) => n > 1).length;
  const issues: string[] = [];
  if (frags.length >= 3) issues.push(`${frags.length} 条不足 0.5km 的碎片记录（可能是同一次间歇被拆开）`);
  if (dups) issues.push(`${dups} 组同日同距离的疑似重复`);
  if (issues.length) out.push(`数据质量：${issues.join("；")}`);

  return out.join("\n");
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

/** 处方/伤病上下文：由调用方（Lead 统一接入）可选传入。 */
export interface SignalContext {
  /** 当前训练处方/教练备注原文，用来识别"全改骑/暂停跑/膝痛"等恢复期 */
  coaching?: string;
  /** 明确处于交叉训练期（不跑步） */
  crossTraining?: boolean;
}

/**
 * 分析该不该主动开口。无信号返回空数组。
 * 阈值都偏保守：宁可漏报，也不要天天打扰。
 */
export function analyzeSignals(all: Row[], now = Date.now(), ctx?: SignalContext): Signal[] {
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

  // 2) 训练负荷（Edwards TRIMP / ACWR）
  // 与跑量规则互补：负荷看心率区间，能识别"量没涨但强度堆太多"。
  const load = computeLoad(dated, now);
  const acwrHigh = load.acwr > 1.5;
  if (acwrHigh) {
    out.push({
      key: `load-high-${today}`,
      weight: 78,
      text: `近 7 天训练负荷 **${Math.round(load.trimp7)}** TRIMP，28 天累计 **${Math.round(load.trimp28)}**；`
        + `ACWR **${load.acwr.toFixed(2)}** 超过 1.5，单调性 ${load.monotony.toFixed(2)}（strain ${Math.round(load.strain)}）。`
        + "负荷涨得比恢复快时先别加量，强度课和长距离别排在一起。",
    });
  }
  if (load.acwr < 0.8 && load.trimp28 > 0) {
    out.push({
      key: `load-low-${today}`,
      weight: 45,
      text: `近 7 天负荷 **${Math.round(load.trimp7)}** TRIMP，28 天累计 ${Math.round(load.trimp28)}，`
        + `ACWR **${load.acwr.toFixed(2)}** 偏低。是刻意减量/恢复周，还是受伤、太忙？`
        + "先确认原因，不急着补量。",
    });
  }

  // 3) 跑量骤降：恢复期（交叉训练/膝痛）改成按处方走，不劝补跑
  const recoveryMode = ctx?.crossTraining === true
    || /全改骑|暂停跑|PFPS|膝|髌骨/.test(ctx?.coaching || "");
  const km7 = runKm(last7), kmPrev = runKm(prev7);
  if (kmPrev >= 8 && km7 < kmPrev * 0.6) {
    const pct = Math.round((1 - km7 / kmPrev) * 100);
    out.push({
      key: `volume-drop-${today}`,
      weight: 60,
      text: `本周跑量 **${km7.toFixed(1)}km**，比上周（${kmPrev.toFixed(1)}km）少了 **${pct}%**。`
        + (recoveryMode
          ? "这和当前处方一致：按当前处方继续交叉训练，等疼痛稳定再评估复跑。"
          : "是刻意减量还是被事情挤掉了？如果是后者，明天补一次轻松跑就能把节奏接回来。"),
    });
  }

  // 4) 跑量骤增（次要提示）：ACWR 已报就不再重复
  if (!acwrHigh && kmPrev >= 5 && km7 > kmPrev * 1.8 && km7 >= 15) {
    out.push({
      key: `volume-spike-${today}`,
      weight: 75,
      text: `本周跑量 **${km7.toFixed(1)}km**，比上周（${kmPrev.toFixed(1)}km）涨了 **${Math.round((km7 / kmPrev - 1) * 100)}%**（单周涨幅）。`
        + `当前 ACWR ${load.acwr.toFixed(2)}。单周涨幅超过 10~20% 是常见的伤病诱因，注意别把长距离和强度课排在一起。`,
    });
  }

  // 5) 同配速心率漂移：最近三场各自找「配速 ±15 秒/km」的历史基线
  // 旧版直接比 30 天均心率，不控配速：间歇被拆成多行或最近都是慢跑时必然误报。
  // 先合并同日同 type 的间歇，再逐场匹配配速；基线不足 5 条就跳过，绝不猜。
  const runs30 = mergeSessions(last30.filter((r) => RUN_TYPES.includes(r.type || "")))
    .filter((r) => num(r.avg_pace_s) > 0 && num(r.avg_hr) > 0)
    .sort((a, b) =>
      String(a.date ?? "").localeCompare(String(b.date ?? ""))
      || num(a.start_utc) - num(b.start_utc));
  const last3 = runs30.slice(-3);
  if (last3.length === 3 && runs30.length > 3) {
    const basePool = runs30.slice(0, -3);
    const PACE_TOL = 15; // 秒/km
    const MIN_BASE = 5;
    let wSum = 0, diffSum = 0, hrSum = 0, used = 0;
    for (const cur of last3) {
      const pace = num(cur.avg_pace_s);
      const near = basePool.filter((b) => Math.abs(num(b.avg_pace_s) - pace) <= PACE_TOL);
      if (near.length < MIN_BASE) continue;
      const wAll = near.reduce((a, b) => a + Math.max(num(b.duration_s), 1), 0);
      const baseHr = near.reduce(
        (a, b) => a + num(b.avg_hr) * Math.max(num(b.duration_s), 1), 0,
      ) / wAll;
      const w = Math.max(num(cur.duration_s), 1);
      wSum += w;
      diffSum += (num(cur.avg_hr) - baseHr) * w;
      hrSum += num(cur.avg_hr) * w;
      used++;
    }
    const diff = wSum > 0 ? diffSum / wSum : 0;
    if (used > 0 && diff >= 6) {
      out.push({
        key: `hr-drift-${today}`,
        weight: 65,
        text: `最近 ${used} 次跑步在**同配速下**（配速差 ±15 秒/km）平均心率 **${Math.round(hrSum / wSum)}**，`
          + `比你自己的历史基线高了 **${Math.round(diff)}** 次/分。`
          + "同配速心率抬高通常是疲劳或睡眠不足，这周把轻松跑再放慢一点，别硬顶强度。",
      });
    }
  }

  // 6) 单月新高
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
