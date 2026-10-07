import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { encodeFrame, FrameDecoder } from '../../companion/src/framing';
import { handleRequest, Limiter, runHost, validateRequest, type HostDeps } from '../../companion/src/host';
import { runSelfTest, SELF_TEST_STATE } from '../../companion/src/selftest';
import { HostError, NULL_LOGGER, type CompanionConfig } from '../../companion/src/types';
import type { TranscribeItem } from '../../shared/protocol';
import { answers } from '../shared/helpers';

const cfg: CompanionConfig = { home: '/h', typesafeApiKey: 'k'.repeat(20), apiKeySource: 'env', jevBaseUrl: 'x', jevModel: 'jev-latest', claudePath: 'C:\\claude.exe', claudeEffort: 'low', jevConcurrency: 6, visionConcurrency: 2, cacheTtlDays: 30 };
const deps = (o: Partial<HostDeps> = {}): HostDeps => ({
  version: '0.1.0', cfg, log: NULL_LOGGER,
  classify: vi.fn(async () => ({ model: 'jev-1.13.0', answers: answers({ ragebait: 0.9 }), latencyMs: 300, cached: false })),
  transcribe: vi.fn(async (items: TranscribeItem[]) => ({ transcripts: items.map((i) => ({ key: i.key, kind: i.kind, inQuote: i.inQuote, visibleText: 'T', description: 'D', cues: [], model: 'claude-opus-5-5' })), latencyMs: 4000, cachedKeys: [] })),
  ...o,
});
const state = { post: { author: '@a', text: 't' }, media_status: 'none' };

async function roundTrip(frames: Buffer[], d: HostDeps) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (c) => chunks.push(c));
  const done = runHost(input, output, d);
  for (const f of frames) input.write(f);
  input.end();
  await done;
  const all = Buffer.concat(chunks);
  const dec = new FrameDecoder();
  const decoded = dec.push(all);
  return { decoded, all };
}

