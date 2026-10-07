// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HIDDEN_ATTR, hidePost, hideTargetOf, isHidden, pickAnchor, preserveAnchor, STYLE_ID, unhideAll, unhidePost } from '../../extension/src/content/hider';

function timeline(n: number) {
  document.body.innerHTML = '<div data-testid="primaryColumn">' + Array.from({ length: n }, (_, i) =>
    `<div data-testid="cellInnerDiv" id="c${i}"><div><article data-testid="tweet" id="a${i}"><div>post ${i}</div></article></div></div>`).join('') + '</div>';
  return Array.from({ length: n }, (_, i) => document.getElementById(`a${i}`)!);
}
const rect = (el: Element, top: number, height = 100) => { (el as any).getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }); };
const dynRect = (el: Element, top: () => number, height = 100) => { (el as any).getBoundingClientRect = () => ({ top: top(), bottom: top() + height, height }); };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Anchor at document y=1050 in a window scrolled to 1000 (on-screen top 50); scrollBy moves the viewport. */
function scrolled() {
  const anchor = hideTargetOf(timeline(2)[1]);
  const layout = { top: 1050 };
  const win: any = { scrollY: 1000, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
  win.scrollBy = vi.fn((_x: number, dy: number) => { win.scrollY += dy; });
  dynRect(anchor, () => layout.top - win.scrollY);
  return { anchor, win, layout };
}

describe('hider', () => {
  it('hides the whole cell with an attribute + one stylesheet, and unhides', () => {
    const [a] = timeline(2);
    rect(hideTargetOf(a), 100);
    expect(hidePost(a)).toBe(true);
    expect(hidePost(a)).toBe(false);
    expect(document.getElementById('c0')!.getAttribute(HIDDEN_ATTR)).toBe('1');
    expect(isHidden(a)).toBe(true);
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(STYLE_ID)!.textContent).toContain('display: none !important');
    expect(document.body.textContent).not.toMatch(/hidden by/i); // no stub text anywhere
    expect(unhidePost(a)).toBe(true);
    expect(isHidden(a)).toBe(false);
  });

  it('falls back to the article when there is no cell', () => {
    document.body.innerHTML = '<article data-testid="tweet" id="x"></article>';
    const a = document.getElementById('x')!;
    rect(a, 10);
    hidePost(a);
    expect(a.getAttribute(HIDDEN_ATTR)).toBe('1');
  });

  it('pickAnchor chooses the first visible cell that is not the target', () => {
    const arts = timeline(4);
    const cells = arts.map(hideTargetOf);
    [-300, -150, 20, 300].forEach((t, i) => rect(cells[i], t));
    expect(pickAnchor(cells, cells[0])).toBe(cells[2]);
  });

  it('preserveAnchor scrolls by the anchor shift, including async re-layout', async () => {
    const { anchor, win, layout } = scrolled();
    preserveAnchor(anchor, () => { layout.top = 950; }, win, 200); // the collapsed cell above was 100px
    expect(win.scrollBy).toHaveBeenLastCalledWith(0, -100);
    expect(anchor.getBoundingClientRect().top).toBe(50);
    layout.top = 970; // X moves the cell asynchronously via style.transform
    anchor.setAttribute('style', 'transform: translateY(20px)');
    await tick();
    expect(win.scrollBy).toHaveBeenLastCalledWith(0, 20);
    expect(anchor.getBoundingClientRect().top).toBe(50);
  });

  it('hidePost only preserves the anchor when the target is above the viewport', () => {
    const arts = timeline(3);
    const cells = arts.map(hideTargetOf);
    rect(cells[0], -200); rect(cells[2], 200);
    const hidden = (i: number) => cells[i].hasAttribute(HIDDEN_ATTR);
    // cells[1] moves up when cells[0] collapses; the (unrealistic) shift on hiding cells[2] must be ignored.
    dynRect(cells[1], () => (hidden(0) ? -190 : 10) + (hidden(2) ? 40 : 0));
    const timers: Array<() => void> = [];
    const flush = () => timers.splice(0).forEach((fn) => fn()); // runs the observer disconnects
    const win = { scrollBy: vi.fn(), setTimeout: (fn: () => void) => timers.push(fn) } as any;
    hidePost(arts[0], { win, cells: () => cells });
    expect(win.scrollBy).toHaveBeenCalledTimes(1);
    expect(win.scrollBy).toHaveBeenCalledWith(0, -200);
    expect(timers).toHaveLength(1);
    flush();
    // Restore cells[1] to top 10 so it is an eligible anchor that hiding cells[2] would shift by +40.
    expect(unhidePost(arts[0])).toBe(true);
    win.scrollBy.mockClear();
    hidePost(arts[2], { win, cells: () => cells });
    expect(isHidden(arts[2])).toBe(true);
    expect(win.scrollBy).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
    flush();
    expect(unhideAll(document)).toBe(1);
  });
});

