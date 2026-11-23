// 训练负荷（Edwards TRIMP）与会话合并：自包含纯函数。
// 故意不 import github.ts —— 并行开发期间避免互相牵制；Lead 之后统一口径。
// 注：显式 .ts 后缀是为了 node --test 能直接跑（tsconfig 已开 allowImportingTsExtensions）。

/** 只要求行是字符串字典：github.ts 的 Row 天然满足，测试也能直接造。 */
export type LoadRow = Record<string, string | undefined>;

export interface ZoneMinutes {
  /** 热身区（< 心率区间 1）分钟 */
  z1: number;
  /** 燃脂区分钟 */
  z2: number;
  /** 有氧区分钟 */
  z3: number;
  /** 无氧区分钟 */
  z4: number;
  /** 极限区分钟 */
  z5: number;
}

export interface LoadStats {
  /** 近 7 个自然日（含今天）的 TRIMP 合计 */
  trimp7: number;
  /** 近 28 个自然日（含今天）的 TRIMP 合计 */
  trimp28: number;
  /** 急慢性负荷比 = trimp7 / (trimp28 / 4)；分母 <= 0 时为 0 */
  acwr: number;
  /** 单调性 = 近 7 天日均负荷 / 标准差；标准差 <= 0 时为 0 */
  monotony: number;
  /** 应变 = trimp7 * monotony */
  strain: number;
  /** 近 7 天有训练记录的天数 */
  days7: number;
}

const ZONES = [
  { zone: "z1", key: "hrm_warm_up_duration" },
  { zone: "z2", key: "hrm_fat_burning_duration" },
  { zone: "z3", key: "hrm_aerobic_duration" },
  { zone: "z4", key: "hrm_anaerobic_duration" },
  { zone: "z5", key: "hrm_extreme_duration" },
] as const;

function num(v: unknown): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function parseValueJson(row: LoadRow): Record<string, unknown> {
  const raw = row.value_json;
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(String(raw));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** value_json 里各心率区间时长（秒）→ 分钟。缺字段/坏 JSON 一律按 0。 */
export function zoneMinutes(row: LoadRow): ZoneMinutes {
  const v = parseValueJson(row);
  const out: ZoneMinutes = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (const { zone, key } of ZONES) {
    out[zone] = Math.max(0, num(v[key])) / 60;
  }
  return out;
}

/** 单条记录的 Edwards TRIMP：z1*1 + z2*2 + z3*3 + z4*4 + z5*5。 */
export function rowTrimp(row: LoadRow): number {
  const z = zoneMinutes(row);
  return z.z1 * 1 + z.z2 * 2 + z.z3 * 3 + z.z4 * 4 + z.z5 * 5;
}

/** 记录所属的北京日期；date 不是 YYYY-MM-DD 时退回 start_utc（秒）换算。 */
function bjDateOf(row: LoadRow): string {
  const d = String(row.date ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const t = num(row.start_utc);
  if (t > 0) return new Date(t * 1000 + 8 * 36e5).toISOString().slice(0, 10);
  return "";
}

/** 北京时间的今天（YYYY-MM-DD） */
function bjToday(now: number): string {
  return new Date(now + 8 * 36e5).toISOString().slice(0, 10);
}

/** 纯日期字符串平移（不经过本地时区，避免 DST 干扰）。 */
function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 864e5).toISOString().slice(0, 10);
}

/**
 * 近 7 / 28 天训练负荷。按北京日期聚合，跨项目（跑步+骑行…）都算。
 * 单调性用近 7 个自然日的日负荷（没有训练的日子记 0）计算；
 * 分母为 0 时 acwr / monotony 返回 0，调用方据此跳过信号，绝不除零。
 */
