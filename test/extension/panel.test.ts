// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PANEL_ATTR, panelLines, panelVerdict, removeAllPanels, removePanel, renderPanel, scoreChip, type PanelModel } from '../../extension/src/content/panel';
import { decide } from '../../shared/decide';
import { mergeResult } from '../../shared/results';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { ResultMsg } from '../../shared/protocol';
import { answers } from '../shared/helpers';

const jev = (p: number, cached = false) => ({ model: 'jev-1.13.0', answers: answers({ ragebait: p, intensity: 3.6, category: { engagement_bait: 0.9, benign_other: 0.1 }, emotion: { anger_outrage: 1 }, topic: { politics: 0.8, other: 0.2 } }), latencyMs: 312, cached });
const msg = (o: Partial<ResultMsg>): ResultMsg => ({ type: 'result', postId: '1', snapHash: 'h', stage: 'text', vision: 'none', timings: {}, ...o });
function model(o: Partial<PanelModel> = {}, st = mergeResult(undefined, msg({ jev: jev(0.97, true), timings: { textMs: 312 } }))): PanelModel {
  const settings = { ...DEFAULT_SETTINGS.dev };
  return { postId: '1', state: st, decision: decide(st?.text?.jev?.answers, settings.threshold), settings, ...o };
}

describe('panel', () => {
  it('verdicts', () => {
    expect(panelVerdict(model())).toBe('HIDE');
    expect(panelVerdict(model({ state: undefined, decision: decide(undefined, 0.7) }))).toBe('PENDING');
    const err = mergeResult(undefined, msg({ error: { code: 'NO_API_KEY', message: 'x' } }));
    expect(panelVerdict(model({ state: err, decision: decide(undefined, 0.7) }))).toBe('ERROR');
  });

  it('lines follow the spec format', () => {
    const lines = panelLines(model());
    expect(lines[0]).toBe('LOW CORTISOL · dev   HIDE (would hide)');
    expect(lines[1]).toBe('reason: ragebait 0.97 ≥ 0.70; hide-kinds 0.90 ≥ 0.80 & intensity 3.6 ≥ 2.5 (top: engagement_bait)');
    expect(lines[2]).toBe('ragebait 0.97 · category engagement_bait 0.90 (hide-kinds 0.90) · emotion anger_outrage 1.00');
    expect(lines[3]).toBe('intensity 3.6 Inflammatory · topic politics 0.80 · jev-1.13.0 · r1');
    expect(lines).toContain('vision: none');
    expect(lines).toContain('timing: text 312 ms (cache)');
  });

  it('shows transcripts only when enabled and vision states', () => {
    let st = mergeResult(undefined, msg({ jev: jev(0.1), vision: 'pending' }));
    st = mergeResult(st, msg({ stage: 'full', jev: jev(0.1), vision: 'done', transcripts: [{ key: 'k', kind: 'image', inQuote: true, visibleText: 'THEY ARE LYING', description: 'Red text.', cues: ['meme'], model: 'claude-opus-5-5' }], timings: { visionMs: 4300, fullMs: 280 } }));
    const on = panelLines(model({}, st));
    expect(on).toContain('vision: done 1 item(s) (claude-opus-5-5)');
    expect(on).toContain('transcript #1 image (quote): "THEY ARE LYING" — Red text. [meme]');
    const off = panelLines(model({ settings: { ...DEFAULT_SETTINGS.dev, showTranscript: false } }, st));
    expect(off.some((l) => l.startsWith('transcript'))).toBe(false);
  });

  it('renders once per article in a shadow root, stops propagation, sends feedback', () => {
    document.body.innerHTML = '<article data-testid="tweet" id="a"><div>post</div></article>';
    const a = document.getElementById('a')!;
    const outer = vi.fn();
    a.addEventListener('click', outer);
    const fb = vi.fn();
    renderPanel(a, model(), fb);
    const host = renderPanel(a, model({ saved: 'keep' }), fb);
    expect(a.querySelectorAll(`[${PANEL_ATTR}]`)).toHaveLength(1);
    const root = host.shadowRoot!;
    expect(root.textContent).toContain('LOW CORTISOL · dev');
    expect(root.textContent).toContain('saved ✓ (keep)');
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Should keep')!;
    btn.click();
    expect(fb).toHaveBeenCalledWith('keep');
    expect(outer).not.toHaveBeenCalled();
    expect(removeAllPanels(document)).toBe(1);
  });
});

