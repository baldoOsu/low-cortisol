import { describe, expect, it, vi } from 'vitest';
import { arrayBufferToBase64, fetchMediaItems, isAllowedMediaUrl, MAX_MEDIA_BYTES, MEDIA_FETCH_TIMEOUT_MS } from '../../extension/src/background/media';
import type { MediaRef } from '../../shared/types';

const ref = (key: string): MediaRef => ({ kind: 'image', url: `https://pbs.twimg.com/media/${key}?name=small`, key: `media/${key}`, inQuote: false });
describe('media', () => {
  it('base64 of bytes', () => {
    expect(arrayBufferToBase64(new Uint8Array([104, 105]).buffer)).toBe('aGk=');
  });
  it('fetches images, skips non-images, failures and oversize, caps at 6', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/BAD')) return new Response('x', { status: 404 });
      if (url.includes('/HTML')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
      if (url.includes('/BIG')) return new Response(new Uint8Array(MAX_MEDIA_BYTES + 1), { headers: { 'content-type': 'image/jpeg' } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg; charset=binary' } });
    });
    const media = ['A', 'BAD', 'HTML', 'BIG', 'B', 'C', 'D'].map(ref);
    const r = await fetchMediaItems(media, fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
    expect(fetchImpl.mock.calls[0][1]!.signal).toBeInstanceOf(AbortSignal);
    expect(r.items.map((i) => i.key)).toEqual(['media/A', 'media/B', 'media/C']);
    expect(r.items[0]).toMatchObject({ mediaType: 'image/jpeg', dataBase64: 'AQID', kind: 'image', inQuote: false });
    expect(r.failed).toEqual(['media/BAD', 'media/HTML', 'media/BIG']);
  });

  it('never requests anything but https pbs.twimg.com (counted as failed)', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
    const bad = [
      'https://x.com/i/api/graphql/foo',
      'http://pbs.twimg.com/media/A?name=small',
      'https://pbs.twimg.com.evil.example/media/A',
      'https://evil.example/?pbs.twimg.com',
      'https://abs.twimg.com/media/A',
      'not a url',
    ];
    const media = [...bad.map((url, i): MediaRef => ({ kind: 'image', url, key: `bad/${i}`, inQuote: false })), ref('OK')];
    const r = await fetchMediaItems(media, fetchImpl as any, 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toContain('https://pbs.twimg.com/media/OK?name=small');
    expect(r.items.map((i) => i.key)).toEqual(['media/OK']);
    expect(r.failed).toEqual(bad.map((_, i) => `bad/${i}`));
    expect(isAllowedMediaUrl('https://PBS.twimg.com/media/A')).toBe(true); // URL lower-cases the host
  });

  it('a stalled fetch times out and counts as failed', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
    expect(MEDIA_FETCH_TIMEOUT_MS).toBe(15_000);
    const r = await fetchMediaItems([ref('SLOW')], fetchImpl as any, 6, 20);
    expect(r).toEqual({ items: [], failed: ['media/SLOW'] });
  });
});
