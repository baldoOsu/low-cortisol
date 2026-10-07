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
  var flavor = "dev";
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc2hhcmVkL2RheS50cyIsICIuLi8uLi9zaGFyZWQvcHJvdG9jb2wudHMiLCAiLi4vLi4vc2hhcmVkL3NldHRpbmdzLnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvcG9wdXAvdmlldy50cyIsICIuLi8uLi9leHRlbnNpb24vc3JjL3BvcHVwL3BvcHVwLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBcIk4gaGlkZGVuIHRvZGF5XCIgYm9va2tlZXBpbmcgaGVscGVycyBzaGFyZWQgYnkgdGhlIHNlcnZpY2Ugd29ya2VyICh3cml0ZXIpIGFuZCBwb3B1cCAocmVhZGVyKS5cblxuaW1wb3J0IHR5cGUgeyBIaWRkZW5TdGF0cyB9IGZyb20gJy4vcHJvdG9jb2wnO1xuXG4vKiogTG9jYWwgY2FsZW5kYXIgZGF5IGFzIFwiWVlZWS1NTS1ERFwiLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2FsRGF5KGQ6IERhdGUpOiBzdHJpbmcge1xuICBjb25zdCB5ID0gZC5nZXRGdWxsWWVhcigpO1xuICBjb25zdCBtID0gU3RyaW5nKGQuZ2V0TW9udGgoKSArIDEpLnBhZFN0YXJ0KDIsICcwJyk7XG4gIGNvbnN0IGRheSA9IFN0cmluZyhkLmdldERhdGUoKSkucGFkU3RhcnQoMiwgJzAnKTtcbiAgcmV0dXJuIGAke3l9LSR7bX0tJHtkYXl9YDtcbn1cblxuLyoqIENvdW50IG9mIHBvc3RzIGhpZGRlbiB0b2RheSBmcm9tIHRoZSBzdG9yZWQgc3RhdHMgcmVjb3JkICgwIGlmIG1pc3NpbmcsIG1hbGZvcm1lZCBvciBmcm9tIGFub3RoZXIgZGF5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoaWRkZW5Db3VudEZyb20oc3RhdHM6IHVua25vd24sIG5vdzogRGF0ZSk6IG51bWJlciB7XG4gIGNvbnN0IHMgPSBzdGF0cyBhcyBQYXJ0aWFsPEhpZGRlblN0YXRzPiB8IHVuZGVmaW5lZDtcbiAgaWYgKCFzIHx8IHR5cGVvZiBzICE9PSAnb2JqZWN0JyB8fCBzLmRheSAhPT0gbG9jYWxEYXkobm93KSB8fCAhQXJyYXkuaXNBcnJheShzLmhpZGRlbklkcykpIHJldHVybiAwO1xuICByZXR1cm4gcy5oaWRkZW5JZHMubGVuZ3RoO1xufVxuIiwgIi8vIE1lc3NhZ2UgY29udHJhY3RzOiBleHRlbnNpb24gXHUyMTk0IGNvbXBhbmlvbiAoTmF0aXZlIE1lc3NhZ2luZyksIGNvbnRlbnQgXHUyMTk0IHNlcnZpY2Ugd29ya2VyLCBwb3B1cCBcdTIxOTQgU1cuXG4vLyBTcGVjOiBkb2NzL3N1cGVycG93ZXJzL3NwZWNzLzIwMjYtMDktMzAtbG93LWNvcnRpc29sLWRlc2lnbi5tZCBcdTAwQTc0LjIsIFx1MDBBNzVcblxuaW1wb3J0IHR5cGUge1xuICBFcnJvckluZm8sXG4gIEZsYXZvcixcbiAgSmV2QW5zd2VycyxcbiAgSmV2UmVzdWx0LFxuICBKZXZTdGF0ZSxcbiAgTWVkaWFLaW5kLFxuICBNZWRpYVRyYW5zY3JpcHQsXG4gIFBvc3RTbmFwc2hvdCxcbiAgUmF0ZUxpbWl0SW5mbyxcbiAgVHJhbnNjcmlwdE1vZGVsLFxuICBWaXNpb25TdGF0dXMsXG59IGZyb20gJy4vdHlwZXMnO1xuXG5leHBvcnQgY29uc3QgSE9TVF9OQU1FID0gJ2NvbS5sb3djb3J0aXNvbC5jb21wYW5pb24nO1xuZXhwb3J0IGNvbnN0IFBPUlRfTkFNRSA9ICdsYyc7XG5leHBvcnQgY29uc3QgTUFYX1ZJU0lPTl9JVEVNUyA9IDY7XG5cbmV4cG9ydCBjb25zdCBTVE9SQUdFX0tFWVMgPSB7XG4gIHNldHRpbmdzOiAnc2V0dGluZ3MnLFxuICBzdGF0czogJ3N0YXRzJyxcbiAgZmVlZGJhY2s6ICdmZWVkYmFjaycsXG59IGFzIGNvbnN0O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tIEV4dGVuc2lvbiBcdTIxOTQgY29tcGFuaW9uIC0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBUcmFuc2NyaWJlSXRlbSB7XG4gIGtleTogc3RyaW5nO1xuICBraW5kOiBNZWRpYUtpbmQ7XG4gIGluUXVvdGU6IGJvb2xlYW47XG4gIGFsdD86IHN0cmluZztcbiAgLyoqIGUuZy4gXCJpbWFnZS9qcGVnXCIgKi9cbiAgbWVkaWFUeXBlOiBzdHJpbmc7XG4gIGRhdGFCYXNlNjQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIZWxsb1JlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICB0eXBlOiAnaGVsbG8nO1xuICBmbGF2b3I6IEZsYXZvcjtcbiAgZXh0VmVyc2lvbjogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENsYXNzaWZ5UmVxdWVzdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHR5cGU6ICdjbGFzc2lmeSc7XG4gIHN0YXRlOiBKZXZTdGF0ZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmFuc2NyaWJlUmVxdWVzdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHR5cGU6ICd0cmFuc2NyaWJlJztcbiAgbW9kZWw6IFRyYW5zY3JpcHRNb2RlbDtcbiAgaXRlbXM6IFRyYW5zY3JpYmVJdGVtW107XG59XG5cbmV4cG9ydCB0eXBlIEhvc3RSZXF1ZXN0ID0gSGVsbG9SZXF1ZXN0IHwgQ2xhc3NpZnlSZXF1ZXN0IHwgVHJhbnNjcmliZVJlcXVlc3Q7XG5leHBvcnQgdHlwZSBIb3N0UmVxdWVzdFR5cGUgPSBIb3N0UmVxdWVzdFsndHlwZSddO1xuXG5leHBvcnQgaW50ZXJmYWNlIEhlbGxvUmVzcG9uc2Uge1xuICBpZDogc3RyaW5nO1xuICBvazogdHJ1ZTtcbiAgdHlwZTogJ2hlbGxvJztcbiAgY29tcGFuaW9uVmVyc2lvbjogc3RyaW5nO1xuICBqZXZDb25maWd1cmVkOiBib29sZWFuO1xuICBjbGF1ZGVGb3VuZDogYm9vbGVhbjtcbiAgY2xhdWRlUGF0aD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDbGFzc2lmeVJlc3BvbnNlIHtcbiAgaWQ6IHN0cmluZztcbiAgb2s6IHRydWU7XG4gIHR5cGU6ICdjbGFzc2lmeSc7XG4gIHJlc3VsdDogSmV2UmVzdWx0O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRyYW5zY3JpYmVPdXRwdXQge1xuICB0cmFuc2NyaXB0czogTWVkaWFUcmFuc2NyaXB0W107XG4gIGxhdGVuY3lNczogbnVtYmVyO1xuICAvKiogS2V5cyBzZXJ2ZWQgZnJvbSB0aGUgY29tcGFuaW9uIGNhY2hlIChubyBjbGF1ZGUgY2FsbCBuZWVkZWQgZm9yIHRoZW0pLiAqL1xuICBjYWNoZWRLZXlzOiBzdHJpbmdbXTtcbiAgcmF0ZUxpbWl0PzogUmF0ZUxpbWl0SW5mbztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmFuc2NyaWJlUmVzcG9uc2UgZXh0ZW5kcyBUcmFuc2NyaWJlT3V0cHV0IHtcbiAgaWQ6IHN0cmluZztcbiAgb2s6IHRydWU7XG4gIHR5cGU6ICd0cmFuc2NyaWJlJztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFcnJvclJlc3BvbnNlIHtcbiAgaWQ6IHN0cmluZztcbiAgb2s6IGZhbHNlO1xuICB0eXBlOiBIb3N0UmVxdWVzdFR5cGUgfCAndW5rbm93bic7XG4gIGVycm9yOiBFcnJvckluZm87XG59XG5cbmV4cG9ydCB0eXBlIEhvc3RSZXNwb25zZSA9IEhlbGxvUmVzcG9uc2UgfCBDbGFzc2lmeVJlc3BvbnNlIHwgVHJhbnNjcmliZVJlc3BvbnNlIHwgRXJyb3JSZXNwb25zZTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLSBDb250ZW50IHNjcmlwdCBcdTIxOTQgc2VydmljZSB3b3JrZXIgKHBvcnQgUE9SVF9OQU1FKSAtLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgUG9zdE1zZyB7XG4gIHR5cGU6ICdwb3N0JztcbiAgc25hcHNob3Q6IFBvc3RTbmFwc2hvdDtcbiAgLyoqIGhhc2g1MyhzdGFibGVTdHJpbmdpZnkoc25hcHNob3QpKTsgZWNob2VkIGJhY2sgaW4gcmVzdWx0cyBzbyBzdGFsZSByZXN1bHRzIGNhbiBiZSBpZ25vcmVkLiAqL1xuICBzbmFwSGFzaDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhpZGRlbk1zZyB7XG4gIHR5cGU6ICdoaWRkZW4nO1xuICBwb3N0SWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGZWVkYmFja01zZyB7XG4gIHR5cGU6ICdmZWVkYmFjayc7XG4gIGVudHJ5OiBGZWVkYmFja0VudHJ5O1xufVxuXG4vKiogU2VsZWN0b3IgaGVhbHRoIGZyb20gY2hlY2tIZWFsdGgoKTsgc2VudCBvbmx5IHdoZW4gYG9rYCBmbGlwcyAoc3BlYyBcdTAwQTc0LjEpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBIZWFsdGhNc2cge1xuICB0eXBlOiAnaGVhbHRoJztcbiAgb2s6IGJvb2xlYW47XG4gIGNlbGxzOiBudW1iZXI7XG4gIGFydGljbGVzOiBudW1iZXI7XG4gIHBhcnNlZDogbnVtYmVyO1xufVxuXG5leHBvcnQgdHlwZSBDb250ZW50VG9TdyA9IFBvc3RNc2cgfCBIaWRkZW5Nc2cgfCBGZWVkYmFja01zZyB8IEhlYWx0aE1zZztcblxuZXhwb3J0IGludGVyZmFjZSBSZXN1bHRUaW1pbmdzIHtcbiAgdGV4dE1zPzogbnVtYmVyO1xuICB2aXNpb25Ncz86IG51bWJlcjtcbiAgZnVsbE1zPzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlc3VsdE1zZyB7XG4gIHR5cGU6ICdyZXN1bHQnO1xuICBwb3N0SWQ6IHN0cmluZztcbiAgc25hcEhhc2g6IHN0cmluZztcbiAgc3RhZ2U6ICd0ZXh0JyB8ICdmdWxsJztcbiAgamV2PzogSmV2UmVzdWx0O1xuICB2aXNpb246IFZpc2lvblN0YXR1cztcbiAgdHJhbnNjcmlwdHM/OiBNZWRpYVRyYW5zY3JpcHRbXTtcbiAgZXJyb3I/OiBFcnJvckluZm87XG4gIHRpbWluZ3M6IFJlc3VsdFRpbWluZ3M7XG59XG5cbmV4cG9ydCB0eXBlIFN3VG9Db250ZW50ID0gUmVzdWx0TXNnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tIFBvcHVwIFx1MjE5NCBzZXJ2aWNlIHdvcmtlciAtLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgR2V0U3RhdHVzTXNnIHtcbiAgdHlwZTogJ2dldFN0YXR1cyc7XG59XG5cbmV4cG9ydCB0eXBlIENvbXBhbmlvblN0YXR1cyA9ICdjb25uZWN0aW5nJyB8ICdvbmxpbmUnIHwgJ29mZmxpbmUnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0YXR1c1NuYXBzaG90IHtcbiAgY29tcGFuaW9uOiBDb21wYW5pb25TdGF0dXM7XG4gIGNvbXBhbmlvblZlcnNpb24/OiBzdHJpbmc7XG4gIGpldkNvbmZpZ3VyZWQ/OiBib29sZWFuO1xuICBjbGF1ZGVGb3VuZD86IGJvb2xlYW47XG4gIGxhc3RFcnJvcj86IHN0cmluZztcbiAgcGVuZGluZzogeyB0ZXh0OiBudW1iZXI7IHZpc2lvbjogbnVtYmVyIH07XG4gIGF2Z01zOiB7IHRleHQ/OiBudW1iZXI7IHZpc2lvbj86IG51bWJlcjsgZnVsbD86IG51bWJlciB9O1xuICByYXRlTGltaXQ/OiBSYXRlTGltaXRJbmZvO1xuICAvKiogTGFzdCBzZWxlY3RvciBoZWFsdGggcmVwb3J0ZWQgYnkgYW55IHRhYi4gKi9cbiAgc2VsZWN0b3JIZWFsdGg/OiBPbWl0PEhlYWx0aE1zZywgJ3R5cGUnPjtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLSBTdG9yYWdlIHJlY29yZHMgLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIEhpZGRlblN0YXRzIHtcbiAgLyoqIExvY2FsIGNhbGVuZGFyIGRheSwgXCJZWVlZLU1NLUREXCIuICovXG4gIGRheTogc3RyaW5nO1xuICBoaWRkZW5JZHM6IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZlZWRiYWNrRW50cnkge1xuICAvKiogSVNPIHRpbWVzdGFtcC4gKi9cbiAgYXQ6IHN0cmluZztcbiAgZmxhdm9yOiBGbGF2b3I7XG4gIHBvc3RJZDogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbiAgLyoqIFRoZSBvd25lcidzIGxhYmVsLiAqL1xuICBsYWJlbDogJ2hpZGUnIHwgJ2tlZXAnO1xuICAvKiogV2hhdCBMb3cgQ29ydGlzb2wgZGVjaWRlZCBhdCBgdGhyZXNob2xkYC4gKi9cbiAgdmVyZGljdDogJ2hpZGUnIHwgJ2tlZXAnO1xuICB0aHJlc2hvbGQ6IG51bWJlcjtcbiAgcnVicmljVmVyc2lvbjogc3RyaW5nO1xuICBqZXZNb2RlbDogc3RyaW5nO1xuICBzdGFnZTogJ3RleHQnIHwgJ2Z1bGwnO1xuICBhbnN3ZXJzOiBKZXZBbnN3ZXJzO1xuICAvKiogRXhhY3QgSmV2IGlucHV0IChpbmNsdWRlcyB0cmFuc2NyaXB0cyBvbiB0aGUgZnVsbCBzdGFnZSkuICovXG4gIHN0YXRlOiBKZXZTdGF0ZTtcbn1cbiIsICIvLyBTZXR0aW5ncyBkZWZhdWx0cyBwZXIgZmxhdm9yIGFuZCB0aGUgcHJvZC9kZXYgXCJlZmZlY3RpdmUgc2V0dGluZ3NcIiBydWxlLiBTcGVjIFx1MDBBNzMuMVxuXG5pbXBvcnQgdHlwZSB7IEZsYXZvciwgU2V0dGluZ3MsIFRyYW5zY3JpcHRNb2RlbCB9IGZyb20gJy4vdHlwZXMnO1xuXG5leHBvcnQgY29uc3QgVEhSRVNIT0xEX01JTiA9IDAuNTtcbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfTUFYID0gMC45NTtcbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfU1RFUCA9IDAuMDU7XG5cbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfUFJFU0VUUyA9IHtcbiAgYWdncmVzc2l2ZTogMC41NSxcbiAgYmFsYW5jZWQ6IDAuNyxcbiAgY29uc2VydmF0aXZlOiAwLjg1LFxufSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgVGhyZXNob2xkUHJlc2V0ID0ga2V5b2YgdHlwZW9mIFRIUkVTSE9MRF9QUkVTRVRTO1xuXG4vKiogTW9kZWwgaWRzIHZlcmlmaWVkIHdpdGggQ2xhdWRlIENvZGUgQ0xJIDIuMS4yODEgb24gMjAyNi0wOS0zMCAoc2VlIGRvY3Mvb3duZXItYW5zd2Vycy5tZCkuICovXG5leHBvcnQgY29uc3QgVFJBTlNDUklQVF9NT0RFTFM6IFJlYWRvbmx5QXJyYXk8eyBpZDogVHJhbnNjcmlwdE1vZGVsOyBsYWJlbDogc3RyaW5nIH0+ID0gW1xuICB7IGlkOiAnY2xhdWRlLW9wdXMtNS01JywgbGFiZWw6ICdPcHVzIDUuNSAoZGVmYXVsdCknIH0sXG4gIHsgaWQ6ICdjbGF1ZGUtc29ubmV0LTUtNScsIGxhYmVsOiAnU29ubmV0IDUuNScgfSxcbl07XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1RSQU5TQ1JJUFRfTU9ERUw6IFRyYW5zY3JpcHRNb2RlbCA9ICdjbGF1ZGUtb3B1cy01LTUnO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogUmVhZG9ubHk8UmVjb3JkPEZsYXZvciwgUmVhZG9ubHk8U2V0dGluZ3M+Pj4gPSB7XG4gIHByb2Q6IHtcbiAgICBoaWRlRW5hYmxlZDogdHJ1ZSxcbiAgICBzaG93UmVzdWx0czogZmFsc2UsXG4gICAgdGhyZXNob2xkOiBUSFJFU0hPTERfUFJFU0VUUy5iYWxhbmNlZCxcbiAgICB2aXNpb25FbmFibGVkOiB0cnVlLFxuICAgIHRyYW5zY3JpcHRNb2RlbDogREVGQVVMVF9UUkFOU0NSSVBUX01PREVMLFxuICAgIHNob3dUcmFuc2NyaXB0OiBmYWxzZSxcbiAgICBzaG93U3RhdHVzOiBmYWxzZSxcbiAgfSxcbiAgZGV2OiB7XG4gICAgLy8gRGV2IHN0YXJ0cyBpbiBsYWJlbGluZyBtb2RlOiBzaG93cyB3aGF0IGl0IHdvdWxkIGhpZGUgd2l0aG91dCBoaWRpbmcuXG4gICAgaGlkZUVuYWJsZWQ6IGZhbHNlLFxuICAgIHNob3dSZXN1bHRzOiB0cnVlLFxuICAgIHRocmVzaG9sZDogVEhSRVNIT0xEX1BSRVNFVFMuYmFsYW5jZWQsXG4gICAgdmlzaW9uRW5hYmxlZDogdHJ1ZSxcbiAgICB0cmFuc2NyaXB0TW9kZWw6IERFRkFVTFRfVFJBTlNDUklQVF9NT0RFTCxcbiAgICBzaG93VHJhbnNjcmlwdDogdHJ1ZSxcbiAgICBzaG93U3RhdHVzOiB0cnVlLFxuICB9LFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNsYW1wVGhyZXNob2xkKG46IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIgPSBUSFJFU0hPTERfUFJFU0VUUy5iYWxhbmNlZCk6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgbiAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIGZhbGxiYWNrO1xuICBjb25zdCBjbGFtcGVkID0gTWF0aC5taW4oVEhSRVNIT0xEX01BWCwgTWF0aC5tYXgoVEhSRVNIT0xEX01JTiwgbikpO1xuICByZXR1cm4gTWF0aC5yb3VuZChjbGFtcGVkICogMTAwKSAvIDEwMDtcbn1cblxuZnVuY3Rpb24gaXNUcmFuc2NyaXB0TW9kZWwodjogdW5rbm93bik6IHYgaXMgVHJhbnNjcmlwdE1vZGVsIHtcbiAgcmV0dXJuIFRSQU5TQ1JJUFRfTU9ERUxTLnNvbWUoKG0pID0+IG0uaWQgPT09IHYpO1xufVxuXG5mdW5jdGlvbiBib29sKHY6IHVua25vd24sIGZhbGxiYWNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ2Jvb2xlYW4nID8gdiA6IGZhbGxiYWNrO1xufVxuXG4vKipcbiAqIFByb2Qgb25seSBob25vdXJzIGBoaWRlRW5hYmxlZGA7IGV2ZXJ5dGhpbmcgZWxzZSBpcyBmb3JjZWQgdG8gcHJvZCBkZWZhdWx0cyAocHJvZCBjYW4gbmV2ZXIgc2hvdyBwYW5lbHMpLlxuICogRGV2IG1lcmdlcyBzdG9yZWQgdmFsdWVzIG92ZXIgZGV2IGRlZmF1bHRzLCBpZ25vcmluZyB3cm9uZyB0eXBlcyBhbmQgY2xhbXBpbmcgdGhlIHRocmVzaG9sZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVmZmVjdGl2ZVNldHRpbmdzKHN0b3JlZDogdW5rbm93biwgZmxhdm9yOiBGbGF2b3IpOiBTZXR0aW5ncyB7XG4gIGNvbnN0IHMgPSAoc3RvcmVkICYmIHR5cGVvZiBzdG9yZWQgPT09ICdvYmplY3QnID8gc3RvcmVkIDoge30pIGFzIFBhcnRpYWw8UmVjb3JkPGtleW9mIFNldHRpbmdzLCB1bmtub3duPj47XG4gIGNvbnN0IGQgPSBERUZBVUxUX1NFVFRJTkdTW2ZsYXZvcl07XG4gIGlmIChmbGF2b3IgPT09ICdwcm9kJykge1xuICAgIHJldHVybiB7IC4uLmQsIGhpZGVFbmFibGVkOiBib29sKHMuaGlkZUVuYWJsZWQsIGQuaGlkZUVuYWJsZWQpIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBoaWRlRW5hYmxlZDogYm9vbChzLmhpZGVFbmFibGVkLCBkLmhpZGVFbmFibGVkKSxcbiAgICBzaG93UmVzdWx0czogYm9vbChzLnNob3dSZXN1bHRzLCBkLnNob3dSZXN1bHRzKSxcbiAgICB0aHJlc2hvbGQ6IGNsYW1wVGhyZXNob2xkKHMudGhyZXNob2xkLCBkLnRocmVzaG9sZCksXG4gICAgdmlzaW9uRW5hYmxlZDogYm9vbChzLnZpc2lvbkVuYWJsZWQsIGQudmlzaW9uRW5hYmxlZCksXG4gICAgdHJhbnNjcmlwdE1vZGVsOiBpc1RyYW5zY3JpcHRNb2RlbChzLnRyYW5zY3JpcHRNb2RlbCkgPyBzLnRyYW5zY3JpcHRNb2RlbCA6IGQudHJhbnNjcmlwdE1vZGVsLFxuICAgIHNob3dUcmFuc2NyaXB0OiBib29sKHMuc2hvd1RyYW5zY3JpcHQsIGQuc2hvd1RyYW5zY3JpcHQpLFxuICAgIHNob3dTdGF0dXM6IGJvb2wocy5zaG93U3RhdHVzLCBkLnNob3dTdGF0dXMpLFxuICB9O1xufVxuXG4vKiogQ2xhc3NpZmljYXRpb24gcnVucyAoYW5kIGFueXRoaW5nIGlzIHNlbnQgYW55d2hlcmUpIG9ubHkgd2hlbiB0aGlzIGlzIHRydWUuICovXG5leHBvcnQgZnVuY3Rpb24gaXNDbGFzc2lmaWNhdGlvbkFjdGl2ZShzOiBTZXR0aW5ncyk6IGJvb2xlYW4ge1xuICByZXR1cm4gcy5oaWRlRW5hYmxlZCB8fCBzLnNob3dSZXN1bHRzO1xufVxuIiwgIi8vIFB1cmUgcG9wdXAgdmlldy1tb2RlbCBidWlsZGVycyAodW5pdC10ZXN0ZWQpOyBwb3B1cC50cyB3aXJlcyB0aGVtIHRvIHRoZSBET00uIFNwZWMgXHUwMEE3NC4zXG5cbmltcG9ydCB0eXBlIHsgRmVlZGJhY2tFbnRyeSwgU3RhdHVzU25hcHNob3QgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvcHJvdG9jb2wnO1xuaW1wb3J0IHsgVEhSRVNIT0xEX1BSRVNFVFMsIFRSQU5TQ1JJUFRfTU9ERUxTIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3NldHRpbmdzJztcbmltcG9ydCB0eXBlIHsgRmxhdm9yLCBTZXR0aW5ncywgVHJhbnNjcmlwdE1vZGVsIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3R5cGVzJztcblxuZXhwb3J0IHR5cGUgUHJlc2V0TmFtZSA9ICdBZ2dyZXNzaXZlJyB8ICdCYWxhbmNlZCcgfCAnQ29uc2VydmF0aXZlJztcblxuZXhwb3J0IGludGVyZmFjZSBQb3B1cE1vZGVsIHtcbiAgZmxhdm9yOiBGbGF2b3I7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGhpZGVFbmFibGVkOiBib29sZWFuO1xuICBoaWRkZW5Ub2RheVRleHQ6IHN0cmluZztcbiAgb2ZmbGluZVdhcm5pbmc/OiBzdHJpbmc7XG4gIGRldj86IHtcbiAgICBzaG93UmVzdWx0czogYm9vbGVhbjtcbiAgICB0aHJlc2hvbGQ6IG51bWJlcjtcbiAgICB0aHJlc2hvbGRUZXh0OiBzdHJpbmc7XG4gICAgdmlzaW9uRW5hYmxlZDogYm9vbGVhbjtcbiAgICB0cmFuc2NyaXB0TW9kZWw6IFRyYW5zY3JpcHRNb2RlbDtcbiAgICBzaG93VHJhbnNjcmlwdDogYm9vbGVhbjtcbiAgICBzaG93U3RhdHVzOiBib29sZWFuO1xuICAgIG1vZGVsczogUmVhZG9ubHlBcnJheTx7IGlkOiBUcmFuc2NyaXB0TW9kZWw7IGxhYmVsOiBzdHJpbmcgfT47XG4gICAgcHJlc2V0czogQXJyYXk8eyBuYW1lOiBQcmVzZXROYW1lOyB2YWx1ZTogbnVtYmVyIH0+O1xuICAgIHN0YXR1c0xpbmVzOiBzdHJpbmdbXTtcbiAgICBmZWVkYmFja0NvdW50OiBudW1iZXI7XG4gIH07XG59XG5cbmNvbnN0IFBSRVNFVFM6IEFycmF5PHsgbmFtZTogUHJlc2V0TmFtZTsgdmFsdWU6IG51bWJlciB9PiA9IFtcbiAgeyBuYW1lOiAnQWdncmVzc2l2ZScsIHZhbHVlOiBUSFJFU0hPTERfUFJFU0VUUy5hZ2dyZXNzaXZlIH0sXG4gIHsgbmFtZTogJ0JhbGFuY2VkJywgdmFsdWU6IFRIUkVTSE9MRF9QUkVTRVRTLmJhbGFuY2VkIH0sXG4gIHsgbmFtZTogJ0NvbnNlcnZhdGl2ZScsIHZhbHVlOiBUSFJFU0hPTERfUFJFU0VUUy5jb25zZXJ2YXRpdmUgfSxcbl07XG5cbmV4cG9ydCBjb25zdCBPRkZMSU5FX1dBUk5JTkcgPSAnQ29tcGFuaW9uIG9mZmxpbmU6IG5vdGhpbmcgaXMgYmVpbmcgZmlsdGVyZWQuJztcblxuLyoqIFwiMC43MCAoQmFsYW5jZWQpXCIgZm9yIGEgcHJlc2V0IHZhbHVlLCBvdGhlcndpc2UganVzdCBcIjAuNjBcIi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aHJlc2hvbGRUZXh0KHQ6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSB0LnRvRml4ZWQoMik7XG4gIGNvbnN0IHByZXNldCA9IFBSRVNFVFMuZmluZCgocCkgPT4gcC52YWx1ZS50b0ZpeGVkKDIpID09PSB0ZXh0KTtcbiAgcmV0dXJuIHByZXNldCA/IGAke3RleHR9ICgke3ByZXNldC5uYW1lfSlgIDogdGV4dDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXR1c0xpbmVzKHM6IFN0YXR1c1NuYXBzaG90IHwgdW5kZWZpbmVkKTogc3RyaW5nW10ge1xuICBpZiAoIXMpIHJldHVybiBbJ1N0YXR1czogdW5hdmFpbGFibGUnXTtcbiAgY29uc3QgbGluZXMgPSBbYENvbXBhbmlvbjogJHtzLmNvbXBhbmlvbn0ke3MuY29tcGFuaW9uVmVyc2lvbiA/ICcgdicgKyBzLmNvbXBhbmlvblZlcnNpb24gOiAnJ31gXTtcbiAgaWYgKHMuamV2Q29uZmlndXJlZCAhPT0gdW5kZWZpbmVkKSBsaW5lcy5wdXNoKGBKZXYga2V5OiAke3MuamV2Q29uZmlndXJlZCA/ICdjb25maWd1cmVkJyA6ICdtaXNzaW5nJ31gKTtcbiAgaWYgKHMuY2xhdWRlRm91bmQgIT09IHVuZGVmaW5lZCkgbGluZXMucHVzaChgQ2xhdWRlIENMSTogJHtzLmNsYXVkZUZvdW5kID8gJ2ZvdW5kJyA6ICdub3QgZm91bmQnfWApO1xuICBsaW5lcy5wdXNoKGBQZW5kaW5nOiB0ZXh0ICR7cy5wZW5kaW5nLnRleHR9IFx1MDBCNyB2aXNpb24gJHtzLnBlbmRpbmcudmlzaW9ufWApO1xuICBjb25zdCB7IHRleHQsIHZpc2lvbiwgZnVsbCB9ID0gcy5hdmdNcztcbiAgY29uc3QgbXMgPSAobjogbnVtYmVyIHwgdW5kZWZpbmVkKSA9PiAobiAhPSBudWxsID8gU3RyaW5nKE1hdGgucm91bmQobikpIDogJ1x1MjAxMycpO1xuICBjb25zdCB2aXNpb25UZXh0ID0gdmlzaW9uICE9IG51bGwgPyAodmlzaW9uIC8gMTAwMCkudG9GaXhlZCgxKSArICcgcycgOiAnXHUyMDEzJztcbiAgbGluZXMucHVzaChgQXZnOiB0ZXh0ICR7bXModGV4dCl9IG1zIFx1MDBCNyB2aXNpb24gJHt2aXNpb25UZXh0fSBcdTAwQjcgZnVsbCAke21zKGZ1bGwpfSBtc2ApO1xuICBjb25zdCB1ID0gcy5yYXRlTGltaXQ/LmZpdmVIb3VyVXRpbGl6YXRpb247XG4gIGlmICh1ICE9PSB1bmRlZmluZWQpIGxpbmVzLnB1c2goYENsYXVkZSA1aCB1c2FnZTogJHtNYXRoLnJvdW5kKHUgKiAxMDApfSVgKTtcbiAgY29uc3QgaCA9IHMuc2VsZWN0b3JIZWFsdGg7XG4gIGlmIChoKSBsaW5lcy5wdXNoKGgub2sgPyAnU2VsZWN0b3JzOiBPSycgOiBgU2VsZWN0b3JzOiBCUk9LRU4gKGNlbGxzICR7aC5jZWxsc30sIHBvc3RzICR7aC5hcnRpY2xlc30sIHBhcnNlZCAke2gucGFyc2VkfSlgKTtcbiAgaWYgKHMubGFzdEVycm9yKSBsaW5lcy5wdXNoKGBMYXN0IGVycm9yOiAke3MubGFzdEVycm9yfWApO1xuICByZXR1cm4gbGluZXM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFBvcHVwTW9kZWwoaToge1xuICBmbGF2b3I6IEZsYXZvcjtcbiAgc2V0dGluZ3M6IFNldHRpbmdzO1xuICBzdGF0dXM/OiBTdGF0dXNTbmFwc2hvdDtcbiAgaGlkZGVuVG9kYXk6IG51bWJlcjtcbiAgZmVlZGJhY2tDb3VudDogbnVtYmVyO1xufSk6IFBvcHVwTW9kZWwge1xuICBjb25zdCB7IGZsYXZvciwgc2V0dGluZ3M6IHMsIHN0YXR1cyB9ID0gaTtcbiAgY29uc3QgbW9kZWw6IFBvcHVwTW9kZWwgPSB7XG4gICAgZmxhdm9yLFxuICAgIHRpdGxlOiBmbGF2b3IgPT09ICdkZXYnID8gJ0xvdyBDb3J0aXNvbCAoRGV2KScgOiAnTG93IENvcnRpc29sJyxcbiAgICBoaWRlRW5hYmxlZDogcy5oaWRlRW5hYmxlZCxcbiAgICBoaWRkZW5Ub2RheVRleHQ6IGAke2kuaGlkZGVuVG9kYXl9IGhpZGRlbiB0b2RheWAsXG4gIH07XG4gIGlmIChzdGF0dXM/LmNvbXBhbmlvbiA9PT0gJ29mZmxpbmUnICYmIChzLmhpZGVFbmFibGVkIHx8IHMuc2hvd1Jlc3VsdHMpKSBtb2RlbC5vZmZsaW5lV2FybmluZyA9IE9GRkxJTkVfV0FSTklORztcbiAgaWYgKGZsYXZvciA9PT0gJ2RldicpIHtcbiAgICBtb2RlbC5kZXYgPSB7XG4gICAgICBzaG93UmVzdWx0czogcy5zaG93UmVzdWx0cyxcbiAgICAgIHRocmVzaG9sZDogcy50aHJlc2hvbGQsXG4gICAgICB0aHJlc2hvbGRUZXh0OiB0aHJlc2hvbGRUZXh0KHMudGhyZXNob2xkKSxcbiAgICAgIHZpc2lvbkVuYWJsZWQ6IHMudmlzaW9uRW5hYmxlZCxcbiAgICAgIHRyYW5zY3JpcHRNb2RlbDogcy50cmFuc2NyaXB0TW9kZWwsXG4gICAgICBzaG93VHJhbnNjcmlwdDogcy5zaG93VHJhbnNjcmlwdCxcbiAgICAgIHNob3dTdGF0dXM6IHMuc2hvd1N0YXR1cyxcbiAgICAgIG1vZGVsczogVFJBTlNDUklQVF9NT0RFTFMsXG4gICAgICBwcmVzZXRzOiBQUkVTRVRTLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBzdGF0dXNMaW5lczogc3RhdHVzTGluZXMoc3RhdHVzKSxcbiAgICAgIGZlZWRiYWNrQ291bnQ6IGkuZmVlZGJhY2tDb3VudCxcbiAgICB9O1xuICB9XG4gIHJldHVybiBtb2RlbDtcbn1cblxuLyoqIE9uZSBKU09OIG9iamVjdCBwZXIgbGluZSwgd2l0aCBhIHRyYWlsaW5nIG5ld2xpbmUgd2hlbiBub24tZW1wdHkuICovXG5leHBvcnQgZnVuY3Rpb24gZmVlZGJhY2tUb0pzb25sKGVudHJpZXM6IEZlZWRiYWNrRW50cnlbXSk6IHN0cmluZyB7XG4gIHJldHVybiBlbnRyaWVzLm1hcCgoZSkgPT4gSlNPTi5zdHJpbmdpZnkoZSkgKyAnXFxuJykuam9pbignJyk7XG59XG5cbi8qKiBcImxvdy1jb3J0aXNvbC1mZWVkYmFjay1ZWVlZTU1ERC5qc29ubFwiIGZvciB0aGUgbG9jYWwgZGF0ZSBvZiBgZGAuICovXG5leHBvcnQgZnVuY3Rpb24gZmVlZGJhY2tGaWxlbmFtZShkOiBEYXRlKTogc3RyaW5nIHtcbiAgY29uc3QgeSA9IGQuZ2V0RnVsbFllYXIoKTtcbiAgY29uc3QgbSA9IFN0cmluZyhkLmdldE1vbnRoKCkgKyAxKS5wYWRTdGFydCgyLCAnMCcpO1xuICBjb25zdCBkYXkgPSBTdHJpbmcoZC5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsICcwJyk7XG4gIHJldHVybiBgbG93LWNvcnRpc29sLWZlZWRiYWNrLSR7eX0ke219JHtkYXl9Lmpzb25sYDtcbn1cbiIsICIvLyBQb3B1cCBET00gd2lyaW5nOiByZWFkcyBzdG9yYWdlICsgU1cgc3RhdHVzLCByZW5kZXJzIHRoZSB2aWV3LW1vZGVsLCB3cml0ZXMgc2V0dGluZ3MgYmFjay4gU3BlYyBcdTAwQTc0LjNcbi8vIEFsbCB0ZXh0IGdvZXMgdGhyb3VnaCB0ZXh0Q29udGVudC5cblxuaW1wb3J0IHsgaGlkZGVuQ291bnRGcm9tIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL2RheSc7XG5pbXBvcnQgdHlwZSB7IEZlZWRiYWNrRW50cnksIEdldFN0YXR1c01zZywgU3RhdHVzU25hcHNob3QgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvcHJvdG9jb2wnO1xuaW1wb3J0IHsgU1RPUkFHRV9LRVlTIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3Byb3RvY29sJztcbmltcG9ydCB7IGNsYW1wVGhyZXNob2xkLCBlZmZlY3RpdmVTZXR0aW5ncywgVEhSRVNIT0xEX01BWCwgVEhSRVNIT0xEX01JTiwgVEhSRVNIT0xEX1NURVAgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvc2V0dGluZ3MnO1xuaW1wb3J0IHR5cGUgeyBTZXR0aW5ncyB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC90eXBlcyc7XG5pbXBvcnQgeyBidWlsZFBvcHVwTW9kZWwsIGZlZWRiYWNrRmlsZW5hbWUsIGZlZWRiYWNrVG9Kc29ubCwgdHlwZSBQb3B1cE1vZGVsLCB0aHJlc2hvbGRUZXh0IH0gZnJvbSAnLi92aWV3JztcblxudHlwZSBCb29sRmllbGQgPSAnaGlkZUVuYWJsZWQnIHwgJ3Nob3dSZXN1bHRzJyB8ICd2aXNpb25FbmFibGVkJyB8ICdzaG93VHJhbnNjcmlwdCcgfCAnc2hvd1N0YXR1cyc7XG5cbmNvbnN0IFNUQVRVU19SRUZSRVNIX01TID0gMjAwMDtcbmNvbnN0IGZsYXZvciA9IF9fRkxBVk9SX187XG5cbmxldCBzdG9yZWRTZXR0aW5nczogdW5rbm93bjtcbmxldCBzdGF0czogdW5rbm93bjtcbmxldCBmZWVkYmFjazogRmVlZGJhY2tFbnRyeVtdID0gW107XG5sZXQgc3RhdHVzOiBTdGF0dXNTbmFwc2hvdCB8IHVuZGVmaW5lZDtcblxuZnVuY3Rpb24gZWw8SyBleHRlbmRzIGtleW9mIEhUTUxFbGVtZW50VGFnTmFtZU1hcD4odGFnOiBLLCBjbGFzc05hbWU/OiBzdHJpbmcsIHRleHQ/OiBzdHJpbmcpOiBIVE1MRWxlbWVudFRhZ05hbWVNYXBbS10ge1xuICBjb25zdCBub2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICBpZiAoY2xhc3NOYW1lKSBub2RlLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgaWYgKHRleHQgIT09IHVuZGVmaW5lZCkgbm9kZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBub2RlO1xufVxuXG5mdW5jdGlvbiB3cml0ZVNldHRpbmdzKGZpZWxkOiBrZXlvZiBTZXR0aW5ncywgdmFsdWU6IFNldHRpbmdzW2tleW9mIFNldHRpbmdzXSk6IHZvaWQge1xuICBjb25zdCBiYXNlID0gc3RvcmVkU2V0dGluZ3MgJiYgdHlwZW9mIHN0b3JlZFNldHRpbmdzID09PSAnb2JqZWN0JyA/IHN0b3JlZFNldHRpbmdzIDoge307XG4gIHZvaWQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfS0VZUy5zZXR0aW5nc106IHsgLi4uYmFzZSwgW2ZpZWxkXTogdmFsdWUgfSB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZVN3aXRjaChsYWJlbDogc3RyaW5nLCBmaWVsZDogQm9vbEZpZWxkKTogeyByb290OiBIVE1MTGFiZWxFbGVtZW50OyBpbnB1dDogSFRNTElucHV0RWxlbWVudCB9IHtcbiAgY29uc3Qgcm9vdCA9IGVsKCdsYWJlbCcsICdzd2l0Y2gnKTtcbiAgY29uc3QgaW5wdXQgPSBlbCgnaW5wdXQnKTtcbiAgaW5wdXQudHlwZSA9ICdjaGVja2JveCc7XG4gIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHdyaXRlU2V0dGluZ3MoZmllbGQsIGlucHV0LmNoZWNrZWQpKTtcbiAgcm9vdC5hcHBlbmQoaW5wdXQsIGVsKCdzcGFuJywgJ3RyYWNrJyksIGVsKCdzcGFuJywgJ3N3aXRjaC1sYWJlbCcsIGxhYmVsKSk7XG4gIHJldHVybiB7IHJvb3QsIGlucHV0IH07XG59XG5cbi8vIC0tLS0gU3RhdGljIHN0cnVjdHVyZSAoYnVpbHQgb25jZTsgcmVuZGVyKCkgb25seSB1cGRhdGVzIHZhbHVlcyBzbyBjb250cm9scyBrZWVwIGZvY3VzKSAtLS0tXG5cbmNvbnN0IGFwcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHAnKSE7XG5jb25zdCB0aXRsZSA9IGVsKCdoMScpO1xuY29uc3Qgd2FybmluZyA9IGVsKCdwJywgJ3dhcm5pbmcnKTtcbmNvbnN0IGhpZGUgPSBtYWtlU3dpdGNoKCdIaWRlIHJhZ2ViYWl0JywgJ2hpZGVFbmFibGVkJyk7XG5jb25zdCBoaWRkZW5Ub2RheSA9IGVsKCdwJywgJ2hpZGRlbi10b2RheScpO1xuYXBwLmFwcGVuZCh0aXRsZSwgd2FybmluZywgaGlkZS5yb290LCBoaWRkZW5Ub2RheSk7XG5cbmludGVyZmFjZSBEZXZWaWV3IHtcbiAgdG9nZ2xlczogQXJyYXk8eyBmaWVsZDogRXhjbHVkZTxCb29sRmllbGQsICdoaWRlRW5hYmxlZCc+OyBpbnB1dDogSFRNTElucHV0RWxlbWVudCB9PjtcbiAgcmFuZ2U6IEhUTUxJbnB1dEVsZW1lbnQ7XG4gIHJhbmdlVGV4dDogSFRNTFNwYW5FbGVtZW50O1xuICBwcmVzZXRzOiBIVE1MQnV0dG9uRWxlbWVudFtdO1xuICBtb2RlbDogSFRNTFNlbGVjdEVsZW1lbnQ7XG4gIHN0YXR1czogSFRNTFByZUVsZW1lbnQ7XG4gIGZlZWRiYWNrQ291bnQ6IEhUTUxTcGFuRWxlbWVudDtcbiAgZXhwb3J0QnRuOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgY2xlYXJCdG46IEhUTUxCdXR0b25FbGVtZW50O1xufVxuXG5mdW5jdGlvbiBidWlsZERldihpbml0aWFsOiBOb25OdWxsYWJsZTxQb3B1cE1vZGVsWydkZXYnXT4pOiBEZXZWaWV3IHtcbiAgY29uc3Qgc2VjdGlvbiA9IGVsKCdzZWN0aW9uJywgJ2RldicpO1xuICBjb25zdCB0b2dnbGVzID0gKFxuICAgIFtcbiAgICAgIFsnU2hvdyBjbGFzc2lmaWVyIHJlc3VsdHMnLCAnc2hvd1Jlc3VsdHMnXSxcbiAgICAgIFsnVmlzaW9uIChpbWFnZSB0cmFuc2NyaXB0cyknLCAndmlzaW9uRW5hYmxlZCddLFxuICAgICAgWydTaG93IHRyYW5zY3JpcHQnLCAnc2hvd1RyYW5zY3JpcHQnXSxcbiAgICAgIFsnU2hvdyBzdGF0dXMnLCAnc2hvd1N0YXR1cyddLFxuICAgIF0gYXMgY29uc3RcbiAgKS5tYXAoKFtsYWJlbCwgZmllbGRdKSA9PiB7XG4gICAgY29uc3QgcyA9IG1ha2VTd2l0Y2gobGFiZWwsIGZpZWxkKTtcbiAgICBzZWN0aW9uLmFwcGVuZChzLnJvb3QpO1xuICAgIHJldHVybiB7IGZpZWxkLCBpbnB1dDogcy5pbnB1dCB9O1xuICB9KTtcblxuICBjb25zdCBzdHJpY3RuZXNzID0gZWwoJ2RpdicsICdmaWVsZCcpO1xuICBjb25zdCBoZWFkID0gZWwoJ2RpdicsICdmaWVsZC1oZWFkJyk7XG4gIGNvbnN0IHJhbmdlVGV4dCA9IGVsKCdzcGFuJywgJ3ZhbHVlJyk7XG4gIGhlYWQuYXBwZW5kKGVsKCdzcGFuJywgdW5kZWZpbmVkLCAnU3RyaWN0bmVzcycpLCByYW5nZVRleHQpO1xuICBjb25zdCByYW5nZSA9IGVsKCdpbnB1dCcpO1xuICByYW5nZS50eXBlID0gJ3JhbmdlJztcbiAgcmFuZ2UubWluID0gU3RyaW5nKFRIUkVTSE9MRF9NSU4pO1xuICByYW5nZS5tYXggPSBTdHJpbmcoVEhSRVNIT0xEX01BWCk7XG4gIHJhbmdlLnN0ZXAgPSBTdHJpbmcoVEhSRVNIT0xEX1NURVApO1xuICByYW5nZS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IChyYW5nZVRleHQudGV4dENvbnRlbnQgPSB0aHJlc2hvbGRUZXh0KGNsYW1wVGhyZXNob2xkKE51bWJlcihyYW5nZS52YWx1ZSkpKSkpO1xuICByYW5nZS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB3cml0ZVNldHRpbmdzKCd0aHJlc2hvbGQnLCBjbGFtcFRocmVzaG9sZChOdW1iZXIocmFuZ2UudmFsdWUpKSkpO1xuICBjb25zdCBwcmVzZXRSb3cgPSBlbCgnZGl2JywgJ3ByZXNldHMnKTtcbiAgY29uc3QgcHJlc2V0cyA9IGluaXRpYWwucHJlc2V0cy5tYXAoKHApID0+IHtcbiAgICBjb25zdCBiID0gZWwoJ2J1dHRvbicsIHVuZGVmaW5lZCwgcC5uYW1lKTtcbiAgICBiLnR5cGUgPSAnYnV0dG9uJztcbiAgICBiLmRhdGFzZXQudmFsdWUgPSBTdHJpbmcocC52YWx1ZSk7XG4gICAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHdyaXRlU2V0dGluZ3MoJ3RocmVzaG9sZCcsIHAudmFsdWUpKTtcbiAgICBwcmVzZXRSb3cuYXBwZW5kKGIpO1xuICAgIHJldHVybiBiO1xuICB9KTtcbiAgc3RyaWN0bmVzcy5hcHBlbmQoaGVhZCwgcmFuZ2UsIHByZXNldFJvdyk7XG5cbiAgY29uc3QgbW9kZWxGaWVsZCA9IGVsKCdsYWJlbCcsICdmaWVsZCcpO1xuICBjb25zdCBtb2RlbCA9IGVsKCdzZWxlY3QnKTtcbiAgZm9yIChjb25zdCBtIG9mIGluaXRpYWwubW9kZWxzKSB7XG4gICAgY29uc3QgbyA9IGVsKCdvcHRpb24nLCB1bmRlZmluZWQsIG0ubGFiZWwpO1xuICAgIG8udmFsdWUgPSBtLmlkO1xuICAgIG1vZGVsLmFwcGVuZChvKTtcbiAgfVxuICBtb2RlbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgY29uc3QgcGlja2VkID0gaW5pdGlhbC5tb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gbW9kZWwudmFsdWUpO1xuICAgIGlmIChwaWNrZWQpIHdyaXRlU2V0dGluZ3MoJ3RyYW5zY3JpcHRNb2RlbCcsIHBpY2tlZC5pZCk7XG4gIH0pO1xuICBtb2RlbEZpZWxkLmFwcGVuZChlbCgnc3BhbicsIHVuZGVmaW5lZCwgJ1RyYW5zY3JpcHQgbW9kZWwnKSwgbW9kZWwpO1xuXG4gIGNvbnN0IHN0YXR1c1ByZSA9IGVsKCdwcmUnLCAnc3RhdHVzJyk7XG5cbiAgY29uc3QgZmIgPSBlbCgnZGl2JywgJ2ZlZWRiYWNrJyk7XG4gIGNvbnN0IGZlZWRiYWNrQ291bnQgPSBlbCgnc3BhbicpO1xuICBjb25zdCBleHBvcnRCdG4gPSBlbCgnYnV0dG9uJywgdW5kZWZpbmVkLCAnRXhwb3J0IEpTT05MJyk7XG4gIGV4cG9ydEJ0bi50eXBlID0gJ2J1dHRvbic7XG4gIGV4cG9ydEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGV4cG9ydEZlZWRiYWNrKTtcbiAgY29uc3QgY2xlYXJCdG4gPSBlbCgnYnV0dG9uJywgdW5kZWZpbmVkLCAnQ2xlYXInKTtcbiAgY2xlYXJCdG4udHlwZSA9ICdidXR0b24nO1xuICBjbGVhckJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICBpZiAoY29uZmlybShgRGVsZXRlICR7ZmVlZGJhY2subGVuZ3RofSBmZWVkYmFjayBlbnRyaWVzP2ApKSB2b2lkIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX0tFWVMuZmVlZGJhY2tdOiBbXSB9KTtcbiAgfSk7XG4gIGZiLmFwcGVuZChmZWVkYmFja0NvdW50LCBleHBvcnRCdG4sIGNsZWFyQnRuKTtcblxuICBzZWN0aW9uLmFwcGVuZChzdHJpY3RuZXNzLCBtb2RlbEZpZWxkLCBzdGF0dXNQcmUsIGZiKTtcbiAgYXBwLmFwcGVuZChzZWN0aW9uKTtcbiAgcmV0dXJuIHsgdG9nZ2xlcywgcmFuZ2UsIHJhbmdlVGV4dCwgcHJlc2V0cywgbW9kZWwsIHN0YXR1czogc3RhdHVzUHJlLCBmZWVkYmFja0NvdW50LCBleHBvcnRCdG4sIGNsZWFyQnRuIH07XG59XG5cbmZ1bmN0aW9uIGV4cG9ydEZlZWRiYWNrKCk6IHZvaWQge1xuICBjb25zdCBibG9iID0gbmV3IEJsb2IoW2ZlZWRiYWNrVG9Kc29ubChmZWVkYmFjayldLCB7IHR5cGU6ICdhcHBsaWNhdGlvbi94LW5kanNvbicgfSk7XG4gIGNvbnN0IHVybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7XG4gIGNvbnN0IGEgPSBlbCgnYScpO1xuICBhLmhyZWYgPSB1cmw7XG4gIGEuZG93bmxvYWQgPSBmZWVkYmFja0ZpbGVuYW1lKG5ldyBEYXRlKCkpO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZChhKTtcbiAgYS5jbGljaygpO1xuICBhLnJlbW92ZSgpO1xuICBzZXRUaW1lb3V0KCgpID0+IFVSTC5yZXZva2VPYmplY3RVUkwodXJsKSwgMTAwMCk7XG59XG5cbmxldCBkZXZWaWV3OiBEZXZWaWV3IHwgdW5kZWZpbmVkO1xuXG5mdW5jdGlvbiByZW5kZXIoKTogdm9pZCB7XG4gIGNvbnN0IG0gPSBidWlsZFBvcHVwTW9kZWwoe1xuICAgIGZsYXZvcixcbiAgICBzZXR0aW5nczogZWZmZWN0aXZlU2V0dGluZ3Moc3RvcmVkU2V0dGluZ3MsIGZsYXZvciksXG4gICAgc3RhdHVzLFxuICAgIGhpZGRlblRvZGF5OiBoaWRkZW5Db3VudEZyb20oc3RhdHMsIG5ldyBEYXRlKCkpLFxuICAgIGZlZWRiYWNrQ291bnQ6IGZlZWRiYWNrLmxlbmd0aCxcbiAgfSk7XG4gIGRvY3VtZW50LnRpdGxlID0gbS50aXRsZTtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBtLnRpdGxlO1xuICB3YXJuaW5nLnRleHRDb250ZW50ID0gbS5vZmZsaW5lV2FybmluZyA/PyAnJztcbiAgd2FybmluZy5oaWRkZW4gPSAhbS5vZmZsaW5lV2FybmluZztcbiAgaGlkZS5pbnB1dC5jaGVja2VkID0gbS5oaWRlRW5hYmxlZDtcbiAgaGlkZGVuVG9kYXkudGV4dENvbnRlbnQgPSBtLmhpZGRlblRvZGF5VGV4dDtcblxuICBjb25zdCBkZXYgPSBtLmRldjtcbiAgaWYgKCFkZXYpIHJldHVybjtcbiAgZGV2VmlldyA/Pz0gYnVpbGREZXYoZGV2KTtcbiAgY29uc3QgdiA9IGRldlZpZXc7XG4gIGZvciAoY29uc3QgdCBvZiB2LnRvZ2dsZXMpIHQuaW5wdXQuY2hlY2tlZCA9IGRldlt0LmZpZWxkXTtcbiAgLy8gTGVhdmUgdGhlIHNsaWRlciBhbG9uZSB3aGlsZSB0aGUgdXNlciBpcyBvbiBpdDogdGhlIDIgcyBzdGF0dXMgcmVmcmVzaCB3b3VsZCBzbmFwIGl0IGJhY2sgbWlkLWRyYWcuXG4gIGlmIChkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9PSB2LnJhbmdlKSB7XG4gICAgdi5yYW5nZS52YWx1ZSA9IFN0cmluZyhkZXYudGhyZXNob2xkKTtcbiAgICB2LnJhbmdlVGV4dC50ZXh0Q29udGVudCA9IGRldi50aHJlc2hvbGRUZXh0O1xuICB9XG4gIGZvciAoY29uc3QgYiBvZiB2LnByZXNldHMpIGIuY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgTnVtYmVyKGIuZGF0YXNldC52YWx1ZSkgPT09IGRldi50aHJlc2hvbGQpO1xuICB2Lm1vZGVsLnZhbHVlID0gZGV2LnRyYW5zY3JpcHRNb2RlbDtcbiAgdi5zdGF0dXMudGV4dENvbnRlbnQgPSBkZXYuc3RhdHVzTGluZXMuam9pbignXFxuJyk7XG4gIHYuZmVlZGJhY2tDb3VudC50ZXh0Q29udGVudCA9IGAke2Rldi5mZWVkYmFja0NvdW50fSBmZWVkYmFjayAke2Rldi5mZWVkYmFja0NvdW50ID09PSAxID8gJ2VudHJ5JyA6ICdlbnRyaWVzJ31gO1xuICB2LmV4cG9ydEJ0bi5kaXNhYmxlZCA9IGRldi5mZWVkYmFja0NvdW50ID09PSAwO1xuICB2LmNsZWFyQnRuLmRpc2FibGVkID0gZGV2LmZlZWRiYWNrQ291bnQgPT09IDA7XG59XG5cbmZ1bmN0aW9uIGFwcGx5U3RvcmFnZShyOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICBpZiAoU1RPUkFHRV9LRVlTLnNldHRpbmdzIGluIHIpIHN0b3JlZFNldHRpbmdzID0gcltTVE9SQUdFX0tFWVMuc2V0dGluZ3NdO1xuICBpZiAoU1RPUkFHRV9LRVlTLnN0YXRzIGluIHIpIHN0YXRzID0gcltTVE9SQUdFX0tFWVMuc3RhdHNdO1xuICBpZiAoU1RPUkFHRV9LRVlTLmZlZWRiYWNrIGluIHIpIHtcbiAgICBjb25zdCBmID0gcltTVE9SQUdFX0tFWVMuZmVlZGJhY2tdO1xuICAgIGZlZWRiYWNrID0gQXJyYXkuaXNBcnJheShmKSA/IChmIGFzIEZlZWRiYWNrRW50cnlbXSkgOiBbXTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoU3RhdHVzKCk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IG1zZzogR2V0U3RhdHVzTXNnID0geyB0eXBlOiAnZ2V0U3RhdHVzJyB9O1xuICAgIHN0YXR1cyA9IChhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShtc2cpKSBhcyBTdGF0dXNTbmFwc2hvdCB8IHVuZGVmaW5lZDtcbiAgfSBjYXRjaCB7XG4gICAgc3RhdHVzID0gdW5kZWZpbmVkO1xuICB9XG4gIHJlbmRlcigpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbml0KCk6IFByb21pc2U8dm9pZD4ge1xuICBjaHJvbWUuc3RvcmFnZS5vbkNoYW5nZWQuYWRkTGlzdGVuZXIoKGNoYW5nZXMsIGFyZWEpID0+IHtcbiAgICBpZiAoYXJlYSAhPT0gJ2xvY2FsJykgcmV0dXJuO1xuICAgIGNvbnN0IHI6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgZm9yIChjb25zdCBbaywgY10gb2YgT2JqZWN0LmVudHJpZXMoY2hhbmdlcykpIHJba10gPSBjLm5ld1ZhbHVlO1xuICAgIGFwcGx5U3RvcmFnZShyKTtcbiAgICByZW5kZXIoKTtcbiAgfSk7XG4gIGNvbnN0IHIgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfS0VZUy5zZXR0aW5ncywgU1RPUkFHRV9LRVlTLnN0YXRzLCBTVE9SQUdFX0tFWVMuZmVlZGJhY2tdKTtcbiAgYXBwbHlTdG9yYWdlKHsgW1NUT1JBR0VfS0VZUy5zZXR0aW5nc106IHVuZGVmaW5lZCwgW1NUT1JBR0VfS0VZUy5zdGF0c106IHVuZGVmaW5lZCwgW1NUT1JBR0VfS0VZUy5mZWVkYmFja106IFtdLCAuLi5yIH0pO1xuICByZW5kZXIoKTtcbiAgYXdhaXQgcmVmcmVzaFN0YXR1cygpO1xuICBzZXRJbnRlcnZhbCgoKSA9PiB2b2lkIHJlZnJlc2hTdGF0dXMoKSwgU1RBVFVTX1JFRlJFU0hfTVMpO1xufVxuXG52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