describe('hidePost (one preservation per anchor)', () => {
  it('two hides above the viewport before one re-layout correct the combined shift once', async () => {
    const arts = timeline(3);
    const cells = arts.map(hideTargetOf);
    rect(cells[0], -300); rect(cells[1], -150);
    const anchor = cells[2];
    const layout = { top: 1050 }; // document y; on-screen top 50 at scrollY 1000
    const win: any = { scrollY: 1000, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };
    win.scrollBy = vi.fn((_x: number, dy: number) => { win.scrollY += dy; });
    dynRect(anchor, () => layout.top - win.scrollY);
    expect(hidePost(arts[0], { win, cells: () => cells, timeoutMs: 200 })).toBe(true);
    expect(hidePost(arts[1], { win, cells: () => cells, timeoutMs: 200 })).toBe(true);
    expect(win.scrollBy).not.toHaveBeenCalled(); // X has not re-laid out yet
    layout.top = 850; // one re-layout for both 100px cells
    anchor.setAttribute('style', 'transform: translateY(-200px)');
    await tick();
    expect(win.scrollBy).toHaveBeenCalledTimes(1);
    expect(win.scrollBy).toHaveBeenCalledWith(0, -200);
    expect(anchor.getBoundingClientRect().top).toBe(50);
    expect(isHidden(arts[0]) && isHidden(arts[1])).toBe(true);
  });

  it('a second hide extends the shared preservation window', async () => {
    const arts = timeline(3);
    const cells = arts.map(hideTargetOf);
    rect(cells[0], -300); rect(cells[1], -150);
    const anchor = cells[2];
    const layout = { top: 1050 };
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const win: any = { scrollY: 1000, setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }) };
    win.scrollBy = vi.fn((_x: number, dy: number) => { win.scrollY += dy; });
    dynRect(anchor, () => layout.top - win.scrollY);
    hidePost(arts[0], { win, cells: () => cells });
    hidePost(arts[1], { win, cells: () => cells });
    expect(timers).toHaveLength(2);
    timers[0].fn(); // the first timer is superseded: still observing
    layout.top = 850;
    anchor.setAttribute('style', 'transform: translateY(-200px)');
    await tick();
    expect(win.scrollBy).toHaveBeenCalledTimes(1);
    timers[1].fn(); // the extended timer stops it
    layout.top = 800;
    anchor.setAttribute('style', 'transform: translateY(-250px)');
    await tick();
    expect(win.scrollBy).toHaveBeenCalledTimes(1);
  });
});

describe('preserveAnchor (layout shift only)', () => {
  it('does not undo a user scroll during the window', async () => {
    const { anchor, win, layout } = scrolled();
    preserveAnchor(anchor, () => { layout.top = 950; }, win, 200);
    win.scrollY += 300; // the reader scrolls down
    layout.top = 970;
    anchor.setAttribute('style', 'transform: translateY(20px)');
    await tick();
    expect(win.scrollBy).toHaveBeenLastCalledWith(0, 20);
    expect(win.scrollY).toBe(1220);
    expect(anchor.getBoundingClientRect().top).toBe(-250); // scrolled 300 past its original 50
  });

  it('stops when the anchor cell is recycled for another post', async () => {
    const { anchor, win, layout } = scrolled();
    preserveAnchor(anchor, () => { layout.top = 950; }, win, 200);
    anchor.firstElementChild!.innerHTML = '<article data-testid="tweet"><div>other post</div></article>';
    layout.top = 1500;
    anchor.setAttribute('style', 'transform: translateY(550px)');
    await tick();
    anchor.setAttribute('style', 'transform: translateY(560px)');
    await tick();
    expect(win.scrollBy).toHaveBeenCalledTimes(1);
  });

  it('stops when the anchor is disconnected', async () => {
    const { anchor, win, layout } = scrolled();
    preserveAnchor(anchor, () => { layout.top = 950; }, win, 200);
    anchor.remove();
    layout.top = 0;
    anchor.setAttribute('style', 'transform: translateY(0px)');
    await tick();
    expect(win.scrollBy).toHaveBeenCalledTimes(1);
  });
});

describe('hider (extra)', () => {
  it('pickAnchor skips hidden cells and returns null when nothing is visible', () => {
    const cells = timeline(3).map(hideTargetOf);
    [-100, 10, 50].forEach((t, i) => rect(cells[i], t));
    cells[1].setAttribute(HIDDEN_ATTR, '1');
    expect(pickAnchor(cells, cells[0])).toBe(cells[2]);
    expect(pickAnchor([cells[0]], cells[0])).toBeNull();
  });

  it('preserveAnchor stops correcting after the timeout', async () => {
    const anchor = hideTargetOf(timeline(1)[0]);
    let top = 50;
    (anchor as any).getBoundingClientRect = () => ({ top, bottom: top + 100 });
    const win = { scrollBy: vi.fn(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) } as any;
    preserveAnchor(anchor, () => {}, win, 0);
    expect(win.scrollBy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
    top = 0;
    anchor.setAttribute('style', 'transform: translateY(1px)');
    await new Promise((r) => setTimeout(r, 0));
    expect(win.scrollBy).not.toHaveBeenCalled();
  });

  it('only touches its own attribute and leaves post content in place', () => {
    const [a] = timeline(1);
    rect(hideTargetOf(a), 100);
    const before = document.getElementById('c0')!.innerHTML;
    hidePost(a);
    const cell = document.getElementById('c0')!;
    expect(cell.innerHTML).toBe(before);
    expect([...cell.attributes].map((x) => x.name).sort()).toEqual(['data-lc-hidden', 'data-testid', 'id']);
    expect(unhideAll(document)).toBe(1);
    expect(unhidePost(a)).toBe(false);
  });
});
