import { describe, expect, it } from 'vitest';
import { clampThreshold, DEFAULT_SETTINGS, effectiveSettings, isClassificationActive } from '../../shared/settings';

describe('effectiveSettings', () => {
  it('prod honours only hideEnabled', () => {
    const s = effectiveSettings(
      { hideEnabled: false, showResults: true, threshold: 0.55, transcriptModel: 'claude-sonnet-5-5', visionEnabled: false },
      'prod',
    );
    expect(s).toEqual({ ...DEFAULT_SETTINGS.prod, hideEnabled: false });
    expect(s.showResults).toBe(false);
  });

  it('prod defaults: hide on, opus 5.5, balanced', () => {
    expect(effectiveSettings(undefined, 'prod')).toMatchObject({
      hideEnabled: true,
      threshold: 0.7,
      transcriptModel: 'claude-opus-5-5',
    });
  });

  it('dev defaults to labeling mode', () => {
    expect(effectiveSettings(null, 'dev')).toMatchObject({ hideEnabled: false, showResults: true });
  });

  it('dev merges valid values and ignores wrong types / unknown models', () => {
    const s = effectiveSettings(
      { hideEnabled: true, showResults: 'yes', threshold: 2, transcriptModel: 'claude-sonnet-5' },
      'dev',
    );
    expect(s.hideEnabled).toBe(true);
    expect(s.showResults).toBe(true);
    expect(s.threshold).toBe(0.95);
    expect(s.transcriptModel).toBe('claude-opus-5-5');
    expect(effectiveSettings({ transcriptModel: 'claude-sonnet-5-5' }, 'dev').transcriptModel).toBe('claude-sonnet-5-5');
  });

  it('clampThreshold rounds to 2 decimals and falls back', () => {
    expect(clampThreshold(0.123)).toBe(0.5);
    expect(clampThreshold(0.7500001)).toBe(0.75);
    expect(clampThreshold(NaN)).toBe(0.7);
  });

  it('classification is active only when hiding or showing results', () => {
    expect(isClassificationActive({ ...DEFAULT_SETTINGS.prod, hideEnabled: false })).toBe(false);
    expect(isClassificationActive(DEFAULT_SETTINGS.prod)).toBe(true);
    expect(isClassificationActive({ ...DEFAULT_SETTINGS.dev, hideEnabled: false, showResults: true })).toBe(true);
  });
});

describe('day helpers', () => {
  it('localDay formats local date', async () => {
    const { localDay } = await import('../../shared/day');
    expect(localDay(new Date(2026, 8, 30, 23, 59))).toBe('2026-09-30');
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
  it('hiddenCountFrom only counts today', async () => {
    const { hiddenCountFrom } = await import('../../shared/day');
    const now = new Date(2026, 8, 30, 12);
    expect(hiddenCountFrom({ day: '2026-09-30', hiddenIds: ['1', '2'] }, now)).toBe(2);
    expect(hiddenCountFrom({ day: '2026-09-29', hiddenIds: ['1'] }, now)).toBe(0);
    expect(hiddenCountFrom(undefined, now)).toBe(0);
    expect(hiddenCountFrom({ day: '2026-09-30', hiddenIds: 'x' }, now)).toBe(0);
  });
});
