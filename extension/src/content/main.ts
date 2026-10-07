// Content script orchestration (spec §4.1 main.ts): scan → send → result → decide → hide / dev panel.
// Fail open: nothing is hidden without a verdict; errors, disconnects and inactive settings leave posts visible.

import { decide, type Decision } from '../../../shared/decide';
import { hash53, stableStringify } from '../../../shared/hash';
import {
  PORT_NAME,
  STORAGE_KEYS,
  type ContentToSw,
  type FeedbackEntry,
  type ResultMsg,
} from '../../../shared/protocol';
import { effectiveJev, effectiveStage, mergeResult, type PostResultState } from '../../../shared/results';
import { RUBRIC_VERSION, buildJevState } from '../../../shared/rubric';
import { effectiveSettings, isClassificationActive } from '../../../shared/settings';
import type { Flavor, PostSnapshot, Settings } from '../../../shared/types';
import { HIDDEN_ATTR, hidePost, unhideAll, unhidePost } from './hider';
import { pageInfo, shouldFilter, type PageInfo } from './page';
import { PANEL_ATTR, removeAllPanels, removePanel, renderPanel } from './panel';
import { exemptReason, snapshotArticle, type ExemptContext, type ExemptReason } from './scanner';
import { SEL, checkHealth, findArticles, ownHandleOf, postIdOf, scanRoot } from './selectors';

export const EXEMPT_ATTR = 'data-lc-exempt';
export const SCAN_DEBOUNCE_MS = 100;
export const URL_POLL_MS = 500;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** On-demand reconnects (a message to send while the port is down) are at most this frequent. */
export const CONNECT_MIN_INTERVAL_MS = 1000;
/** A post whose result is an error without answers is re-sent on a later scan after this long. */
export const ERROR_RETRY_MS = 30_000;
/** Non-post messages kept while the port is down; posts are re-sent from `sent` instead. */
const OUTBOX_MAX = 200;

