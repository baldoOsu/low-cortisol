import { describe, expect, it } from 'vitest';
import { parsePanelText, sampleFromCell, summarize } from '../../scripts/lib/live-report.mjs';

describe('live-report', () => {
  it('parses dev panel text', () => {
    expect(parsePanelText('LOW CORTISOL · dev   HIDE (would hide)reason: ragebait 0.97 ≥ 0.70vision: none')).toMatchObject({ verdict: 'HIDE', vision: 'none' });
    expect(parsePanelText('LOW CORTISOL · dev   ERROR NO_API_KEYvision: none')).toMatchObject({ verdict: 'ERROR', errorCode: 'NO_API_KEY' });
    expect(parsePanelText('LOW CORTISOL · dev   KEEPvision: failed: CLAUDE_FAILED')).toMatchObject({ verdict: 'KEEP', vision: 'failed' });
    expect(parsePanelText('')).toEqual({ verdict: null });
  });
  it('summarizes samples', () => {
    const s = summarize([
      { postId: '1', verdict: 'HIDE', hidden: true, vision: 'none' },
      { postId: '2', verdict: 'KEEP', hidden: false, vision: 'done' },
      { postId: '3', verdict: 'ERROR', hidden: false, vision: null, errorCode: 'COMPANION_OFFLINE' },
      { postId: '4', verdict: null, hidden: false, vision: null },
    ]);
    expect(s).toEqual({ posts: 4, withVerdict: 3, hide: 1, keep: 1, pending: 0, error: 1, hiddenCells: 1, visionDone: 1, visionFailed: 0, errorCodes: { COMPANION_OFFLINE: 1 } });
  });

  it('parses the remaining panel variants exactly', () => {
    expect(parsePanelText('LOW CORTISOL · dev   PENDINGvision: pending')).toEqual({ verdict: 'PENDING', vision: 'pending' });
    expect(parsePanelText('LOW CORTISOL · dev   KEEPreason: ragebait 0.10 < 0.70vision: done 2 items (claude-opus-5-5)timing: text 312 ms')).toEqual({ verdict: 'KEEP', vision: 'done' });
    expect(parsePanelText('LOW CORTISOL · dev   HIDEvision: skipped (flagged by text)')).toEqual({ verdict: 'HIDE', vision: 'skipped' });
    expect(parsePanelText('LOW CORTISOL · dev   ERROR COMPANION_OFFLINE')).toEqual({ verdict: 'ERROR', errorCode: 'COMPANION_OFFLINE' });
    expect(parsePanelText(null)).toEqual({ verdict: null });
    expect(parsePanelText('something unrelated')).toEqual({ verdict: null });
  });

  it('builds a sample from a collected cell; a hidden cell counts as HIDE', () => {
    expect(sampleFromCell({ postId: '9', hidden: false, panelText: 'LOW CORTISOL · dev   ERROR NO_API_KEYvision: none' })).toEqual({ postId: '9', verdict: 'ERROR', hidden: false, vision: 'none', errorCode: 'NO_API_KEY' });
    // Prod has no panel, and dev drops the panel on hide: the hidden cell itself is the verdict.
    expect(sampleFromCell({ postId: '8', hidden: true, panelText: null })).toEqual({ postId: '8', verdict: 'HIDE', hidden: true, vision: null });
    expect(sampleFromCell({ postId: '7', hidden: false, panelText: null })).toEqual({ postId: '7', verdict: null, hidden: false, vision: null });
  });

  it('counts failed vision, pending and repeated error codes', () => {
    const s = summarize([
      { postId: '1', verdict: 'PENDING', hidden: false, vision: 'pending' },
      { postId: '2', verdict: 'KEEP', hidden: false, vision: 'failed' },
      { postId: '3', verdict: 'ERROR', hidden: false, vision: null, errorCode: 'JEV_TIMEOUT' },
      { postId: '4', verdict: 'ERROR', hidden: false, vision: null, errorCode: 'JEV_TIMEOUT' },
    ]);
    expect(s).toMatchObject({ posts: 4, withVerdict: 4, pending: 1, keep: 1, error: 2, visionFailed: 1, errorCodes: { JEV_TIMEOUT: 2 } });
    expect(summarize([])).toEqual({ posts: 0, withVerdict: 0, hide: 0, keep: 0, pending: 0, error: 0, hiddenCells: 0, visionDone: 0, visionFailed: 0, errorCodes: {} });
  });
});
