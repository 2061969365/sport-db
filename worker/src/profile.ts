// 跨通道共享的长期记忆：把 user_profile / coaching_notes 存进数据仓，
// 这样 TG、飞书、网页版读到的是同一份画像（各通道原本各存一份，互不知情）。
//
// 为什么放仓库而不是单独开个 DO：
//   * 用户能自己打开文件看/改（长期记忆透明，不会变成黑盒）；
//   * 跟着 git 走，DO 重建/迁移也不丢；
//   * 和「GitHub 即数据库」的取舍一致。
// 代价：画像是公开的（仓库是 public）。不想公开就设 PROFILE_SHARED=false 回到
// 各通道独立的本机存储（那样就失去跨通道共享）。
import type { Env } from "./env.ts";
import { ghGetFile, ghPutFile, type SqlTag } from "./github.ts";

const TTL_MS = 60_000;

interface Cached {
  text: string;
  sha: string;
  at: number;
}

function readCache(sql: SqlTag | undefined, path: string): Cached | null {
  if (!sql) return null;
  try {
    sql`CREATE TABLE IF NOT EXISTS profile_cache (path TEXT PRIMARY KEY, text TEXT, sha TEXT, updated_at INTEGER)`;
    const rows = sql`SELECT text, sha, updated_at FROM profile_cache WHERE path = ${path}` as
      { text: string; sha: string; updated_at: number }[];
    if (!rows.length) return null;
    if (Date.now() - rows[0].updated_at > TTL_MS) return null;
    return { text: rows[0].text, sha: rows[0].sha, at: rows[0].updated_at };
  } catch {
    return null;
  }
}

function writeCache(sql: SqlTag | undefined, path: string, text: string, sha: string): void {
  if (!sql) return;
  try {
    sql`CREATE TABLE IF NOT EXISTS profile_cache (path TEXT PRIMARY KEY, text TEXT, sha TEXT, updated_at INTEGER)`;
    sql`INSERT OR REPLACE INTO profile_cache(path, text, sha, updated_at) VALUES (${path}, ${text}, ${sha}, ${Date.now()})`;
  } catch { /* 缓存失败不影响主流程 */ }
}

function dropCache(sql: SqlTag | undefined, path: string): void {
  if (!sql) return;
  try {
    sql`DELETE FROM profile_cache WHERE path = ${path}`;
  } catch { /* 忽略 */ }
}

export interface ProfileProvider {
  get(): Promise<string | null>;
  set(content: string): Promise<void>;
}

/**
 * 仓库文件版画像 provider。
 * 读：60s 缓存 → GitHub；文件不存在时给种子文案（好让模型知道可以往里写什么）。
 * 写：带上 sha 乐观锁写回，冲突时重读重试一次。
 */
export function repoProfileProvider(
  env: Env, path: string, sql: SqlTag | undefined, seed: string,
): ProfileProvider {
  return {
    async get(): Promise<string | null> {
      const hit = readCache(sql, path);
      if (hit) return hit.text || seed;
      const g = await ghGetFile(env, path).catch(() => null);
      if (g) {
        writeCache(sql, path, g.text, g.sha);
        return g.text || seed;
      }
      return seed;
    },
    async set(content: string): Promise<void> {
      const text = String(content ?? "");
      // 用最新 sha 写，避免拿陈旧缓存覆盖别处的更新
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = await ghGetFile(env, path).catch(() => null);
        try {
          await ghPutFile(env, path, text, cur?.sha || "", `bot: 更新画像 ${path}`);
          writeCache(sql, path, text, "");
          return;
        } catch (e) {
          const msg = String((e as Error).message || e);
          if (msg.startsWith("Conflict:") && attempt === 0) {
            dropCache(sql, path);
            continue;
          }
          throw new Error(`画像写回失败（${msg.slice(0, 100)}）`);
        }
      }
      throw new Error("画像写回连续冲突，稍后再试");
    },
  };
}

/** 画像种子文案：让模型知道这个块是干什么的、该往里写什么。 */
export const PROFILE_SEED =
  "（还没有记录）在这里记长期事实：目标赛事与日期、周可训练天数、伤病史、作息、装备偏好。";

export const NOTES_SEED =
  "（还没有记录）在这里记教练观察：用户弱项、上次建议的执行情况、下次要提醒的事。";

export const PROFILE_PATH = "profile/user_profile.md";
export const NOTES_PATH = "profile/coaching_notes.md";

/** 是否启用跨通道共享画像（默认开；PROFILE_SHARED=false 则回退到各通道本机存储）。 */
export function profileShared(env: Env): boolean {
  if (!env.GH_PAT) return false; // 没写权限就没法共享
  return String(env.PROFILE_SHARED ?? "true").toLowerCase() !== "false";
}
