import { describe, expect, it } from 'vitest';
import { appendFeedback, MAX_FEEDBACK, recordHidden, type StorageAreaLike } from '../../extension/src/background/store';

function mem(): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) { const ks = Array.isArray(keys) ? keys : [keys]; await new Promise((r) => setTimeout(r, 1)); return Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async set(items) { await new Promise((r) => setTimeout(r, 1)); Object.assign(data, structuredClone(items)); },
  };
}

describe('store', () => {
  it('recordHidden dedupes under concurrency and rolls over at midnight', async () => {
    const s = mem();
    const d1 = new Date(2026, 8, 30, 10);
    await Promise.all(['1', '2', '1', '3', '2'].map((id) => recordHidden(s, id, d1)));
    expect(s.data.stats).toEqual({ day: '2026-09-30', hiddenIds: ['1', '2', '3'] });
    expect(await recordHidden(s, '4', new Date(2026, 9, 1, 0, 1))).toBe(1);
  });

  it('appendFeedback appends and caps', async () => {
    const s = mem();
    s.data.feedback = Array.from({ length: MAX_FEEDBACK }, (_, i) => ({ postId: String(i) }));
    expect(await appendFeedback(s, { postId: 'new' } as any)).toBe(MAX_FEEDBACK);
    const fb = s.data.feedback as any[];
    expect(fb[fb.length - 1].postId).toBe('new');
    expect(fb[0].postId).toBe('1');
  });

  it('recovers from malformed stored values', async () => {
    const s = mem();
    s.data.feedback = { not: 'an array' };
    s.data.stats = 'garbage';
    expect(await appendFeedback(s, { postId: 'a' } as any)).toBe(1);
    expect(await recordHidden(s, 'x', new Date(2026, 8, 30))).toBe(1);
    expect(s.data.stats).toEqual({ day: '2026-09-30', hiddenIds: ['x'] });
  });
});
