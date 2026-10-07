// Service worker entry: chrome.* wiring only. Logic lives in native/pipeline/store (unit-tested).

import {
  HOST_NAME,
  PORT_NAME,
  STORAGE_KEYS,
  type ContentToSw,
  type HealthMsg,
  type ResultMsg,
  type StatusSnapshot,
} from '../../../shared/protocol';
import { effectiveSettings, isClassificationActive } from '../../../shared/settings';
import type { RateLimitInfo, Settings } from '../../../shared/types';
import { NativeClient } from './native';
import { createPipelineDeps, processPost, type PipelineStats } from './pipeline';
import { appendFeedback, recordHidden } from './store';

const flavor = __FLAVOR__;
const noop = () => {};

// ---- Settings ----

let settings: Settings = effectiveSettings(undefined, flavor);
const settingsReady = chrome.storage.local
  .get(STORAGE_KEYS.settings)
  .then((r) => {
    settings = effectiveSettings(r[STORAGE_KEYS.settings], flavor);
  })
  .catch(noop)
  .finally(updateBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(STORAGE_KEYS.settings in changes)) return;
  settings = effectiveSettings(changes[STORAGE_KEYS.settings].newValue, flavor);
  updateBadge();
});

// ---- Companion ----

const native = new NativeClient({
  connect: () => chrome.runtime.connectNative(HOST_NAME),
  flavor,
  extVersion: chrome.runtime.getManifest().version,
  lastError: () => chrome.runtime.lastError?.message,
  onStatus: updateBadge,
});

function updateBadge(): void {
  const alarm = native.getStatus().companion === 'offline' && isClassificationActive(settings);
  if (alarm) {
    chrome.action.setBadgeText({ text: '!' }).catch(noop);
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(noop);
    chrome.action.setTitle({ title: 'Low Cortisol: companion offline, nothing is filtered' }).catch(noop);
  } else {
    chrome.action.setBadgeText({ text: '' }).catch(noop);
    chrome.action.setTitle({ title: flavor === 'dev' ? 'Low Cortisol (Dev)' : 'Low Cortisol' }).catch(noop);
  }
}

// ---- Stats ----

type Kind = 'text' | 'vision' | 'full';
const SAMPLES = 50;
const samples: Record<Kind, number[]> = { text: [], vision: [], full: [] };
let rateLimit: RateLimitInfo | undefined;
let selectorHealth: Omit<HealthMsg, 'type'> | undefined;

const stats: PipelineStats = {
  pending: { text: 0, vision: 0 },
  record(kind, ms) {
    const a = samples[kind];
    a.push(ms);
    if (a.length > SAMPLES) a.shift();
  },
  setRateLimit(r) {
    // Fully cached transcribes report no rate limit; keep the last known one.
    if (r) rateLimit = r;
  },
};

function avg(kind: Kind): number | undefined {
  const a = samples[kind];
  return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : undefined;
}

const deps = createPipelineDeps(native, () => settings, stats);

// ---- Content ports ----

function safePost(port: chrome.runtime.Port, r: ResultMsg): void {
  try {
    port.postMessage(r);
  } catch {
    // The tab went away; it re-sends unresolved posts when it reconnects.
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener((msg: ContentToSw) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'post':
        void settingsReady.then(() => {
          if (isClassificationActive(settings)) return processPost(msg, (r) => safePost(port, r), deps);
        });
        break;
      case 'hidden':
        recordHidden(chrome.storage.local, msg.postId).catch(noop);
        break;
      case 'feedback':
        appendFeedback(chrome.storage.local, msg.entry).catch(noop);
        break;
      case 'health':
        selectorHealth = { ok: msg.ok, cells: msg.cells, articles: msg.articles, parsed: msg.parsed };
        break;
    }
  });
});

// ---- Popup ----

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if ((msg as { type?: unknown } | null)?.type !== 'getStatus') return;
  const status: StatusSnapshot = {
    ...native.getStatus(),
    pending: { ...stats.pending },
    avgMs: { text: avg('text'), vision: avg('vision'), full: avg('full') },
    rateLimit,
    selectorHealth,
  };
  sendResponse(status);
});
