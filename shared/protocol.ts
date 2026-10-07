// Message contracts: extension ↔ companion (Native Messaging), content ↔ service worker, popup ↔ SW.
// Spec: docs/superpowers/specs/2026-09-30-low-cortisol-design.md §4.2, §5

import type {
  ErrorInfo,
  Flavor,
  JevAnswers,
  JevResult,
  JevState,
  MediaKind,
  MediaTranscript,
  PostSnapshot,
  RateLimitInfo,
  TranscriptModel,
  VisionStatus,
} from './types';

export const HOST_NAME = 'com.lowcortisol.companion';
export const PORT_NAME = 'lc';
export const MAX_VISION_ITEMS = 6;

export const STORAGE_KEYS = {
  settings: 'settings',
  stats: 'stats',
  feedback: 'feedback',
} as const;

// ---------------- Extension ↔ companion ----------------

export interface TranscribeItem {
  key: string;
  kind: MediaKind;
  inQuote: boolean;
  alt?: string;
  /** e.g. "image/jpeg" */
  mediaType: string;
  dataBase64: string;
}

export interface HelloRequest {
  id: string;
  type: 'hello';
  flavor: Flavor;
  extVersion: string;
}

export interface ClassifyRequest {
  id: string;
  type: 'classify';
  state: JevState;
}

export interface TranscribeRequest {
  id: string;
  type: 'transcribe';
  model: TranscriptModel;
  items: TranscribeItem[];
}

export type HostRequest = HelloRequest | ClassifyRequest | TranscribeRequest;
export type HostRequestType = HostRequest['type'];

export interface HelloResponse {
  id: string;
  ok: true;
  type: 'hello';
  companionVersion: string;
  jevConfigured: boolean;
  claudeFound: boolean;
  claudePath?: string;
}

export interface ClassifyResponse {
  id: string;
  ok: true;
  type: 'classify';
  result: JevResult;
}

export interface TranscribeOutput {
  transcripts: MediaTranscript[];
  latencyMs: number;
  /** Keys served from the companion cache (no claude call needed for them). */
  cachedKeys: string[];
  rateLimit?: RateLimitInfo;
}

export interface TranscribeResponse extends TranscribeOutput {
  id: string;
  ok: true;
  type: 'transcribe';
}

export interface ErrorResponse {
  id: string;
  ok: false;
  type: HostRequestType | 'unknown';
  error: ErrorInfo;
}

export type HostResponse = HelloResponse | ClassifyResponse | TranscribeResponse | ErrorResponse;

// ---------------- Content script ↔ service worker (port PORT_NAME) ----------------

export interface PostMsg {
  type: 'post';
  snapshot: PostSnapshot;
  /** hash53(stableStringify(snapshot)); echoed back in results so stale results can be ignored. */
  snapHash: string;
}

export interface HiddenMsg {
  type: 'hidden';
  postId: string;
}

export interface FeedbackMsg {
  type: 'feedback';
  entry: FeedbackEntry;
}

/** Selector health from checkHealth(); sent only when `ok` flips (spec §4.1). */
export interface HealthMsg {
  type: 'health';
  ok: boolean;
  cells: number;
  articles: number;
  parsed: number;
}

export type ContentToSw = PostMsg | HiddenMsg | FeedbackMsg | HealthMsg;

export interface ResultTimings {
  textMs?: number;
  visionMs?: number;
  fullMs?: number;
}

export interface ResultMsg {
  type: 'result';
  postId: string;
  snapHash: string;
  stage: 'text' | 'full';
  jev?: JevResult;
  vision: VisionStatus;
  transcripts?: MediaTranscript[];
  error?: ErrorInfo;
  timings: ResultTimings;
}

export type SwToContent = ResultMsg;

// ---------------- Popup ↔ service worker ----------------

export interface GetStatusMsg {
  type: 'getStatus';
}

export type CompanionStatus = 'connecting' | 'online' | 'offline';

export interface StatusSnapshot {
  companion: CompanionStatus;
  companionVersion?: string;
  jevConfigured?: boolean;
  claudeFound?: boolean;
  lastError?: string;
  pending: { text: number; vision: number };
  avgMs: { text?: number; vision?: number; full?: number };
  rateLimit?: RateLimitInfo;
  /** Last selector health reported by any tab. */
  selectorHealth?: Omit<HealthMsg, 'type'>;
}

// ---------------- Storage records ----------------

export interface HiddenStats {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  hiddenIds: string[];
}

export interface FeedbackEntry {
  /** ISO timestamp. */
  at: string;
  flavor: Flavor;
  postId: string;
  url: string;
  /** The owner's label. */
  label: 'hide' | 'keep';
  /** What Low Cortisol decided at `threshold`. */
  verdict: 'hide' | 'keep';
  threshold: number;
  rubricVersion: string;
  jevModel: string;
  stage: 'text' | 'full';
  answers: JevAnswers;
  /** Exact Jev input (includes transcripts on the full stage). */
  state: JevState;
}
