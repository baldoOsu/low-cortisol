import { describe, expect, it } from 'vitest';
import { pageInfo, shouldFilter } from '../../extension/src/content/page';

describe('pageInfo', () => {
  it.each([
    ['https://x.com/home', 'home'], ['https://x.com/', 'home'], ['https://x.com/i/lists/123', 'list'],
    ['https://x.com/search?q=a', 'search'], ['https://x.com/explore/tabs/for_you', 'explore'],
    ['https://x.com/notifications', 'notifications'], ['https://x.com/i/bookmarks', 'bookmarks'],
    ['https://x.com/messages/123-456', 'messages'], ['https://x.com/alice', 'profile'], ['https://x.com/alice/with_replies', 'profile'],
    ['https://x.com/settings/account', 'other'], ['https://x.com/i/communities/1', 'other'], ['https://twitter.com/home', 'home'],
  ])('%s → %s', (url, kind) => expect(pageInfo(url).kind).toBe(kind));

  it('status pages carry the focal id', () => {
    expect(pageInfo('https://x.com/alice/status/1800000000000000102/photo/1')).toEqual({ kind: 'status', focalId: '1800000000000000102' });
  });

  it('filters only home, lists, search, explore and status', () => {
    expect(['home', 'list', 'search', 'explore', 'status'].every((k) => shouldFilter(k as any))).toBe(true);
    expect(['profile', 'notifications', 'bookmarks', 'messages', 'other'].some((k) => shouldFilter(k as any))).toBe(false);
  });

  it.each([
    ['https://x.com/messages', 'messages'], ['https://x.com/Messages/compose', 'messages'],
    ['https://x.com/compose/post', 'other'], ['https://x.com/i/lists/create', 'other'],
    ['https://x.com/not-a-handle', 'other'], ['not a url', 'other'], ['https://x.com/averyveryverylonghandle', 'other'],
    ['https://x.com/notifications/mentions', 'notifications'], ['https://x.com/i/lists/42/members', 'list'],
  ])('edge route %s → %s', (url, kind) => expect(pageInfo(url).kind).toBe(kind));

  it('non-status pages have no focal id', () => {
    expect(pageInfo('https://x.com/home')).toEqual({ kind: 'home' });
  });
});
