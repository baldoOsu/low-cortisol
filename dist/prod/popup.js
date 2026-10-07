"use strict";
(() => {
  // shared/day.ts
  function localDay(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function hiddenCountFrom(stats2, now) {
    const s = stats2;
    if (!s || typeof s !== "object" || s.day !== localDay(now) || !Array.isArray(s.hiddenIds)) return 0;
    return s.hiddenIds.length;
  }

  // shared/protocol.ts
  var STORAGE_KEYS = {
    settings: "settings",
    stats: "stats",
    feedback: "feedback"
  };

  // shared/settings.ts
  var THRESHOLD_MIN = 0.5;
  var THRESHOLD_MAX = 0.95;
  var THRESHOLD_STEP = 0.05;
  var THRESHOLD_PRESETS = {
    aggressive: 0.55,
    balanced: 0.7,
    conservative: 0.85
  };
  var TRANSCRIPT_MODELS = [
    { id: "claude-opus-5-5", label: "Opus 5.5 (default)" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" }
  ];
  var DEFAULT_TRANSCRIPT_MODEL = "claude-opus-5-5";
  var DEFAULT_SETTINGS = {
    prod: {
      hideEnabled: true,
      showResults: false,
      threshold: THRESHOLD_PRESETS.balanced,
      visionEnabled: true,
      transcriptModel: DEFAULT_TRANSCRIPT_MODEL,
      showTranscript: false,
      showStatus: false
    },
    dev: {
      // Dev starts in labeling mode: shows what it would hide without hiding.
      hideEnabled: false,
      showResults: true,
      threshold: THRESHOLD_PRESETS.balanced,
      visionEnabled: true,
      transcriptModel: DEFAULT_TRANSCRIPT_MODEL,
      showTranscript: true,
      showStatus: true
    }
  };
  function clampThreshold(n, fallback = THRESHOLD_PRESETS.balanced) {
    if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
    const clamped = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, n));
    return Math.round(clamped * 100) / 100;
  }
  function isTranscriptModel(v) {
    return TRANSCRIPT_MODELS.some((m) => m.id === v);
  }
  function bool(v, fallback) {
    return typeof v === "boolean" ? v : fallback;
  }
  function effectiveSettings(stored, flavor2) {
    const s = stored && typeof stored === "object" ? stored : {};
    const d = DEFAULT_SETTINGS[flavor2];
    if (flavor2 === "prod") {
      return { ...d, hideEnabled: bool(s.hideEnabled, d.hideEnabled) };
    }
    return {
      hideEnabled: bool(s.hideEnabled, d.hideEnabled),
      showResults: bool(s.showResults, d.showResults),
      threshold: clampThreshold(s.threshold, d.threshold),
      visionEnabled: bool(s.visionEnabled, d.visionEnabled),
      transcriptModel: isTranscriptModel(s.transcriptModel) ? s.transcriptModel : d.transcriptModel,
      showTranscript: bool(s.showTranscript, d.showTranscript),
      showStatus: bool(s.showStatus, d.showStatus)
    };
  }

  // extension/src/popup/view.ts
  var PRESETS = [
    { name: "Aggressive", value: THRESHOLD_PRESETS.aggressive },
    { name: "Balanced", value: THRESHOLD_PRESETS.balanced },
    { name: "Conservative", value: THRESHOLD_PRESETS.conservative }
  ];
  var OFFLINE_WARNING = "Companion offline: nothing is being filtered.";
  function thresholdText(t) {
    const text = t.toFixed(2);
    const preset = PRESETS.find((p) => p.value.toFixed(2) === text);
    return preset ? `${text} (${preset.name})` : text;
  }
  function statusLines(s) {
    if (!s) return ["Status: unavailable"];
    const lines = [`Companion: ${s.companion}${s.companionVersion ? " v" + s.companionVersion : ""}`];
    if (s.jevConfigured !== void 0) lines.push(`Jev key: ${s.jevConfigured ? "configured" : "missing"}`);
    if (s.claudeFound !== void 0) lines.push(`Claude CLI: ${s.claudeFound ? "found" : "not found"}`);
    lines.push(`Pending: text ${s.pending.text} \xB7 vision ${s.pending.vision}`);
    const { text, vision, full } = s.avgMs;
    const ms = (n) => n != null ? String(Math.round(n)) : "\u2013";
    const visionText = vision != null ? (vision / 1e3).toFixed(1) + " s" : "\u2013";
    lines.push(`Avg: text ${ms(text)} ms \xB7 vision ${visionText} \xB7 full ${ms(full)} ms`);
    const u = s.rateLimit?.fiveHourUtilization;
    if (u !== void 0) lines.push(`Claude 5h usage: ${Math.round(u * 100)}%`);
    const h = s.selectorHealth;
    if (h) lines.push(h.ok ? "Selectors: OK" : `Selectors: BROKEN (cells ${h.cells}, posts ${h.articles}, parsed ${h.parsed})`);
    if (s.lastError) lines.push(`Last error: ${s.lastError}`);
    return lines;
  }
  function buildPopupModel(i) {
    const { flavor: flavor2, settings: s, status: status2 } = i;
    const model = {
      flavor: flavor2,
      title: flavor2 === "dev" ? "Low Cortisol (Dev)" : "Low Cortisol",
      hideEnabled: s.hideEnabled,
      hiddenTodayText: `${i.hiddenToday} hidden today`
    };
    if (status2?.companion === "offline" && (s.hideEnabled || s.showResults)) model.offlineWarning = OFFLINE_WARNING;
    if (flavor2 === "dev") {
      model.dev = {
        showResults: s.showResults,
        threshold: s.threshold,
        thresholdText: thresholdText(s.threshold),
        visionEnabled: s.visionEnabled,
        transcriptModel: s.transcriptModel,
        showTranscript: s.showTranscript,
        showStatus: s.showStatus,
        models: TRANSCRIPT_MODELS,
        presets: PRESETS.map((p) => ({ ...p })),
        statusLines: statusLines(status2),
        feedbackCount: i.feedbackCount
      };
    }
    return model;
  }
  function feedbackToJsonl(entries) {
    return entries.map((e) => JSON.stringify(e) + "\n").join("");
  }
  function feedbackFilename(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `low-cortisol-feedback-${y}${m}${day}.jsonl`;
  }

  // extension/src/popup/popup.ts
  var STATUS_REFRESH_MS = 2e3;
  var flavor = "prod";
  var storedSettings;
  var stats;
  var feedback = [];
  var status;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function writeSettings(field, value) {
    const base = storedSettings && typeof storedSettings === "object" ? storedSettings : {};
    void chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...base, [field]: value } });
  }
  function makeSwitch(label, field) {
    const root = el("label", "switch");
    const input = el("input");
    input.type = "checkbox";
    input.addEventListener("change", () => writeSettings(field, input.checked));
    root.append(input, el("span", "track"), el("span", "switch-label", label));
    return { root, input };
  }
  var app = document.getElementById("app");
  var title = el("h1");
  var warning = el("p", "warning");
  var hide = makeSwitch("Hide ragebait", "hideEnabled");
  var hiddenToday = el("p", "hidden-today");
  app.append(title, warning, hide.root, hiddenToday);
  function buildDev(initial) {
    const section = el("section", "dev");
    const toggles = [
      ["Show classifier results", "showResults"],
      ["Vision (image transcripts)", "visionEnabled"],
      ["Show transcript", "showTranscript"],
      ["Show status", "showStatus"]
    ].map(([label, field]) => {
      const s = makeSwitch(label, field);
      section.append(s.root);
      return { field, input: s.input };
    });
    const strictness = el("div", "field");
    const head = el("div", "field-head");
    const rangeText = el("span", "value");
    head.append(el("span", void 0, "Strictness"), rangeText);
    const range = el("input");
    range.type = "range";
    range.min = String(THRESHOLD_MIN);
    range.max = String(THRESHOLD_MAX);
    range.step = String(THRESHOLD_STEP);
    range.addEventListener("input", () => rangeText.textContent = thresholdText(clampThreshold(Number(range.value))));
    range.addEventListener("change", () => writeSettings("threshold", clampThreshold(Number(range.value))));
    const presetRow = el("div", "presets");
    const presets = initial.presets.map((p) => {
      const b = el("button", void 0, p.name);
      b.type = "button";
      b.dataset.value = String(p.value);
      b.addEventListener("click", () => writeSettings("threshold", p.value));
      presetRow.append(b);
      return b;
    });
    strictness.append(head, range, presetRow);
    const modelField = el("label", "field");
    const model = el("select");
    for (const m of initial.models) {
      const o = el("option", void 0, m.label);
      o.value = m.id;
      model.append(o);
    }
    model.addEventListener("change", () => {
      const picked = initial.models.find((m) => m.id === model.value);
      if (picked) writeSettings("transcriptModel", picked.id);
    });
    modelField.append(el("span", void 0, "Transcript model"), model);
    const statusPre = el("pre", "status");
    const fb = el("div", "feedback");
    const feedbackCount = el("span");
    const exportBtn = el("button", void 0, "Export JSONL");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", exportFeedback);
    const clearBtn = el("button", void 0, "Clear");
    clearBtn.type = "button";
    clearBtn.addEventListener("click", () => {
      if (confirm(`Delete ${feedback.length} feedback entries?`)) void chrome.storage.local.set({ [STORAGE_KEYS.feedback]: [] });
    });
    fb.append(feedbackCount, exportBtn, clearBtn);
    section.append(strictness, modelField, statusPre, fb);
    app.append(section);
    return { toggles, range, rangeText, presets, model, status: statusPre, feedbackCount, exportBtn, clearBtn };
  }
  function exportFeedback() {
    const blob = new Blob([feedbackToJsonl(feedback)], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = feedbackFilename(/* @__PURE__ */ new Date());
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  var devView;
  function render() {
    const m = buildPopupModel({
      flavor,
      settings: effectiveSettings(storedSettings, flavor),
      status,
      hiddenToday: hiddenCountFrom(stats, /* @__PURE__ */ new Date()),
      feedbackCount: feedback.length
    });
    document.title = m.title;
    title.textContent = m.title;
    warning.textContent = m.offlineWarning ?? "";
    warning.hidden = !m.offlineWarning;
    hide.input.checked = m.hideEnabled;
    hiddenToday.textContent = m.hiddenTodayText;
    const dev = m.dev;
    if (!dev) return;
    devView ??= buildDev(dev);
    const v = devView;
    for (const t of v.toggles) t.input.checked = dev[t.field];
    if (document.activeElement !== v.range) {
      v.range.value = String(dev.threshold);
      v.rangeText.textContent = dev.thresholdText;
    }
    for (const b of v.presets) b.classList.toggle("active", Number(b.dataset.value) === dev.threshold);
    v.model.value = dev.transcriptModel;
    v.status.textContent = dev.statusLines.join("\n");
    v.feedbackCount.textContent = `${dev.feedbackCount} feedback ${dev.feedbackCount === 1 ? "entry" : "entries"}`;
    v.exportBtn.disabled = dev.feedbackCount === 0;
    v.clearBtn.disabled = dev.feedbackCount === 0;
  }
  function applyStorage(r) {
    if (STORAGE_KEYS.settings in r) storedSettings = r[STORAGE_KEYS.settings];
    if (STORAGE_KEYS.stats in r) stats = r[STORAGE_KEYS.stats];
    if (STORAGE_KEYS.feedback in r) {
      const f = r[STORAGE_KEYS.feedback];
      feedback = Array.isArray(f) ? f : [];
    }
  }
  async function refreshStatus() {
    try {
      const msg = { type: "getStatus" };
      status = await chrome.runtime.sendMessage(msg);
    } catch {
      status = void 0;
    }
    render();
  }
  async function init() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const r2 = {};
      for (const [k, c] of Object.entries(changes)) r2[k] = c.newValue;
      applyStorage(r2);
      render();
    });
    const r = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.stats, STORAGE_KEYS.feedback]);
    applyStorage({ [STORAGE_KEYS.settings]: void 0, [STORAGE_KEYS.stats]: void 0, [STORAGE_KEYS.feedback]: [], ...r });
    render();
    await refreshStatus();
    setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);
  }
  void init();
})();
