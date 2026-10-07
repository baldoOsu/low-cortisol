// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe (fd 3 = to Chrome, fd 4 = from Chrome, NUL-terminated JSON).
import { spawn } from 'node:child_process';

export async function launchChromePipe({ chrome, userDataDir, extraArgs = [] }) {
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  child.stderr.resume(); // Chrome is chatty on stderr; drain it so it never blocks.

  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();

  const rejectAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  const dispatch = (msg) => {
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message} (${msg.error.code})`));
      else entry.resolve(msg.result ?? {});
      return;
    }
    for (const cb of listeners.get(msg.method) ?? []) cb(msg.params ?? {}, msg.sessionId);
  };

  let buffer = Buffer.alloc(0);
  fromChrome.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      const raw = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      dispatch(msg);
    }
  });
  fromChrome.on('error', () => {});
  toChrome.on('error', () => {});

  const exited = new Promise((resolve) => child.once('exit', resolve));
  const spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  exited.then(() => {
    closed = true;
    rejectAll(new Error('Chrome exited'));
  });
  await spawned;

  function send(method, params = {}, sessionId) {
    if (closed) return Promise.reject(new Error(`${method}: Chrome is not running`));
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      toChrome.write(JSON.stringify(msg) + '\0');
    });
  }

  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
  }

  async function close() {
    if (closed) return;
    send('Browser.close').catch(() => {});
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }

  return { send, on, close };
}