export interface ContentPort {
  postMessage(m: ContentToSw): void;
  disconnect(): void;
  onMessage: { addListener(cb: (m: ResultMsg) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface ContentDeps {
  doc: Document;
  win: Window;
  flavor: Flavor;
  connect: () => ContentPort;
  /** Raw stored settings. */
  loadSettings: () => Promise<unknown>;
  onSettingsChanged: (cb: (raw: unknown) => void) => void;
  /** Calls `cb` once when `el` comes within 2,000 px of the viewport; returns a cancel function. */
  observeNear: (el: Element, cb: () => void) => () => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  locationHref: () => string;
  /** False once the extension was reloaded/removed under this script (default: always valid). */
  contextValid?: () => boolean;
}

interface SentPost {
  snapHash: string;
  snapshot: PostSnapshot;
  at: number;
}

type ScanContext = ExemptContext & { root: Element };

export class ContentController {
  private settings: Settings;
  private readonly results = new Map<string, PostResultState>();
  /** The last snapshot sent per post; results for any other snapHash are dropped. */
  private readonly sent = new Map<string, SentPost>();
  /** The snapshot each stored result was computed from (feedback records its exact Jev state). */
  private readonly resultSnaps = new Map<string, PostSnapshot>();
  private readonly hiddenReported = new Set<string>();
  private readonly saved = new Map<string, 'hide' | 'keep'>();
  /** Articles with an active observeNear, and its cancel function. */
  private readonly watching = new Map<Element, () => void>();
  /** Status pages: focal id → ids of the focal post and its ancestors, seen while the focal was in the DOM. */
  private readonly threadExempt = new Map<string, Set<string>>();

  private port: ContentPort | null = null;
  private outbox: ContentToSw[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = undefined;
  private lastConnectAt = -Infinity;
  private scanTimer: unknown = undefined;
  private pollTimer: unknown = undefined;
  private observer: MutationObserver | null = null;
  private lastHref = '';
  private lastHealthOk: boolean | undefined;
  private stopped = false;

  constructor(private readonly deps: ContentDeps) {
    this.settings = effectiveSettings(undefined, deps.flavor);
  }

  async start(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.deps.loadSettings();
    } catch {
      raw = undefined;
    }
    if (this.stopped) return;
    this.settings = effectiveSettings(raw, this.deps.flavor);
    this.deps.onSettingsChanged((r) => {
      if (!this.stopped) this.applySettings(r);
    });
    this.connect();

    this.observer = new MutationObserver((records) => {
      if (records.some((r) => !isOwnMutation(r))) this.scheduleScan();
    });
    this.observer.observe(this.deps.doc.body, { childList: true, subtree: true, characterData: true });
    this.deps.win.addEventListener('popstate', this.onPopState);
    this.lastHref = this.deps.locationHref();
    this.pollTimer = this.deps.setTimer(this.poll, URL_POLL_MS);
    this.scan();
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    this.deps.win.removeEventListener('popstate', this.onPopState);
    for (const t of [this.scanTimer, this.pollTimer, this.reconnectTimer]) {
      if (t !== undefined) this.deps.clearTimer(t);
    }
    this.scanTimer = this.pollTimer = this.reconnectTimer = undefined;
    this.unwatchAll();
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // Already gone.
    }
  }

  scan(): void {
    if (this.stopped) return;
    const ctx = this.context();
    if (!ctx) {
      this.clearAll();
      // primaryColumn itself is missing on a filtered page: selector drift (spec §7). Posts stay visible.
      if (this.filteredPage()) {
        this.reportHealth({ ok: false, cells: this.deps.doc.querySelectorAll(SEL.cell).length, articles: 0, parsed: 0 });
      }
      return;
    }
    this.reconcile(ctx);
    this.pruneWatching();

    for (const article of findArticles(ctx.root)) {
      // An orphan stop() (via post → reconnect) may run mid-scan: nothing may touch the page after it.
      if (this.stopped) return;
      const snap = snapshotArticle(article);
      if (!snap) continue;
      const reason = this.exempt(article, snap, ctx);
      if (reason) {
        article.setAttribute(EXEMPT_ATTR, reason);
        removePanel(article);
        unhidePost(article);
        continue;
      }
      article.removeAttribute(EXEMPT_ATTR);
      this.retryIfErrored(snap.postId, article);

      const h = hash53(stableStringify(snap));
      if (this.sent.get(snap.postId)?.snapHash !== h && !this.watching.has(article)) {
        let fired = false;
        const cancel = this.deps.observeNear(article, () => {
          fired = true;
          this.watching.delete(article);
          this.send(snap, h);
        });
        if (!fired) this.watching.set(article, cancel);
      }
      this.apply(article, snap.postId, ctx);
    }
    if (this.stopped) return;
    this.reportHealth(checkHealth(ctx.root));
  }

  handleResult(msg: ResultMsg): void {
    const entry = this.sent.get(msg.postId);
    if (!entry || msg.snapHash !== entry.snapHash) return;
    this.results.set(msg.postId, mergeResult(this.results.get(msg.postId), msg));
    this.resultSnaps.set(msg.postId, entry.snapshot);
    this.applyPost(msg.postId);
  }

  applySettings(raw: unknown): void {
    this.settings = effectiveSettings(raw, this.deps.flavor);
    this.scan();
  }

  // ---- Scanning ----

  /** This page when it is filtered and classification is on; null otherwise. */
  private filteredPage(): PageInfo | null {
    const page = pageInfo(this.deps.locationHref());
    // DMs are never touched beyond clearing our own marks.
    if (page.kind === 'messages') return null;
    return shouldFilter(page.kind) && isClassificationActive(this.settings) ? page : null;
  }

  /** The scan context when this page is filtered, classification is on and the scan root exists. */
  private context(): ScanContext | null {
    const { doc } = this.deps;
    const page = this.filteredPage();
    const root = page && scanRoot(doc);
    return page && root ? { page, ownHandle: ownHandleOf(doc), root } : null;
  }

  /**
   * exemptReason, plus memory for status threads: while the focal post is in the DOM, the ids of the
   * focal post and its ancestors are remembered per focal id. Once X's virtual list drops the focal
   * article, only those ids stay exempt and every other article is a reply, filtered as usual.
   * 'no-focal' (everything exempt) remains only when this page's focal post was never seen.
   */
  private exempt(article: Element, snap: PostSnapshot | null, ctx: ScanContext): ExemptReason | null {
    const reason = exemptReason(article, snap, ctx);
    const focalId = ctx.page.kind === 'status' ? ctx.page.focalId : undefined;
    const postId = snap?.postId ?? postIdOf(article);
    if (!focalId || !postId) return reason;
    let thread = this.threadExempt.get(focalId);
    if (reason === 'focal' || reason === 'ancestor') {
      if (!thread) this.threadExempt.set(focalId, (thread = new Set()));
      thread.add(postId);
      return reason;
    }
    if (reason !== 'no-focal' || !thread) return reason;
    if (!thread.has(postId)) return null;
    return postId === focalId ? 'focal' : 'ancestor';
  }

  private clearAll(): void {
    this.unwatchAll();
    unhideAll(this.deps.doc);
    removeAllPanels(this.deps.doc);
  }

  /** Unhide every hidden cell whose (possibly recycled) article is gone or no longer decided "hide". */
  private reconcile(ctx: ScanContext): void {
    for (const el of Array.from(this.deps.doc.querySelectorAll(`[${HIDDEN_ATTR}]`))) {
      const article = el.matches(SEL.article) ? el : findArticles(el)[0];
      const postId = article && ctx.root.contains(article) ? postIdOf(article) : null;
      if (!postId || !this.settings.hideEnabled || !this.decision(postId).hide) el.removeAttribute(HIDDEN_ATTR);
    }
  }

  /** Re-send a post whose last result was an error without answers, at most once per ERROR_RETRY_MS. */
  private retryIfErrored(postId: string, article: Element): void {
    const entry = this.sent.get(postId);
    const st = this.results.get(postId);
    if (!entry || !st?.error || effectiveJev(st) || this.watching.has(article)) return;
    if (this.deps.now() - entry.at >= ERROR_RETRY_MS) this.forget(postId);
  }

  /** Drop the sent record so the next scan sends the post again; a state without answers is dropped too. */
  private forget(postId: string): void {
    this.sent.delete(postId);
    if (!effectiveJev(this.results.get(postId))) {
      this.results.delete(postId);
      this.resultSnaps.delete(postId);
    }
  }

  /** A usable result for this exact snapshot, with no vision pass still in flight. */
  private isResolved(postId: string, snapHash: string): boolean {
    const st = this.results.get(postId);
    return st?.snapHash === snapHash && !!effectiveJev(st) && st.vision !== 'pending';
  }

  private pruneWatching(): void {
    for (const [el, cancel] of this.watching) {
      if (el.isConnected) continue;
      cancel();
      this.watching.delete(el);
    }
  }

  private unwatchAll(): void {
    for (const cancel of this.watching.values()) cancel();
    this.watching.clear();
  }

  private send(snapshot: PostSnapshot, snapHash: string): void {
    if (this.stopped || !this.context()) return;
    this.sent.set(snapshot.postId, { snapHash, snapshot, at: this.deps.now() });
    this.post({ type: 'post', snapshot, snapHash });
  }

  /** Report selector health to the SW when it flips. */
  private reportHealth({ ok, cells, articles, parsed }: ReturnType<typeof checkHealth>): void {
    if (ok === this.lastHealthOk) return;
    this.lastHealthOk = ok;
    this.post({ type: 'health', ok, cells, articles, parsed });
    if (__FLAVOR__ === 'dev' && this.deps.flavor === 'dev' && !ok) {
      console.warn('[Low Cortisol] selector health', { ok, cells, articles, parsed });
    }
  }

  // ---- Applying verdicts ----

  private decision(postId: string): Decision {
    return decide(effectiveJev(this.results.get(postId))?.answers, this.settings.threshold);
  }

  /** Re-apply every eligible article in the scan root that shows `postId`. */
  private applyPost(postId: string): void {
    const ctx = this.stopped ? null : this.context();
    if (!ctx) return;
    for (const article of findArticles(ctx.root)) {
      if (this.stopped) return;
      if (postIdOf(article) !== postId) continue;
      if (this.exempt(article, snapshotArticle(article), ctx)) continue;
      this.apply(article, postId, ctx);
    }
  }

  private apply(article: Element, postId: string, ctx: ScanContext): void {
    if (this.stopped) return;
    const st = this.results.get(postId);
    const d = this.decision(postId);
    if (this.settings.hideEnabled && d.hide) {
      // Hidden posts vanish completely: never a panel or stub (answer 19b).
      removePanel(article);
      const cells = () => Array.from(ctx.root.querySelectorAll(SEL.cell));
      if (hidePost(article, { win: this.deps.win, cells }) && !this.hiddenReported.has(postId)) {
        this.hiddenReported.add(postId);
        this.post({ type: 'hidden', postId });
      }
      return;
    }
    unhidePost(article);
    if (__FLAVOR__ === 'dev' && this.deps.flavor === 'dev' && this.settings.showResults) {
      renderPanel(
        article,
        { postId, state: st, decision: d, settings: this.settings, saved: this.saved.get(postId) },
        (label) => this.feedback(postId, label),
      );
    } else {
      removePanel(article);
    }
  }

  private feedback(postId: string, label: 'hide' | 'keep'): void {
    if (this.stopped) return;
    const st = this.results.get(postId);
    const jev = effectiveJev(st);
    const stage = effectiveStage(st);
    const snap = this.resultSnaps.get(postId);
    if (!st || !jev || !stage || !snap) return;
    const entry: FeedbackEntry = {
      at: new Date(this.deps.now()).toISOString(),
      flavor: this.deps.flavor,
      postId,
      url: snap.url,
      label,
      verdict: this.decision(postId).hide ? 'hide' : 'keep',
      threshold: this.settings.threshold,
      rubricVersion: RUBRIC_VERSION,
      jevModel: jev.model,
      stage,
      answers: jev.answers,
      state: buildJevState(snap, stage === 'full' ? st.transcripts : undefined),
    };
    this.post({ type: 'feedback', entry });
    this.saved.set(postId, label);
    this.applyPost(postId);
  }

  // ---- Port ----

  private post(m: ContentToSw): void {
    if (this.port) {
      try {
        this.port.postMessage(m);
        return;
      } catch {
        // Disconnected but onDisconnect not delivered yet: fall through and queue.
      }
    }
    // Posts are re-sent from `sent` on reconnect and health is re-reported; hidden/feedback wait here.
    if ((m.type === 'hidden' || m.type === 'feedback') && this.outbox.length < OUTBOX_MAX) this.outbox.push(m);
    this.reconnectNow();
  }

  private connect(): void {
    if (this.stopped) return;
    this.lastConnectAt = this.deps.now();
    let port: ContentPort;
    try {
      port = this.deps.connect();
    } catch {
      // The extension was reloaded or removed: this script is orphaned, so stop and leave X as it is.
      if (this.deps.contextValid && !this.deps.contextValid()) {
        this.stop();
        this.clearAll();
        return;
      }
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    const connectedAt = this.deps.now();
    port.onMessage.addListener((m) => {
      if (this.port !== port || this.stopped) return;
      this.reconnectAttempt = 0;
      if (m && m.type === 'result') this.handleResult(m);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      // A port that lived this long ended in a normal SW idle restart, not a failing connect.
      if (this.deps.now() - connectedAt >= RECONNECT_MAX_MS) this.reconnectAttempt = 0;
      this.scheduleReconnect();
    });
  }

  /** Something must be sent and the port is down: reconnect now instead of waiting out the backoff. */
  private reconnectNow(): void {
    if (this.stopped || this.port || this.deps.now() - this.lastConnectAt < CONNECT_MIN_INTERVAL_MS) return;
    if (this.reconnectTimer !== undefined) {
      this.deps.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = undefined;
      this.reconnect();
    }, ms);
  }

  /** Reconnect, flush queued messages, re-send every unresolved post and re-report selector health. */
  private reconnect(): void {
    this.connect();
    if (!this.port) return;
    const queued = this.outbox;
    this.outbox = [];
    queued.forEach((m) => this.post(m));
    // The SW may have restarted and lost in-flight work, whether or not the article is still in the DOM.
    if (isClassificationActive(this.settings)) {
      for (const [postId, entry] of this.sent) {
        if (this.isResolved(postId, entry.snapHash)) continue;
        entry.at = this.deps.now();
        this.post({ type: 'post', snapshot: entry.snapshot, snapHash: entry.snapHash });
      }
    }
    // The SW keeps selector health in memory only: report it again on the next scan.
    this.lastHealthOk = undefined;
    this.scheduleScan();
  }

  // ---- Triggers ----

  private scheduleScan(): void {
    if (this.stopped || this.scanTimer !== undefined) return;
    this.scanTimer = this.deps.setTimer(() => {
      this.scanTimer = undefined;
      this.scan();
    }, SCAN_DEBOUNCE_MS);
  }

  private readonly poll = (): void => {
    if (this.stopped) return;
    this.checkUrl();
    this.pollTimer = this.deps.setTimer(this.poll, URL_POLL_MS);
  };

  private readonly onPopState = (): void => {
    if (!this.stopped) this.checkUrl();
  };

  private checkUrl(): void {
    const href = this.deps.locationHref();
    if (href === this.lastHref) return;
    this.lastHref = href;
    this.scan();
  }
}

/** Mutations that only add/remove our own panel hosts must not trigger another scan. */
function isOwnMutation(r: MutationRecord): boolean {
  if (r.type !== 'childList') return false;
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.hasAttribute(PANEL_ATTR));
}

function realDeps(): ContentDeps {
  return {
    doc: document,
    win: window,
    flavor: __FLAVOR__,
    connect: () => {
      const port = chrome.runtime.connect({ name: PORT_NAME });
      // Reading lastError marks it handled (otherwise Chrome logs "Unchecked runtime.lastError").
      port.onDisconnect.addListener(() => void chrome.runtime.lastError);
      return port;
    },
    loadSettings: async () => (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings],
    onSettingsChanged: (cb) =>
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && STORAGE_KEYS.settings in changes) cb(changes[STORAGE_KEYS.settings].newValue);
      }),
    observeNear: (el, cb) => {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          cb();
        },
        { rootMargin: '2000px 0px' },
      );
      io.observe(el);
      return () => io.disconnect();
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    locationHref: () => location.href,
    contextValid: () => !!chrome.runtime?.id,
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) void new ContentController(realDeps()).start();
