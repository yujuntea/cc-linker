// src/review/profile.ts
// v2.1.6 + v2.1.6.1: ReviewProfile TOML load + per-phase deep merge + provider resolution.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseTOML } from '@iarna/toml';  // already a dep (config.ts uses @iarna/toml)
import { providerManager } from '../utils/providers';
import { CCLinkerError } from '../utils/errors';
import { REVIEW_PROFILES_DIR } from './paths';
import type { Phase } from './types';

export class ProfileError extends CCLinkerError {}

export interface ResolvedProfile {
  meta: { name: string; description?: string };
  work: { provider: string };
  review: { provider: string };
  guards: {
    maxRounds: number;
    maxConcurrentPipelines: number;
    parseRetryTimeoutMs: number;
  };
  contextLimits?: Record<string, number>;
  prompts: {
    work: {
      produce: { system: { template: string } };
      self_review: { system: { template: string } };
      fixing: { system: { template: string } };
    };
    review: {
      spec: { system: { template: string } };
      plan: { system: { template: string } };
      code: { system: { template: string } };
    };
  };
  workSettingsPath: string;
  reviewSettingsPath: string;
}

interface LoadOptions {
  profilesDir?: string;  // test override
}

function deepMerge<T>(base: T, override: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (override === undefined ? base : override) as T;
  }
  const out: any = { ...base };
  for (const k of Object.keys(override ?? {})) {
    if (typeof (base as any)[k] === 'object' && !Array.isArray((base as any)[k]) && (base as any)[k] !== null) {
      out[k] = deepMerge((base as any)[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

async function resolveSettingsPath(alias: string): Promise<string> {
  await providerManager.scan();
  const cfg = providerManager.resolve(alias);
  if (!cfg) {
    throw new ProfileError(
      'PROVIDER_NOT_FOUND',
      `provider '${alias}' not in ~/.claude/providers/`,
    );
  }
  return cfg.path;
}

export async function loadProfile(name: string, phase: Phase, opts: LoadOptions = {}): Promise<ResolvedProfile> {
  const dir = opts.profilesDir ?? REVIEW_PROFILES_DIR;
  const path = join(dir, `${name}.toml`);
  if (!existsSync(path)) {
    throw new ProfileError('PROFILE_NOT_FOUND', `profile '${name}' not found at ${path}`);
  }
  let raw: any;
  try {
    raw = parseTOML(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ProfileError('PROFILE_PARSE_ERROR', `failed to parse ${path}: ${e}`);
  }

  // apply phase_override deep merge
  const override = raw.phase_overrides?.[phase];
  const merged = override ? deepMerge(raw, override) : raw;

  const workProvider = merged.work?.provider;
  const reviewProvider = merged.review?.provider;
  if (!workProvider || !reviewProvider) {
    throw new ProfileError('PROFILE_INVALID', 'profile must define [work].provider and [review].provider');
  }

  const [workSettingsPath, reviewSettingsPath] = await Promise.all([
    resolveSettingsPath(workProvider),
    resolveSettingsPath(reviewProvider),
  ]);

  return {
    meta: { name: merged.meta?.name ?? name, description: merged.meta?.description },
    work: { provider: workProvider },
    review: { provider: reviewProvider },
    guards: {
      maxRounds: merged.guards?.max_rounds ?? 6,
      maxConcurrentPipelines: merged.guards?.max_concurrent_pipelines ?? 1,
      parseRetryTimeoutMs: merged.guards?.parse_retry_timeout_ms ?? 15000,
    },
    contextLimits: merged.context_limits,
    prompts: merged.prompts,
    workSettingsPath,
    reviewSettingsPath,
  };
}