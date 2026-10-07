import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameTooLargeError, MAX_OUTBOUND_BYTES } from '../../companion/src/framing';

describe('framing', () => {
  it('round-trips a message with a little-endian length prefix', () => {
    const buf = encodeFrame({ id: '1', type: 'hello', text: 'héllo 😡' });
    expect(buf.readUInt32LE(0)).toBe(buf.length - 4);
    const d = new FrameDecoder();
    expect(d.push(buf)).toEqual([{ ok: true, value: { id: '1', type: 'hello', text: 'héllo 😡' } }]);
  });

  it('handles frames split across chunks and several frames per chunk', () => {
    const a = encodeFrame({ n: 1 });
    const b = encodeFrame({ n: 2 });
    const all = Buffer.concat([a, b]);
    const d = new FrameDecoder();
    const out = [...d.push(all.subarray(0, 3)), ...d.push(all.subarray(3, a.length + 2)), ...d.push(all.subarray(a.length + 2))];
    expect(out).toEqual([{ ok: true, value: { n: 1 } }, { ok: true, value: { n: 2 } }]);
  });

  it('decoder survives malformed JSON and keeps decoding', () => {
    const bad = Buffer.from('{nope', 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(bad.length, 0);
    const d = new FrameDecoder();
    const out = d.push(Buffer.concat([hdr, bad, encodeFrame({ ok: 1 })]));
    expect(out[0].ok).toBe(false);
    expect(out[1]).toEqual({ ok: true, value: { ok: 1 } });
  });

  it('encodeFrame throws FrameTooLargeError over 1 MiB', () => {
    expect(() => encodeFrame({ s: 'x'.repeat(MAX_OUTBOUND_BYTES) })).toThrow(FrameTooLargeError);
  });

  it('decoder rejects a header above its max', () => {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(100, 0);
    expect(() => new FrameDecoder(10).push(hdr)).toThrow(FrameTooLargeError);
  });

  it('decodes byte-by-byte delivery and a large frame fed in small chunks', () => {
    const small = encodeFrame({ t: 'é😡' });
    const big = encodeFrame({ s: 'y'.repeat(200_000) });
    const all = Buffer.concat([small, big, small]);
    const d = new FrameDecoder();
    const out = [];
    for (let i = 0; i < small.length; i++) out.push(...d.push(all.subarray(i, i + 1)));
    for (let i = small.length; i < all.length; i += 997) out.push(...d.push(all.subarray(i, Math.min(i + 997, all.length))));
    expect(out).toEqual([
      { ok: true, value: { t: 'é😡' } },
      { ok: true, value: { s: 'y'.repeat(200_000) } },
      { ok: true, value: { t: 'é😡' } },
    ]);
  });

  it('FrameTooLargeError carries the byte count; encodeFrame accepts exactly the max', () => {
    const e = new FrameTooLargeError(123);
    expect(e.bytes).toBe(123);
    expect(e).toBeInstanceOf(Error);
    const exact = encodeFrame('x'.repeat(MAX_OUTBOUND_BYTES - 2)); // JSON adds two quote bytes
    expect(exact.readUInt32LE(0)).toBe(MAX_OUTBOUND_BYTES);
  });
});
