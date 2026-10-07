// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentController, ERROR_RETRY_MS, type ContentDeps } from '../../extension/src/content/main';
import { HIDDEN_ATTR } from '../../extension/src/content/hider';
import type { ContentToSw, ResultMsg } from '../../shared/protocol';
import { buildJevState } from '../../shared/rubric';
import { answers } from '../shared/helpers';
import { loadFixture } from './fixtures';

function harness(url = 'https://x.com/home', stored: unknown = { hideEnabled: true, showResults: true }) {
  const sent: ContentToSw[] = [];
  let onMsg: (m: ResultMsg) => void = () => {};
  let onDisc: () => void = () => {};
  const settingsCbs: Array<(raw: unknown) => void> = [];
  let href = url;
  const timers: Array<() => void> = [];
  const deps: ContentDeps = {
    doc: document, win: window, flavor: 'dev',
    connect: vi.fn(() => ({ postMessage: (m: ContentToSw) => sent.push(m), disconnect() {}, onMessage: { addListener: (cb: any) => (onMsg = cb) }, onDisconnect: { addListener: (cb: any) => (onDisc = cb) } })),
    loadSettings: async () => stored,
    onSettingsChanged: (cb) => settingsCbs.push(cb),
    observeNear: (_el, cb) => { cb(); return () => {}; },
    now: () => Date.parse('2026-09-30T10:00:00Z'),
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
    locationHref: () => href,
  };
  const c = new ContentController(deps);
  const posts = () => sent.filter((m): m is Extract<ContentToSw, { type: 'post' }> => m.type === 'post');
  const reply = (postId: string, p: number, extra: Partial<ResultMsg> = {}) => {
    const m = posts().filter((x) => x.snapshot.postId === postId).pop()!;
    onMsg({ type: 'result', postId, snapHash: m.snapHash, stage: 'text', vision: 'none', timings: { textMs: 300 }, jev: { model: 'jev-1.13.0', answers: answers({ ragebait: p }), latencyMs: 300, cached: false }, ...extra });
  };
  return { c, deps, sent, posts, reply, disconnect: () => onDisc(), setSettings: (raw: unknown) => settingsCbs.forEach((cb) => cb(raw)), setHref: (h: string) => (href = h), timers };
}
const article = (suffix: string) => [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => a.querySelector(`a[href$="${suffix}"]`)) as HTMLElement;
const cellHidden = (suffix: string) => article(suffix).closest('[data-testid="cellInnerDiv"]')!.hasAttribute(HIDDEN_ATTR);

