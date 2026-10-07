import { describe, expect, it } from 'vitest';
import { buildPopupModel, feedbackFilename, feedbackToJsonl, statusLines, thresholdText } from '../../extension/src/popup/view';
import { DEFAULT_SETTINGS } from '../../shared/settings';

describe('popup view', () => {
  it('prod: switch + hidden today only', () => {
    const m = buildPopupModel({ flavor: 'prod', settings: DEFAULT_SETTINGS.prod, hiddenToday: 3, feedbackCount: 0, status: { companion: 'online', pending: { text: 0, vision: 0 }, avgMs: {} } });
    expect(m).toEqual({ flavor: 'prod', title: 'Low Cortisol', hideEnabled: true, hiddenTodayText: '3 hidden today' });
  });
  it('prod offline warning only when active', () => {
    const offline = { companion: 'offline' as const, pending: { text: 0, vision: 0 }, avgMs: {} };
    expect(buildPopupModel({ flavor: 'prod', settings: DEFAULT_SETTINGS.prod, hiddenToday: 1, feedbackCount: 0, status: offline }).offlineWarning).toBe('Companion offline: nothing is being filtered.');
    expect(buildPopupModel({ flavor: 'prod', settings: { ...DEFAULT_SETTINGS.prod, hideEnabled: false }, hiddenToday: 1, feedbackCount: 0, status: offline }).offlineWarning).toBeUndefined();
    expect(buildPopupModel({ flavor: 'prod', settings: DEFAULT_SETTINGS.prod, hiddenToday: 1, feedbackCount: 0 }).hiddenTodayText).toBe('1 hidden today');
  });
  it('dev: toggles, presets, models, status lines', () => {
    const m = buildPopupModel({ flavor: 'dev', settings: DEFAULT_SETTINGS.dev, hiddenToday: 0, feedbackCount: 12, status: { companion: 'online', companionVersion: '0.1.0', jevConfigured: true, claudeFound: false, pending: { text: 1, vision: 2 }, avgMs: { text: 350, vision: 4300 }, rateLimit: { fiveHourUtilization: 0.021 } } });
    expect(m.title).toBe('Low Cortisol (Dev)');
    expect(m.dev!.presets.map((p) => p.value)).toEqual([0.55, 0.7, 0.85]);
    expect(m.dev!.models.map((x) => x.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(m.dev!.statusLines).toEqual(['Companion: online v0.1.0', 'Jev key: configured', 'Claude CLI: not found', 'Pending: text 1 · vision 2', 'Avg: text 350 ms · vision 4.3 s · full – ms', 'Claude 5h usage: 2%']);
    expect(m.dev!.feedbackCount).toBe(12);
  });
  it('threshold labels and feedback export', () => {
    expect(thresholdText(0.7)).toBe('0.70 (Balanced)');
    expect(thresholdText(0.6)).toBe('0.60');
    expect(statusLines(undefined)).toEqual(['Status: unavailable']);
    expect(statusLines({ companion: 'online', pending: { text: 0, vision: 0 }, avgMs: {}, selectorHealth: { ok: false, cells: 5, articles: 5, parsed: 0 }, lastError: 'x' }).slice(-2)).toEqual(['Selectors: BROKEN (cells 5, posts 5, parsed 0)', 'Last error: x']);
    expect(feedbackToJsonl([{ postId: '1' } as any, { postId: '2' } as any])).toBe('{"postId":"1"}\n{"postId":"2"}\n');
    expect(feedbackToJsonl([])).toBe('');
    expect(feedbackFilename(new Date(2026, 8, 30))).toBe('low-cortisol-feedback-20260930.jsonl');
  });

  // Additional tests beyond the brief.
  it('dev model mirrors settings and labels the threshold', () => {
    const m = buildPopupModel({ flavor: 'dev', settings: { ...DEFAULT_SETTINGS.dev, threshold: 0.85, transcriptModel: 'claude-sonnet-5-5' }, hiddenToday: 2, feedbackCount: 0 });
    expect(m).toMatchObject({ flavor: 'dev', hideEnabled: false, hiddenTodayText: '2 hidden today' });
    expect(m.offlineWarning).toBeUndefined();
    expect(m.dev).toMatchObject({ showResults: true, threshold: 0.85, thresholdText: '0.85 (Conservative)', visionEnabled: true, transcriptModel: 'claude-sonnet-5-5', showTranscript: true, showStatus: true, statusLines: ['Status: unavailable'] });
    expect(m.dev!.presets.map((p) => p.name)).toEqual(['Aggressive', 'Balanced', 'Conservative']);
  });
  it('dev offline warning when only showResults is on', () => {
    const offline = { companion: 'offline' as const, pending: { text: 0, vision: 0 }, avgMs: {} };
    const m = buildPopupModel({ flavor: 'dev', settings: DEFAULT_SETTINGS.dev, hiddenToday: 0, feedbackCount: 0, status: offline });
    expect(m.offlineWarning).toBe('Companion offline: nothing is being filtered.');
    const off = buildPopupModel({ flavor: 'dev', settings: { ...DEFAULT_SETTINGS.dev, showResults: false }, hiddenToday: 0, feedbackCount: 0, status: offline });
    expect(off.offlineWarning).toBeUndefined();
  });
  it('threshold presets and float noise', () => {
    expect(thresholdText(0.55)).toBe('0.55 (Aggressive)');
    expect(thresholdText(0.85)).toBe('0.85 (Conservative)');
    expect(thresholdText(0.1 + 0.6)).toBe('0.70 (Balanced)');
  });
  it('status lines: minimal snapshot and healthy selectors', () => {
    expect(statusLines({ companion: 'connecting', pending: { text: 0, vision: 0 }, avgMs: {} })).toEqual(['Companion: connecting', 'Pending: text 0 · vision 0', 'Avg: text – ms · vision – · full – ms']);
    expect(statusLines({ companion: 'online', pending: { text: 0, vision: 0 }, avgMs: { full: 5000 }, selectorHealth: { ok: true, cells: 3, articles: 3, parsed: 3 } }).slice(-2)).toEqual(['Avg: text – ms · vision – · full 5000 ms', 'Selectors: OK']);
  });
  it('feedback filename pads month and day', () => {
    expect(feedbackFilename(new Date(2027, 0, 5, 23, 59))).toBe('low-cortisol-feedback-20270105.jsonl');
  });
});
