// Persistent namespaced file cache with TTL: <dir>/<ns>/<sha256(key)>.json. Spec §5

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KVCache } from './types';

const DAY_MS = 86_400_000;
const NAMESPACE = /^[A-Za-z0-9_-]+$/;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface Entry {
  createdAt: number;
  value: unknown;
}

function parseEntry(text: string): Entry | undefined {
  try {
    const e = JSON.parse(text) as Partial<Entry> | null;
    return e && typeof e === 'object' && typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? (e as Entry) : undefined;
  } catch {
    return undefined;
  }
}

export class FileCache implements KVCache {
  private readonly ttlMs: number;

  constructor(
    private readonly dir: string,
    ttlDays: number,
    private readonly now: () => number = Date.now,
  ) {
    this.ttlMs = ttlDays * DAY_MS;
  }

  private fileFor(ns: string, key: string): string | undefined {
    return NAMESPACE.test(ns) ? join(this.dir, ns, `${sha256Hex(key)}.json`) : undefined;
  }

  private expired(e: Entry): boolean {
    return this.now() - e.createdAt > this.ttlMs;
  }

  async get<T>(ns: string, key: string): Promise<T | undefined> {
    const file = this.fileFor(ns, key);
    if (!file) return undefined;
    try {
      const e = parseEntry(await readFile(file, 'utf8'));
      return e && !this.expired(e) ? (e.value as T) : undefined;
    } catch {
      return undefined;
    }
  }

  async set<T>(ns: string, key: string, value: T): Promise<void> {
    const file = this.fileFor(ns, key);
    if (!file) return;
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await mkdir(join(this.dir, ns), { recursive: true });
      await writeFile(tmp, JSON.stringify({ createdAt: this.now(), value }), 'utf8');
      await rename(tmp, file);
    } catch {
      await unlink(tmp).catch(() => undefined);
    }
  }

  /** Deletes expired or unparsable entries; returns how many were removed. */
  async sweep(): Promise<number> {
    let removed = 0;
    let namespaces: string[];
    try {
      namespaces = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const ns of namespaces) {
      if (!NAMESPACE.test(ns)) continue;
      let names: string[];
      try {
        names = await readdir(join(this.dir, ns));
      } catch {
        continue; // not a directory
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = join(this.dir, ns, name);
        try {
          const e = parseEntry(await readFile(file, 'utf8'));
          if (e && !this.expired(e)) continue;
          await unlink(file);
          removed++;
        } catch {
          // concurrently removed or unreadable: skip
        }
      }
    }
    return removed;
  }
}