export function computeLoad(rows: LoadRow[], now = Date.now()): LoadStats {
  const today = bjToday(now);
  const start28 = shift(today, -27);
  const byDate = new Map<string, number>();
  const trainDays = new Set<string>();

  for (const r of rows) {
    const d = bjDateOf(r);
    if (!d || d < start28 || d > today) continue;
    trainDays.add(d);
    byDate.set(d, (byDate.get(d) ?? 0) + rowTrimp(r));
  }

  const daily = (d: string) => byDate.get(d) ?? 0;
  const win7 = Array.from({ length: 7 }, (_, i) => shift(today, -(6 - i)));
  const trimp7 = win7.reduce((a, d) => a + daily(d), 0);

  let trimp28 = 0;
  for (let i = 0; i < 28; i++) trimp28 += daily(shift(today, -i));

  const avg28 = trimp28 / 4;
  const acwr = avg28 > 0 ? trimp7 / avg28 : 0;

  const mean7 = trimp7 / 7;
  const variance = win7.reduce((a, d) => a + (daily(d) - mean7) ** 2, 0) / 7;
  const std = Math.sqrt(variance);
  const monotony = std > 0 ? mean7 / std : 0;

  return {
    trimp7,
    trimp28,
    acwr,
    monotony,
    strain: trimp7 * monotony,
    days7: win7.filter((d) => trainDays.has(d)).length,
  };
}

function weightedHr(a: LoadRow, b: LoadRow): string {
  const durA = num(a.duration_s), durB = num(b.duration_s);
  const hrA = num(a.avg_hr), hrB = num(b.avg_hr);
  if (hrA > 0 && hrB > 0) {
    if (durA + durB > 0) return String(Math.round((hrA * durA + hrB * durB) / (durA + durB)));
    return String(Math.round((hrA + hrB) / 2));
  }
  const one = hrA > 0 ? hrA : hrB;
  return one > 0 ? String(Math.round(one)) : "";
}

function combine<T extends LoadRow>(a: T, b: T): T {
  const durA = num(a.duration_s), durB = num(b.duration_s);
  const dur = durA + durB;
  const dist = num(a.distance_m) + num(b.distance_m);
  const start = Math.min(num(a.start_utc), num(b.start_utc));
  const end = Math.max(num(a.start_utc) + durA, num(b.start_utc) + durB);
  const pace = dist > 0 && dur > 0
    ? dur / (dist / 1000)
    : (num(a.avg_pace_s) || num(b.avg_pace_s));
  return {
    ...a,
    start_utc: String(start),
    end_utc: String(end),
    distance_m: String(dist),
    duration_s: String(dur),
    avg_hr: weightedHr(a, b),
    avg_pace_s: pace > 0 ? String(Math.round(pace)) : "",
  } as T;
}

/**
 * 合并「同日同 type、相邻间隔 < 30 分钟」的记录（间歇常被设备拆成多行）。
 * 距离/时长相加，avg_hr 按 duration_s 加权，配速按合并后的距离/时长重算。
 * 泛型只为保留调用方的行类型（如 github 的 Row），不引入依赖。
 */
export function mergeSessions<T extends LoadRow>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  const loose: T[] = [];

  for (const r of rows) {
    const d = bjDateOf(r);
    const type = String(r.type ?? "");
    if (!d || !type || num(r.start_utc) <= 0) {
      loose.push(r);
      continue;
    }
    const key = `${d}|${type}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const out: T[] = [...loose];
  for (const g of groups.values()) {
    g.sort((a, b) => num(a.start_utc) - num(b.start_utc));
    let cur: T | null = null;
    for (const r of g) {
      if (!cur) {
        cur = { ...r } as T;
        continue;
      }
      const curEnd = num(cur.start_utc) + num(cur.duration_s);
      if (num(r.start_utc) - curEnd < 1800) cur = combine(cur, r);
      else {
        out.push(cur);
        cur = { ...r } as T;
      }
    }
    if (cur) out.push(cur);
  }

  return out.sort((a, b) =>
    String(a.date ?? "").localeCompare(String(b.date ?? ""))
    || num(a.start_utc) - num(b.start_utc));
}
