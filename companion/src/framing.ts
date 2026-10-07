// Chrome Native Messaging framing: 4-byte little-endian length + UTF-8 JSON. Spec §5

export const MAX_INBOUND_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOUND_BYTES = 1024 * 1024;

export class FrameTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`frame of ${bytes} bytes exceeds the limit`);
    this.name = 'FrameTooLargeError';
    this.bytes = bytes;
  }
}

/** Throws FrameTooLargeError if the JSON body exceeds MAX_OUTBOUND_BYTES. */
export function encodeFrame(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  if (json === undefined) throw new TypeError('message is not JSON-serializable');
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_OUTBOUND_BYTES) throw new FrameTooLargeError(bytes);
  const buf = Buffer.allocUnsafe(4 + bytes);
  buf.writeUInt32LE(bytes, 0);
  buf.write(json, 4, 'utf8');
  return buf;
}

export type Decoded = { ok: true; value: unknown } | { ok: false; error: string };

export class FrameDecoder {
  // Chunks are queued and only joined when a frame is complete, so a large frame
  // arriving in many small chunks is copied O(n) rather than O(n²).
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly maxBytes = MAX_INBOUND_BYTES) {}

  /** Returns 0..n complete frames. A header above maxBytes resets the decoder and throws FrameTooLargeError. */
  push(chunk: Buffer): Decoded[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.total += chunk.length;
    }
    const out: Decoded[] = [];
    while (this.total >= 4) {
      const len = this.head(4).readUInt32LE(0);
      if (len > this.maxBytes) {
        this.chunks = [];
        this.total = 0;
        throw new FrameTooLargeError(len);
      }
      if (this.total < 4 + len) break;
      const body = this.head(4 + len).toString('utf8', 4, 4 + len);
      this.consume(4 + len);
      try {
        out.push({ ok: true, value: JSON.parse(body) });
      } catch {
        out.push({ ok: false, error: 'malformed JSON frame' });
      }
    }
    return out;
  }

  /** First queued buffer, joined with the rest if it holds fewer than n bytes (n <= total). */
  private head(n: number): Buffer {
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks, this.total)];
    return this.chunks[0];
  }

  private consume(n: number): void {
    const rest = this.chunks[0].subarray(n);
    if (rest.length) this.chunks[0] = rest;
    else this.chunks.shift();
    this.total -= n;
  }
}
