// Fetches the media X already displays (pbs.twimg.com) and base64-encodes it for `transcribe`. Spec §4.2

import { MAX_VISION_ITEMS, type TranscribeItem } from '../../../shared/protocol';
import type { MediaRef } from '../../../shared/types';

export const MAX_MEDIA_BYTES = 3.5 * 1024 * 1024;
/** A stalled media fetch fails after this long, so the post's vision pass ends instead of pending forever. */
export const MEDIA_FETCH_TIMEOUT_MS = 15_000;

const CHUNK = 0x8000;

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Only media X already displays: https on pbs.twimg.com (hard rule; the scanner checks this too). */
export function isAllowedMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com';
  } catch {
    return false;
  }
}

async function fetchOne(m: MediaRef, fetchImpl: typeof fetch, timeoutMs: number): Promise<TranscribeItem | undefined> {
  if (!isAllowedMediaUrl(m.url)) return undefined;
  const res = await fetchImpl(m.url, { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return undefined;
  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mediaType.startsWith('image/')) return undefined;
  if (Number(res.headers.get('content-length')) > MAX_MEDIA_BYTES) return undefined;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_MEDIA_BYTES) return undefined;
  return { key: m.key, kind: m.kind, inQuote: m.inQuote, alt: m.alt, mediaType, dataBase64: arrayBufferToBase64(buf) };
}

export async function fetchMediaItems(
  media: MediaRef[],
  fetchImpl: typeof fetch = fetch,
  max: number = MAX_VISION_ITEMS,
  timeoutMs: number = MEDIA_FETCH_TIMEOUT_MS,
): Promise<{ items: TranscribeItem[]; failed: string[] }> {
  const picked = media.slice(0, max);
  const results = await Promise.all(picked.map((m) => fetchOne(m, fetchImpl, timeoutMs).catch(() => undefined)));
  const items: TranscribeItem[] = [];
  const failed: string[] = [];
  results.forEach((item, i) => {
    if (item) items.push(item);
    else failed.push(picked[i].key);
  });
  return { items, failed };
}
