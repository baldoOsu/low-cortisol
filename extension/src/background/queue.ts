// Concurrency and caching primitives for the service worker pipeline. Spec §4.2

/** Async semaphore: at most `max` `run` callbacks in flight; the rest wait FIFO. */
export class Semaphore {
  private readonly max: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    // Hand the slot straight to the next waiter; `running` stays the same.
    if (next) next();
    else this.running--;
  }
}

/** Map-backed LRU: `get` refreshes recency; `set` evicts the least recently used past `max`. */
export class LruCache<K, V> {
  private readonly max: number;
  private readonly map = new Map<K, V>();

  constructor(max: number) {
    this.max = max;
  }

  get size(): number {
    return this.map.size;
  }

  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k) as V;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

/** Dedupes concurrent work: callers with the same key share one promise until it settles. */
export class InFlight<K, V> {
  private readonly map = new Map<K, Promise<V>>();

  run(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.map.get(key);
    if (existing) return existing;
    // Deferred start so a synchronous throw can't settle before the entry is stored.
    const p: Promise<V> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.map.get(key) === p) this.map.delete(key);
      });
    this.map.set(key, p);
    return p;
  }
}
