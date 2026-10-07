// Dev-only results panel rendered inside each post (the caller guards with __FLAVOR__): a compact
// `{score}` chip plus a toggle, placed under the post text just above the engagement row, whose
// collapsed-by-default details stack below it (never beside the post, so the feed keeps its width).
// Post-derived text is untrusted: everything is rendered as text nodes, never innerHTML.

import { intensityLabel, type Decision, type Ranked } from '../../../shared/decide';
import { effectiveJev, type PostResultState } from '../../../shared/results';
import { RUBRIC_VERSION } from '../../../shared/rubric';
import type { Settings } from '../../../shared/types';
import { SEL, quoteOf } from './selectors';

export const PANEL_ATTR = 'data-lc-panel';

export type PanelVerdict = 'HIDE' | 'KEEP' | 'PENDING' | 'ERROR';
/** Chip color: red at or above the hide threshold, green below it, gray without a score. */
export type ScoreTone = 'over' | 'under' | 'none';

export interface PanelModel {
  postId: string;
  state: PostResultState | undefined;
  decision: Decision;
  settings: Settings;
  saved?: 'hide' | 'keep';
}

// Stopped on the host so X never sees clicks/keys inside the panel (it would open the post).
// Bubble phase only: a capture-phase stop on the host would also block the panel's own buttons
// (the host is at-target for events from its shadow tree), and cannot affect ancestors anyway.
const STOPPED_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'keydown', 'touchstart'];

const PANEL_CSS = `
:host { display: block; }
.lc { font: 12px/1.4 ui-monospace, Consolas, monospace; color: inherit; margin: 6px 0 2px; }
.row { display: flex; align-items: center; gap: 6px; }
.chip {
  font: inherit; font-weight: 600; padding: 1px 6px; border-radius: 4px;
  color: #71767b; background: rgba(113,118,123,.14); border: 1px solid rgba(113,118,123,.35);
}
.chip.under { color: #00ba7c; background: rgba(0,186,124,.12); border-color: rgba(0,186,124,.45); }
.chip.over { color: #f4212e; background: rgba(244,33,46,.12); border-color: rgba(244,33,46,.45); }
.tog {
  width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: #8b98a5; color: #fff; font: 800 12px/1 system-ui, sans-serif;
}
.tog span { display: inline-block; transform: rotate(90deg); transition: transform .15s; }
.tog[aria-expanded="true"] span { transform: rotate(-90deg); }
.details {
  white-space: pre-wrap; margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  border-left: 4px solid #9aa0a6; background: rgba(127,127,127,.08);
}
.details[hidden] { display: none; }
.details.hide { border-left-color: #d93025; }
.details.keep { border-left-color: #188038; }
.details button { font: inherit; margin: 4px 6px 0 0; }
`;

const f2 = (n: number) => n.toFixed(2);
const f1 = (n: number) => n.toFixed(1);
const ranked = (r: Ranked | undefined) => (r ? `${r.key} ${f2(r.p)}` : '-');
const num = (n: number | undefined, f: (n: number) => string) => (n === undefined ? '-' : f(n));

/** The chip's text and tone: the Jev ragebait score against the configured hide threshold. */
export function scoreChip(m: PanelModel): { text: string; tone: ScoreTone } {
  const p = effectiveJev(m.state) ? m.decision.ragebait : undefined;
  if (p === undefined) return { text: m.state?.error ? '{err}' : '{…}', tone: 'none' };
  return { text: `{${f2(p)}}`, tone: p >= m.settings.threshold ? 'over' : 'under' };
}

export function panelVerdict(m: PanelModel): PanelVerdict {
  if (!effectiveJev(m.state)) return m.state?.error ? 'ERROR' : 'PENDING';
  return m.decision.hide ? 'HIDE' : 'KEEP';
}

function visionLine(state: PostResultState | undefined): string {
  switch (state?.vision) {
    case undefined:
    case 'pending':
      return 'vision: pending';
    case 'none':
      return 'vision: none';
    case 'disabled':
      return 'vision: disabled';
    case 'skipped_flagged':
      return 'vision: skipped (flagged by text)';
    case 'failed':
      return `vision: failed: ${state.full?.error?.code ?? state.error?.code ?? 'unknown'}`;
    case 'done': {
      const ts = state.transcripts ?? [];
      return `vision: done ${ts.length} item(s)` + (ts[0] ? ` (${ts[0].model})` : '');
    }
  }
}

function timingLine(state: PostResultState | undefined): string | undefined {
  const t = { ...state?.text?.timings, ...state?.full?.timings };
  const parts: string[] = [];
  if (t.textMs !== undefined) parts.push(`text ${t.textMs} ms${state?.text?.jev?.cached ? ' (cache)' : ''}`);
  if (t.visionMs !== undefined) parts.push(`vision ${(t.visionMs / 1000).toFixed(1)} s`);
  if (t.fullMs !== undefined) parts.push(`full ${t.fullMs} ms`);
  return parts.length ? `timing: ${parts.join(' · ')}` : undefined;
}

