// Shared contract for Low Cortisol. Pure types: no DOM, chrome.* or node:* imports.
// Spec: docs/superpowers/specs/2026-09-30-low-cortisol-design.md §3

export type Flavor = 'dev' | 'prod';

export type MediaKind = 'image' | 'gif_poster' | 'video_poster' | 'card_image';

export interface MediaRef {
  kind: MediaKind;
  /** URL to fetch (already normalised: name=large|orig|4096x4096 → name=medium). */
  url: string;
  /** Stable id derived from the URL without size/format params, e.g. "media/F1a2b3". */
  key: string;
  alt?: string;
  /** True when the media belongs to the quoted post. */
  inQuote: boolean;
}

export interface LinkCard {
  domain?: string;
  title?: string;
  description?: string;
}

export interface QuotedPost {
  postId?: string;
  authorHandle: string;
  authorName: string;
  text: string;
  truncated: boolean;
}

export interface PostSnapshot {
  postId: string;
  url: string;
  /** "@handle" (with the @). */
  authorHandle: string;
  authorName: string;
  text: string;
  truncated: boolean;
  lang?: string;
  promoted: boolean;
  /** "@handle" or display text of the account that reposted, when the cell is a repost. */
  repostedBy?: string;
  card?: LinkCard;
  quoted?: QuotedPost;
  /** Order: outer media, card image, quoted media. Vision uses at most MAX_VISION_ITEMS. */
  media: MediaRef[];
}

// ---- Jev answers (shapes verified against jev-1.13.0 on 2026-09-30) ----

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level, 0..(levels-1). */
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface JevAnswers {
  ragebait: NoulAnswer;
  category: ChoiceAnswer;
  emotion: ChoiceAnswer;
  intensity: ScoreAnswer;
  topic: ChoiceAnswer;
}

export interface JevResult {
  /** Served model version, e.g. "jev-1.13.0". */
  model: string;
  answers: JevAnswers;
  latencyMs: number;
  cached: boolean;
}

// ---- Jev input state (built by shared/rubric.ts buildJevState) ----

export interface JevMediaState {
  kind: MediaKind;
  alt?: string;
  visible_text?: string;
  description?: string;
  cues?: string[];
}

export interface JevQuotedState {
  author: string;
  text: string;
  text_truncated?: true;
  media?: JevMediaState[];
}

export interface JevPostState {
  author: string;
  text: string;
  text_truncated?: true;
  reposted_by?: string;
  promoted?: true;
  link_card?: LinkCard;
  media?: JevMediaState[];
  quoted_post?: JevQuotedState;
}

export type MediaStatus = 'none' | 'not_transcribed' | 'transcribed';

export interface JevState {
  post: JevPostState;
  media_status: MediaStatus;
}

// ---- Vision ----

export interface MediaTranscript {
  key: string;
  kind: MediaKind;
  inQuote: boolean;
  visibleText: string;
  description: string;
  cues: string[];
  /** Claude model id that produced it. */
  model: string;
}

export type TranscriptModel = 'claude-opus-5-5' | 'claude-sonnet-5-5';

export interface RateLimitInfo {
  status?: string;
  /** 0..1 */
  fiveHourUtilization?: number;
  /** 0..1 */
  sevenDayUtilization?: number;
}

export type VisionStatus = 'none' | 'disabled' | 'pending' | 'done' | 'skipped_flagged' | 'failed';

// ---- Settings ----

export interface Settings {
  /** Prod: the one switch ("Hide ragebait"). Dev: the "Hide ragebait" toggle. */
  hideEnabled: boolean;
  /** Dev only: render the results panel inside each post. */
  showResults: boolean;
  /** Ragebait threshold T, 0.50..0.95. */
  threshold: number;
  visionEnabled: boolean;
  transcriptModel: TranscriptModel;
  showTranscript: boolean;
  /** Dev only: show the per-post timing line in panels. */
  showStatus: boolean;
}

// ---- Errors ----

export type ErrorCode =
  | 'NO_API_KEY'
  | 'JEV_HTTP'
  | 'JEV_TIMEOUT'
  | 'JEV_NETWORK'
  | 'JEV_BAD_RESPONSE'
  | 'CLAUDE_NOT_FOUND'
  | 'CLAUDE_FAILED'
  | 'CLAUDE_TIMEOUT'
  | 'MEDIA_FETCH_FAILED'
  | 'COMPANION_OFFLINE'
  | 'COMPANION_TIMEOUT'
  | 'BAD_REQUEST'
  | 'RESPONSE_TOO_LARGE'
  | 'INTERNAL';

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  status?: number;
}
