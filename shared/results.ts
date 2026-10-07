// Content-side aggregation of text/full stage results for one post. Pure.

import type { ResultMsg } from './protocol';
import type { ErrorInfo, JevResult, MediaTranscript, VisionStatus } from './types';

export interface PostResultState {
  postId: string;
  snapHash: string;
  text?: ResultMsg;
  full?: ResultMsg;
  vision: VisionStatus;
  transcripts?: MediaTranscript[];
  /** Most recent error from either stage. */
  error?: ErrorInfo;
}

/**
 * Merge a result into the post's state. A result for a different snapHash than `prev` starts a
 * fresh state (the snapshot changed, e.g. a card loaded late) — callers must drop results whose
 * snapHash is not the one they last sent.
 */
export function mergeResult(prev: PostResultState | undefined, msg: ResultMsg): PostResultState {
  const base: PostResultState =
    prev && prev.snapHash === msg.snapHash
      ? { ...prev }
      : { postId: msg.postId, snapHash: msg.snapHash, vision: msg.vision };
  if (msg.stage === 'text') base.text = msg;
  else base.full = msg;
  base.vision = msg.vision;
  if (msg.transcripts) base.transcripts = msg.transcripts;
  if (msg.error) base.error = msg.error;
  return base;
}

/** The Jev result to decide on: the full (vision) pass when present, else the text pass. */
export function effectiveJev(state: PostResultState | undefined): JevResult | undefined {
  return state?.full?.jev ?? state?.text?.jev;
}

/** Which stage `effectiveJev` came from. */
export function effectiveStage(state: PostResultState | undefined): 'text' | 'full' | undefined {
  if (state?.full?.jev) return 'full';
  if (state?.text?.jev) return 'text';
  return undefined;
}
