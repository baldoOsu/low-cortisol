import { describe, expect, it, vi } from 'vitest';
import { createPipelineDeps, processPost, type PipelineDeps, type PipelineStats } from '../../extension/src/background/pipeline';
import { NativeCallError, type NativeApi } from '../../extension/src/background/native';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { PostMsg, ResultMsg } from '../../shared/protocol';
import type { Settings } from '../../shared/types';
import { answers, snapshot } from '../shared/helpers';

const stats = (): PipelineStats => ({ record: vi.fn(), setRateLimit: vi.fn(), pending: { text: 0, vision: 0 } });
const jevRes = (p: number) => ({ model: 'jev-1.13.0', answers: answers({ ragebait: p }), latencyMs: 300, cached: false });
function fakeNative(textP: number, fullP = textP, opts: { failClassify?: boolean; failTranscribe?: boolean } = {}) {
  const calls: any[] = [];
  const native: NativeApi = {
    getStatus: () => ({ companion: 'online' }),
    request: vi.fn(async (call: any) => {
      calls.push(call);
      if (call.type === 'classify') {
        if (opts.failClassify) throw new NativeCallError({ code: 'JEV_HTTP', message: 'Jev HTTP 529', status: 529 });
        return { id: '1', ok: true, type: 'classify', result: jevRes(call.state.media_status === 'transcribed' ? fullP : textP) } as any;
      }
      if (opts.failTranscribe) throw new NativeCallError({ code: 'CLAUDE_FAILED', message: 'x' });
      return { id: '2', ok: true, type: 'transcribe', latencyMs: 4000, cachedKeys: [], transcripts: call.items.map((i: any) => ({ key: i.key, kind: i.kind, inQuote: i.inQuote, visibleText: 'T', description: 'D', cues: [], model: call.model })), rateLimit: { fiveHourUtilization: 0.1 } } as any;
    }) as any,
  };
  return { native, calls };
}
const withMedia = snapshot({ media: [{ kind: 'image', url: 'https://pbs.twimg.com/media/A?name=small', key: 'media/A', inQuote: false }] });
const post = (s = withMedia): PostMsg => ({ type: 'post', snapshot: s, snapHash: 'h1' });
const fetchMedia = vi.fn(async (m: any[]) => ({ items: m.map((x) => ({ key: x.key, kind: x.kind, inQuote: x.inQuote, mediaType: 'image/jpeg', dataBase64: 'AQID' })), failed: [] }));
async function run(native: NativeApi, settings: Partial<Settings> = {}, msg = post(), fm: PipelineDeps['fetchMedia'] = fetchMedia) {
  const out: ResultMsg[] = [];
  const st = stats();
  const deps = createPipelineDeps(native, () => ({ ...DEFAULT_SETTINGS.dev, ...settings }), st, fm);
  await processPost(msg, (r) => out.push(r), deps);
  return { out, st, deps };
}

describe('processPost', () => {
  it('text pass then vision pass with the selected model', async () => {
    const { native, calls } = fakeNative(0.1, 0.9);
    const { out, st } = await run(native, { transcriptModel: 'claude-sonnet-5-5' });
    expect(out.map((r) => [r.stage, r.vision])).toEqual([['text', 'pending'], ['full', 'done']]);
    expect(out[1].jev?.answers.ragebait.noul).toBe(0.9);
    expect(out[1].transcripts).toHaveLength(1);
    expect(calls.find((c) => c.type === 'transcribe').model).toBe('claude-sonnet-5-5');
    expect(st.setRateLimit).toHaveBeenCalledWith({ fiveHourUtilization: 0.1 });
    expect(out.every((r) => r.snapHash === 'h1' && r.postId === withMedia.postId)).toBe(true);
  });

  it('no media → vision none; vision off → disabled; flagged by text → skipped', async () => {
    expect((await run(fakeNative(0.1).native, {}, post(snapshot()))).out.map((r) => r.vision)).toEqual(['none']);
    expect((await run(fakeNative(0.1).native, { visionEnabled: false })).out.map((r) => r.vision)).toEqual(['disabled']);
    const f = fakeNative(0.95);
    expect((await run(f.native)).out.map((r) => r.vision)).toEqual(['skipped_flagged']);
    expect(f.calls.some((c) => c.type === 'transcribe')).toBe(false);
  });

  it('fails open: classify error → text result with error, no throw', async () => {
    const { out } = await run(fakeNative(0.1, 0.1, { failClassify: true }).native);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ stage: 'text', error: { code: 'JEV_HTTP' } });
    expect(out[0].jev).toBeUndefined();
  });

  it('fails open: transcribe error → full result vision failed, text verdict stands', async () => {
    const { out } = await run(fakeNative(0.1, 0.1, { failTranscribe: true }).native);
    expect(out[1]).toMatchObject({ stage: 'full', vision: 'failed', error: { code: 'CLAUDE_FAILED' } });
  });

  it('media fetch failure → MEDIA_FETCH_FAILED', async () => {
    const { out } = await run(fakeNative(0.1).native, {}, post(), vi.fn(async () => ({ items: [], failed: ['media/A'] })));
    expect(out[1]).toMatchObject({ vision: 'failed', error: { code: 'MEDIA_FETCH_FAILED' } });
  });

  it('LRU: same text state is classified once', async () => {
    const f = fakeNative(0.1);
    const st = stats();
    const deps = createPipelineDeps(f.native, () => ({ ...DEFAULT_SETTINGS.dev, visionEnabled: false }), st, fetchMedia);
    await processPost(post(snapshot()), () => {}, deps);
    const out: ResultMsg[] = [];
    await processPost(post(snapshot()), (r) => out.push(r), deps);
    expect(f.calls.filter((c) => c.type === 'classify')).toHaveLength(1);
    expect(out[0].jev?.cached).toBe(true);
  });

  it('text error on a post with media reports vision failed (no vision pass follows)', async () => {
    const f = fakeNative(0.1, 0.1, { failClassify: true });
    const { out } = await run(f.native);
    expect(out.map((r) => [r.stage, r.vision])).toEqual([['text', 'failed']]);
    expect(f.calls.some((c) => c.type === 'transcribe')).toBe(false);
  });

  it('balances pending counters and records timings', async () => {
    const { st } = await run(fakeNative(0.1, 0.2).native);
    expect(st.pending).toEqual({ text: 0, vision: 0 });
    expect((st.record as any).mock.calls.map((c: any[]) => c[0])).toEqual(['text', 'vision', 'full']);
    const failed = await run(fakeNative(0.1, 0.1, { failTranscribe: true }).native);
    expect(failed.st.pending).toEqual({ text: 0, vision: 0 });
  });

  it('never throws, even when emit does', async () => {
    const deps = createPipelineDeps(fakeNative(0.1).native, () => DEFAULT_SETTINGS.dev, stats(), fetchMedia);
    await expect(processPost(post(), () => { throw new Error('port closed'); }, deps)).resolves.toBeUndefined();
  });
});
