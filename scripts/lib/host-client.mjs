// Test harness for the built companion: spawns dist/companion/host.cjs and talks Native Messaging framing to it.
// Used by the smoke scripts. Never prints env values.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'companion', 'host.cjs');
const MAX_REPLY_BYTES = 1024 * 1024;

export function encodeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

export function describeError(r) {
  const e = r.error ?? {};
  return `error ${e.code}${e.status !== undefined ? ` ${e.status}` : ''}: ${e.message}`;
}

/** Spawns the host with a throwaway home; request(msg, timeoutMs) resolves with the reply of the same id. */
export function startHost() {
  const home = mkdtempSync(join(tmpdir(), 'lc-smoke-'));
  const child = spawn(process.execPath, [HOST, 'chrome-extension://smoke/'], {
    env: { ...process.env, LOW_CORTISOL_HOME: home },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const waiting = new Map();
  let buf = Buffer.alloc(0);
  let dead;
  const fail = (err) => {
    dead ??= err;
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };

  /** Next complete reply from buf, undefined if incomplete; throws on anything that isn't valid framing. */
  const nextReply = () => {
    if (buf.length < 4) return undefined;
    const len = buf.readUInt32LE(0);
    if (len > MAX_REPLY_BYTES) throw new Error('oversize frame header');
    if (buf.length < 4 + len) return undefined;
    const msg = JSON.parse(buf.toString('utf8', 4, 4 + len));
    if (!msg || typeof msg !== 'object') throw new Error('frame is not a JSON object');
    buf = buf.subarray(4 + len);
    return msg;
  };

  child.stdout.on('data', (chunk) => {
    if (dead) return;
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      let msg;
      try {
        msg = nextReply();
      } catch {
        console.log('host stdout is not valid framing');
        fail(new Error('host output aborted (invalid framing)'));
        child.kill();
        return;
      }
      if (!msg) return;
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w.resolve(msg);
      } else {
        console.log(`unexpected reply id=${msg.id} ok=${msg.ok}`);
      }
    }
  });
  const exit = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', (err) => resolve(`spawn failed: ${err.code ?? err.message}`));
  });
  void exit.then((code) => fail(new Error(`host exited (${code})`)));
  child.stdin.on('error', () => undefined); // the exit handler reports a dead host
  let seq = 0;
  return {
    request(msg, timeoutMs) {
      const id = String(++seq);
      return new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`no reply to ${msg.type} within ${timeoutMs} ms`));
        }, timeoutMs);
        const settle = (fn) => (v) => {
          clearTimeout(timer);
          fn(v);
        };
        waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
        child.stdin.write(encodeFrame({ ...msg, id }));
      });
    },
    /** Ends stdin (killing the host if it doesn't exit within 5 s), deletes the temp home and returns the exit code. */
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      const code = await exit;
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      return code;
    },
  };
}
