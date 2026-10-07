import { describe, expect, it } from 'vitest';
import { hash53, stableStringify } from '../../shared/hash';
import { effectiveJev, effectiveStage, mergeResult } from '../../shared/results';
import type { ResultMsg } from '../../shared/protocol';
import { answers } from './helpers';

describe('hash', () => {
  it('stableStringify sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('hash53 is stable and discriminates', () => {
    expect(hash53('abc')).toBe(hash53('abc'));
    expect(hash53('abc')).not.toBe(hash53('abd'));
    expect(hash53('')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('results', () => {
  const jev = (p: number) => ({ model: 'jev-1.13.0', answers: answers({ ragebait: p }), latencyMs: 300, cached: false });
  const msg = (o: Partial<ResultMsg>): ResultMsg => ({
    type: 'result',
    postId: '1',
    snapHash: 'h1',
    stage: 'text',
    vision: 'none',
    timings: {},
    ...o,
  });

  it('prefers the full pass', () => {
    let s = mergeResult(undefined, msg({ jev: jev(0.1), vision: 'pending' }));
    expect(effectiveStage(s)).toBe('text');
    s = mergeResult(s, msg({ stage: 'full', jev: jev(0.9), vision: 'done', transcripts: [] }));
    expect(effectiveJev(s)?.answers.ragebait.noul).toBe(0.9);
    expect(effectiveStage(s)).toBe('full');
    expect(s.vision).toBe('done');
  });

  it('keeps the text verdict when vision fails', () => {
    let s = mergeResult(undefined, msg({ jev: jev(0.2), vision: 'pending' }));
    s = mergeResult(s, msg({ stage: 'full', vision: 'failed', error: { code: 'CLAUDE_FAILED', message: 'x' } }));
    expect(effectiveJev(s)?.answers.ragebait.noul).toBe(0.2);
    expect(s.error?.code).toBe('CLAUDE_FAILED');
  });

  it('a new snapHash starts fresh', () => {
    const s1 = mergeResult(undefined, msg({ jev: jev(0.9) }));
    const s2 = mergeResult(s1, msg({ snapHash: 'h2', vision: 'pending' }));
    expect(s2.text?.jev).toBeUndefined();
    expect(effectiveJev(s2)).toBeUndefined();
  });
});
