// X route → page kind. Spec §4.1: only home, lists, search, explore and status pages are filtered (Q18).

export type PageKind =
  | 'home'
  | 'list'
  | 'search'
  | 'explore'
  | 'status'
  | 'profile'
  | 'notifications'
  | 'bookmarks'
  | 'messages'
  | 'other';

export interface PageInfo {
  kind: PageKind;
  focalId?: string;
}

const STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED = new Set([
  'home', 'explore', 'search', 'notifications', 'messages', 'i',
  'settings', 'compose', 'login', 'logout', 'tos', 'privacy', 'jobs',
]);
const FILTERED: ReadonlySet<PageKind> = new Set<PageKind>(['home', 'list', 'search', 'explore', 'status']);

export function pageInfo(url: string): PageInfo {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return { kind: 'other' };
  }
  const segs = path.split('/').filter(Boolean);
  const first = (segs[0] ?? '').toLowerCase();

  if (!first || first === 'home') return { kind: 'home' };
  // DMs are checked before anything else so no route pattern can ever make them filterable.
  if (first === 'messages') return { kind: 'messages' };
  const status = STATUS_RE.exec(path);
  if (status) return { kind: 'status', focalId: status[2] };
  if (first === 'search') return { kind: 'search' };
  if (first === 'explore') return { kind: 'explore' };
  if (first === 'notifications') return { kind: 'notifications' };
  if (first === 'i') {
    const second = segs[1]?.toLowerCase();
    if (second === 'lists' && /^\d+$/.test(segs[2] ?? '')) return { kind: 'list' };
    if (second === 'bookmarks') return { kind: 'bookmarks' };
    return { kind: 'other' };
  }
  if (!RESERVED.has(first) && HANDLE_RE.test(segs[0])) return { kind: 'profile' };
  return { kind: 'other' };
}

export function shouldFilter(kind: PageKind): boolean {
  return FILTERED.has(kind);
}
