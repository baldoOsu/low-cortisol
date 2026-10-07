// Redacting JSON-lines file logger. Never writes to stdout/stderr (stdout carries frames only). Spec §5

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './types';

const MIN_SECRET_LENGTH = 8;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export function redact(text: string, secrets: string[]): string {
  let out = text;
  const usable = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  for (const s of usable) out = out.split(s).join('[redacted]');
  return out.replace(/Bearer\s+[^\s"']+/g, 'Bearer [redacted]');
}

type Level = 'info' | 'warn' | 'error';

function serialize(ts: string, level: Level, event: string, fields?: Record<string, unknown>): string {
  const head = { ts, level, event };
  try {
    // Fields cannot override ts/level/event, but those keys still come first.
    return JSON.stringify(Object.assign({}, head, fields, head));
  } catch {
    return JSON.stringify({ ...head, logError: 'unserializable fields' });
  }
}

export function createLogger(opts: { file: string; secrets?: string[]; maxBytes?: number; now?: () => Date }): Logger {
  const { file } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  // Secrets are also matched in their JSON-escaped form, since redaction runs over the serialized line.
  const secrets = (opts.secrets ?? []).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
  let dirReady = false;

  function write(level: Level, event: string, fields?: Record<string, unknown>): void {
    try {
      const line = redact(serialize(now().toISOString(), level, event, fields), secrets) + '\n';
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true });
        dirReady = true;
      }
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // no file yet
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, file + '.1');
      appendFileSync(file, line);
    } catch {
      dirReady = false; // logging must never crash the host; retry the mkdir next time
    }
  }

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
