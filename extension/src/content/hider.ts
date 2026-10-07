// Complete, stub-free hiding of a post's timeline cell (answer 19b), keeping the reader's scroll
// position stable when the hidden cell is above the viewport. Touches only HIDDEN_ATTR and STYLE_ID.

export const HIDDEN_ATTR = 'data-lc-hidden';
export const STYLE_ID = 'lc-style';

const CELL_SELECTOR = 'div[data-testid="cellInnerDiv"]';

const STYLE_TEXT = `[${HIDDEN_ATTR}] > * { display: none !important; }
[${HIDDEN_ATTR}] { border: 0 !important; margin: 0 !important; padding: 0 !important; }
article[${HIDDEN_ATTR}] { display: none !important; }
`;

/** Insert the one shared stylesheet if it is not there yet. */
export function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** The element that gets hidden: the post's timeline cell, else the article itself. */
export function hideTargetOf(article: Element): HTMLElement {
  return (article.closest(CELL_SELECTOR) ?? article) as HTMLElement;
}

export function isHidden(article: Element): boolean {
  return hideTargetOf(article).hasAttribute(HIDDEN_ATTR);
}

/** Hide the post's cell. Returns true if it was newly hidden. */
export function hidePost(
  article: Element,
  opts: { win?: Window; cells?: () => Element[]; timeoutMs?: number } = {},
): boolean {
  const doc = article.ownerDocument;
  ensureStyles(doc);
  const t = hideTargetOf(article);
  if (t.hasAttribute(HIDDEN_ATTR)) return false;
  const win = opts.win ?? doc.defaultView;
  const mutate = () => t.setAttribute(HIDDEN_ATTR, '1');

  if (win && t.getBoundingClientRect().bottom <= 0) {
    // Entirely above the viewport: collapsing it would shift everything the reader sees.
    const cells = opts.cells?.() ?? [...doc.querySelectorAll(CELL_SELECTOR)];
    const anchor = pickAnchor(cells, t);
    if (anchor) {
      preserveAnchor(anchor, mutate, win, opts.timeoutMs ?? 1000);
      return true;
    }
  }
  mutate();
  return true;
}

/** Returns true if the post was hidden. */
export function unhidePost(article: Element): boolean {
  const t = hideTargetOf(article);
  if (!t.hasAttribute(HIDDEN_ATTR)) return false;
  t.removeAttribute(HIDDEN_ATTR);
  return true;
}

/** Unhide everything; returns how many elements were unhidden. */
export function unhideAll(doc: Document): number {
  const hidden = doc.querySelectorAll(`[${HIDDEN_ATTR}]`);
  hidden.forEach((el) => el.removeAttribute(HIDDEN_ATTR));
  return hidden.length;
}

/** First cell other than `target`, not hidden, whose top is at or below the viewport top. */
export function pickAnchor(cells: Element[], target: Element): Element | null {
  for (const cell of cells) {
    if (cell === target || cell.hasAttribute(HIDDEN_ATTR)) continue;
    if (cell.getBoundingClientRect().top >= 0) return cell;
  }
  return null;
}

/**
 * Run `mutate`, then compensate the layout shift it caused so `anchor` stays where it was on screen.
 * X re-lays out its virtualised list asynchronously (style.transform on cells), so keep compensating
 * on the anchor's style changes for `timeoutMs`. Only the anchor's document position (rect.top +
 * scrollY) is tracked, so the reader's own scrolling is never undone. Stops early if the anchor is
 * detached or X recycles the cell for another post (its first article/child changes).
 * One preservation per anchor: if the anchor is already being preserved, a further hide reuses that
 * observer and baseline and extends its timeout, so a combined re-layout is compensated exactly once.
 */
export function preserveAnchor(anchor: Element, mutate: () => void, win: Window, timeoutMs = 1000): void {
  const existing = active.get(anchor);
  if (existing && !existing.stopped) {
    mutate();
    existing.correct();
    if (!existing.stopped) existing.extend(timeoutMs);
    return;
  }
  const docTop = () => anchor.getBoundingClientRect().top + (win.scrollY ?? 0);
  const content = () => anchor.querySelector('article') ?? anchor.firstElementChild;
  const original = content();
  let base = docTop();
  let generation = 0;
  const observer = new MutationObserver((records) => records.forEach(correct));
  const state: Preservation = {
    stopped: false,
    correct,
    extend(ms) {
      const g = ++generation;
      win.setTimeout(() => { if (g === generation) stop(); }, ms);
    },
  };
  function stop() {
    state.stopped = true;
    observer.disconnect();
    if (active.get(anchor) === state) active.delete(anchor);
  }
  function correct() {
    if (state.stopped) return;
    if (!anchor.isConnected || content() !== original) return stop();
    const d = docTop() - base;
    if (Math.abs(d) < 1) return;
    win.scrollBy(0, d);
    base = docTop();
  }
  mutate();
  correct();
  if (state.stopped) return;
  active.set(anchor, state);
  observer.observe(anchor, { attributes: true, attributeFilter: ['style'] });
  state.extend(timeoutMs);
}

interface Preservation {
  stopped: boolean;
  /** Scroll by the anchor's shift since the last correction (idempotent). */
  correct(): void;
  /** Restart the stop timer. */
  extend(timeoutMs: number): void;
}

const active = new WeakMap<Element, Preservation>();
