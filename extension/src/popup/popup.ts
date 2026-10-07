// Popup DOM wiring: reads storage + SW status, renders the view-model, writes settings back. Spec §4.3
// All text goes through textContent.

import { hiddenCountFrom } from '../../../shared/day';
import type { FeedbackEntry, GetStatusMsg, StatusSnapshot } from '../../../shared/protocol';
import { STORAGE_KEYS } from '../../../shared/protocol';
import { clampThreshold, effectiveSettings, THRESHOLD_MAX, THRESHOLD_MIN, THRESHOLD_STEP } from '../../../shared/settings';
import type { Settings } from '../../../shared/types';
import { buildPopupModel, feedbackFilename, feedbackToJsonl, type PopupModel, thresholdText } from './view';

type BoolField = 'hideEnabled' | 'showResults' | 'visionEnabled' | 'showTranscript' | 'showStatus';

const STATUS_REFRESH_MS = 2000;
const flavor = __FLAVOR__;

let storedSettings: unknown;
let stats: unknown;
let feedback: FeedbackEntry[] = [];
let status: StatusSnapshot | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function writeSettings(field: keyof Settings, value: Settings[keyof Settings]): void {
  const base = storedSettings && typeof storedSettings === 'object' ? storedSettings : {};
  void chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...base, [field]: value } });
}

function makeSwitch(label: string, field: BoolField): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = el('label', 'switch');
  const input = el('input');
  input.type = 'checkbox';
  input.addEventListener('change', () => writeSettings(field, input.checked));
  root.append(input, el('span', 'track'), el('span', 'switch-label', label));
  return { root, input };
}

// ---- Static structure (built once; render() only updates values so controls keep focus) ----

const app = document.getElementById('app')!;
const title = el('h1');
const warning = el('p', 'warning');
const hide = makeSwitch('Hide ragebait', 'hideEnabled');
const hiddenToday = el('p', 'hidden-today');
app.append(title, warning, hide.root, hiddenToday);

interface DevView {
  toggles: Array<{ field: Exclude<BoolField, 'hideEnabled'>; input: HTMLInputElement }>;
  range: HTMLInputElement;
  rangeText: HTMLSpanElement;
  presets: HTMLButtonElement[];
  model: HTMLSelectElement;
  status: HTMLPreElement;
  feedbackCount: HTMLSpanElement;
  exportBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
}

function buildDev(initial: NonNullable<PopupModel['dev']>): DevView {
  const section = el('section', 'dev');
  const toggles = (
    [
      ['Show classifier results', 'showResults'],
      ['Vision (image transcripts)', 'visionEnabled'],
      ['Show transcript', 'showTranscript'],
      ['Show status', 'showStatus'],
    ] as const
  ).map(([label, field]) => {
    const s = makeSwitch(label, field);
    section.append(s.root);
    return { field, input: s.input };
  });

  const strictness = el('div', 'field');
  const head = el('div', 'field-head');
  const rangeText = el('span', 'value');
  head.append(el('span', undefined, 'Strictness'), rangeText);
  const range = el('input');
  range.type = 'range';
  range.min = String(THRESHOLD_MIN);
  range.max = String(THRESHOLD_MAX);
  range.step = String(THRESHOLD_STEP);
  range.addEventListener('input', () => (rangeText.textContent = thresholdText(clampThreshold(Number(range.value)))));
  range.addEventListener('change', () => writeSettings('threshold', clampThreshold(Number(range.value))));
  const presetRow = el('div', 'presets');
  const presets = initial.presets.map((p) => {
    const b = el('button', undefined, p.name);
    b.type = 'button';
    b.dataset.value = String(p.value);
    b.addEventListener('click', () => writeSettings('threshold', p.value));
    presetRow.append(b);
    return b;
  });
  strictness.append(head, range, presetRow);

  const modelField = el('label', 'field');
  const model = el('select');
  for (const m of initial.models) {
    const o = el('option', undefined, m.label);
    o.value = m.id;
    model.append(o);
  }
  model.addEventListener('change', () => {
    const picked = initial.models.find((m) => m.id === model.value);
    if (picked) writeSettings('transcriptModel', picked.id);
  });
  modelField.append(el('span', undefined, 'Transcript model'), model);

  const statusPre = el('pre', 'status');

  const fb = el('div', 'feedback');
  const feedbackCount = el('span');
  const exportBtn = el('button', undefined, 'Export JSONL');
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', exportFeedback);
  const clearBtn = el('button', undefined, 'Clear');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => {
    if (confirm(`Delete ${feedback.length} feedback entries?`)) void chrome.storage.local.set({ [STORAGE_KEYS.feedback]: [] });
  });
  fb.append(feedbackCount, exportBtn, clearBtn);

  section.append(strictness, modelField, statusPre, fb);
  app.append(section);
  return { toggles, range, rangeText, presets, model, status: statusPre, feedbackCount, exportBtn, clearBtn };
}

function exportFeedback(): void {
  const blob = new Blob([feedbackToJsonl(feedback)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = feedbackFilename(new Date());
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let devView: DevView | undefined;

function render(): void {
  const m = buildPopupModel({
    flavor,
    settings: effectiveSettings(storedSettings, flavor),
    status,
    hiddenToday: hiddenCountFrom(stats, new Date()),
    feedbackCount: feedback.length,
  });
  document.title = m.title;
  title.textContent = m.title;
  warning.textContent = m.offlineWarning ?? '';
  warning.hidden = !m.offlineWarning;
  hide.input.checked = m.hideEnabled;
  hiddenToday.textContent = m.hiddenTodayText;

  const dev = m.dev;
  if (!dev) return;
  devView ??= buildDev(dev);
  const v = devView;
  for (const t of v.toggles) t.input.checked = dev[t.field];
  // Leave the slider alone while the user is on it: the 2 s status refresh would snap it back mid-drag.
  if (document.activeElement !== v.range) {
    v.range.value = String(dev.threshold);
    v.rangeText.textContent = dev.thresholdText;
  }
  for (const b of v.presets) b.classList.toggle('active', Number(b.dataset.value) === dev.threshold);
  v.model.value = dev.transcriptModel;
  v.status.textContent = dev.statusLines.join('\n');
  v.feedbackCount.textContent = `${dev.feedbackCount} feedback ${dev.feedbackCount === 1 ? 'entry' : 'entries'}`;
  v.exportBtn.disabled = dev.feedbackCount === 0;
  v.clearBtn.disabled = dev.feedbackCount === 0;
}

function applyStorage(r: Record<string, unknown>): void {
  if (STORAGE_KEYS.settings in r) storedSettings = r[STORAGE_KEYS.settings];
  if (STORAGE_KEYS.stats in r) stats = r[STORAGE_KEYS.stats];
  if (STORAGE_KEYS.feedback in r) {
    const f = r[STORAGE_KEYS.feedback];
    feedback = Array.isArray(f) ? (f as FeedbackEntry[]) : [];
  }
}

async function refreshStatus(): Promise<void> {
  try {
    const msg: GetStatusMsg = { type: 'getStatus' };
    status = (await chrome.runtime.sendMessage(msg)) as StatusSnapshot | undefined;
  } catch {
    status = undefined;
  }
  render();
}

async function init(): Promise<void> {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const r: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(changes)) r[k] = c.newValue;
    applyStorage(r);
    render();
  });
  const r = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.stats, STORAGE_KEYS.feedback]);
  applyStorage({ [STORAGE_KEYS.settings]: undefined, [STORAGE_KEYS.stats]: undefined, [STORAGE_KEYS.feedback]: [], ...r });
  render();
  await refreshStatus();
  setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
}

void init();
