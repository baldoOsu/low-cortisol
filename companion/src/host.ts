// Native Messaging host loop: decode request frames, dispatch concurrently, write response frames. Spec §5
// The output stream carries frames only; every byte written here is a complete frame.

import { MAX_VISION_ITEMS, type HostRequest, type HostRequestType, type HostResponse, type TranscribeOutput, type TranscribeItem } from '../../shared/protocol';
import type { JevResult, JevState, TranscriptModel } from '../../shared/types';
import { encodeFrame, FrameDecoder, FrameTooLargeError } from './framing';
import { HostError, type CompanionConfig, type Logger } from './types';

export interface HostDeps {
  version: string;
  cfg: CompanionConfig;
  log: Logger;
  classify(state: JevState): Promise<JevResult>;
  transcribe(items: TranscribeItem[], model: TranscriptModel): Promise<TranscribeOutput>;
}

const REQUEST_TYPES: readonly HostRequestType[] = ['hello', 'classify', 'transcribe'];
const TRANSCRIPT_MODELS: readonly TranscriptModel[] = ['claude-opus-5-5', 'claude-sonnet-5-5'];

/** Runs at most `max` tasks at once; the rest wait in FIFO order. */
export class Limiter {
  private readonly max: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max) || 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // the slot is handed over, not re-counted
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(message: string): HostError {
  return new HostError('BAD_REQUEST', message);
}

/** Checks the shape the host relies on; messages never echo request values. */
export function validateRequest(raw: unknown): HostRequest {
  if (!isObject(raw)) throw bad('request must be a JSON object');
  if (typeof raw.id !== 'string' || !raw.id) throw bad('request id must be a non-empty string');
  if (!REQUEST_TYPES.includes(raw.type as HostRequestType)) throw bad('unknown request type');
  if (raw.type === 'classify') {
    if (!isObject(raw.state) || !isObject(raw.state.post)) throw bad('classify needs state.post');
  } else if (raw.type === 'transcribe') {
    if (!TRANSCRIPT_MODELS.includes(raw.model as TranscriptModel)) throw bad('unsupported transcript model');
    const items = raw.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_VISION_ITEMS) {
      throw bad(`transcribe needs 1-${MAX_VISION_ITEMS} items`);
    }
    items.forEach((it, i) => {
      if (!isObject(it) || typeof it.key !== 'string' || typeof it.mediaType !== 'string' || typeof it.dataBase64 !== 'string') {
        throw bad(`item ${i + 1} needs string key, mediaType and dataBase64`);
      }
    });
  }
  return raw as unknown as HostRequest;
}

function idOf(raw: unknown): string {
  return isObject(raw) && typeof raw.id === 'string' && raw.id ? raw.id : 'unknown';
}

function typeOf(raw: unknown): HostRequestType | 'unknown' {
  return isObject(raw) && REQUEST_TYPES.includes(raw.type as HostRequestType) ? (raw.type as HostRequestType) : 'unknown';
}

function errorResponse(id: string, type: HostRequestType | 'unknown', code: HostError['code'], message: string, status?: number): HostResponse {
  const error: { code: HostError['code']; message: string; status?: number } = { code, message };
  if (status !== undefined) error.status = status;
  return { id, ok: false, type, error };
}

/** Never throws: failures become ErrorResponse. Non-HostError details stay in the log. */
export async function handleRequest(raw: unknown, deps: HostDeps): Promise<HostResponse> {
  try {
    const req = validateRequest(raw);
    const { id } = req;
    switch (req.type) {
      case 'hello': {
        const { cfg } = deps;
        return {
          id,
          ok: true,
          type: 'hello',
          companionVersion: deps.version,
          jevConfigured: !!cfg.typesafeApiKey,
          claudeFound: !!cfg.claudePath,
          claudePath: cfg.claudePath,
        };
      }
      case 'classify':
        return { id, ok: true, type: 'classify', result: await deps.classify(req.state) };
      case 'transcribe':
        return { id, ok: true, type: 'transcribe', ...(await deps.transcribe(req.items, req.model)) };
    }
  } catch (err) {
    const id = idOf(raw);
    const type = typeOf(raw);
    if (err instanceof HostError) {
      deps.log.warn('host.request_failed', { id, type, code: err.code, status: err.status });
      return errorResponse(id, type, err.code, err.message, err.status);
    }
    deps.log.error('host.internal', { id, type, error: String((err as Error)?.stack ?? err) });
    return errorResponse(id, type, 'INTERNAL', 'internal error');
  }
}

/** Resolves after input ends (or an oversize header stops the reader) and every in-flight response is written. */
export function runHost(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, deps: HostDeps): Promise<void> {
  const { log } = deps;
  const jev = new Limiter(deps.cfg.jevConcurrency);
  const vision = new Limiter(deps.cfg.visionConcurrency);
  const limited: HostDeps = {
    ...deps,
    classify: (state) => jev.run(() => deps.classify(state)),
    transcribe: (items, model) => vision.run(() => deps.transcribe(items, model)),
  };

  const decoder = new FrameDecoder();
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    const settled = p.catch((err: unknown) => log.error('host.dispatch_failed', { error: String((err as Error)?.message ?? err) }));
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };

  const write = (frame: Buffer): void => {
    // The callback also fires (with an error) if the stream is closed, so this never hangs on a dead pipe.
    track(new Promise<void>((resolve) => void output.write(frame, () => resolve())));
  };

  const send = (res: HostResponse): void => {
    let frame: Buffer;
    try {
      frame = encodeFrame(res);
    } catch (err) {
      if (err instanceof FrameTooLargeError) {
        log.warn('host.response_too_large', { id: res.id, type: res.type, bytes: err.bytes });
        frame = encodeFrame(errorResponse(res.id, res.type, 'RESPONSE_TOO_LARGE', 'response exceeds 1 MiB'));
      } else {
        log.error('host.encode_failed', { id: res.id, type: res.type, error: String((err as Error)?.message ?? err) });
        frame = encodeFrame(errorResponse(res.id, res.type, 'INTERNAL', 'internal error'));
      }
    }
    write(frame);
  };

  output.on('error', (err: Error) => log.warn('host.output_error', { error: err.message }));

  return new Promise<void>((resolve) => {
    let stopped = false;

    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      input.removeListener('data', onData);
      input.pause();
      // Finished requests add their writes to `pending`, so drain until nothing new appears.
      while (pending.size) await Promise.all([...pending]);
      resolve();
    };

    const onData = (chunk: Buffer | string): void => {
      if (stopped) return;
      let frames;
      try {
        frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      } catch (err) {
        if (err instanceof FrameTooLargeError) {
          log.error('host.frame_too_large', { bytes: err.bytes });
          send(errorResponse('unknown', 'unknown', 'BAD_REQUEST', 'request frame exceeds 64 MiB'));
        } else {
          log.error('host.decode_failed', { error: String((err as Error)?.message ?? err) });
        }
        void stop();
        return;
      }
      for (const f of frames) {
        if (!f.ok) {
          log.warn('host.malformed_frame');
          send(errorResponse('unknown', 'unknown', 'BAD_REQUEST', 'malformed JSON frame'));
        } else {
          track(handleRequest(f.value, limited).then(send));
        }
      }
    };

    input.on('data', onData);
    input.on('end', () => void stop());
    input.on('close', () => void stop());
    input.on('error', (err: Error) => {
      log.warn('host.input_error', { error: err.message });
      void stop();
    });
  });
}
