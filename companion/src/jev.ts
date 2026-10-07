// TypeSafe Jev client: POST the rubric, retry transient failures, cache answers. Spec §5
// The API key never appears in logs or error messages; response bodies are never logged.

import { isValidAnswers } from '../../shared/decide';
import { stableStringify } from '../../shared/hash';
import { JEV_QUESTIONS, RUBRIC_VERSION } from '../../shared/rubric';
import type { ErrorCode, JevAnswers, JevResult, JevState } from '../../shared/types';
import { HostError, type CompanionConfig, type FetchLike, type KVCache, type Logger } from './types';

export const JEV_PATH = '/v1/systemone';

const CACHE_NS = 'jev';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [300, 900];
const JITTER_MS = 100;
const DEFAULT_TIMEOUT_MS = 6000;

export interface JevDeps {
  cfg: CompanionConfig;
  cache: KVCache;
  log: Logger;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  timeoutMs?: number;
}

interface Cached {
  model: string;
  answers: JevAnswers;
}

type Attempt = { ok: true; body: unknown; status: number } | { ok: false; error: HostError; retryable: boolean };

export function jevCacheKey(state: JevState, cfg: CompanionConfig): string {
  return `${RUBRIC_VERSION}|${cfg.jevModel}|${stableStringify(state)}`;
}

export function parseJevResponse(body: unknown): Cached {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || typeof b.model !== 'string' || !isValidAnswers(b.answers)) {
    throw new HostError('JEV_BAD_RESPONSE', 'Jev response is missing model or valid answers');
  }
  return { model: b.model, answers: b.answers };
}

export async function classifyState(state: JevState, deps: JevDeps): Promise<JevResult> {
  const { cfg, cache, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const start = now();

  const key = cfg.typesafeApiKey;
  if (!key) throw new HostError('NO_API_KEY', 'TYPESAFE_API_KEY is not configured');

  const cacheKey = jevCacheKey(state, cfg);
  const hit = await readCache(cache, cacheKey, log);
  if (hit) return { ...hit, latencyMs: now() - start, cached: true };

  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.jevModel, state, questions: JEV_QUESTIONS }),
    // Only api.typesafe.ai: a redirect is a network error, never followed (the key would go along).
    redirect: 'error' as const,
  };
  const url = `${cfg.jevBaseUrl}${JEV_PATH}`;

  let last: HostError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[attempt - 2] + Math.floor(random() * JITTER_MS));
    const t0 = now();
    const r = await attemptOnce(deps.fetchImpl ?? fetch, url, init, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (r.ok) {
      log.info('jev.request', { attempt, status: r.status, ms: now() - t0 });
      let parsed: Cached;
      try {
        parsed = parseJevResponse(r.body);
      } catch (e) {
        log.warn('jev.error', { attempt, code: 'JEV_BAD_RESPONSE', status: r.status });
        throw e;
      }
      await writeCache(cache, cacheKey, parsed, log);
      return { ...parsed, latencyMs: now() - start, cached: false };
    }
    log.warn('jev.error', { attempt, code: r.error.code, status: r.error.status });
    if (!r.retryable) throw r.error;
    last = r.error;
  }
  throw last!;
}

async function attemptOnce(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Attempt> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const fail = (code: ErrorCode, message: string, retryable: boolean, status?: number): Attempt => ({
    ok: false,
    error: new HostError(code, message, status),
    retryable,
  });
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch {
      return timedOut
        ? fail('JEV_TIMEOUT', `Jev request timed out after ${timeoutMs} ms`, true)
        : fail('JEV_NETWORK', 'Jev request failed (network error)', true);
    }
    if (!res.ok) {
      // Discard the body unread: it may echo credentials and is never surfaced.
      res.body?.cancel().catch(() => {});
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      return fail('JEV_HTTP', `Jev HTTP ${res.status}`, retryable, res.status);
    }
    try {
      return { ok: true, body: await res.json(), status: res.status };
    } catch (e) {
      if (timedOut) return fail('JEV_TIMEOUT', `Jev request timed out after ${timeoutMs} ms`, true);
      if (e instanceof SyntaxError) return fail('JEV_BAD_RESPONSE', 'Jev response is not valid JSON', false, res.status);
      return fail('JEV_NETWORK', 'Jev response could not be read (network error)', true);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(cache: KVCache, key: string, log: Logger): Promise<Cached | undefined> {
  try {
    const v = await cache.get<Cached>(CACHE_NS, key);
    return v && typeof v.model === 'string' && isValidAnswers(v.answers) ? v : undefined;
  } catch {
    log.warn('jev.cache_error', { op: 'get' });
    return undefined;
  }
}

async function writeCache(cache: KVCache, key: string, value: Cached, log: Logger): Promise<void> {
  try {
    await cache.set(CACHE_NS, key, value);
  } catch {
    log.warn('jev.cache_error', { op: 'set' });
  }
}
