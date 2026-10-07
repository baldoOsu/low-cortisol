// chrome.storage.local writers: "hidden today" ids and the feedback log. Spec §4.2

import { STORAGE_KEYS, type FeedbackEntry, type HiddenStats } from '../../../shared/protocol';
import { localDay } from '../../../shared/day';

export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const MAX_HIDDEN_IDS = 10000;
export const MAX_FEEDBACK = 5000;

// Read-modify-write must not interleave (e.g. two `hidden` messages for the same post).
let chain: Promise<unknown> = Promise.resolve();

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

export function recordHidden(storage: StorageAreaLike, postId: string, now: Date = new Date()): Promise<number> {
  return locked(async () => {
    const day = localDay(now);
    const stored = (await storage.get(STORAGE_KEYS.stats))[STORAGE_KEYS.stats] as Partial<HiddenStats> | undefined;
    const ids =
      stored && typeof stored === 'object' && stored.day === day && Array.isArray(stored.hiddenIds)
        ? stored.hiddenIds
        : [];
    if (!ids.includes(postId)) ids.push(postId);
    const stats: HiddenStats = { day, hiddenIds: ids.slice(-MAX_HIDDEN_IDS) };
    await storage.set({ [STORAGE_KEYS.stats]: stats });
    return stats.hiddenIds.length;
  });
}

export function appendFeedback(storage: StorageAreaLike, entry: FeedbackEntry): Promise<number> {
  return locked(async () => {
    const stored = (await storage.get(STORAGE_KEYS.feedback))[STORAGE_KEYS.feedback];
    const feedback = [...(Array.isArray(stored) ? stored : []), entry].slice(-MAX_FEEDBACK);
    await storage.set({ [STORAGE_KEYS.feedback]: feedback });
    return feedback.length;
  });
}
