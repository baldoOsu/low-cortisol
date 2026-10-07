// Companion configuration: home dir, config.json, API key source, claude CLI discovery. Spec §5

import { existsSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type { CompanionConfig } from './types';

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | undefined;
}

const DEFAULTS = {
  jevBaseUrl: 'https://api.typesafe.ai',
  jevModel: 'jev-latest',
  claudeEffort: 'low',
  jevConcurrency: 6,
  visionConcurrency: 2,
  cacheTtlDays: 30,
} as const;

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function companionHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string): string {
  if (env.LOW_CORTISOL_HOME) return env.LOW_CORTISOL_HOME;
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local'), 'LowCortisol');
  }
  return path.posix.join(homedir, '.local', 'share', 'low-cortisol');
}

export function findClaude(opts: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  exists: (p: string) => boolean;
  configured?: string;
}): string | undefined {
  const { env, platform, homedir, exists, configured } = opts;
  const p = pathFor(platform);
  const win = platform === 'win32';
  const exe = win ? 'claude.exe' : 'claude';
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  // A copied Windows env object is case-sensitive, so accept `Path` too.
  const pathVar = env.PATH ?? (win ? env.Path : undefined) ?? '';
  for (const raw of pathVar.split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir) candidates.push(p.join(dir, exe));
  }
  candidates.push(p.join(homedir, '.local', 'bin', exe));
  for (const c of candidates) {
    try {
      if (exists(c)) return c;
    } catch {
      // unreadable candidate: keep looking
    }
  }
  return undefined;
}

type FileConfig = Record<string, unknown>;

function readConfigFile(file: string, readFile: (p: string) => string | undefined): FileConfig {
  try {
    const text = readFile(file);
    if (!text) return {};
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FileConfig) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function posInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function defaultReadFile(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Synchronous and never throws; a missing or invalid config.json means defaults. */
export function loadConfig(opts: LoadConfigOptions = {}): CompanionConfig {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homedir = opts.homedir ?? safeHomedir();
  const exists = opts.exists ?? existsSync;
  const home = companionHome(env, platform, homedir);
  const file = readConfigFile(pathFor(platform).join(home, 'config.json'), opts.readFile ?? defaultReadFile);

  const envKey = str(env.TYPESAFE_API_KEY);
  const fileKey = str(file.typesafeApiKey);
  const typesafeApiKey = envKey ?? fileKey;
  const apiKeySource: CompanionConfig['apiKeySource'] = envKey ? 'env' : fileKey ? 'file' : 'none';

  const cfg: CompanionConfig = {
    home,
    apiKeySource,
    jevBaseUrl: str(file.jevBaseUrl) ?? DEFAULTS.jevBaseUrl,
    jevModel: str(file.jevModel) ?? DEFAULTS.jevModel,
    claudePath: findClaude({ env, platform, homedir, exists, configured: str(file.claudePath) }),
    claudeEffort: str(file.claudeEffort) ?? DEFAULTS.claudeEffort,
    jevConcurrency: posInt(file.jevConcurrency) ?? DEFAULTS.jevConcurrency,
    visionConcurrency: posInt(file.visionConcurrency) ?? DEFAULTS.visionConcurrency,
    cacheTtlDays: posInt(file.cacheTtlDays) ?? DEFAULTS.cacheTtlDays,
  };
  if (typesafeApiKey) cfg.typesafeApiKey = typesafeApiKey;
  return cfg;
}

function safeHomedir(): string {
  try {
    return osHomedir();
  } catch {
    return '';
  }
}

/** Values the logger must redact. */
export function secretsOf(cfg: CompanionConfig): string[] {
  return cfg.typesafeApiKey ? [cfg.typesafeApiKey] : [];
}