describe('host', () => {
  it('hello reports config without the key', async () => {
    const r: any = await handleRequest({ id: '1', type: 'hello', flavor: 'dev', extVersion: '0.1.0' }, deps());
    expect(r).toEqual({ id: '1', ok: true, type: 'hello', companionVersion: '0.1.0', jevConfigured: true, claudeFound: true, claudePath: 'C:\\claude.exe' });
    expect(JSON.stringify(r)).not.toContain('kkkkkkkk');
  });

  it('maps HostError and unknown errors', async () => {
    const d = deps({ classify: vi.fn(async () => { throw new HostError('JEV_HTTP', 'Jev HTTP 529', 529); }) });
    expect(await handleRequest({ id: '2', type: 'classify', state }, d)).toEqual({ id: '2', ok: false, type: 'classify', error: { code: 'JEV_HTTP', message: 'Jev HTTP 529', status: 529 } });
    const d2 = deps({ classify: vi.fn(async () => { throw new Error('secret stack'); }) });
    expect(await handleRequest({ id: '3', type: 'classify', state }, d2)).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'internal error' } });
  });

  it('validates requests', () => {
    expect(() => validateRequest({ id: '1', type: 'nope' })).toThrow(HostError);
    expect(() => validateRequest({ id: '1', type: 'transcribe', model: 'claude-sonnet-5', items: [] })).toThrow(HostError);
    expect(validateRequest({ id: '1', type: 'classify', state }).type).toBe('classify');
  });

  it('runHost output is only well-formed frames', async () => {
    const { decoded, all } = await roundTrip([
      encodeFrame({ id: '1', type: 'hello', flavor: 'prod', extVersion: '0.1.0' }),
      encodeFrame({ id: '2', type: 'classify', state }),
      encodeFrame({ id: '3', type: 'transcribe', model: 'claude-opus-5-5', items: [{ key: 'media/A', kind: 'image', inQuote: false, mediaType: 'image/png', dataBase64: 'AA==' }] }),
    ], deps());
    expect(decoded.map((d: any) => d.ok && d.value.id).sort()).toEqual(['1', '2', '3']);
    let off = 0, frames = 0;
    while (off < all.length) { off += 4 + all.readUInt32LE(off); frames++; }
    expect(off).toBe(all.length);
    expect(frames).toBe(3);
  });

  it('malformed frame → BAD_REQUEST, keeps serving', async () => {
    const bad = Buffer.from('{x', 'utf8');
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(bad.length, 0);
    const { decoded } = await roundTrip([Buffer.concat([hdr, bad]), encodeFrame({ id: '9', type: 'hello', flavor: 'dev', extVersion: '0' })], deps());
    const vals = decoded.map((d: any) => d.value);
    expect(vals).toContainEqual({ id: 'unknown', ok: false, type: 'unknown', error: { code: 'BAD_REQUEST', message: 'malformed JSON frame' } });
    expect(vals.some((v: any) => v.id === '9' && v.ok)).toBe(true);
  });

  it('oversize result becomes RESPONSE_TOO_LARGE', async () => {
    const d = deps({ transcribe: vi.fn(async () => ({ transcripts: [{ key: 'k', kind: 'image', inQuote: false, visibleText: 'x'.repeat(1_100_000), description: '', cues: [], model: 'claude-opus-5-5' }], latencyMs: 1, cachedKeys: [] })) as any });
    const { decoded } = await roundTrip([encodeFrame({ id: '5', type: 'transcribe', model: 'claude-opus-5-5', items: [{ key: 'k', kind: 'image', inQuote: false, mediaType: 'image/png', dataBase64: 'AA==' }] })], d);
    expect((decoded[0] as any).value).toEqual({ id: '5', ok: false, type: 'transcribe', error: { code: 'RESPONSE_TOO_LARGE', message: 'response exceeds 1 MiB' } });
  });

  it('limits concurrent transcribes to visionConcurrency', async () => {
    let live = 0, peak = 0;
    const d = deps({ transcribe: vi.fn(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; return { transcripts: [], latencyMs: 1, cachedKeys: [] }; }) as any });
    const item = { key: 'k', kind: 'image', inQuote: false, mediaType: 'image/png', dataBase64: 'AA==' };
    await roundTrip([1, 2, 3, 4].map((i) => encodeFrame({ id: String(i), type: 'transcribe', model: 'claude-opus-5-5', items: [item] })), d);
    expect(peak).toBe(2);
  });

  it('limits concurrent classifies to jevConcurrency', async () => {
    let live = 0, peak = 0;
    const d = deps({
      cfg: { ...cfg, jevConcurrency: 3 },
      classify: vi.fn(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; return { model: 'm', answers: answers(), latencyMs: 1, cached: false }; }),
    });
    const { decoded } = await roundTrip([1, 2, 3, 4, 5, 6, 7].map((i) => encodeFrame({ id: String(i), type: 'classify', state })), d);
    expect(peak).toBe(3);
    expect(decoded).toHaveLength(7);
  });

  it('bad requests echo a usable id and type, else unknown', async () => {
    expect(await handleRequest({ id: '4', type: 'transcribe', model: 'claude-opus-5-5', items: [] }, deps())).toEqual({
      id: '4', ok: false, type: 'transcribe', error: { code: 'BAD_REQUEST', message: 'transcribe needs 1-6 items' },
    });
    expect(await handleRequest({ id: 7, type: 'nope' }, deps())).toMatchObject({ id: 'unknown', ok: false, type: 'unknown', error: { code: 'BAD_REQUEST' } });
    expect(await handleRequest(null, deps())).toMatchObject({ id: 'unknown', type: 'unknown', error: { code: 'BAD_REQUEST' } });
  });

  it('validates classify state and transcribe items', () => {
    const item = { key: 'k', kind: 'image', inQuote: false, mediaType: 'image/png', dataBase64: 'AA==' };
    expect(() => validateRequest({ id: '', type: 'hello' })).toThrow(HostError);
    expect(() => validateRequest({ id: '1', type: 'classify', state: { media_status: 'none' } })).toThrow(HostError);
    expect(() => validateRequest({ id: '1', type: 'transcribe', model: 'claude-opus-5-5', items: Array(7).fill(item) })).toThrow(HostError);
    expect(() => validateRequest({ id: '1', type: 'transcribe', model: 'claude-opus-5-5', items: [{ ...item, dataBase64: 1 }] })).toThrow(HostError);
    expect(validateRequest({ id: '1', type: 'transcribe', model: 'claude-sonnet-5-5', items: Array(6).fill(item) }).type).toBe('transcribe');
  });

  it('an oversize inbound header writes one BAD_REQUEST and ends', async () => {
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c) => chunks.push(c));
    const done = runHost(input, output, deps());
    input.write(encodeFrame({ id: '1', type: 'hello', flavor: 'dev', extVersion: '0' }));
    input.write(hdr);
    await done; // resolves without input.end()
    const vals = new FrameDecoder().push(Buffer.concat(chunks)).map((d: any) => d.value);
    expect(vals).toHaveLength(2);
    expect(vals).toContainEqual({ id: 'unknown', ok: false, type: 'unknown', error: { code: 'BAD_REQUEST', message: 'request frame exceeds 64 MiB' } });
    expect(vals.some((v: any) => v.id === '1' && v.ok)).toBe(true);
  });

  it('never writes anything but frames, even when a dependency logs or throws', async () => {
    const d = deps({ classify: vi.fn(async () => { throw new TypeError('boom'); }) });
    const { decoded, all } = await roundTrip([encodeFrame({ id: '1', type: 'classify', state })], d);
    expect(decoded).toHaveLength(1);
    expect(all.length).toBe(4 + all.readUInt32LE(0));
    expect(JSON.stringify(decoded)).not.toContain('boom');
  });
});

