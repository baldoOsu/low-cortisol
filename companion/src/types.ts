// Companion-internal contracts shared by config/log/cache/jev/claude/host. Spec §5

import type { ErrorCode } from '../../shared/types';

export interface CompanionConfig {
  /** %LOCALAPPDATA%\LowCortisol (Windows), ~/.local/share/low-cortisol elsewhere, or $LOW_CORTISOL_HOME. */
  home: string;
  /** Never log, print, send to the extension or pass to child processes. */
  typesafeApiKey?: string;
  apiKeySource: 'env' | 'file' | 'none';
  jevBaseUrl: string;
  jevModel: string;
  /** Absolute path to claude(.exe), if found. */
  claudePath?: string;
  claudeEffort: string;
  jevConcurrency: number;
  visionConcurrency: number;
  cacheTtlDays: number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Namespaced persistent key/value cache (FileCache implements it; tests use an in-memory fake). */
export interface KVCache {
  get<T>(ns: string, key: string): Promise<T | undefined>;
  set<T>(ns: string, key: string, value: T): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Typed failure carried back to the extension as ErrorResponse.error. Messages must never contain secrets. */
export class HostError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.status = status;
  }
}

export const NULL_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

/** In-memory KVCache (tests, and a fallback if the cache dir is unwritable). */
export class MemoryCache implements KVCache {
  private readonly map = new Map<string, unknown>();
  async get<T>(ns: string, key: string): Promise<T | undefined> {
    return this.map.get(`${ns}\u0000${key}`) as T | undefined;
  }
  async set<T>(ns: string, key: string, value: T): Promise<void> {
    this.map.set(`${ns}\u0000${key}`, value);
  }
}
