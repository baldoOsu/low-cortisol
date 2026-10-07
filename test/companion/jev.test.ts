import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { classifyState, jevCacheKey, parseJevResponse } from '../../companion/src/jev';
import { HostError, MemoryCache, type CompanionConfig, type Logger } from '../../companion/src/types';
import { buildJevState, JEV_QUESTIONS } from '../../shared/rubric';
import { answers, snapshot } from '../shared/helpers';

const KEY = 'ts_test_KEY_0123456789abcdef';
const cfg = (o: Partial<CompanionConfig> = {}): CompanionConfig => ({
  home: '/tmp/h', typesafeApiKey: KEY, apiKeySource: 'env', jevBaseUrl: 'https://api.typesafe.ai', jevModel: 'jev-latest',
  claudeEffort: 'low', jevConcurrency: 6, visionConcurrency: 2, cacheTtlDays: 30, ...o,
});
const state = buildJevState(snapshot({ text: 'Can you BELIEVE these idiots?' }));
const okBody = { model: 'jev-1.13.0', answers: answers({ ragebait: 0.97 }), usage: { input_tokens: 800, output_tokens: 90 } };
const res = (status: number, body: unknown = okBody) => new Response(JSON.stringify(body), { status });
function recLog() {
  const lines: string[] = [];
  const log: Logger = { info: (e, f) => lines.push(JSON.stringify({ e, f })), warn: (e, f) => lines.push(JSON.stringify({ e, f })), error: (e, f) => lines.push(JSON.stringify({ e, f })) };
  return { log, lines };
}
const deps = (fetchImpl: any, o: any = {}) => ({ cfg: cfg(), cache: new MemoryCache(), log: recLog().log, fetchImpl, sleep: async () => {}, random: () => 0, ...o });

