// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sendMessage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main>';
  sendMessage = vi.fn(async () => undefined);
  (globalThis as any).chrome = {
    storage: {
      local: { get: vi.fn(async () => ({ settings: { threshold: 0.7 } })), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
    runtime: { sendMessage },
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).chrome;
});

describe('popup (dev) threshold slider', () => {
  it('is not snapped back by the status refresh while the user is on it', async () => {
    await import('../../extension/src/popup/popup');
    await vi.advanceTimersByTimeAsync(0);
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    const label = range.previousElementSibling!.querySelector('.value')!;
    expect(range.value).toBe('0.7');
    range.focus();
    range.value = '0.85';
    range.dispatchEvent(new Event('input'));
    expect(label.textContent).toBe('0.85 (Conservative)');
    const calls = sendMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000); // status refresh → render
    expect(sendMessage.mock.calls.length).toBeGreaterThan(calls);
    expect(range.value).toBe('0.85');
    expect(label.textContent).toBe('0.85 (Conservative)');
    range.blur();
    await vi.advanceTimersByTimeAsync(2000);
    expect(range.value).toBe('0.7'); // the stored value again once the user left it (nothing was saved)
  });
});