describe('panel (extra)', () => {
  it('error and pending lines; buttons disabled without a verdict', () => {
    const err = mergeResult(undefined, msg({ error: { code: 'NO_API_KEY', message: 'x' } }));
    expect(panelLines(model({ state: err, decision: decide(undefined, 0.7) }))).toEqual(['LOW CORTISOL · dev   ERROR NO_API_KEY', 'vision: none']);
    document.body.innerHTML = '<article id="a"></article>';
    const host = renderPanel(document.getElementById('a')!, model({ state: undefined, decision: decide(undefined, 0.7) }), vi.fn());
    const buttons = [...host.shadowRoot!.querySelectorAll('.details button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Should hide', 'Should keep']);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(host.shadowRoot!.textContent).toContain('PENDING');
  });

  it('KEEP verdict, vision failed/skipped lines, no "(would hide)" when hiding is on', () => {
    const calm = { ...jev(0.1), answers: answers({ ragebait: 0.1 }) };
    let st = mergeResult(undefined, msg({ jev: calm, vision: 'skipped_flagged' }));
    expect(panelLines(model({}, st))).toContain('vision: skipped (flagged by text)');
    expect(panelLines(model({}, st))[0]).toBe('LOW CORTISOL · dev   KEEP');
    st = mergeResult(st, msg({ stage: 'full', vision: 'failed', error: { code: 'CLAUDE_TIMEOUT', message: 'x' } }));
    expect(panelLines(model({}, st))).toContain('vision: failed: CLAUDE_TIMEOUT');
    expect(panelVerdict(model({}, st))).toBe('KEEP');
    const on = { ...DEFAULT_SETTINGS.dev, hideEnabled: true };
    expect(panelLines(model({ settings: on }))[0]).toBe('LOW CORTISOL · dev   HIDE');
    expect(panelLines(model({ settings: { ...on, showStatus: false } })).some((l) => l.startsWith('timing'))).toBe(false);
  });

  it('renders untrusted transcript text as text, not markup', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const st = mergeResult(undefined, msg({ jev: jev(0.1), vision: 'done', transcripts: [{ key: 'k', kind: 'image', inQuote: false, visibleText: evil, description: evil, cues: [], model: 'claude-opus-5-5' }] }));
    document.body.innerHTML = '<article id="a"></article>';
    const host = renderPanel(document.getElementById('a')!, model({}, st), vi.fn());
    expect(host.shadowRoot!.querySelector('img')).toBeNull();
    expect(host.shadowRoot!.textContent).toContain(evil);
  });

  it('stops key and pointer events from reaching the article; removePanel removes it', () => {
    document.body.innerHTML = '<article id="a"><div>post</div></article>';
    const a = document.getElementById('a')!;
    const outer = vi.fn();
    for (const t of ['keydown', 'mousedown', 'pointerdown', 'auxclick']) a.addEventListener(t, outer);
    const host = renderPanel(a, model(), vi.fn());
    const btn = host.shadowRoot!.querySelector('.details button')!;
    btn.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'l' }));
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    btn.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, composed: true }));
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(outer).not.toHaveBeenCalled();
    expect(a.lastElementChild).toBe(host);
    removePanel(a);
    expect(a.querySelector(`[${PANEL_ATTR}]`)).toBeNull();
  });
});

