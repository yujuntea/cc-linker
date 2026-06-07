// src/agent-view/name-cache.ts
//
// v2.2.6 新增:把 active `claude agents --json` 看到的 {shortId, name} 持久化到
// ~/.cc-linker/agent-names-cache.json,用于在 session settled 之后还原显示名。
//
// 背景:`claude agents --json` 只报 active session 的 name(来自
// roster.json[short].dispatch.seed.name)。session 一 settled,roster 条目被清掉,
// `claude logs <short>` 也基本失效("job not found"),Agent View 的 completed section
// 只能退化成 short hash —— Feishu 用户看到一排 `273a5566` 而不是 `timer command response`。
//
// 解决方式:bot 每次调用 AgentSnapshotFetcher.fetch() 看到 active 列表时,
// 把 {short → name} 顺手写进 cache;之后 enrichCompletedSessions 在 `claude logs` 之前
// 先查 cache,缺失才退化。TTL 48h(略大于 readCompletedSessions 的 24h 窗口,
// 确保该 session 整个"completed 可见周期"内 name 都能查到)。
//
// 文件落在 ~/.cc-linker/ 是因为这是 cc-linker 自己维护的状态,不污染 ~/.claude/。
// 单写者(bot)+ 简单 atomic write(.tmp + rename),不上 proper-lockfile —— 即便偶发
// 并发覆盖,丢的是一两次 name 缓存,下次 fetch 立刻补回,无业务影响。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { AGENT_NAMES_CACHE_PATH } from '../utils/paths';

const TTL_MS = 48 * 3600_000;

export interface NameCacheEntry {
  name: string;
  sessionId: string;
  capturedAt: number;
}

type NameCache = Record<string, NameCacheEntry>; // keyed by 8-char shortId

function readRaw(path: string): NameCache {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? (parsed as NameCache) : {};
  } catch {
    // 损坏 / 权限问题 —— 当成空 cache,下次 capture 重建
    return {};
  }
}

function writeRaw(path: string, cache: NameCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, path);
  } catch {
    // best effort:写不动就跳过,不影响 fetch 返回
  }
}

/** 把 active session 的 name 写入 cache,顺手 prune 过期(>48h)条目。
 *
 * @param sessions  必须带 sessionId(UUID)和 name —— 不带 name 的会被跳过。
 * @param now       注入 Date.now() 便于测试。
 * @param path      注入 cache path 便于测试。
 */
export function captureNames(
  sessions: Array<{ sessionId: string; name: string }>,
  now: number = Date.now(),
  path: string = AGENT_NAMES_CACHE_PATH,
): void {
  const cache = readRaw(path);
  let dirty = false;
  for (const s of sessions) {
    if (!s.sessionId || !s.name) continue;
    // 'unnamed' 是 parseAgentsJson 的兜底值,缓存它毫无意义还会盖掉真名 —— skip
    if (s.name === 'unnamed') continue;
    const short = s.sessionId.slice(0, 8);
    cache[short] = { name: s.name, sessionId: s.sessionId, capturedAt: now };
    dirty = true;
  }
  // prune stale
  for (const [k, v] of Object.entries(cache)) {
    if (now - v.capturedAt > TTL_MS) {
      delete cache[k];
      dirty = true;
    }
  }
  if (dirty) writeRaw(path, cache);
}

/** 查 cache 拿 name(短 hash 命中即返回)。读不到返回 undefined,调用方退化下一级。 */
export function lookupName(
  shortId: string,
  path: string = AGENT_NAMES_CACHE_PATH,
): string | undefined {
  const cache = readRaw(path);
  return cache[shortId]?.name;
}