describe('Limiter', () => {
  it('runs at most max tasks in FIFO order and survives failures', async () => {
    const lim = new Limiter(2);
    const started: number[] = [];
    let live = 0, peak = 0;
    const task = (i: number, fail = false) => lim.run(async () => {
      started.push(i); live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      if (fail) throw new Error('x');
      return i;
    });
    const results = await Promise.allSettled([task(1, true), task(2), task(3), task(4, true), task(5)]);
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
    expect(await task(6)).toBe(6);
  });
});

describe('runSelfTest', () => {
  const probePng = Buffer.from('png');
  const transcript = { key: 'selftest/probe', kind: 'image' as const, inQuote: false, visibleText: 'A small checkerboard\npattern of blue and yellow squares here', description: 'd', cues: [], model: 'claude-opus-5-5' };
  const base = () => ({
    cfg,
    vision: false,
    out: vi.fn(),
    classify: vi.fn(async () => ({ model: 'jev-1.13.0', answers: answers({ ragebait: 0.04 }), latencyMs: 312, cached: false })),
    transcribe: vi.fn(async () => ({ transcripts: [transcript], latencyMs: 4200, cachedKeys: [] })),
    claudeVersion: vi.fn(async (): Promise<string | undefined> => '2.1.281 (Claude Code)'),
    probePng,
  });
  const lines = (o: ReturnType<typeof base>) => o.out.mock.calls.map((c) => c[0]);

  it('prints status lines without the key and passes when everything works', async () => {
    const o = { ...base(), vision: true };
    expect(await runSelfTest(o)).toBe(true);
    expect(lines(o)).toEqual([
      'Low Cortisol companion self-test',
      '  home: /h',
      '  TYPESAFE_API_KEY: present (env)',
      '  Jev: OK (jev-1.13.0, 312 ms, ragebait 0.04)',
      '  claude: C:\\claude.exe (2.1.281 (Claude Code))',
      '  Vision: OK (claude-opus-5-5, 4.2 s, "A small checkerboard pattern of blue and")',
    ]);
    expect(lines(o).join('\n')).not.toContain('kkkkkkkk');
    expect(o.classify).toHaveBeenCalledWith(SELF_TEST_STATE);
    expect(o.transcribe).toHaveBeenCalledWith([{ key: 'selftest/probe', kind: 'image', inQuote: false, mediaType: 'image/png', dataBase64: probePng.toString('base64') }], 'claude-opus-5-5');
  });

  it('fails on a missing key or Jev error, reports claude not found, skips vision unless asked', async () => {
    const o = {
      ...base(),
      cfg: { ...cfg, typesafeApiKey: undefined, apiKeySource: 'none' as const, claudePath: undefined },
      classify: vi.fn(async () => { throw new HostError('NO_API_KEY', 'TYPESAFE_API_KEY is not configured'); }),
    };
    expect(await runSelfTest(o)).toBe(false);
    expect(lines(o).slice(2)).toEqual(['  TYPESAFE_API_KEY: MISSING', '  Jev: FAILED NO_API_KEY', '  claude: NOT FOUND']);
    expect(o.transcribe).not.toHaveBeenCalled();
    expect(o.claudeVersion).not.toHaveBeenCalled();

    const o2 = { ...base(), classify: vi.fn(async () => { throw new HostError('JEV_HTTP', 'Jev HTTP 529', 529); }) };
    expect(await runSelfTest(o2)).toBe(false);
    expect(lines(o2)).toContain('  Jev: FAILED JEV_HTTP 529');
  });

  it('fails when vision fails', async () => {
    const o = { ...base(), vision: true, transcribe: vi.fn(async () => { throw new HostError('CLAUDE_TIMEOUT', 'claude timed out'); }), claudeVersion: vi.fn(async () => undefined) };
    expect(await runSelfTest(o)).toBe(false);
    expect(lines(o).slice(-2)).toEqual(['  claude: C:\\claude.exe (version unknown)', '  Vision: FAILED CLAUDE_TIMEOUT']);
  });
});
