import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, redact } from '../../companion/src/log';

describe('log', () => {
  const SECRET = 'ts_live_abcdefghijklmnop';
  it('redact removes secrets and bearer tokens', () => {
    expect(redact(`key=${SECRET} again ${SECRET}`, [SECRET])).toBe('key=[redacted] again [redacted]');
    expect(redact('Authorization: Bearer abc.def-ghi', [])).toBe('Authorization: Bearer [redacted]');
    expect(redact('short', ['abc'])).toBe('short'); // secrets < 8 chars ignored
  });

  it('writes redacted JSON lines and rotates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-log-'));
    const file = join(dir, 'logs', 'companion.log');
    const log = createLogger({ file, secrets: [SECRET], maxBytes: 300 });
    log.info('jev.request', { status: 200, leaked: SECRET });
    const first = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(first[0]).toMatchObject({ level: 'info', event: 'jev.request', status: 200, leaked: '[redacted]' });
    for (let i = 0; i < 20; i++) log.warn('filler', { i, pad: 'x'.repeat(20) });
    expect(existsSync(file + '.1')).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
  });

  it('never throws on unwritable paths', () => {
    const log = createLogger({ file: join(tmpdir(), 'nul\u0000bad', 'x.log') });
    expect(() => log.error('x')).not.toThrow();
  });

  it('keeps ts/level/event authoritative, survives unserializable fields, never touches stdout/stderr', () => {
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    try {
      const file = join(mkdtempSync(join(tmpdir(), 'lc-log-')), 'c.log');
      const log = createLogger({ file, now: () => new Date('2026-09-30T12:00:00.000Z') });
      log.error('boom', { level: 'info', event: 'spoof', ts: 'x', auth: 'Bearer sk-live-123' });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      log.warn('circ', { circular, big: 1n });
      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines[0]).toEqual({ ts: '2026-09-30T12:00:00.000Z', level: 'error', event: 'boom', auth: 'Bearer [redacted]' });
      expect(lines[1]).toMatchObject({ ts: '2026-09-30T12:00:00.000Z', level: 'warn', event: 'circ' });
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('redacts the JSON-escaped form of a secret too', () => {
    const odd = 'abc"def\\ghij';
    const file = join(mkdtempSync(join(tmpdir(), 'lc-log-')), 'c.log');
    createLogger({ file, secrets: [odd] }).info('e', { v: odd });
    expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe('[redacted]');
  });
});
