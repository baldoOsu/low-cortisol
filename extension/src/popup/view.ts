// Pure popup view-model builders (unit-tested); popup.ts wires them to the DOM. Spec §4.3

import type { FeedbackEntry, StatusSnapshot } from '../../../shared/protocol';
import { THRESHOLD_PRESETS, TRANSCRIPT_MODELS } from '../../../shared/settings';
import type { Flavor, Settings, TranscriptModel } from '../../../shared/types';

export type PresetName = 'Aggressive' | 'Balanced' | 'Conservative';

export interface PopupModel {
  flavor: Flavor;
  title: string;
  hideEnabled: boolean;
  hiddenTodayText: string;
  offlineWarning?: string;
  dev?: {
    showResults: boolean;
    threshold: number;
    thresholdText: string;
    visionEnabled: boolean;
    transcriptModel: TranscriptModel;
    showTranscript: boolean;
    showStatus: boolean;
    models: ReadonlyArray<{ id: TranscriptModel; label: string }>;
    presets: Array<{ name: PresetName; value: number }>;
    statusLines: string[];
    feedbackCount: number;
  };
}

const PRESETS: Array<{ name: PresetName; value: number }> = [
  { name: 'Aggressive', value: THRESHOLD_PRESETS.aggressive },
  { name: 'Balanced', value: THRESHOLD_PRESETS.balanced },
  { name: 'Conservative', value: THRESHOLD_PRESETS.conservative },
];

export const OFFLINE_WARNING = 'Companion offline: nothing is being filtered.';

/** "0.70 (Balanced)" for a preset value, otherwise just "0.60". */
export function thresholdText(t: number): string {
  const text = t.toFixed(2);
  const preset = PRESETS.find((p) => p.value.toFixed(2) === text);
  return preset ? `${text} (${preset.name})` : text;
}

export function statusLines(s: StatusSnapshot | undefined): string[] {
  if (!s) return ['Status: unavailable'];
  const lines = [`Companion: ${s.companion}${s.companionVersion ? ' v' + s.companionVersion : ''}`];
  if (s.jevConfigured !== undefined) lines.push(`Jev key: ${s.jevConfigured ? 'configured' : 'missing'}`);
  if (s.claudeFound !== undefined) lines.push(`Claude CLI: ${s.claudeFound ? 'found' : 'not found'}`);
  lines.push(`Pending: text ${s.pending.text} · vision ${s.pending.vision}`);
  const { text, vision, full } = s.avgMs;
  const ms = (n: number | undefined) => (n != null ? String(Math.round(n)) : '–');
  const visionText = vision != null ? (vision / 1000).toFixed(1) + ' s' : '–';
  lines.push(`Avg: text ${ms(text)} ms · vision ${visionText} · full ${ms(full)} ms`);
  const u = s.rateLimit?.fiveHourUtilization;
  if (u !== undefined) lines.push(`Claude 5h usage: ${Math.round(u * 100)}%`);
  const h = s.selectorHealth;
  if (h) lines.push(h.ok ? 'Selectors: OK' : `Selectors: BROKEN (cells ${h.cells}, posts ${h.articles}, parsed ${h.parsed})`);
  if (s.lastError) lines.push(`Last error: ${s.lastError}`);
  return lines;
}

export function buildPopupModel(i: {
  flavor: Flavor;
  settings: Settings;
  status?: StatusSnapshot;
  hiddenToday: number;
  feedbackCount: number;
}): PopupModel {
  const { flavor, settings: s, status } = i;
  const model: PopupModel = {
    flavor,
    title: flavor === 'dev' ? 'Low Cortisol (Dev)' : 'Low Cortisol',
    hideEnabled: s.hideEnabled,
    hiddenTodayText: `${i.hiddenToday} hidden today`,
  };
  if (status?.companion === 'offline' && (s.hideEnabled || s.showResults)) model.offlineWarning = OFFLINE_WARNING;
  if (flavor === 'dev') {
    model.dev = {
      showResults: s.showResults,
      threshold: s.threshold,
      thresholdText: thresholdText(s.threshold),
      visionEnabled: s.visionEnabled,
      transcriptModel: s.transcriptModel,
      showTranscript: s.showTranscript,
      showStatus: s.showStatus,
      models: TRANSCRIPT_MODELS,
      presets: PRESETS.map((p) => ({ ...p })),
      statusLines: statusLines(status),
      feedbackCount: i.feedbackCount,
    };
  }
  return model;
}

/** One JSON object per line, with a trailing newline when non-empty. */
export function feedbackToJsonl(entries: FeedbackEntry[]): string {
  return entries.map((e) => JSON.stringify(e) + '\n').join('');
}

/** "low-cortisol-feedback-YYYYMMDD.jsonl" for the local date of `d`. */
export function feedbackFilename(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `low-cortisol-feedback-${y}${m}${day}.jsonl`;
}
