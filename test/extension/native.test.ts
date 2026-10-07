import { describe, expect, it, vi } from 'vitest';
import { BACKOFF_MS, NativeClient, type PortLike } from '../../extension/src/background/native';

function fakePort(respond: (m: any, port: ReturnType<typeof fakePort>) => void) {
  const msgL: Array<(m: any) => void> = [];
  const discL: Array<() => void> = [];
  const port = {
    sent: [] as any[],
    postMessage(m: any) { port.sent.push(m); queueMicrotask(() => respond(m, port)); },
    disconnect: vi.fn(),
    onMessage: { addListener: (cb: any) => msgL.push(cb) },
    onDisconnect: { addListener: (cb: any) => discL.push(cb) },
    reply: (m: any) => msgL.forEach((cb) => cb(m)),
    drop: () => discL.forEach((cb) => cb()),
  };
  return port;
}
const hello = (m: any) => ({ id: m.id, ok: true, type: 'hello', companionVersion: '0.1.0', jevConfigured: true, claudeFound: true });

describe('NativeClient', () => {
  it('connects lazily, says hello, then serves requests', async () => {
    const port = fakePort((m, p) => p.reply(m.type === 'hello' ? hello(m) : { id: m.id, ok: true, type: 'classify', result: { model: 'jev-1.13.0' } }));
    const connect = vi.fn(() => port as unknown as PortLike);
    const c = new NativeClient({ connect, flavor: 'dev', extVersion: '0.1.0' });
    expect(connect).not.toHaveBeenCalled();
    const r: any = await c.request({ type: 'classify', state: { post: { author: 'a', text: 't' }, media_status: 'none' } });
    expect(r.result.model).toBe('jev-1.13.0');
    expect(port.sent[0]).toMatchObject({ type: 'hello', flavor: 'dev', extVersion: '0.1.0' });
    await Promise.resolve();
    expect(c.getStatus()).toMatchObject({ companion: 'online', jevConfigured: true, claudeFound: true });
  });

  it('rejects ok:false with the error info', async () => {
    const port = fakePort((m, p) => p.reply(m.type === 'hello' ? hello(m) : { id: m.id, ok: false, type: 'classify', error: { code: 'NO_API_KEY', message: 'no key' } }));
    const c = new NativeClient({ connect: () => port as any, flavor: 'prod', extVersion: '0.1.0' });
    await expect(c.request({ type: 'classify', state: {} as any })).rejects.toMatchObject({ info: { code: 'NO_API_KEY' } });
  });

  it('goes offline on disconnect, rejects pending, and backs off without reconnecting', async () => {
    let now = 0;
    const port = fakePort((m, p) => { if (m.type !== 'hello') p.drop(); });
    const connect = vi.fn(() => port as any);
    const c = new NativeClient({ connect, flavor: 'dev', extVersion: '0.1.0', now: () => now, lastError: () => 'Specified native messaging host not found.' });
    await expect(c.request({ type: 'classify', state: {} as any })).rejects.toMatchObject({ info: { code: 'COMPANION_OFFLINE' } });
    expect(c.getStatus()).toMatchObject({ companion: 'offline', lastError: 'Specified native messaging host not found.' });
    await expect(c.request({ type: 'classify', state: {} as any })).rejects.toMatchObject({ info: { code: 'COMPANION_OFFLINE' } });
    expect(connect).toHaveBeenCalledTimes(1);
    now += BACKOFF_MS[0] + 1;
    c.request({ type: 'classify', state: {} as any }).catch(() => {});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('times out a silent request', async () => {
    vi.useFakeTimers();
    const port = fakePort((m, p) => { if (m.type === 'hello') p.reply(hello(m)); });
    const c = new NativeClient({ connect: () => port as any, flavor: 'dev', extVersion: '0.1.0' });
    const p = c.request({ type: 'classify', state: {} as any }, 50);
    vi.advanceTimersByTime(60);
    await expect(p).rejects.toMatchObject({ info: { code: 'COMPANION_TIMEOUT' } });
    vi.useRealTimers();
  });

  it('backs off progressively, reports status changes, and a good hello resets the backoff', async () => {
    let now = 0;
    let up = false;
    const port = fakePort((m, p) => { if (up) p.reply(m.type === 'hello' ? hello(m) : { id: m.id, ok: true, type: 'classify', result: {} }); else p.drop(); });
    const statuses: string[] = [];
    const connect = vi.fn(() => port as any);
    const c = new NativeClient({ connect, flavor: 'dev', extVersion: '0.1.0', now: () => now, onStatus: (s) => statuses.push(s) });
    await expect(c.request({ type: 'classify', state: {} as any })).rejects.toMatchObject({ info: { code: 'COMPANION_OFFLINE' } });
    expect(c.getStatus().lastError).toBe('disconnected');
    now += BACKOFF_MS[0];
    await expect(c.request({ type: 'classify', state: {} as any })).rejects.toMatchObject({ info: { code: 'COMPANION_OFFLINE' } });
    now += BACKOFF_MS[1] - 1;
    await expect(c.request({ type: 'classify', state: {} as any })).rejects.toMatchObject({ info: { code: 'COMPANION_OFFLINE' } });
    expect(connect).toHaveBeenCalledTimes(2);
    now += 1;
    up = true;
    await c.request({ type: 'classify', state: {} as any });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual(['offline', 'connecting', 'offline', 'connecting', 'online']);
    expect(c.getStatus()).toMatchObject({ companion: 'online', lastError: undefined });
    up = false;
    port.drop();
    now += BACKOFF_MS[0];
    c.request({ type: 'classify', state: {} as any }).catch(() => {});
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it('ignores events from a stale port after reconnecting', async () => {
    let now = 0;
    const old = fakePort(() => {});
    const fresh = fakePort((m, p) => p.reply(m.type === 'hello' ? hello(m) : { id: m.id, ok: true, type: 'classify', result: { model: 'new' } }));
    const ports = [old, fresh];
    const c = new NativeClient({ connect: () => ports.shift() as any, flavor: 'dev', extVersion: '0.1.0', now: () => now });
    const first = c.request({ type: 'classify', state: {} as any });
    old.drop();
    await expect(first).rejects.toMatchObject({ info: { code: 'COMPANION_OFFLINE' } });
    now += BACKOFF_MS[0];
    const second = c.request({ type: 'classify', state: {} as any });
    old.drop();
    old.reply({ id: '4', ok: false, type: 'classify', error: { code: 'INTERNAL', message: 'stale' } });
    await expect(second).resolves.toMatchObject({ result: { model: 'new' } });
    expect(c.getStatus().companion).toBe('online');
  });
});