describe('ContentController', () => {
  it('sends every non-exempt post once, never own/sidebar posts', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    const ids = h.posts().map((p) => p.snapshot.postId.slice(-3)).sort();
    expect(ids).toEqual(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '012']);
    h.c.scan();
    expect(h.posts()).toHaveLength(11);
  });

  it('hides flagged posts completely, reports hidden once, and shows panels on kept posts', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    h.reply('1800000000000000001', 0.97);
    h.reply('1800000000000000002', 0.05);
    expect(cellHidden('1800000000000000001')).toBe(true);
    expect(cellHidden('1800000000000000002')).toBe(false);
    expect(article('1800000000000000002').querySelector('[data-lc-panel]')).not.toBeNull();
    // Inline under the post text, directly above X's engagement row (not a column beside the post).
    expect(article('1800000000000000002').querySelector('[data-lc-panel]')!.nextElementSibling!.getAttribute('role')).toBe('group');
    expect(article('1800000000000000001').querySelector('[data-lc-panel]')).toBeNull();
    h.c.scan();
    expect(h.sent.filter((m) => m.type === 'hidden')).toEqual([{ type: 'hidden', postId: '1800000000000000001' }]);
  });

  it('settings toggle re-applies instantly from memory', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    h.reply('1800000000000000001', 0.97);
    const before = h.sent.length;
    h.setSettings({ hideEnabled: false, showResults: true });
    expect(cellHidden('1800000000000000001')).toBe(false);
    expect(article('1800000000000000001').querySelector('[data-lc-panel]')!.shadowRoot!.textContent).toContain('HIDE (would hide)');
    h.setSettings({ hideEnabled: true, showResults: true, threshold: 0.95 });
    expect(cellHidden('1800000000000000001')).toBe(true);
    expect(h.sent.length).toBe(before);
  });

  it('inactive settings send nothing and clear everything', async () => {
    loadFixture('home-timeline.html');
    const h = harness('https://x.com/home', { hideEnabled: false, showResults: false });
    await h.c.start();
    expect(h.posts()).toHaveLength(0);
  });

  it('ignores stale results for an old snapHash', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    h.reply('1800000000000000001', 0.97, { snapHash: 'old' } as any);
    expect(cellHidden('1800000000000000001')).toBe(false);
  });

  it('reconcile unhides a cell whose article changed (X recycled it)', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    h.reply('1800000000000000001', 0.97);
    const cell = article('1800000000000000001').closest('[data-testid="cellInnerDiv"]')!;
    const other = article('1800000000000000002').closest('[data-testid="cellInnerDiv"]')!;
    cell.innerHTML = other.innerHTML; // now shows post 002 (kept)
    h.c.scan();
    expect(cell.hasAttribute(HIDDEN_ATTR)).toBe(false);
  });

  it('re-sends unresolved posts after port disconnect', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    h.reply('1800000000000000001', 0.1);
    const n = h.posts().length;
    const k = h.timers.length;
    h.disconnect();
    h.timers.slice(k).forEach((f) => f()); // run the reconnect timer (and any debounce timers)
    const resent = h.posts().slice(n).map((p) => p.snapshot.postId.slice(-3));
    expect(resent).not.toContain('001');
    expect(resent).toContain('002');
  });

  it('status page: focal and ancestor never sent; DMs never scanned', async () => {
    loadFixture('status-page.html');
    const h = harness('https://x.com/dave/status/1800000000000000102');
    await h.c.start();
    expect(h.posts().map((p) => p.snapshot.postId.slice(-3)).sort()).toEqual(['103', '104']);
    loadFixture('dm-drawer.html');
    const h2 = harness('https://x.com/messages/1-2');
    await h2.c.start();
    expect(h2.posts()).toHaveLength(0);
  });

  it('status page: replies stay filtered after the focal and ancestor articles leave the DOM', async () => {
    loadFixture('status-page.html');
    const h = harness('https://x.com/dave/status/1800000000000000102');
    await h.c.start();
    h.reply('1800000000000000103', 0.97);
    h.reply('1800000000000000104', 0.05);
    expect(cellHidden('1800000000000000103')).toBe(true);
    // X's virtual list drops the focal post and its ancestor as the reader scrolls down the replies.
    const cellOf = (id: string) => article(id).closest('[data-testid="cellInnerDiv"]')!;
    const ancestorCell = cellOf('1800000000000000101');
    ancestorCell.remove();
    cellOf('1800000000000000102').remove();
    h.c.scan();
    expect(cellHidden('1800000000000000103')).toBe(true);
    expect(article('1800000000000000104').hasAttribute('data-lc-exempt')).toBe(false);
    expect(article('1800000000000000104').querySelector('[data-lc-panel]')).not.toBeNull();
    // A reply first seen after the focal left is classified like any other reply.
    const late = cellOf('1800000000000000104').cloneNode(true) as Element;
    late.querySelector('[data-lc-panel]')?.remove();
    late.querySelector('a[href$="1800000000000000104"]')!.setAttribute('href', '/frank/status/1800000000000000105');
    cellOf('1800000000000000104').after(late);
    h.c.scan();
    expect(h.posts().map((p) => p.snapshot.postId.slice(-3)).sort()).toEqual(['103', '104', '105']);
    // The remembered ancestor stays exempt when X brings it back without the focal post.
    cellOf('1800000000000000103').before(ancestorCell);
    h.c.scan();
    expect(article('1800000000000000101').getAttribute('data-lc-exempt')).toBe('ancestor');
    expect(h.posts().map((p) => p.snapshot.postId.slice(-3))).not.toContain('101');
  });

  it('status page: everything stays exempt while the focal post was never seen', async () => {
    loadFixture('status-page.html');
    article('1800000000000000102').closest('[data-testid="cellInnerDiv"]')!.remove();
    const h = harness('https://x.com/dave/status/1800000000000000102');
    await h.c.start();
    expect(h.posts()).toHaveLength(0);
    expect(article('1800000000000000103').getAttribute('data-lc-exempt')).toBe('no-focal');
  });

  it('feedback posts a labeled entry with the exact Jev state', async () => {
    loadFixture('home-timeline.html');
    const h = harness('https://x.com/home', { hideEnabled: false, showResults: true });
    await h.c.start();
    h.reply('1800000000000000002', 0.2);
    const root = article('1800000000000000002').querySelector('[data-lc-panel]')!.shadowRoot!;
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Should hide')!.click();
    const fb = h.sent.find((m) => m.type === 'feedback') as any;
    expect(fb.entry).toMatchObject({ postId: '1800000000000000002', label: 'hide', verdict: 'keep', threshold: 0.7, rubricVersion: 'r1', jevModel: 'jev-1.13.0', stage: 'text', flavor: 'dev' });
    const sentSnap = h.posts().find((p) => p.snapshot.postId === '1800000000000000002')!.snapshot;
    expect(fb.entry.state).toEqual(buildJevState(sentSnap));
    expect(root.textContent).toContain('saved ✓ (hide)');
  });

  it('reports selector health changes to the service worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // dev warns on bad health
    document.body.innerHTML = '<div data-testid="primaryColumn"><div data-testid="cellInnerDiv"><article data-testid="tweet"><div>no permalink here</div></article></div></div>';
    const h = harness();
    await h.c.start();
    expect(h.sent.filter((m) => m.type === 'health')).toEqual([{ type: 'health', ok: false, cells: 1, articles: 1, parsed: 0 }]);
    h.c.scan();
    expect(h.sent.filter((m) => m.type === 'health')).toHaveLength(1); // only on change
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reports bad health when the scan root itself is missing on a filtered page, and recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cells = '<div data-testid="cellInnerDiv"><article data-testid="tweet"><div>post</div></article></div>'.repeat(2);
    document.body.innerHTML = `<main>${cells}</main>`; // primaryColumn renamed by X
    const h = harness();
    await h.c.start();
    const health = () => h.sent.filter((m) => m.type === 'health');
    expect(health()).toEqual([{ type: 'health', ok: false, cells: 2, articles: 0, parsed: 0 }]);
    expect(h.posts()).toHaveLength(0);
    h.c.scan();
    expect(health()).toHaveLength(1); // only on change
    loadFixture('home-timeline.html');
    h.c.scan();
    expect(health().at(-1)).toMatchObject({ type: 'health', ok: true });
    // Not a filtered page: no health report.
    h.setHref('https://x.com/notifications');
    document.body.innerHTML = `<main>${cells}</main>`;
    h.c.scan();
    expect(health()).toHaveLength(2);
    warn.mockRestore();
  });
});

