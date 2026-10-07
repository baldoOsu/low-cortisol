// Per-post pipeline: text pass, then (when useful) a vision pass. Errors are emitted, never thrown
// (fail open). Spec §4.2, §6

import type { ClassifyResponse, PostMsg, ResultMsg, TranscribeItem, TranscribeResponse } from '../../../shared/protocol';
import type { ErrorInfo, JevResult, JevState, MediaRef, PostSnapshot, RateLimitInfo, Settings, VisionStatus } from '../../../shared/types';
import { buildJevState } from '../../../shared/rubric';
import { decide } from '../../../shared/decide';
import { hash53, stableStringify } from '../../../shared/hash';
import { fetchMediaItems } from './media';
import { NativeCallError, TIMEOUTS, type NativeApi } from './native';
import { InFlight, LruCache, Semaphore } from './queue';

export interface PipelineStats {
  record(kind: 'text' | 'vision' | 'full', ms: number): void;
  setRateLimit(r: RateLimitInfo | undefined): void;
  pending: { text: number; vision: number };
}

export interface PipelineDeps {
  native: NativeApi;
  settings: () => Settings;
  fetchMedia: (m: MediaRef[]) => Promise<{ items: TranscribeItem[]; failed: string[] }>;
  textSem: Semaphore;
  visionSem: Semaphore;
  lru: LruCache<string, JevResult>;
  inflight: InFlight<string, JevResult>;
  now: () => number;
  stats: PipelineStats;
}

export function createPipelineDeps(
  native: NativeApi,
  settings: () => Settings,
  stats: PipelineStats,
  fetchMedia: PipelineDeps['fetchMedia'] = (m) => fetchMediaItems(m),
): PipelineDeps {
  return {
    native,
    settings,
    fetchMedia,
    textSem: new Semaphore(6),
    visionSem: new Semaphore(2),
    lru: new LruCache(500),
    inflight: new InFlight(),
    now: Date.now,
    stats,
  };
}

export async function classifyCached(state: JevState, deps: PipelineDeps): Promise<JevResult> {
  const key = hash53(stableStringify(state));
  const hit = deps.lru.get(key);
  if (hit) return { ...hit, cached: true };
  return deps.inflight.run(key, async () => {
    const r = await deps.textSem.run(() =>
      deps.native.request<ClassifyResponse>({ type: 'classify', state }, TIMEOUTS.classify),
    );
    deps.lru.set(key, r.result);
    return r.result;
  });
}

function errorInfo(e: unknown): ErrorInfo {
  if (e instanceof NativeCallError) return e.info;
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

function visionStatus(snapshot: PostSnapshot, s: Settings, jev: JevResult | undefined): VisionStatus {
  if (snapshot.media.length === 0) return 'none';
  if (!s.visionEnabled) return 'disabled';
  // No text verdict (text pass failed): no vision pass follows, so don't report 'pending'.
  if (!jev) return 'failed';
  if (decide(jev.answers, s.threshold).hide) return 'skipped_flagged';
  return 'pending';
}

export async function processPost(msg: PostMsg, emit: (r: ResultMsg) => void, deps: PipelineDeps): Promise<void> {
  try {
    await run(msg, emit, deps);
  } catch {
    // Only `emit` itself can throw here; the post stays visible either way.
  }
}

async function run(msg: PostMsg, emit: (r: ResultMsg) => void, deps: PipelineDeps): Promise<void> {
  const { snapshot, snapHash } = msg;
  const { stats } = deps;
  const s = deps.settings();
  const base = { type: 'result', postId: snapshot.postId, snapHash } as const;
  const t0 = deps.now();

  // 1. Text pass.
  let jev: JevResult;
  stats.pending.text++;
  try {
    jev = await classifyCached(buildJevState(snapshot), deps);
  } catch (e) {
    emit({ ...base, stage: 'text', vision: visionStatus(snapshot, s, undefined), error: errorInfo(e), timings: { textMs: deps.now() - t0 } });
    return;
  } finally {
    stats.pending.text--;
  }
  const textMs = deps.now() - t0;
  stats.record('text', textMs);

  // 2–3. Text result, with the vision decision.
  const vision = visionStatus(snapshot, s, jev);
  emit({ ...base, stage: 'text', jev, vision, timings: { textMs } });
  if (vision !== 'pending') return;

  // 4–7. Vision pass.
  let full: ResultMsg;
  stats.pending.vision++;
  try {
    const tv = deps.now();
    const { items } = await deps.fetchMedia(snapshot.media);
    if (items.length === 0) {
      full = {
        ...base,
        stage: 'full',
        vision: 'failed',
        error: { code: 'MEDIA_FETCH_FAILED', message: 'no media could be fetched' },
        timings: { textMs },
      };
    } else {
      const tr = await deps.visionSem.run(() =>
        deps.native.request<TranscribeResponse>(
          { type: 'transcribe', model: s.transcriptModel, items },
          TIMEOUTS.transcribe,
        ),
      );
      const visionMs = deps.now() - tv;
      stats.setRateLimit(tr.rateLimit);
      stats.record('vision', visionMs);

      const tf = deps.now();
      const jev2 = await classifyCached(buildJevState(snapshot, tr.transcripts), deps);
      const fullMs = deps.now() - tf;
      stats.record('full', fullMs);

      full = {
        ...base,
        stage: 'full',
        jev: jev2,
        vision: 'done',
        transcripts: tr.transcripts,
        timings: { textMs, visionMs, fullMs },
      };
    }
  } catch (e) {
    // 8. The text verdict stands.
    full = { ...base, stage: 'full', vision: 'failed', error: errorInfo(e), timings: { textMs } };
  } finally {
    stats.pending.vision--;
  }
  emit(full);
}
