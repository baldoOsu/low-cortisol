import { describe, expect, it } from 'vitest';
import { bestThreshold, formatTable, latestLabels, parseJsonl, sweep } from '../../scripts/eval-lib';
import { answers } from '../shared/helpers';

const e = (postId: string, label: 'hide' | 'keep', p: number) => ({ at: '2026-09-30T10:00:00Z', flavor: 'dev', postId, url: '', label, verdict: 'keep', threshold: 0.7, rubricVersion: 'r1', jevModel: 'jev-1.13.0', stage: 'text', answers: answers({ ragebait: p }), state: { post: { author: 'a', text: 't' }, media_status: 'none' } });

describe('eval-lib', () => {
  const entries = [e('1', 'hide', 0.9), e('2', 'hide', 0.6), e('3', 'keep', 0.1), e('4', 'keep', 0.65), e('4', 'keep', 0.65)] as any[];
  it('parses JSONL and dedupes by post (last wins)', () => {
    const text = entries.map((x) => JSON.stringify(x)).join('\n') + '\n\nnot json\n';
    expect(parseJsonl(text)).toHaveLength(5);
    expect(latestLabels(parseJsonl(text))).toHaveLength(4);
  });
  it('sweeps thresholds with recall and FPR', () => {
    const rows = sweep(latestLabels(entries), [0.5, 0.7]);
    expect(rows[0]).toMatchObject({ threshold: 0.5, tp: 2, fn: 0, fp: 1, tn: 1, recall: 1, fpr: 0.5, n: 4 });
    expect(rows[1]).toMatchObject({ threshold: 0.7, tp: 1, fn: 1, fp: 0, tn: 2, recall: 0.5, fpr: 0 });
    expect(bestThreshold(rows, 0.5, 0)).toMatchObject({ threshold: 0.7 });
    expect(bestThreshold(rows)).toBeUndefined();
    expect(formatTable(rows)).toContain('0.50');
  });
  it('last label wins when the owner relabels a post', () => {
    const latest = latestLabels([e('9', 'hide', 0.2), e('9', 'keep', 0.2)] as any[]);
    expect(latest).toHaveLength(1);
    expect(latest[0].label).toBe('keep');
  });
  it('skips JSON lines that are not feedback entries', () => {
    const text = ['{"foo":1}', '[1,2]', 'null', JSON.stringify({ ...e('5', 'hide', 0.9), label: 'maybe' }), JSON.stringify(e('6', 'hide', 0.9))].join('\r\n');
    expect(parseJsonl(text).map((x) => x.postId)).toEqual(['6']);
  });
  it('default sweep covers 0.50..0.95 in steps of 0.05 with exact thresholds', () => {
    const rows = sweep(latestLabels(entries));
    expect(rows.map((r) => r.threshold)).toEqual([0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]);
    // p = 0.65 must count as hidden at T = 0.65 (rule A is ragebait >= T)
    expect(rows[3]).toMatchObject({ threshold: 0.65, fp: 1 });
  });
  it('malformed answers count as keep (fail open), and empty classes report NaN', () => {
    const rows = sweep([{ ...e('7', 'hide', 0.9), answers: {} }] as any[], [0.5]);
    expect(rows[0]).toMatchObject({ tp: 0, fn: 1, fp: 0, tn: 0, recall: 0, n: 1 });
    expect(rows[0].fpr).toBeNaN();
    expect(bestThreshold(rows, 0, 1)).toBeUndefined();
    expect(formatTable(rows)).toContain('n/a');
  });
  it('bestThreshold prefers higher recall, then lower FPR, then the higher threshold', () => {
    const r = (threshold: number, recall: number, fpr: number) => ({ threshold, recall, fpr, tp: 0, fn: 0, fp: 0, tn: 0, n: 0 });
    expect(bestThreshold([r(0.6, 0.9, 0.04), r(0.65, 0.95, 0.05), r(0.7, 0.95, 0.02), r(0.5, 1, 0.2)])).toMatchObject({ threshold: 0.7 });
    expect(bestThreshold([r(0.5, 1, 0), r(0.55, 1, 0), r(0.6, 0.9, 0)])).toMatchObject({ threshold: 0.55 });
  });
});