describe('ContentController: retries, navigation, reconnect', () => {
  const ID = '1800000000000000001';
  const sentFor = (h: Pick<ReturnType<typeof harness>, 'posts'>, id: string) => h.posts().filter((p) => p.snapshot.postId === id);

  it('retries a post whose result is an error (no answers) after ERROR_RETRY_MS, visible throughout', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    let t = Date.parse('2026-09-30T10:00:00Z');
    h.deps.now = () => t;
    await h.c.start();
    h.reply(ID, 0, { jev: undefined, error: { code: 'JEV_TIMEOUT', message: 'timed out' } });
    expect(cellHidden(ID)).toBe(false);
    expect(article(ID).querySelector('[data-lc-panel]')!.shadowRoot!.textContent).toContain('ERROR JEV_TIMEOUT');

    t += ERROR_RETRY_MS - 1;
    h.c.scan();
    expect(sentFor(h, ID)).toHaveLength(1);
    expect(cellHidden(ID)).toBe(false);

    t += 1;
    h.c.scan();
    expect(sentFor(h, ID)).toHaveLength(2);
    expect(sentFor(h, ID)[1].snapHash).toBe(sentFor(h, ID)[0].snapHash);
    expect(cellHidden(ID)).toBe(false);
    h.c.scan();
    expect(sentFor(h, ID)).toHaveLength(2); // one retry per ERROR_RETRY_MS

    h.reply(ID, 0.97);
    expect(cellHidden(ID)).toBe(true);
    t += ERROR_RETRY_MS;
    h.c.scan();
    expect(sentFor(h, ID)).toHaveLength(2); // resolved: never retried
  });

  it('does not retry an errored post while its article is still being watched', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    let t = 0;
    h.deps.now = () => t;
    const fire: Array<() => void> = [];
    let lazy = false;
    h.deps.observeNear = (_el, cb) => {
      if (lazy) fire.push(cb);
      else cb();
      return () => {};
    };
    await h.c.start();
    h.reply(ID, 0, { jev: undefined, error: { code: 'COMPANION_OFFLINE', message: 'offline' } });
    lazy = true;
    t += ERROR_RETRY_MS;
    h.c.scan();
    expect(fire).toHaveLength(1); // re-observed, not yet near the viewport
    t += ERROR_RETRY_MS;
    h.c.scan();
    expect(fire).toHaveLength(1);
    expect(sentFor(h, ID)).toHaveLength(1);
    fire[0]();
    expect(sentFor(h, ID)).toHaveLength(2);
  });

  it('SPA navigation to DMs unhides everything and removes panels', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    const polls: Array<() => void> = [];
    h.deps.setTimer = (fn, ms) => {
      if (ms === 500) polls.push(fn);
      return 0;
    };
    await h.c.start();
    h.reply(ID, 0.97);
    expect(cellHidden(ID)).toBe(true);
    h.setHref('https://x.com/messages');
    polls.shift()!();
    expect(cellHidden(ID)).toBe(false);
    expect(document.querySelector('[data-lc-panel]')).toBeNull();
    const n = h.sent.length;
    h.reply(ID, 0.99); // a late result must not hide anything on a DM page
    expect(cellHidden(ID)).toBe(false);
    expect(h.sent.length).toBe(n);
    h.setHref('https://x.com/home');
    polls.shift()!();
    expect(cellHidden(ID)).toBe(true);
  });

  it('reconnects with exponential backoff capped at 30 s, reset by a message', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    h.deps.setTimer = (fn, ms) => {
      if (ms !== 500 && ms !== 100) {
        delays.push(ms);
        pending.push(fn);
      }
      return 0;
    };
    await h.c.start();
    for (let i = 0; i < 7; i++) {
      h.disconnect();
      pending.shift()!();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.deps.connect).toHaveBeenCalledTimes(8);
    h.reply('1800000000000000002', 0.1);
    h.disconnect();
    expect(delays.at(-1)).toBe(1000);
  });

  it('queues hidden and feedback messages while disconnected and flushes them on reconnect', async () => {
    loadFixture('home-timeline.html');
    const h = harness('https://x.com/home', { hideEnabled: true, showResults: true, threshold: 0.95 });
    await h.c.start();
    h.reply(ID, 0.8); // kept at 0.95
    h.reply('1800000000000000002', 0.2);
    const k = h.timers.length;
    h.disconnect();
    h.setSettings({ hideEnabled: true, showResults: true, threshold: 0.7 }); // now hides 001 while offline
    expect(cellHidden(ID)).toBe(true);
    const root = article('1800000000000000002').querySelector('[data-lc-panel]')!.shadowRoot!;
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Should keep')!.click();
    expect(root.textContent).toContain('saved ✓ (keep)');
    expect(h.sent.filter((m) => m.type === 'hidden' || m.type === 'feedback')).toHaveLength(0);
    h.timers.slice(k).forEach((f) => f()); // reconnect
    expect(h.sent.filter((m) => m.type === 'hidden')).toEqual([{ type: 'hidden', postId: ID }]);
    expect(h.sent.filter((m) => m.type === 'feedback').map((m: any) => m.entry.label)).toEqual(['keep']);
  });
});

