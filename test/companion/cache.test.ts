import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileCache, sha256Hex } from '../../companion/src/cache';

describe('FileCache', () => {
  it('stores, reads and expires after ttl', async () => {
    let now = 1_000_000;
    const c = new FileCache(mkdtempSync(join(tmpdir(), 'lc-cache-')), 30, () => now);
    await c.set('jev', 'k1', { a: 1 });
    expect(await c.get('jev', 'k1')).toEqual({ a: 1 });
    expect(await c.get('transcripts', 'k1')).toBeUndefined();
    now += 30 * 86_400_000 + 1;
    expect(await c.get('jev', 'k1')).toBeUndefined();
    expect(await c.sweep()).toBe(1);
  });

  it('sha256Hex is hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('lays files out as <dir>/<ns>/<sha>.json and leaves no temp files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-cache-'));
    const c = new FileCache(dir, 30, () => 5);
    await c.set('jev', 'k', 'v1');
    await c.set('jev', 'k', 'v2');
    expect(readdirSync(join(dir, 'jev'))).toEqual([`${sha256Hex('k')}.json`]);
    expect(await c.get('jev', 'k')).toBe('v2');
  });

  it('unparsable entries read as undefined and are swept; fresh entries survive sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-cache-'));
    const c = new FileCache(dir, 30, () => 1000);
    await c.set('jev', 'fresh', 1);
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'transcripts', `${sha256Hex('bad')}.json`), '{oops');
    expect(await c.get('transcripts', 'bad')).toBeUndefined();
    expect(await c.sweep()).toBe(1);
    expect(await c.get('jev', 'fresh')).toBe(1);
  });

  it('swallows fs errors: unusable dir, missing dir, bad namespace', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lc-cache-')), 'plain-file');
    writeFileSync(file, 'x');
    const c = new FileCache(file, 30); // a file, not a directory
    await expect(c.set('jev', 'k', 1)).resolves.toBeUndefined();
    expect(await c.get('jev', 'k')).toBeUndefined();
    expect(await c.sweep()).toBe(0);
    expect(await new FileCache(join(tmpdir(), `lc-missing-${process.pid}-${Date.now()}`), 30).sweep()).toBe(0);
    const ok = new FileCache(mkdtempSync(join(tmpdir(), 'lc-cache-')), 30);
    await ok.set('../escape', 'k', 1);
    expect(await ok.get('../escape', 'k')).toBeUndefined();
  });
});