describe('panel (inline chip)', () => {
  const POST = '<article data-testid="tweet" id="a"><div><div data-testid="tweetText">post</div>' +
    '<div role="link"><div data-testid="User-Name">q</div><div role="group" id="qg"></div></div>' +
    '<div class="bar"><div role="group" id="g">like</div></div></div></article>';

  it('chip shows the ragebait score, red at/above the threshold, green below, gray without a score', () => {
    expect(scoreChip(model())).toEqual({ text: '{0.97}', tone: 'over' });
    const at = mergeResult(undefined, msg({ jev: { ...jev(0.7), answers: answers({ ragebait: 0.7 }) } }));
    expect(scoreChip(model({ decision: decide(at.text!.jev!.answers, 0.7) }, at))).toEqual({ text: '{0.70}', tone: 'over' });
    const calm = mergeResult(undefined, msg({ jev: { ...jev(0.26), answers: answers({ ragebait: 0.26 }) } }));
    expect(scoreChip(model({ decision: decide(calm.text!.jev!.answers, 0.7) }, calm))).toEqual({ text: '{0.26}', tone: 'under' });
    expect(scoreChip(model({ state: undefined, decision: decide(undefined, 0.7) })).tone).toBe('none');
    const err = mergeResult(undefined, msg({ error: { code: 'NO_API_KEY', message: 'x' } }));
    expect(scoreChip(model({ state: err, decision: decide(undefined, 0.7) }))).toEqual({ text: '{err}', tone: 'none' });
  });

  it('sits just above the own engagement row (not the quoted post row), never as a side column', () => {
    document.body.innerHTML = POST;
    const a = document.getElementById('a')!;
    const host = renderPanel(a, model(), vi.fn());
    expect(host.nextElementSibling).toBe(document.getElementById('g'));
    expect(a.lastElementChild).not.toBe(host);
    const chip = host.shadowRoot!.querySelector('.chip')!;
    expect(chip.textContent).toBe('{0.97}');
    expect(chip.classList.contains('over')).toBe(true);
    // X re-rendering the row away and back: the host follows it on the next update.
    document.getElementById('g')!.before(document.createElement('div'));
    renderPanel(a, model(), vi.fn());
    expect(host.nextElementSibling).toBe(document.getElementById('g'));
    expect(a.querySelectorAll(`[${PANEL_ATTR}]`)).toHaveLength(1);
  });

  it('falls back to right after the post text when there is no engagement row', () => {
    document.body.innerHTML = '<article data-testid="tweet" id="a"><div><div data-testid="tweetText" id="t">post</div><div>media</div></div></article>';
    const host = renderPanel(document.getElementById('a')!, model(), vi.fn());
    expect(host.previousElementSibling).toBe(document.getElementById('t'));
  });

  it('details are collapsed by default; the toggle expands them, survives updates, and never reaches X', () => {
    document.body.innerHTML = POST;
    const a = document.getElementById('a')!;
    const outer = vi.fn();
    a.addEventListener('click', outer);
    const host = renderPanel(a, model(), vi.fn());
    const root = host.shadowRoot!;
    const details = root.querySelector('.details') as HTMLElement;
    const toggle = root.querySelector('.tog') as HTMLButtonElement;
    expect(details.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('>');
    toggle.click();
    expect(details.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(outer).not.toHaveBeenCalled();
    renderPanel(a, model({ saved: 'hide' }), vi.fn());
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('saved ✓ (hide)');
    toggle.click();
    expect(details.hidden).toBe(true);
  });

  it('replaces a markup-cloned host (no shadow root) with a live one', () => {
    document.body.innerHTML = POST;
    const a = document.getElementById('a')!;
    const dead = document.createElement('div');
    dead.setAttribute(PANEL_ATTR, '');
    a.querySelector('[data-testid="tweetText"]')!.after(dead);
    const host = renderPanel(a, model(), vi.fn());
    expect(host).not.toBe(dead);
    expect(a.querySelectorAll(`[${PANEL_ATTR}]`)).toHaveLength(1);
    expect(host.shadowRoot).not.toBeNull();
  });
});