describe('ContentController: reconnect after SW restarts', () => {
  const ID = '1800000000000000001';
  const T0 = Date.parse('2026-09-30T10:00:00Z');
  /** A harness with a mutable clock and inspectable timers (delay, handle, cleared). */
  function clocked(url?: string, stored?: unknown) {
    const h = harness(url, stored);
    let t = T0;
    h.deps.now = () => t;
    const timers: Array<{ fn: () => void; ms: number; id: number; cleared: boolean }> = [];
    h.deps.setTimer = (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ fn, ms, id, cleared: false });
      return id;
    };
    h.deps.clearTimer = (id) => {
      const timer = timers.find((x) => x.id === id);
      if (timer) timer.cleared = true;
    };
    const reconnects = () => timers.filter((x) => x.ms !== 100 && x.ms !== 500);
    const runReconnect = () => {
      const r = reconnects().filter((x) => !x.cleared).pop()!;
      r.cleared = true;
      r.fn();
    };
    return { ...h, timers, reconnects, runReconnect, advance: (ms: number) => (t += ms) };
  }
  const sentFor = (h: Pick<ReturnType<typeof harness>, 'posts'>, id: string) => h.posts().filter((p) => p.snapshot.postId === id);

  it('re-sends every unresolved post from its stored snapshot, even when its article left the DOM', async () => {
    loadFixture('home-timeline.html');
    const h = harness();
    await h.c.start();
    h.reply(ID, 0.1); // resolved
    h.reply('1800000000000000003', 0, { jev: undefined, error: { code: 'JEV_HTTP', message: 'x', status: 529 } });
    h.reply('1800000000000000004', 0.1, { vision: 'pending' });
    h.reply('1800000000000000005', 0.1, { vision: 'pending' });
    h.reply('1800000000000000005', 0.1, { stage: 'full', vision: 'done', transcripts: [] });
    const cell2 = article('1800000000000000002').closest('[data-testid="cellInnerDiv"]')!;
    const parent = cell2.parentElement!;
    cell2.remove(); // X virtualised it away
    const first2 = sentFor(h, '1800000000000000002')[0];
    const n = h.posts().length;
    const k = h.timers.length;
    h.disconnect();
    h.timers.slice(k).forEach((f) => f());
    const resent = h.posts().slice(n);
    expect(resent.map((p) => p.snapshot.postId.slice(-3)).sort()).toEqual(['002', '003', '004', '006', '007', '008', '009', '010', '012']);
    expect(resent.find((p) => p.snapshot.postId.endsWith('002'))).toEqual(first2);

    parent.appendChild(cell2); // it comes back: not sent again, and its result applies
    h.c.scan();
    expect(sentFor(h, '1800000000000000002')).toHaveLength(2);
    h.reply('1800000000000000002', 0.97);
    expect(cellHidden('1800000000000000002')).toBe(true);
  });

  it('re-reports selector health after a reconnect (the SW keeps it in memory only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.body.innerHTML = '<div data-testid="primaryColumn"><div data-testid="cellInnerDiv"><article data-testid="tweet"><div>no permalink here</div></article></div></div>';
    const h = clocked();
    await h.c.start();
    expect(h.sent.filter((m) => m.type === 'health')).toHaveLength(1);
    h.disconnect();
    h.runReconnect();
    h.timers.filter((x) => x.ms === 100 && !x.cleared).forEach((x) => x.fn()); // the debounced scan
    expect(h.sent.filter((m) => m.type === 'health')).toEqual([
      { type: 'health', ok: false, cells: 1, articles: 1, parsed: 0 },
      { type: 'health', ok: false, cells: 1, articles: 1, parsed: 0 },
    ]);
    warn.mockRestore();
  });

  it('long-lived ports that drop (SW idle restarts) do not escalate the backoff', async () => {
    loadFixture('home-timeline.html');
    const h = clocked();
    await h.c.start();
    for (let i = 0; i < 5; i++) {
      h.advance(30_000);
      h.disconnect();
      h.advance(1000);
      h.runReconnect();
    }
    expect(h.reconnects().map((x) => x.ms)).toEqual([1000, 1000, 1000, 1000, 1000]);
    h.disconnect(); // up for 0 ms: a failing connect still backs off
    expect(h.reconnects().at(-1)!.ms).toBe(2000);
  });

  it('a message to send while disconnected reconnects immediately (at most once per second) and is delivered', async () => {
    loadFixture('home-timeline.html');
    const h = clocked();
    await h.c.start();
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    h.advance(5000);
    h.disconnect();
    const pending = h.reconnects().at(-1)!;
    // A post scrolls in / changes: its snapshot must go out now, not after the backoff.
    article('1800000000000000002').querySelector('[data-testid="tweetText"]')!.textContent = 'edited';
    h.c.scan();
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
    expect(pending.cleared).toBe(true);
    const edited = sentFor(h, '1800000000000000002');
    expect(edited).toHaveLength(2);
    expect(edited[1].snapshot.text).toBe('edited');

    h.disconnect(); // drops again right away
    article('1800000000000000003').querySelector('[data-testid="tweetText"]')!.textContent = 'edited too';
    h.c.scan();
    expect(h.deps.connect).toHaveBeenCalledTimes(2); // rate limited: < 1 s since the last connect
    h.advance(999);
    h.c.scan();
    expect(h.deps.connect).toHaveBeenCalledTimes(2);
    h.advance(1);
    article('1800000000000000004').querySelector('[data-testid="tweetText"]')!.textContent = 'edited three';
    h.c.scan();
    expect(h.deps.connect).toHaveBeenCalledTimes(3);
    // Both the rate-limited post and the new one are delivered on the new port.
    expect(sentFor(h, '1800000000000000003').at(-1)!.snapshot.text).toBe('edited too');
    expect(sentFor(h, '1800000000000000004').at(-1)!.snapshot.text).toBe('edited three');
  });

  it('stops for good when the extension context is gone (orphaned script), leaving X untouched', async () => {
    loadFixture('home-timeline.html');
    const h = clocked();
    let valid = true;
    h.deps.contextValid = () => valid;
    await h.c.start();
    h.reply(ID, 0.97);
    expect(cellHidden(ID)).toBe(true);
    h.deps.connect = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    valid = false;
    h.advance(5000);
    h.disconnect();
    h.runReconnect();
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(cellHidden(ID)).toBe(false);
    expect(document.querySelector('[data-lc-panel]')).toBeNull();
    expect(h.reconnects().filter((x) => !x.cleared)).toHaveLength(0);
    h.advance(60_000);
    article('1800000000000000002').querySelector('[data-testid="tweetText"]')!.textContent = 'edited';
    h.c.scan();
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(cellHidden(ID)).toBe(false); // a stopped controller never touches the page again
  });

  it('an orphan stop() in the middle of a scan leaves nothing hidden', async () => {
    loadFixture('home-timeline.html');
    const h = clocked('https://x.com/home', { hideEnabled: false, showResults: true });
    let valid = true;
    h.deps.contextValid = () => valid;
    await h.c.start();
    for (const id of ['1800000000000000001', '1800000000000000002', '1800000000000000003']) h.reply(id, 0.97);
    expect(document.querySelectorAll(`[${HIDDEN_ATTR}]`)).toHaveLength(0);
    h.disconnect(); // the port is down; the first 'hidden' message will reconnect on demand
    h.deps.connect = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    valid = false;
    h.advance(5000);
    h.setSettings({ hideEnabled: true, showResults: true }); // scan: hide 001 → post → connect throws → stop
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`[${HIDDEN_ATTR}]`)).toHaveLength(0);
    expect(document.querySelector('[data-lc-panel]')).toBeNull();
  });
});
