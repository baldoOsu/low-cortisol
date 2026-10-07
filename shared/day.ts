// "N hidden today" bookkeeping helpers shared by the service worker (writer) and popup (reader).

import type { HiddenStats } from './protocol';

/** Local calendar day as "YYYY-MM-DD". */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Count of posts hidden today from the stored stats record (0 if missing, malformed or from another day). */
export function hiddenCountFrom(stats: unknown, now: Date): number {
  const s = stats as Partial<HiddenStats> | undefined;
  if (!s || typeof s !== 'object' || s.day !== localDay(now) || !Array.isArray(s.hiddenIds)) return 0;
  return s.hiddenIds.length;
}
