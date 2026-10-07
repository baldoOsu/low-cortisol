import { describe, expect, it } from 'vitest';
import { decide, intensityLabel, isValidAnswers, topKey } from '../../shared/decide';
import { answers } from './helpers';

describe('decide', () => {
  // Numbers from the live rubric probe on 2026-09-30.
  it('hides the outrage probe (ragebait 0.97) at balanced', () => {
    const d = decide(
      answers({
        ragebait: 0.97,
        intensity: 3.6,
        category: { engagement_bait: 0.42, outrage_bait: 0.28, fear_mongering: 0.21, benign_other: 0.09 },
      }),
      0.7,
    );
    expect(d.hide).toBe(true);
    expect(d.reasons[0]).toBe('ragebait 0.97 ≥ 0.70');
    expect(d.topCategory).toEqual({ key: 'engagement_bait', p: 0.42 });
  });

  it.each([
    ['neutral news', 0.04, 0, { neutral_news: 1 }],
    ['sincere grief (intensity 2.11)', 0.13, 2.11, { sincere_personal: 1 }],
    ['humor meme', 0.06, 0.04, { humor: 1 }],
  ])('keeps %s', (_name, rb, intensity, category) => {
    const d = decide(answers({ ragebait: rb, intensity, category }), 0.7);
    expect(d.hide).toBe(false);
    expect(d.reasons).toEqual([`ragebait ${rb.toFixed(2)} < 0.70`]);
  });

  it('rule A boundary is inclusive', () => {
    expect(decide(answers({ ragebait: 0.7 }), 0.7).hide).toBe(true);
    expect(decide(answers({ ragebait: 0.6999 }), 0.7).hide).toBe(false);
  });

  it('rule B fires on hide-category mass >= T+0.10 with intensity >= 2.5 even when the noul undershoots', () => {
    const d = decide(
      answers({ ragebait: 0.5, intensity: 2.5, category: { culture_war: 0.5, harassment: 0.3, neutral_news: 0.2 } }),
      0.7,
    );
    expect(d.hide).toBe(true);
    expect(d.reasons).toEqual(['hide-kinds 0.80 ≥ 0.80 & intensity 2.5 ≥ 2.5 (top: culture_war)']);
  });

  it('rule B needs intensity: calm hide-kind posts are kept', () => {
    expect(decide(answers({ ragebait: 0.5, intensity: 2.4, category: { culture_war: 1 } }), 0.7).hide).toBe(false);
  });

  it('rule B threshold is capped at 0.99', () => {
    const d = decide(answers({ ragebait: 0.1, intensity: 3, category: { drama: 0.99, humor: 0.01 } }), 0.95);
    expect(d.hide).toBe(true);
  });

  it('both rules can fire and both reasons are listed', () => {
    const d = decide(answers({ ragebait: 0.9, intensity: 4, category: { harassment: 1 } }), 0.7);
    expect(d.reasons).toHaveLength(2);
  });

  it('strictness changes the outcome for the same answers', () => {
    const a = answers({ ragebait: 0.6 });
    expect(decide(a, 0.55).hide).toBe(true);
    expect(decide(a, 0.7).hide).toBe(false);
  });

  it.each([undefined, null, {}, { ragebait: { noul: 'x' } }])('fails open on malformed answers %#', (bad) => {
    expect(decide(bad as never, 0.7)).toEqual({ hide: false, reasons: ['no verdict'] });
  });

  it('isValidAnswers accepts helper answers', () => {
    expect(isValidAnswers(answers())).toBe(true);
  });
});

describe('decide helpers', () => {
  it('topKey picks the max', () => {
    expect(topKey({ a: 0.1, b: 0.7, c: 0.2 })).toEqual({ key: 'b', p: 0.7 });
    expect(topKey({})).toBeUndefined();
  });

  it('intensityLabel rounds and clamps', () => {
    expect(intensityLabel(3.6)).toBe('Inflammatory');
    expect(intensityLabel(3.4)).toBe('Strong');
    expect(intensityLabel(-1)).toBe('Calm');
    expect(intensityLabel(9)).toBe('Inflammatory');
  });
});
