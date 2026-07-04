import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { classifyModel, type ModelKind } from './classify';
import type { ProviderFileInfo } from './types';

export interface Candidate extends ProviderFileInfo {
  source: 'manual' | 'auto';
  kind: ModelKind;
}

export interface DiscoverOpts {
  manualDir: string;
  autoDir: string;
  aliasRcFiles?: string[];
  extraPatterns?: { visionPatterns?: string[]; textOnlyPatterns?: string[] };
}

/**
 * 4 路发现 + dedup by alias + baseUrl 过滤 + 分类。
 * 🔴 Fix #4:末尾 .filter(c => c.baseUrl) — 同现有 install 语义
 * 🔴 Fix #5:source 类型统一 'cc-switch'(连字符)
 */
export function discoverCandidates(opts: DiscoverOpts): Candidate[] {
  const { manualDir, autoDir, extraPatterns } = opts;

  const manualFiles = scanDir(manualDir);
  const autoFiles = scanDir(autoDir);

  // file dedup:manual 覆盖 auto
  const byAlias = new Map<string, ProviderFileInfo>();
  for (const f of autoFiles) if (!byAlias.has(f.alias)) byAlias.set(f.alias, f);
  for (const f of manualFiles) byAlias.set(f.alias, f);

  // 合并成 Candidate
  const candidates: Candidate[] = [];
  for (const [alias, file] of byAlias) {
    const isAuto = !manualFiles.some(m => m.alias === alias);
    candidates.push({
      ...file,
      source: isAuto ? 'auto' : 'manual',
      kind: classifyModel(file.model, extraPatterns),
    });
  }

  // 🔴 过滤无 BASE_URL(同现有 install 语义)
  const withBaseUrl = candidates.filter(c => c.baseUrl);

  // 排序:manual(0) < auto(1)
  const sourcePriority: Record<Candidate['source'], number> = {
    manual: 0,
    auto: 1,
  };
  withBaseUrl.sort((a, b) => {
    const dp = sourcePriority[a.source] - sourcePriority[b.source];
    if (dp !== 0) return dp;
    return a.alias.localeCompare(b.alias);
  });
  return withBaseUrl;
}

function scanDir(dir: string): ProviderFileInfo[] {
  if (!existsSync(dir)) return [];
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readProviderFile(join(dir, f)))
    .filter((p): p is ProviderFileInfo => p !== null);
}

function readProviderFile(path: string): ProviderFileInfo | null {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    return {
      alias: basename(path, '.json'),
      path,
      baseUrl: cfg?.env?.ANTHROPIC_BASE_URL ?? '',
      model: cfg?.env?.ANTHROPIC_MODEL ?? '',
    };
  } catch {
    return null;
  }
}
