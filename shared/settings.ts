// Settings defaults per flavor and the prod/dev "effective settings" rule. Spec Â§3.1

import type { Flavor, Settings, TranscriptModel } from './types';

export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.95;
export const THRESHOLD_STEP = 0.05;

export const THRESHOLD_PRESETS = {
  aggressive: 0.55,
  balanced: 0.7,
  conservative: 0.85,
} as const;

export type ThresholdPreset = keyof typeof THRESHOLD_PRESETS;

/** Model ids verified with Claude Code CLI 2.1.281 on 2026-09-30. */
export const TRANSCRIPT_MODELS: ReadonlyArray<{ id: TranscriptModel; label: string }> = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (default)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
];

export const DEFAULT_TRANSCRIPT_MODEL: TranscriptModel = 'claude-opus-5-5';

export const DEFAULT_SETTINGS: Readonly<Record<Flavor, Readonly<Settings>>> = {
  prod: {
    hideEnabled: true,
    showResults: false,
    threshold: THRESHOLD_PRESETS.balanced,
    visionEnabled: true,
    transcriptModel: DEFAULT_TRANSCRIPT_MODEL,
    showTranscript: false,
    showStatus: false,
  },
  dev: {
    // Dev starts in labeling mode: shows what it would hide without hiding.
    hideEnabled: false,
    showResults: true,
    threshold: THRESHOLD_PRESETS.balanced,
    visionEnabled: true,
    transcriptModel: DEFAULT_TRANSCRIPT_MODEL,
    showTranscript: true,
    showStatus: true,
  },
};

export function clampThreshold(n: unknown, fallback: number = THRESHOLD_PRESETS.balanced): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n));
  return Math.round(clamped * 100) / 100;
}

function isTranscriptModel(v: unknown): v is TranscriptModel {
  return TRANSCRIPT_MODELS.some((m) => m.id === v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Prod only honours `hideEnabled`; everything else is forced to prod defaults (prod can never show panels).
 * Dev merges stored values over dev defaults, ignoring wrong types and clamping the threshold.
 */
export function effectiveSettings(stored: unknown, flavor: Flavor): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS[flavor];
  if (flavor === 'prod') {
    return { ...d, hideEnabled: bool(s.hideEnabled, d.hideEnabled) };
  }
  return {
    hideEnabled: bool(s.hideEnabled, d.hideEnabled),
    showResults: bool(s.showResults, d.showResults),
    threshold: clampThreshold(s.threshold, d.threshold),
    visionEnabled: bool(s.visionEnabled, d.visionEnabled),
    transcriptModel: isTranscriptModel(s.transcriptModel) ? s.transcriptModel : d.transcriptModel,
    showTranscript: bool(s.showTranscript, d.showTranscript),
    showStatus: bool(s.showStatus, d.showStatus),
  };
}

/** Classification runs (and anything is sent anywhere) only when this is true. */
export function isClassificationActive(s: Settings): boolean {
  return s.hideEnabled || s.showResults;
}