export function panelLines(m: PanelModel): string[] {
  const { state, decision: d, settings } = m;
  const verdict = panelVerdict(m);
  const jev = effectiveJev(state);
  const lines = [
    `LOW CORTISOL · dev   ${verdict}` +
      (verdict === 'HIDE' && !settings.hideEnabled ? ' (would hide)' : '') +
      (verdict === 'ERROR' ? ` ${state?.error?.code}` : ''),
  ];
  if (jev) {
    lines.push(`reason: ${d.reasons.join('; ')}`);
    lines.push(
      `ragebait ${num(d.ragebait, f2)} · category ${ranked(d.topCategory)} (hide-kinds ${num(d.hideCategoryMass, f2)})` +
        ` · emotion ${ranked(d.topEmotion)}`,
    );
    const i = d.intensity;
    lines.push(
      `intensity ${i === undefined ? '-' : `${f1(i)} ${intensityLabel(i)}`} · topic ${ranked(d.topTopic)}` +
        ` · ${jev.model} · ${RUBRIC_VERSION}`,
    );
  }
  lines.push(visionLine(state));
  if (settings.showTranscript) {
    (state?.transcripts ?? []).forEach((t, k) => {
      lines.push(
        `transcript #${k + 1} ${t.kind}${t.inQuote ? ' (quote)' : ''}: "${t.visibleText.slice(0, 160)}"` +
          ` — ${t.description.slice(0, 200)}${t.cues.length ? ' [' + t.cues.join(', ') + ']' : ''}`,
      );
    });
  }
  if (settings.showStatus) {
    const timing = timingLine(state);
    if (timing) lines.push(timing);
  }
  return lines;
}

/** False when `el` sits inside a post nested in `article`. */
function ownedBy(article: Element, el: Element): boolean {
  const inner = el.parentElement?.closest(SEL.article);
  return !inner || inner === article || !article.contains(inner);
}

/** This article's own hosts (never one inside a nested article). */
function hostsOf(article: Element): HTMLElement[] {
  return Array.from(article.querySelectorAll<HTMLElement>(`[${PANEL_ATTR}]`)).filter((h) => ownedBy(article, h));
}

/** The last element matching `sel` that belongs to the post itself (not a quoted or nested post). */
function ownLast(article: Element, sel: string): Element | undefined {
  const quote = quoteOf(article);
  const own = Array.from(article.querySelectorAll(sel)).filter(
    (el) => ownedBy(article, el) && !quote?.contains(el),
  );
  return own[own.length - 1];
}

/** Under the post text, just above the engagement row; fallbacks: right after the text, then last child. */
function place(article: Element, host: HTMLElement): void {
  const bar = ownLast(article, SEL.actionBar);
  if (bar) {
    if (bar.previousElementSibling !== host) bar.before(host);
    return;
  }
  const text = ownLast(article, SEL.tweetText);
  if (text) {
    if (text.nextElementSibling !== host) text.after(host);
    return;
  }
  if (article.lastElementChild !== host) article.appendChild(host);
}

function createHost(article: Element): HTMLElement {
  const doc = article.ownerDocument;
  const host = doc.createElement('div');
  host.setAttribute(PANEL_ATTR, '');
  for (const type of STOPPED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = PANEL_CSS;

  const chip = doc.createElement('code');
  chip.className = 'chip';
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tog';
  toggle.title = 'Low Cortisol details';
  toggle.setAttribute('aria-expanded', 'false');
  const arrow = doc.createElement('span');
  arrow.textContent = '>';
  toggle.append(arrow);
  const row = doc.createElement('div');
  row.className = 'row';
  row.append(chip, toggle);

  const details = doc.createElement('div');
  details.className = 'details';
  details.hidden = true;
  toggle.addEventListener('click', () => {
    details.hidden = !details.hidden;
    toggle.setAttribute('aria-expanded', String(!details.hidden));
  });

  const box = doc.createElement('div');
  box.className = 'lc';
  box.append(row, details);
  root.append(style, box);
  return host;
}

/** Create or update the article's single panel; its collapsed/expanded state survives updates. */
export function renderPanel(
  article: Element,
  m: PanelModel,
  onFeedback: (label: 'hide' | 'keep') => void,
): HTMLElement {
  const doc = article.ownerDocument;
  // A host copied by markup (a recycled/cloned cell) has no shadow root; keep one live host only.
  const [first, ...extra] = hostsOf(article);
  extra.forEach((h) => h.remove());
  if (first && !first.shadowRoot) first.remove();
  const host = first?.shadowRoot ? first : createHost(article);
  place(article, host);
  const root = host.shadowRoot!;

  const chip = scoreChip(m);
  const chipEl = root.querySelector('.chip') as HTMLElement;
  chipEl.className = `chip ${chip.tone}`;
  chipEl.textContent = chip.text;

  const box = root.querySelector('.details') as HTMLElement;
  const verdict = panelVerdict(m);
  box.className = `details ${verdict === 'HIDE' ? 'hide' : verdict === 'KEEP' ? 'keep' : 'pending'}`;
  box.replaceChildren(doc.createTextNode(panelLines(m).join('\n') + '\n'));

  const enabled = !!effectiveJev(m.state);
  for (const [text, label] of [['Should hide', 'hide'], ['Should keep', 'keep']] as const) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.disabled = !enabled;
    btn.addEventListener('click', () => onFeedback(label));
    box.append(btn);
  }
  if (m.saved) box.append(doc.createTextNode(`saved ✓ (${m.saved})`));
  return host;
}

export function removePanel(article: Element): void {
  hostsOf(article).forEach((h) => h.remove());
}

export function removeAllPanels(doc: Document): number {
  const panels = doc.querySelectorAll(`[${PANEL_ATTR}]`);
  panels.forEach((p) => p.remove());
  return panels.length;
}
