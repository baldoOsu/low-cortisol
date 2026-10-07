// Hide/keep decision from Jev answers. Pure and fail-open. Spec §3.3

import { HIDE_CATEGORIES, INTENSITY_LEVELS } from './rubric';
import type { JevAnswers } from './types';

export const RULE_B_INTENSITY = 2.5;
export const RULE_B_MARGIN = 0.1;
export const RULE_B_CAP = 0.99;

export interface Ranked {
  key: string;
  p: number;
}

export interface Decision {
  hide: boolean;
  reasons: string[];
  ragebait?: number;
  hideCategoryMass?: number;
  intensity?: number;
  topCategory?: Ranked;
  topEmotion?: Ranked;
  topTopic?: Ranked;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isProbMap(v: unknown): v is Record<string, number> {
  return !!v && typeof v === 'object' && Object.values(v as object).every(isNum);
}

export function isValidAnswers(a: unknown): a is JevAnswers {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, any>;
  return (
    isNum(x.ragebait?.noul) &&
    isProbMap(x.category?.probabilities) &&
    isProbMap(x.emotion?.probabilities) &&
    isProbMap(x.topic?.probabilities) &&
    isNum(x.intensity?.score)
  );
}

export function topKey(probabilities: Record<string, number>): Ranked | undefined {
  let best: Ranked | undefined;
  for (const [key, p] of Object.entries(probabilities)) {
    if (!best || p > best.p) best = { key, p };
  }
  return best;
}

export function intensityLabel(score: number): string {
  const i = Math.min(INTENSITY_LEVELS.length - 1, Math.max(0, Math.round(score)));
  return INTENSITY_LEVELS[i];
}

const f2 = (n: number) => n.toFixed(2);
const f1 = (n: number) => n.toFixed(1);

/**
 * rule A: ragebait ≥ T
 * rule B: hide-category mass ≥ min(T + 0.10, 0.99) AND intensity ≥ 2.5
 * Missing/malformed answers → keep (fail open).
 */
export function decide(answers: JevAnswers | undefined | null, threshold: number): Decision {
  if (!isValidAnswers(answers)) return { hide: false, reasons: ['no verdict'] };

  const T = threshold;
  const p = answers.ragebait.noul;
  const probs = answers.category.probabilities;
  const c = HIDE_CATEGORIES.reduce((sum, k) => sum + (isNum(probs[k]) ? probs[k] : 0), 0);
  const i = answers.intensity.score;
  const tB = Math.min(T + RULE_B_MARGIN, RULE_B_CAP);

  const topCategory = topKey(probs);
  const topEmotion = topKey(answers.emotion.probabilities);
  const topTopic = topKey(answers.topic.probabilities);

  const reasons: string[] = [];
  const ruleA = p >= T;
  const ruleB = c >= tB && i >= RULE_B_INTENSITY;
  if (ruleA) reasons.push(`ragebait ${f2(p)} ≥ ${f2(T)}`);
  if (ruleB) {
    reasons.push(
      `hide-kinds ${f2(c)} ≥ ${f2(tB)} & intensity ${f1(i)} ≥ ${f1(RULE_B_INTENSITY)}` +
        (topCategory ? ` (top: ${topCategory.key})` : ''),
    );
  }
  if (!ruleA && !ruleB) reasons.push(`ragebait ${f2(p)} < ${f2(T)}`);

  return {
    hide: ruleA || ruleB,
    reasons,
    ragebait: p,
    hideCategoryMass: c,
    intensity: i,
    topCategory,
    topEmotion,
    topTopic,
  };
}
