// Native Messaging client for the companion: lazy connect, hello, id-matched requests, timeouts,
// fail-fast backoff after a disconnect. Spec §4.2

import type { CompanionStatus, HelloResponse, HostRequest, HostResponse, StatusSnapshot } from '../../../shared/protocol';
import type { ErrorInfo, Flavor } from '../../../shared/types';

export const TIMEOUTS = { hello: 5000, classify: 10000, transcribe: 120000 } as const;
export const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type HostCall = DistributiveOmit<HostRequest, 'id'>;

export class NativeCallError extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = 'NativeCallError';
    this.info = info;
  }
}

export interface PortLike {
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (m: any) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface NativeApi {
  /** Resolves only `ok:true` responses; rejects with NativeCallError. */
  request<R extends HostResponse = HostResponse>(call: HostCall, timeoutMs?: number): Promise<R>;
  getStatus(): Pick<StatusSnapshot, 'companion' | 'companionVersion' | 'jevConfigured' | 'claudeFound' | 'lastError'>;
}

export interface NativeClientOptions {
  connect: () => PortLike;
  flavor: Flavor;
  extVersion: string;
  lastError?: () => string | undefined;
  now?: () => number;
  onStatus?: (s: CompanionStatus) => void;
}

interface Pending {
  resolve: (r: HostResponse) => void;
  reject: (e: NativeCallError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const offline = (message: string) => new NativeCallError({ code: 'COMPANION_OFFLINE', message });

export class NativeClient implements NativeApi {
  private readonly o: NativeClientOptions;
  private readonly now: () => number;
  private port?: PortLike;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private status: CompanionStatus = 'connecting';
  private companionVersion?: string;
  private jevConfigured?: boolean;
  private claudeFound?: boolean;
  private lastError?: string;
  private failures = 0;
  private retryAt = 0;

  constructor(o: NativeClientOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  getStatus() {
    return {
      companion: this.status,
      companionVersion: this.companionVersion,
      jevConfigured: this.jevConfigured,
      claudeFound: this.claudeFound,
      lastError: this.lastError,
    };
  }

  request<R extends HostResponse = HostResponse>(call: HostCall, timeoutMs: number = TIMEOUTS[call.type]): Promise<R> {
    if (!this.port) {
      if (this.now() < this.retryAt) return Promise.reject(offline(this.lastError ?? 'companion offline'));
      this.open();
      if (!this.port) return Promise.reject(offline(this.lastError ?? 'companion offline'));
    }
    return this.send(this.port, call, timeoutMs) as Promise<R>;
  }

  private open(): void {
    this.setStatus('connecting');
    let port: PortLike;
    try {
      port = this.o.connect();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    this.port = port;
    port.onMessage.addListener((m) => {
      if (this.port === port) this.onMessage(m);
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.fail(this.o.lastError?.() ?? 'disconnected');
    });
    this.send(port, { type: 'hello', flavor: this.o.flavor, extVersion: this.o.extVersion }, TIMEOUTS.hello).then(
      (r) => {
        if (this.port !== port) return;
        const h = r as HelloResponse;
        this.companionVersion = h.companionVersion;
        this.jevConfigured = h.jevConfigured;
        this.claudeFound = h.claudeFound;
        this.lastError = undefined;
        this.failures = 0;
        this.setStatus('online');
      },
      (e: NativeCallError) => {
        // A disconnect has already been handled by onDisconnect; a timeout or error reply means the
        // companion is unusable, so drop it and back off like a disconnect.
        if (this.port !== port) return;
        try {
          port.disconnect();
        } catch {
          // Already dead.
        }
        this.fail(e.info.message);
      },
    );
  }

  private send(port: PortLike, call: HostCall, timeoutMs: number): Promise<HostResponse> {
    const id = String(++this.seq);
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeCallError({ code: 'COMPANION_TIMEOUT', message: `${call.type} timed out after ${timeoutMs} ms` }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ ...call, id });
      } catch (e) {
        // Posting to a port that died before onDisconnect fired.
        if (this.port === port) this.fail(e instanceof Error ? e.message : String(e));
      }
    });
  }

  private onMessage(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const r = m as HostResponse;
    const p = this.pending.get(r.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(r.id);
    if (r.ok === true) p.resolve(r);
    else p.reject(new NativeCallError(r.error ?? { code: 'INTERNAL', message: 'malformed companion response' }));
  }

  /** Port is gone: go offline, reject everything pending, schedule the earliest reconnect. */
  private fail(message: string): void {
    this.port = undefined;
    this.lastError = message;
    this.failures++;
    this.retryAt = this.now() + BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(offline(message));
    }
    this.setStatus('offline');
  }

  private setStatus(s: CompanionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus?.(s);
  }
}
