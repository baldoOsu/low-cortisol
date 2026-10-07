// Hand-written types for live-report.mjs.

export type LiveVerdict = 'HIDE' | 'KEEP' | 'PENDING' | 'ERROR';
export type LiveVision = 'none' | 'disabled' | 'pending' | 'done' | 'skipped' | 'failed';

export interface PanelInfo {
  verdict: LiveVerdict | null;
  errorCode?: string;
  vision?: LiveVision;
}

export interface LiveSample {
  postId: string;
  verdict: LiveVerdict | null;
  hidden: boolean;
  vision: LiveVision | null;
  errorCode?: string;
}

export interface CollectedCell {
  postId: string;
  hidden: boolean;
  panelText: string | null;
}

export interface LiveSummary {
  posts: number;
  withVerdict: number;
  hide: number;
  keep: number;
  pending: number;
  error: number;
  hiddenCells: number;
  visionDone: number;
  visionFailed: number;
  errorCodes: Record<string, number>;
}

export declare function parsePanelText(text: string | null | undefined): PanelInfo;

export declare function sampleFromCell(cell: CollectedCell): LiveSample;

export declare function summarize(samples: LiveSample[]): LiveSummary;
