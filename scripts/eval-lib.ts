// Threshold sweep over the owner's exported feedback labels (answer 26a, Q29 criteria). Spec §8 "Tuning"

import { decide } from '../shared/decide';
import type { FeedbackEntry } from '../shared/protocol';
import { THRESHOLD_MAX, THRESHOLD_MIN, THRESHOLD_STEP } from '../shared/settings';

export interface SweepRow {
  threshold: number;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  /** tp / (tp + fn): share of hide-labelled posts that would be hidden. NaN when there are no hide labels. */
  recall: number;
  /** fp / (fp + tn): share of keep-labelled posts that would be hidden. NaN when there are no keep labels. */
  fpr: number;
  n: number;
}

/** Q29: at least 80% recall on hide labels, at most 5% of keep labels hidden. */
export const TARGET_RECALL = 0.8;
export const TARGET_FPR = 0.05;

const round2 = (n: number) => Math.round(n * 100) / 100;

function defaultThresholds(): number[] {
  const out: number[] = [];
  for (let t = THRESHOLD_MIN; t <= THRESHOLD_MAX + 1e-9; t += THRESHOLD_STEP) out.push(round2(t));
  return out;
}

function isEntry(v: unknown): v is FeedbackEntry {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  return typeof x.postId === 'string' && x.postId !== '' && (x.label === 'hide' || x.label === 'keep');
}

/** One FeedbackEntry per line; blank lines, invalid JSON and non-entries are skipped. */
export function parseJsonl(text: string): FeedbackEntry[] {
  const out: FeedbackEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isEntry(v)) out.push(v);
    } catch {
      // not JSON: skip
    }
  }
  return out;
}

/** The owner can relabel a post; the last entry per postId (in file order) wins. */
export function latestLabels(entries: FeedbackEntry[]): FeedbackEntry[] {
  const byPost = new Map<string, FeedbackEntry>();
  for (const entry of entries) byPost.set(entry.postId, entry);
  return [...byPost.values()];
}

/** Replays decide() at each threshold. Malformed answers decide "keep" (fail open), as in the extension. */
export function sweep(entries: FeedbackEntry[], thresholds: number[] = defaultThresholds()): SweepRow[] {
  return thresholds.map((threshold) => {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    let tn = 0;
    for (const entry of entries) {
      const hide = decide(entry.answers, threshold).hide;
      if (entry.label === 'hide') {
        if (hide) tp++;
        else fn++;
      } else if (hide) fp++;
      else tn++;
    }
    return {
      threshold,
      tp,
      fn,
      fp,
      tn,
      recall: tp + fn > 0 ? tp / (tp + fn) : NaN,
      fpr: fp + tn > 0 ? fp / (fp + tn) : NaN,
      n: entries.length,
    };
  });
}

const pct = (n: number) => (Number.isNaN(n) ? 'n/a' : `${(n * 100).toFixed(1)}%`);

export function formatTable(rows: SweepRow[]): string {
  const header = ['T', 'recall', 'FPR', 'TP', 'FN', 'FP', 'TN', 'n'];
  const body = rows.map((r) => [
    r.threshold.toFixed(2),
    pct(r.recall),
    pct(r.fpr),
    String(r.tp),
    String(r.fn),
    String(r.fp),
    String(r.tn),
    String(r.n),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), ...body.map(line)].join('\n');
}

/** Highest recall among rows meeting recall ≥ minRecall and FPR ≤ maxFpr; ties go to the lower FPR, then the higher (more conservative) threshold. */
export function bestThreshold(
  rows: SweepRow[],
  minRecall: number = TARGET_RECALL,
  maxFpr: number = TARGET_FPR,
): SweepRow | undefined {
  let best: SweepRow | undefined;
  for (const r of rows) {
    // NaN comparisons are false, so rows without both label classes never qualify.
    if (!(r.recall >= minRecall && r.fpr <= maxFpr)) continue;
    const better =
      !best ||
      r.recall > best.recall ||
      (r.recall === best.recall && (r.fpr < best.fpr || (r.fpr === best.fpr && r.threshold > best.threshold)));
    if (better) best = r;
  }
  return best;
}
