// Pure helpers for scripts/live-x-check.mjs: parse dev panel text and summarise per-post samples.

const VERDICT_RE = /(?:^|[\s·])(HIDE|KEEP|PENDING|ERROR)(?![A-Z_])/;
const ERROR_CODE_RE = /ERROR\s+([A-Z][A-Z0-9_]*)/;
const VISION_RE = /vision:\s*(none|disabled|pending|done|skipped|failed)/;

/** Parses a dev panel's shadow textContent (its lines run together) into { verdict, errorCode?, vision? }. */
export function parsePanelText(text) {
  const verdict = typeof text === 'string' ? text.match(VERDICT_RE)?.[1] : undefined;
  if (!verdict) return { verdict: null };
  const out = { verdict };
  if (verdict === 'ERROR') {
    const code = text.match(ERROR_CODE_RE)?.[1];
    if (code) out.errorCode = code;
  }
  const vision = text.match(VISION_RE)?.[1];
  if (vision) out.vision = vision;
  return out;
}

/** Turns one collected cell into a sample. A hidden cell is a HIDE decision even without a panel (prod, or dev after hiding). */
export function sampleFromCell({ postId, hidden, panelText }) {
  const parsed = parsePanelText(panelText);
  const sample = { postId, verdict: hidden ? 'HIDE' : parsed.verdict, hidden, vision: parsed.vision ?? null };
  if (parsed.errorCode) sample.errorCode = parsed.errorCode;
  return sample;
}

export function summarize(samples) {
  const s = { posts: 0, withVerdict: 0, hide: 0, keep: 0, pending: 0, error: 0, hiddenCells: 0, visionDone: 0, visionFailed: 0, errorCodes: {} };
  for (const sample of samples) {
    s.posts++;
    if (sample.verdict) s.withVerdict++;
    if (sample.verdict === 'HIDE') s.hide++;
    else if (sample.verdict === 'KEEP') s.keep++;
    else if (sample.verdict === 'PENDING') s.pending++;
    else if (sample.verdict === 'ERROR') s.error++;
    if (sample.hidden) s.hiddenCells++;
    if (sample.vision === 'done') s.visionDone++;
    else if (sample.vision === 'failed') s.visionFailed++;
    if (sample.errorCode) s.errorCodes[sample.errorCode] = (s.errorCodes[sample.errorCode] ?? 0) + 1;
  }
  return s;
}
