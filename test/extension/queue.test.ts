import { describe, expect, it } from 'vitest';
import { InFlight, LruCache, Semaphore } from '../../extension/src/background/queue';

describe('queue', () => {
  it('Semaphore caps concurrency', async () => {
    const s = new Semaphore(2);
    let live = 0, peak = 0;
    const job = () => s.run(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });
  it('LruCache evicts least recently used', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });
  it('InFlight dedupes concurrent work by key', async () => {
    const f = new InFlight<string, number>();
    let calls = 0;
    const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return 7; };
    expect(await Promise.all([f.run('k', fn), f.run('k', fn)])).toEqual([7, 7]);
    expect(calls).toBe(1);
    await f.run('k', fn);
    expect(calls).toBe(2);
  });

  it('InFlight clears the key after a rejection or synchronous throw', async () => {
    const f = new InFlight<string, number>();
    await expect(f.run('k', async () => { throw new Error('a'); })).rejects.toThrow('a');
    await expect(f.run('k', () => { throw new Error('b'); })).rejects.toThrow('b');
    expect(await f.run('k', async () => 1)).toBe(1);
  });
  it('Semaphore exposes active and waiting counts and releases on rejection', async () => {
    const s = new Semaphore(1);
    let release!: () => void;
    const a = s.run(() => new Promise<void>((r) => { release = r; }));
    const b = s.run(async () => { throw new Error('x'); });
    await Promise.resolve();
    expect([s.active, s.waiting]).toEqual([1, 1]);
    release();
    await a;
    await expect(b).rejects.toThrow('x');
    expect([s.active, s.waiting]).toEqual([0, 0]);
  });
});