describe('classifyState', () => {
  it('posts the rubric with a bearer key and returns answers', async () => {
    const fetchImpl = vi.fn(async () => res(200));
    const r = await classifyState(state, deps(fetchImpl));
    expect(r).toMatchObject({ model: 'jev-1.13.0', cached: false });
    expect(r.answers.ragebait.noul).toBe(0.97);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({ model: 'jev-latest', state, questions: JSON.parse(JSON.stringify(JEV_QUESTIONS)) });
  });

  it('serves the second identical call from cache', async () => {
    const fetchImpl = vi.fn(async () => res(200));
    const d = deps(fetchImpl);
    await classifyState(state, d);
    const r2 = await classifyState(state, d);
    expect(r2.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 then succeeds with backoff 300ms', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429, {})).mockResolvedValueOnce(res(200));
    await classifyState(state, deps(fetchImpl, { sleep }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it('gives up after 3 attempts on 529 with JEV_HTTP 529', async () => {
    const fetchImpl = vi.fn(async () => res(529, {}));
    await expect(classifyState(state, deps(fetchImpl))).rejects.toMatchObject({ code: 'JEV_HTTP', status: 529 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry 401 and never leaks the key', async () => {
    const { log, lines } = recLog();
    const fetchImpl = vi.fn(async () => res(401, { error: 'invalid key ' + KEY }));
    const err = await classifyState(state, deps(fetchImpl, { log })).catch((e) => e);
    expect(err).toBeInstanceOf(HostError);
    expect(err).toMatchObject({ code: 'JEV_HTTP', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(err.message) + JSON.stringify(err)).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('times out slow attempts as JEV_TIMEOUT', async () => {
    const fetchImpl = vi.fn((_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    await expect(classifyState(state, deps(fetchImpl, { timeoutMs: 20 }))).rejects.toMatchObject({ code: 'JEV_TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps network errors to JEV_NETWORK', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(classifyState(state, deps(fetchImpl))).rejects.toMatchObject({ code: 'JEV_NETWORK' });
  });

  it('never follows a redirect: it is a network error and the target is never contacted', async () => {
    const hits: string[] = [];
    const server = createServer((req, reply) => {
      hits.push(req.url ?? '');
      if (req.url === '/v1/systemone') reply.writeHead(307, { Location: '/elsewhere' }).end();
      else reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(okBody));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const { log, lines } = recLog();
      const err = await classifyState(state, deps(fetch, { cfg: cfg({ jevBaseUrl: `http://127.0.0.1:${port}` }), log })).catch((e) => e);
      expect(err).toMatchObject({ code: 'JEV_NETWORK' });
      expect(hits.every((h) => h === '/v1/systemone')).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
      expect(JSON.stringify(err) + String(err.message) + lines.join(' ')).not.toContain(KEY);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('NO_API_KEY without calling fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(classifyState(state, deps(fetchImpl, { cfg: cfg({ typesafeApiKey: undefined, apiKeySource: 'none' }) }))).rejects.toMatchObject({ code: 'NO_API_KEY' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies as JEV_BAD_RESPONSE', () => {
    expect(() => parseJevResponse({ model: 'jev', answers: { ragebait: {} } })).toThrow(expect.objectContaining({ code: 'JEV_BAD_RESPONSE' }));
  });

  it('cache key includes rubric version and model', () => {
    expect(jevCacheKey(state, cfg())).toMatch(/^r1\|jev-latest\|\{/);
  });

  // ---- additional coverage beyond the brief ----

  it('backs off 300 then 900 ms plus jitter across three attempts', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(res(503, {}))
      .mockResolvedValueOnce(res(200));
    const r = await classifyState(state, deps(fetchImpl, { sleep, random: () => 0.999 }));
    expect(r.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([399, 999]);
  });

  it('an AbortError not caused by our own timeout is a network error', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    await expect(classifyState(state, deps(fetchImpl))).rejects.toMatchObject({ code: 'JEV_NETWORK' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps a 200 with a malformed body to JEV_BAD_RESPONSE without retrying or caching', async () => {
    const cache = new MemoryCache();
    const fetchImpl = vi.fn(async () => res(200, { model: 'jev-1.13.0', answers: { nope: true } }));
    await expect(classifyState(state, deps(fetchImpl, { cache }))).rejects.toMatchObject({ code: 'JEV_BAD_RESPONSE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await cache.get('jev', jevCacheKey(state, cfg()))).toBeUndefined();
  });

  it('maps a 200 with non-JSON to JEV_BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    await expect(classifyState(state, deps(fetchImpl))).rejects.toMatchObject({ code: 'JEV_BAD_RESPONSE' });
  });

  it('caches only model and answers, and reports latency from now()', async () => {
    const cache = new MemoryCache();
    let t = 1000;
    const fetchImpl = vi.fn(async () => { t += 250; return res(200); });
    const r = await classifyState(state, deps(fetchImpl, { cache, now: () => t }));
    expect(r.latencyMs).toBe(250);
    expect(await cache.get('jev', jevCacheKey(state, cfg()))).toEqual({ model: 'jev-1.13.0', answers: okBody.answers });
  });

  it('treats a corrupt cache entry as a miss', async () => {
    const cache = new MemoryCache();
    await cache.set('jev', jevCacheKey(state, cfg()), { model: 'jev-1.13.0', answers: { broken: 1 } });
    const fetchImpl = vi.fn(async () => res(200));
    const r = await classifyState(state, deps(fetchImpl, { cache }));
    expect(r.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cache key changes with the model and the state', () => {
    const other = buildJevState(snapshot({ text: 'something else' }));
    expect(jevCacheKey(state, cfg())).not.toBe(jevCacheKey(state, cfg({ jevModel: 'jev-1.14.0' })));
    expect(jevCacheKey(state, cfg())).not.toBe(jevCacheKey(other, cfg()));
  });

  it('logs attempts without key, headers, state or body', async () => {
    const { log, lines } = recLog();
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(500, { detail: 'secret body' })).mockResolvedValueOnce(res(200));
    await classifyState(state, deps(fetchImpl, { log }));
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ e: 'jev.error', f: { attempt: 1, code: 'JEV_HTTP', status: 500 } });
    expect(parsed[1]).toMatchObject({ e: 'jev.request', f: { attempt: 2, status: 200 } });
    const all = lines.join('\n');
    for (const s of [KEY, 'Bearer', 'secret body', 'BELIEVE', 'ragebait']) expect(all).not.toContain(s);
  });
});
