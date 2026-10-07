"use strict";
(() => {
  // shared/protocol.ts
  var HOST_NAME = "com.lowcortisol.companion";
  var PORT_NAME = "lc";
  var MAX_VISION_ITEMS = 6;
  var STORAGE_KEYS = {
    settings: "settings",
    stats: "stats",
    feedback: "feedback"
  };

  // shared/settings.ts
  var THRESHOLD_MIN = 0.5;
  var THRESHOLD_MAX = 0.95;
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
  function isClassificationActive(s) {
    return s.hideEnabled || s.showResults;
  }

  // extension/src/background/native.ts
  var TIMEOUTS = { hello: 5e3, classify: 1e4, transcribe: 12e4 };
  var BACKOFF_MS = [1e3, 2e3, 5e3, 1e4, 3e4];
  var NativeCallError = class extends Error {
    info;
    constructor(info) {
      super(info.message);
      this.name = "NativeCallError";
      this.info = info;
    }
  };
  var offline = (message) => new NativeCallError({ code: "COMPANION_OFFLINE", message });
  var NativeClient = class {
    o;
    now;
    port;
    seq = 0;
    pending = /* @__PURE__ */ new Map();
    status = "connecting";
    companionVersion;
    jevConfigured;
    claudeFound;
    lastError;
    failures = 0;
    retryAt = 0;
    constructor(o) {
      this.o = o;
      this.now = o.now ?? Date.now;
    }
    getStatus() {
      return {
        companion: this.status,
        companionVersion: this.companionVersion,
        jevConfigured: this.jevConfigured,
        claudeFound: this.claudeFound,
        lastError: this.lastError
      };
    }
    request(call, timeoutMs = TIMEOUTS[call.type]) {
      if (!this.port) {
        if (this.now() < this.retryAt) return Promise.reject(offline(this.lastError ?? "companion offline"));
        this.open();
        if (!this.port) return Promise.reject(offline(this.lastError ?? "companion offline"));
      }
      return this.send(this.port, call, timeoutMs);
    }
    open() {
      this.setStatus("connecting");
      let port;
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
        if (this.port === port) this.fail(this.o.lastError?.() ?? "disconnected");
      });
      this.send(port, { type: "hello", flavor: this.o.flavor, extVersion: this.o.extVersion }, TIMEOUTS.hello).then(
        (r) => {
          if (this.port !== port) return;
          const h = r;
          this.companionVersion = h.companionVersion;
          this.jevConfigured = h.jevConfigured;
          this.claudeFound = h.claudeFound;
          this.lastError = void 0;
          this.failures = 0;
          this.setStatus("online");
        },
        (e) => {
          if (this.port !== port) return;
          try {
            port.disconnect();
          } catch {
          }
          this.fail(e.info.message);
        }
      );
    }
    send(port, call, timeoutMs) {
      const id = String(++this.seq);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new NativeCallError({ code: "COMPANION_TIMEOUT", message: `${call.type} timed out after ${timeoutMs} ms` }));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        try {
          port.postMessage({ ...call, id });
        } catch (e) {
          if (this.port === port) this.fail(e instanceof Error ? e.message : String(e));
        }
      });
    }
    onMessage(m) {
      if (!m || typeof m !== "object") return;
      const r = m;
      const p = this.pending.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      if (r.ok === true) p.resolve(r);
      else p.reject(new NativeCallError(r.error ?? { code: "INTERNAL", message: "malformed companion response" }));
    }
    /** Port is gone: go offline, reject everything pending, schedule the earliest reconnect. */
    fail(message) {
      this.port = void 0;
      this.lastError = message;
      this.failures++;
      this.retryAt = this.now() + BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const p of pending) {
        clearTimeout(p.timer);
        p.reject(offline(message));
      }
      this.setStatus("offline");
    }
    setStatus(s) {
      if (this.status === s) return;
      this.status = s;
      this.o.onStatus?.(s);
    }
  };

  // shared/rubric.ts
  var HIDE_CATEGORIES = [
    "outrage_bait",
    "culture_war",
    "engagement_bait",
    "harassment",
    "fear_mongering",
    "drama",
    "sensational_graphic"
  ];
  var INTENSITY_LEVELS = ["Calm", "Mild", "Moderate", "Strong", "Inflammatory"];
  var JEV_QUESTIONS = {
    ragebait: {
      type: "noul",
      instructions: "Should this post be hidden for a reader who wants a calm, low-stress timeline? Hide posts designed or likely to provoke anger, outrage, contempt, fear or doom in a typical reader, rather than to inform, help or entertain. Judge the post, its quoted post, link card and media transcripts together as one unit.",
      criteria: {
        true: "Outrage bait or dunking; political or culture-war fighting; engagement bait (ratio, RT if you agree, deliberately wrong hot takes); insults or harassment aimed at people or groups; fear-mongering (collapse, doom, health scares); influencer or celebrity drama; sensational or graphic crime, violence, war or disaster content.",
        false: "Neutral factual news, even about crime, war, politics or disasters; sad but sincere personal posts (grief, illness); harsh but substantive criticism or negative reviews; sarcasm or memes that are funny rather than hostile; everyday, informative, helpful or positive posts."
      }
    },
    category: {
      type: "choice",
      instructions: "Which kind of post is this (post, quoted post, card and media together)?",
      criteria: {
        outrage_bait: 'Outrage bait or dunk quote-post ("can you believe...")',
        culture_war: "Political or culture-war fighting",
        engagement_bait: "Engagement bait: ratio, RT if you agree, deliberately wrong hot take",
        harassment: "Insults or harassment aimed at people or groups",
        fear_mongering: "Fear-mongering: collapse, doom, health scares",
        drama: "Influencer or celebrity drama",
        sensational_graphic: "Sensational or graphic crime, violence, war or disaster content",
        neutral_news: "Neutral factual news, even about crime, war, politics or disasters",
        sincere_personal: "Sad but sincere personal post (grief, illness)",
        substantive_criticism: "Harsh but substantive criticism or negative review",
        humor: "Sarcasm or meme that is funny rather than hostile",
        benign_other: "Anything else: everyday, informative, helpful or positive"
      }
    },
    emotion: {
      type: "choice",
      instructions: "Which emotion is this post most likely to evoke in a typical reader?",
      criteria: {
        anger_outrage: "Anger or outrage",
        fear_anxiety: "Fear or anxiety",
        disgust_contempt: "Disgust or contempt",
        mockery_dunking: "Mockery or dunking on someone",
        sadness_grief: "Sadness or grief",
        neutral_informative: "Neutral or informative",
        positive_amused: "Positive, amused or uplifted"
      }
    },
    intensity: {
      type: "score",
      instructions: "How emotionally inflammatory is this post for a typical reader?",
      criteria: [...INTENSITY_LEVELS]
    },
    topic: {
      type: "choice",
      instructions: "What is the main topic of this post?",
      criteria: {
        politics: "Politics, elections, government",
        culture_war: "Culture-war or identity conflict",
        crime_violence: "Crime or violence",
        war_conflict: "War or armed conflict",
        disaster: "Disaster, accident or catastrophe",
        economy_business: "Economy, money or business",
        tech_ai: "Technology or AI",
        science_health: "Science or health",
        celebrity_entertainment: "Celebrities, entertainment or influencers",
        sports: "Sports",
        personal_life: "Personal life or everyday experiences",
        other: "Other"
      }
    }
  };
  var GENERIC_ALT = /^(image|photo|picture|embedded video|video|gif)$/i;
  function meaningfulAlt(alt) {
    const a = alt?.trim();
    if (!a || GENERIC_ALT.test(a)) return void 0;
    return a;
  }
  function formatAuthor(handle, name) {
    const h = handle.trim();
    const n = name.trim();
    return n && n !== h ? `${h} (${n})` : h;
  }
  function mediaState(m, byKey) {
    const out = { kind: m.kind };
    const alt = meaningfulAlt(m.alt);
    if (alt) out.alt = alt;
    const t = byKey?.get(m.key);
    if (t) {
      out.visible_text = t.visibleText;
      out.description = t.description;
      out.cues = [...t.cues];
    }
    return out;
  }
  function buildJevState(snapshot, transcripts) {
    const byKey = transcripts ? new Map(transcripts.map((t) => [t.key, t])) : void 0;
    const outerMedia = snapshot.media.filter((m) => !m.inQuote).map((m) => mediaState(m, byKey));
    const quotedMedia = snapshot.media.filter((m) => m.inQuote).map((m) => mediaState(m, byKey));
    const post = {
      author: formatAuthor(snapshot.authorHandle, snapshot.authorName),
      text: snapshot.text
    };
    if (snapshot.truncated) post.text_truncated = true;
    if (snapshot.repostedBy) post.reposted_by = snapshot.repostedBy;
    if (snapshot.promoted) post.promoted = true;
    if (snapshot.card) {
      const card = {};
      if (snapshot.card.domain) card.domain = snapshot.card.domain;
      if (snapshot.card.title) card.title = snapshot.card.title;
      if (snapshot.card.description) card.description = snapshot.card.description;
      if (Object.keys(card).length > 0) post.link_card = card;
    }
    if (outerMedia.length > 0) post.media = outerMedia;
    if (snapshot.quoted) {
      const q = {
        author: formatAuthor(snapshot.quoted.authorHandle, snapshot.quoted.authorName),
        text: snapshot.quoted.text
      };
      if (snapshot.quoted.truncated) q.text_truncated = true;
      if (quotedMedia.length > 0) q.media = quotedMedia;
      post.quoted_post = q;
    }
    const media_status = snapshot.media.length === 0 ? "none" : transcripts ? "transcribed" : "not_transcribed";
    return { post, media_status };
  }

  // shared/decide.ts
  var RULE_B_INTENSITY = 2.5;
  var RULE_B_MARGIN = 0.1;
  var RULE_B_CAP = 0.99;
  function isNum(v) {
    return typeof v === "number" && Number.isFinite(v);
  }
  function isProbMap(v) {
    return !!v && typeof v === "object" && Object.values(v).every(isNum);
  }
  function isValidAnswers(a) {
    if (!a || typeof a !== "object") return false;
    const x = a;
    return isNum(x.ragebait?.noul) && isProbMap(x.category?.probabilities) && isProbMap(x.emotion?.probabilities) && isProbMap(x.topic?.probabilities) && isNum(x.intensity?.score);
  }
  function topKey(probabilities) {
    let best;
    for (const [key, p] of Object.entries(probabilities)) {
      if (!best || p > best.p) best = { key, p };
    }
    return best;
  }
  var f2 = (n) => n.toFixed(2);
  var f1 = (n) => n.toFixed(1);
  function decide(answers, threshold) {
    if (!isValidAnswers(answers)) return { hide: false, reasons: ["no verdict"] };
    const T = threshold;
    const p = answers.ragebait.noul;
    const probs = answers.category.probabilities;
    const c = HIDE_CATEGORIES.reduce((sum, k) => sum + (isNum(probs[k]) ? probs[k] : 0), 0);
    const i = answers.intensity.score;
    const tB = Math.min(T + RULE_B_MARGIN, RULE_B_CAP);
    const topCategory = topKey(probs);
    const topEmotion = topKey(answers.emotion.probabilities);
    const topTopic = topKey(answers.topic.probabilities);
    const reasons = [];
    const ruleA = p >= T;
    const ruleB = c >= tB && i >= RULE_B_INTENSITY;
    if (ruleA) reasons.push(`ragebait ${f2(p)} \u2265 ${f2(T)}`);
    if (ruleB) {
      reasons.push(
        `hide-kinds ${f2(c)} \u2265 ${f2(tB)} & intensity ${f1(i)} \u2265 ${f1(RULE_B_INTENSITY)}` + (topCategory ? ` (top: ${topCategory.key})` : "")
      );
    }
    if (!ruleA && !ruleB) reasons.push(`ragebait ${f2(p)} < ${f2(T)}`);
    return {
      hide: ruleA || ruleB,
      reasons,
      ragebait: p,
      hideCategoryMass: c,
      intensity: i,
      topCategory,
      topEmotion,
      topTopic
    };
  }

  // shared/hash.ts
  function stableStringify(value) {
    return JSON.stringify(sortDeep(value));
  }
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map((x) => x === void 0 ? null : sortDeep(x));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        const val = v[k];
        if (val !== void 0) out[k] = sortDeep(val);
      }
      return out;
    }
    return v;
  }
  function hash53(str, seed = 0) {
    let h1 = 3735928559 ^ seed;
    let h2 = 1103547991 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
    h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // extension/src/background/media.ts
  var MAX_MEDIA_BYTES = 3.5 * 1024 * 1024;
  var MEDIA_FETCH_TIMEOUT_MS = 15e3;
  var CHUNK = 32768;
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function isAllowedMediaUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && u.hostname === "pbs.twimg.com";
    } catch {
      return false;
    }
  }
  async function fetchOne(m, fetchImpl, timeoutMs) {
    if (!isAllowedMediaUrl(m.url)) return void 0;
    const res = await fetchImpl(m.url, { credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return void 0;
    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mediaType.startsWith("image/")) return void 0;
    if (Number(res.headers.get("content-length")) > MAX_MEDIA_BYTES) return void 0;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_MEDIA_BYTES) return void 0;
    return { key: m.key, kind: m.kind, inQuote: m.inQuote, alt: m.alt, mediaType, dataBase64: arrayBufferToBase64(buf) };
  }
  async function fetchMediaItems(media, fetchImpl = fetch, max = MAX_VISION_ITEMS, timeoutMs = MEDIA_FETCH_TIMEOUT_MS) {
    const picked = media.slice(0, max);
    const results = await Promise.all(picked.map((m) => fetchOne(m, fetchImpl, timeoutMs).catch(() => void 0)));
    const items = [];
    const failed = [];
    results.forEach((item, i) => {
      if (item) items.push(item);
      else failed.push(picked[i].key);
    });
    return { items, failed };
  }

  // extension/src/background/queue.ts
  var Semaphore = class {
    max;
    running = 0;
    queue = [];
    constructor(max) {
      this.max = max;
    }
    get active() {
      return this.running;
    }
    get waiting() {
      return this.queue.length;
    }
    async run(fn) {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    }
    acquire() {
      if (this.running < this.max) {
        this.running++;
        return Promise.resolve();
      }
      return new Promise((resolve) => this.queue.push(resolve));
    }
    release() {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  };
  var LruCache = class {
    max;
    map = /* @__PURE__ */ new Map();
    constructor(max) {
      this.max = max;
    }
    get size() {
      return this.map.size;
    }
    get(k) {
      if (!this.map.has(k)) return void 0;
      const v = this.map.get(k);
      this.map.delete(k);
      this.map.set(k, v);
      return v;
    }
    set(k, v) {
      this.map.delete(k);
      this.map.set(k, v);
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
  };
  var InFlight = class {
    map = /* @__PURE__ */ new Map();
    run(key, fn) {
      const existing = this.map.get(key);
      if (existing) return existing;
      const p = Promise.resolve().then(fn).finally(() => {
        if (this.map.get(key) === p) this.map.delete(key);
      });
      this.map.set(key, p);
      return p;
    }
  };

  // extension/src/background/pipeline.ts
  function createPipelineDeps(native2, settings2, stats2, fetchMedia = (m) => fetchMediaItems(m)) {
    return {
      native: native2,
      settings: settings2,
      fetchMedia,
      textSem: new Semaphore(6),
      visionSem: new Semaphore(2),
      lru: new LruCache(500),
      inflight: new InFlight(),
      now: Date.now,
      stats: stats2
    };
  }
  async function classifyCached(state, deps2) {
    const key = hash53(stableStringify(state));
    const hit = deps2.lru.get(key);
    if (hit) return { ...hit, cached: true };
    return deps2.inflight.run(key, async () => {
      const r = await deps2.textSem.run(
        () => deps2.native.request({ type: "classify", state }, TIMEOUTS.classify)
      );
      deps2.lru.set(key, r.result);
      return r.result;
    });
  }
  function errorInfo(e) {
    if (e instanceof NativeCallError) return e.info;
    return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
  }
  function visionStatus(snapshot, s, jev) {
    if (snapshot.media.length === 0) return "none";
    if (!s.visionEnabled) return "disabled";
    if (!jev) return "failed";
    if (decide(jev.answers, s.threshold).hide) return "skipped_flagged";
    return "pending";
  }
  async function processPost(msg, emit, deps2) {
    try {
      await run(msg, emit, deps2);
    } catch {
    }
  }
  async function run(msg, emit, deps2) {
    const { snapshot, snapHash } = msg;
    const { stats: stats2 } = deps2;
    const s = deps2.settings();
    const base = { type: "result", postId: snapshot.postId, snapHash };
    const t0 = deps2.now();
    let jev;
    stats2.pending.text++;
    try {
      jev = await classifyCached(buildJevState(snapshot), deps2);
    } catch (e) {
      emit({ ...base, stage: "text", vision: visionStatus(snapshot, s, void 0), error: errorInfo(e), timings: { textMs: deps2.now() - t0 } });
      return;
    } finally {
      stats2.pending.text--;
    }
    const textMs = deps2.now() - t0;
    stats2.record("text", textMs);
    const vision = visionStatus(snapshot, s, jev);
    emit({ ...base, stage: "text", jev, vision, timings: { textMs } });
    if (vision !== "pending") return;
    let full;
    stats2.pending.vision++;
    try {
      const tv = deps2.now();
      const { items } = await deps2.fetchMedia(snapshot.media);
      if (items.length === 0) {
        full = {
          ...base,
          stage: "full",
          vision: "failed",
          error: { code: "MEDIA_FETCH_FAILED", message: "no media could be fetched" },
          timings: { textMs }
        };
      } else {
        const tr = await deps2.visionSem.run(
          () => deps2.native.request(
            { type: "transcribe", model: s.transcriptModel, items },
            TIMEOUTS.transcribe
          )
        );
        const visionMs = deps2.now() - tv;
        stats2.setRateLimit(tr.rateLimit);
        stats2.record("vision", visionMs);
        const tf = deps2.now();
        const jev2 = await classifyCached(buildJevState(snapshot, tr.transcripts), deps2);
        const fullMs = deps2.now() - tf;
        stats2.record("full", fullMs);
        full = {
          ...base,
          stage: "full",
          jev: jev2,
          vision: "done",
          transcripts: tr.transcripts,
          timings: { textMs, visionMs, fullMs }
        };
      }
    } catch (e) {
      full = { ...base, stage: "full", vision: "failed", error: errorInfo(e), timings: { textMs } };
    } finally {
      stats2.pending.vision--;
    }
    emit(full);
  }

  // shared/day.ts
  function localDay(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // extension/src/background/store.ts
  var MAX_HIDDEN_IDS = 1e4;
  var MAX_FEEDBACK = 5e3;
  var chain = Promise.resolve();
  function locked(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {
    });
    return p;
  }
  function recordHidden(storage, postId, now = /* @__PURE__ */ new Date()) {
    return locked(async () => {
      const day = localDay(now);
      const stored = (await storage.get(STORAGE_KEYS.stats))[STORAGE_KEYS.stats];
      const ids = stored && typeof stored === "object" && stored.day === day && Array.isArray(stored.hiddenIds) ? stored.hiddenIds : [];
      if (!ids.includes(postId)) ids.push(postId);
      const stats2 = { day, hiddenIds: ids.slice(-MAX_HIDDEN_IDS) };
      await storage.set({ [STORAGE_KEYS.stats]: stats2 });
      return stats2.hiddenIds.length;
    });
  }
  function appendFeedback(storage, entry) {
    return locked(async () => {
      const stored = (await storage.get(STORAGE_KEYS.feedback))[STORAGE_KEYS.feedback];
      const feedback = [...Array.isArray(stored) ? stored : [], entry].slice(-MAX_FEEDBACK);
      await storage.set({ [STORAGE_KEYS.feedback]: feedback });
      return feedback.length;
    });
  }

  // extension/src/background/main.ts
  var flavor = "dev";
  var noop = () => {
  };
  var settings = effectiveSettings(void 0, flavor);
  var settingsReady = chrome.storage.local.get(STORAGE_KEYS.settings).then((r) => {
    settings = effectiveSettings(r[STORAGE_KEYS.settings], flavor);
  }).catch(noop).finally(updateBadge);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(STORAGE_KEYS.settings in changes)) return;
    settings = effectiveSettings(changes[STORAGE_KEYS.settings].newValue, flavor);
    updateBadge();
  });
  var native = new NativeClient({
    connect: () => chrome.runtime.connectNative(HOST_NAME),
    flavor,
    extVersion: chrome.runtime.getManifest().version,
    lastError: () => chrome.runtime.lastError?.message,
    onStatus: updateBadge
  });
  function updateBadge() {
    const alarm = native.getStatus().companion === "offline" && isClassificationActive(settings);
    if (alarm) {
      chrome.action.setBadgeText({ text: "!" }).catch(noop);
      chrome.action.setBadgeBackgroundColor({ color: "#d93025" }).catch(noop);
      chrome.action.setTitle({ title: "Low Cortisol: companion offline, nothing is filtered" }).catch(noop);
    } else {
      chrome.action.setBadgeText({ text: "" }).catch(noop);
      chrome.action.setTitle({ title: flavor === "dev" ? "Low Cortisol (Dev)" : "Low Cortisol" }).catch(noop);
    }
  }
  var SAMPLES = 50;
  var samples = { text: [], vision: [], full: [] };
  var rateLimit;
  var selectorHealth;
  var stats = {
    pending: { text: 0, vision: 0 },
    record(kind, ms) {
      const a = samples[kind];
      a.push(ms);
      if (a.length > SAMPLES) a.shift();
    },
    setRateLimit(r) {
      if (r) rateLimit = r;
    }
  };
  function avg(kind) {
    const a = samples[kind];
    return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : void 0;
  }
  var deps = createPipelineDeps(native, () => settings, stats);
  function safePost(port, r) {
    try {
      port.postMessage(r);
    } catch {
    }
  }
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "post":
          void settingsReady.then(() => {
            if (isClassificationActive(settings)) return processPost(msg, (r) => safePost(port, r), deps);
          });
          break;
        case "hidden":
          recordHidden(chrome.storage.local, msg.postId).catch(noop);
          break;
        case "feedback":
          appendFeedback(chrome.storage.local, msg.entry).catch(noop);
          break;
        case "health":
          selectorHealth = { ok: msg.ok, cells: msg.cells, articles: msg.articles, parsed: msg.parsed };
          break;
      }
    });
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "getStatus") return;
    const status = {
      ...native.getStatus(),
      pending: { ...stats.pending },
      avgMs: { text: avg("text"), vision: avg("vision"), full: avg("full") },
      rateLimit,
      selectorHealth
    };
    sendResponse(status);
  });
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc2hhcmVkL3Byb3RvY29sLnRzIiwgIi4uLy4uL3NoYXJlZC9zZXR0aW5ncy50cyIsICIuLi8uLi9leHRlbnNpb24vc3JjL2JhY2tncm91bmQvbmF0aXZlLnRzIiwgIi4uLy4uL3NoYXJlZC9ydWJyaWMudHMiLCAiLi4vLi4vc2hhcmVkL2RlY2lkZS50cyIsICIuLi8uLi9zaGFyZWQvaGFzaC50cyIsICIuLi8uLi9leHRlbnNpb24vc3JjL2JhY2tncm91bmQvbWVkaWEudHMiLCAiLi4vLi4vZXh0ZW5zaW9uL3NyYy9iYWNrZ3JvdW5kL3F1ZXVlLnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvYmFja2dyb3VuZC9waXBlbGluZS50cyIsICIuLi8uLi9zaGFyZWQvZGF5LnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvYmFja2dyb3VuZC9zdG9yZS50cyIsICIuLi8uLi9leHRlbnNpb24vc3JjL2JhY2tncm91bmQvbWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gTWVzc2FnZSBjb250cmFjdHM6IGV4dGVuc2lvbiBcdTIxOTQgY29tcGFuaW9uIChOYXRpdmUgTWVzc2FnaW5nKSwgY29udGVudCBcdTIxOTQgc2VydmljZSB3b3JrZXIsIHBvcHVwIFx1MjE5NCBTVy5cbi8vIFNwZWM6IGRvY3Mvc3VwZXJwb3dlcnMvc3BlY3MvMjAyNi0wOS0zMC1sb3ctY29ydGlzb2wtZGVzaWduLm1kIFx1MDBBNzQuMiwgXHUwMEE3NVxuXG5pbXBvcnQgdHlwZSB7XG4gIEVycm9ySW5mbyxcbiAgRmxhdm9yLFxuICBKZXZBbnN3ZXJzLFxuICBKZXZSZXN1bHQsXG4gIEpldlN0YXRlLFxuICBNZWRpYUtpbmQsXG4gIE1lZGlhVHJhbnNjcmlwdCxcbiAgUG9zdFNuYXBzaG90LFxuICBSYXRlTGltaXRJbmZvLFxuICBUcmFuc2NyaXB0TW9kZWwsXG4gIFZpc2lvblN0YXR1cyxcbn0gZnJvbSAnLi90eXBlcyc7XG5cbmV4cG9ydCBjb25zdCBIT1NUX05BTUUgPSAnY29tLmxvd2NvcnRpc29sLmNvbXBhbmlvbic7XG5leHBvcnQgY29uc3QgUE9SVF9OQU1FID0gJ2xjJztcbmV4cG9ydCBjb25zdCBNQVhfVklTSU9OX0lURU1TID0gNjtcblxuZXhwb3J0IGNvbnN0IFNUT1JBR0VfS0VZUyA9IHtcbiAgc2V0dGluZ3M6ICdzZXR0aW5ncycsXG4gIHN0YXRzOiAnc3RhdHMnLFxuICBmZWVkYmFjazogJ2ZlZWRiYWNrJyxcbn0gYXMgY29uc3Q7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0gRXh0ZW5zaW9uIFx1MjE5NCBjb21wYW5pb24gLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIFRyYW5zY3JpYmVJdGVtIHtcbiAga2V5OiBzdHJpbmc7XG4gIGtpbmQ6IE1lZGlhS2luZDtcbiAgaW5RdW90ZTogYm9vbGVhbjtcbiAgYWx0Pzogc3RyaW5nO1xuICAvKiogZS5nLiBcImltYWdlL2pwZWdcIiAqL1xuICBtZWRpYVR5cGU6IHN0cmluZztcbiAgZGF0YUJhc2U2NDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhlbGxvUmVxdWVzdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHR5cGU6ICdoZWxsbyc7XG4gIGZsYXZvcjogRmxhdm9yO1xuICBleHRWZXJzaW9uOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2xhc3NpZnlSZXF1ZXN0IHtcbiAgaWQ6IHN0cmluZztcbiAgdHlwZTogJ2NsYXNzaWZ5JztcbiAgc3RhdGU6IEpldlN0YXRlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRyYW5zY3JpYmVSZXF1ZXN0IHtcbiAgaWQ6IHN0cmluZztcbiAgdHlwZTogJ3RyYW5zY3JpYmUnO1xuICBtb2RlbDogVHJhbnNjcmlwdE1vZGVsO1xuICBpdGVtczogVHJhbnNjcmliZUl0ZW1bXTtcbn1cblxuZXhwb3J0IHR5cGUgSG9zdFJlcXVlc3QgPSBIZWxsb1JlcXVlc3QgfCBDbGFzc2lmeVJlcXVlc3QgfCBUcmFuc2NyaWJlUmVxdWVzdDtcbmV4cG9ydCB0eXBlIEhvc3RSZXF1ZXN0VHlwZSA9IEhvc3RSZXF1ZXN0Wyd0eXBlJ107XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGVsbG9SZXNwb25zZSB7XG4gIGlkOiBzdHJpbmc7XG4gIG9rOiB0cnVlO1xuICB0eXBlOiAnaGVsbG8nO1xuICBjb21wYW5pb25WZXJzaW9uOiBzdHJpbmc7XG4gIGpldkNvbmZpZ3VyZWQ6IGJvb2xlYW47XG4gIGNsYXVkZUZvdW5kOiBib29sZWFuO1xuICBjbGF1ZGVQYXRoPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENsYXNzaWZ5UmVzcG9uc2Uge1xuICBpZDogc3RyaW5nO1xuICBvazogdHJ1ZTtcbiAgdHlwZTogJ2NsYXNzaWZ5JztcbiAgcmVzdWx0OiBKZXZSZXN1bHQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNjcmliZU91dHB1dCB7XG4gIHRyYW5zY3JpcHRzOiBNZWRpYVRyYW5zY3JpcHRbXTtcbiAgbGF0ZW5jeU1zOiBudW1iZXI7XG4gIC8qKiBLZXlzIHNlcnZlZCBmcm9tIHRoZSBjb21wYW5pb24gY2FjaGUgKG5vIGNsYXVkZSBjYWxsIG5lZWRlZCBmb3IgdGhlbSkuICovXG4gIGNhY2hlZEtleXM6IHN0cmluZ1tdO1xuICByYXRlTGltaXQ/OiBSYXRlTGltaXRJbmZvO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRyYW5zY3JpYmVSZXNwb25zZSBleHRlbmRzIFRyYW5zY3JpYmVPdXRwdXQge1xuICBpZDogc3RyaW5nO1xuICBvazogdHJ1ZTtcbiAgdHlwZTogJ3RyYW5zY3JpYmUnO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVycm9yUmVzcG9uc2Uge1xuICBpZDogc3RyaW5nO1xuICBvazogZmFsc2U7XG4gIHR5cGU6IEhvc3RSZXF1ZXN0VHlwZSB8ICd1bmtub3duJztcbiAgZXJyb3I6IEVycm9ySW5mbztcbn1cblxuZXhwb3J0IHR5cGUgSG9zdFJlc3BvbnNlID0gSGVsbG9SZXNwb25zZSB8IENsYXNzaWZ5UmVzcG9uc2UgfCBUcmFuc2NyaWJlUmVzcG9uc2UgfCBFcnJvclJlc3BvbnNlO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tIENvbnRlbnQgc2NyaXB0IFx1MjE5NCBzZXJ2aWNlIHdvcmtlciAocG9ydCBQT1JUX05BTUUpIC0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBQb3N0TXNnIHtcbiAgdHlwZTogJ3Bvc3QnO1xuICBzbmFwc2hvdDogUG9zdFNuYXBzaG90O1xuICAvKiogaGFzaDUzKHN0YWJsZVN0cmluZ2lmeShzbmFwc2hvdCkpOyBlY2hvZWQgYmFjayBpbiByZXN1bHRzIHNvIHN0YWxlIHJlc3VsdHMgY2FuIGJlIGlnbm9yZWQuICovXG4gIHNuYXBIYXNoOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGlkZGVuTXNnIHtcbiAgdHlwZTogJ2hpZGRlbic7XG4gIHBvc3RJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZlZWRiYWNrTXNnIHtcbiAgdHlwZTogJ2ZlZWRiYWNrJztcbiAgZW50cnk6IEZlZWRiYWNrRW50cnk7XG59XG5cbi8qKiBTZWxlY3RvciBoZWFsdGggZnJvbSBjaGVja0hlYWx0aCgpOyBzZW50IG9ubHkgd2hlbiBgb2tgIGZsaXBzIChzcGVjIFx1MDBBNzQuMSkuICovXG5leHBvcnQgaW50ZXJmYWNlIEhlYWx0aE1zZyB7XG4gIHR5cGU6ICdoZWFsdGgnO1xuICBvazogYm9vbGVhbjtcbiAgY2VsbHM6IG51bWJlcjtcbiAgYXJ0aWNsZXM6IG51bWJlcjtcbiAgcGFyc2VkOiBudW1iZXI7XG59XG5cbmV4cG9ydCB0eXBlIENvbnRlbnRUb1N3ID0gUG9zdE1zZyB8IEhpZGRlbk1zZyB8IEZlZWRiYWNrTXNnIHwgSGVhbHRoTXNnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlc3VsdFRpbWluZ3Mge1xuICB0ZXh0TXM/OiBudW1iZXI7XG4gIHZpc2lvbk1zPzogbnVtYmVyO1xuICBmdWxsTXM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzdWx0TXNnIHtcbiAgdHlwZTogJ3Jlc3VsdCc7XG4gIHBvc3RJZDogc3RyaW5nO1xuICBzbmFwSGFzaDogc3RyaW5nO1xuICBzdGFnZTogJ3RleHQnIHwgJ2Z1bGwnO1xuICBqZXY/OiBKZXZSZXN1bHQ7XG4gIHZpc2lvbjogVmlzaW9uU3RhdHVzO1xuICB0cmFuc2NyaXB0cz86IE1lZGlhVHJhbnNjcmlwdFtdO1xuICBlcnJvcj86IEVycm9ySW5mbztcbiAgdGltaW5nczogUmVzdWx0VGltaW5ncztcbn1cblxuZXhwb3J0IHR5cGUgU3dUb0NvbnRlbnQgPSBSZXN1bHRNc2c7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0gUG9wdXAgXHUyMTk0IHNlcnZpY2Ugd29ya2VyIC0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBHZXRTdGF0dXNNc2cge1xuICB0eXBlOiAnZ2V0U3RhdHVzJztcbn1cblxuZXhwb3J0IHR5cGUgQ29tcGFuaW9uU3RhdHVzID0gJ2Nvbm5lY3RpbmcnIHwgJ29ubGluZScgfCAnb2ZmbGluZSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhdHVzU25hcHNob3Qge1xuICBjb21wYW5pb246IENvbXBhbmlvblN0YXR1cztcbiAgY29tcGFuaW9uVmVyc2lvbj86IHN0cmluZztcbiAgamV2Q29uZmlndXJlZD86IGJvb2xlYW47XG4gIGNsYXVkZUZvdW5kPzogYm9vbGVhbjtcbiAgbGFzdEVycm9yPzogc3RyaW5nO1xuICBwZW5kaW5nOiB7IHRleHQ6IG51bWJlcjsgdmlzaW9uOiBudW1iZXIgfTtcbiAgYXZnTXM6IHsgdGV4dD86IG51bWJlcjsgdmlzaW9uPzogbnVtYmVyOyBmdWxsPzogbnVtYmVyIH07XG4gIHJhdGVMaW1pdD86IFJhdGVMaW1pdEluZm87XG4gIC8qKiBMYXN0IHNlbGVjdG9yIGhlYWx0aCByZXBvcnRlZCBieSBhbnkgdGFiLiAqL1xuICBzZWxlY3RvckhlYWx0aD86IE9taXQ8SGVhbHRoTXNnLCAndHlwZSc+O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tIFN0b3JhZ2UgcmVjb3JkcyAtLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgSGlkZGVuU3RhdHMge1xuICAvKiogTG9jYWwgY2FsZW5kYXIgZGF5LCBcIllZWVktTU0tRERcIi4gKi9cbiAgZGF5OiBzdHJpbmc7XG4gIGhpZGRlbklkczogc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmVlZGJhY2tFbnRyeSB7XG4gIC8qKiBJU08gdGltZXN0YW1wLiAqL1xuICBhdDogc3RyaW5nO1xuICBmbGF2b3I6IEZsYXZvcjtcbiAgcG9zdElkOiBzdHJpbmc7XG4gIHVybDogc3RyaW5nO1xuICAvKiogVGhlIG93bmVyJ3MgbGFiZWwuICovXG4gIGxhYmVsOiAnaGlkZScgfCAna2VlcCc7XG4gIC8qKiBXaGF0IExvdyBDb3J0aXNvbCBkZWNpZGVkIGF0IGB0aHJlc2hvbGRgLiAqL1xuICB2ZXJkaWN0OiAnaGlkZScgfCAna2VlcCc7XG4gIHRocmVzaG9sZDogbnVtYmVyO1xuICBydWJyaWNWZXJzaW9uOiBzdHJpbmc7XG4gIGpldk1vZGVsOiBzdHJpbmc7XG4gIHN0YWdlOiAndGV4dCcgfCAnZnVsbCc7XG4gIGFuc3dlcnM6IEpldkFuc3dlcnM7XG4gIC8qKiBFeGFjdCBKZXYgaW5wdXQgKGluY2x1ZGVzIHRyYW5zY3JpcHRzIG9uIHRoZSBmdWxsIHN0YWdlKS4gKi9cbiAgc3RhdGU6IEpldlN0YXRlO1xufVxuIiwgIi8vIFNldHRpbmdzIGRlZmF1bHRzIHBlciBmbGF2b3IgYW5kIHRoZSBwcm9kL2RldiBcImVmZmVjdGl2ZSBzZXR0aW5nc1wiIHJ1bGUuIFNwZWMgXHUwMEE3My4xXG5cbmltcG9ydCB0eXBlIHsgRmxhdm9yLCBTZXR0aW5ncywgVHJhbnNjcmlwdE1vZGVsIH0gZnJvbSAnLi90eXBlcyc7XG5cbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfTUlOID0gMC41O1xuZXhwb3J0IGNvbnN0IFRIUkVTSE9MRF9NQVggPSAwLjk1O1xuZXhwb3J0IGNvbnN0IFRIUkVTSE9MRF9TVEVQID0gMC4wNTtcblxuZXhwb3J0IGNvbnN0IFRIUkVTSE9MRF9QUkVTRVRTID0ge1xuICBhZ2dyZXNzaXZlOiAwLjU1LFxuICBiYWxhbmNlZDogMC43LFxuICBjb25zZXJ2YXRpdmU6IDAuODUsXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBUaHJlc2hvbGRQcmVzZXQgPSBrZXlvZiB0eXBlb2YgVEhSRVNIT0xEX1BSRVNFVFM7XG5cbi8qKiBNb2RlbCBpZHMgdmVyaWZpZWQgd2l0aCBDbGF1ZGUgQ29kZSBDTEkgMi4xLjI4MSBvbiAyMDI2LTA5LTMwIChzZWUgZG9jcy9vd25lci1hbnN3ZXJzLm1kKS4gKi9cbmV4cG9ydCBjb25zdCBUUkFOU0NSSVBUX01PREVMUzogUmVhZG9ubHlBcnJheTx7IGlkOiBUcmFuc2NyaXB0TW9kZWw7IGxhYmVsOiBzdHJpbmcgfT4gPSBbXG4gIHsgaWQ6ICdjbGF1ZGUtb3B1cy01LTUnLCBsYWJlbDogJ09wdXMgNS41IChkZWZhdWx0KScgfSxcbiAgeyBpZDogJ2NsYXVkZS1zb25uZXQtNS01JywgbGFiZWw6ICdTb25uZXQgNS41JyB9LFxuXTtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfVFJBTlNDUklQVF9NT0RFTDogVHJhbnNjcmlwdE1vZGVsID0gJ2NsYXVkZS1vcHVzLTUtNSc7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBSZWFkb25seTxSZWNvcmQ8Rmxhdm9yLCBSZWFkb25seTxTZXR0aW5ncz4+PiA9IHtcbiAgcHJvZDoge1xuICAgIGhpZGVFbmFibGVkOiB0cnVlLFxuICAgIHNob3dSZXN1bHRzOiBmYWxzZSxcbiAgICB0aHJlc2hvbGQ6IFRIUkVTSE9MRF9QUkVTRVRTLmJhbGFuY2VkLFxuICAgIHZpc2lvbkVuYWJsZWQ6IHRydWUsXG4gICAgdHJhbnNjcmlwdE1vZGVsOiBERUZBVUxUX1RSQU5TQ1JJUFRfTU9ERUwsXG4gICAgc2hvd1RyYW5zY3JpcHQ6IGZhbHNlLFxuICAgIHNob3dTdGF0dXM6IGZhbHNlLFxuICB9LFxuICBkZXY6IHtcbiAgICAvLyBEZXYgc3RhcnRzIGluIGxhYmVsaW5nIG1vZGU6IHNob3dzIHdoYXQgaXQgd291bGQgaGlkZSB3aXRob3V0IGhpZGluZy5cbiAgICBoaWRlRW5hYmxlZDogZmFsc2UsXG4gICAgc2hvd1Jlc3VsdHM6IHRydWUsXG4gICAgdGhyZXNob2xkOiBUSFJFU0hPTERfUFJFU0VUUy5iYWxhbmNlZCxcbiAgICB2aXNpb25FbmFibGVkOiB0cnVlLFxuICAgIHRyYW5zY3JpcHRNb2RlbDogREVGQVVMVF9UUkFOU0NSSVBUX01PREVMLFxuICAgIHNob3dUcmFuc2NyaXB0OiB0cnVlLFxuICAgIHNob3dTdGF0dXM6IHRydWUsXG4gIH0sXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gY2xhbXBUaHJlc2hvbGQobjogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlciA9IFRIUkVTSE9MRF9QUkVTRVRTLmJhbGFuY2VkKTogbnVtYmVyIHtcbiAgaWYgKHR5cGVvZiBuICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzRmluaXRlKG4pKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IGNsYW1wZWQgPSBNYXRoLm1pbihUSFJFU0hPTERfTUFYLCBNYXRoLm1heChUSFJFU0hPTERfTUlOLCBuKSk7XG4gIHJldHVybiBNYXRoLnJvdW5kKGNsYW1wZWQgKiAxMDApIC8gMTAwO1xufVxuXG5mdW5jdGlvbiBpc1RyYW5zY3JpcHRNb2RlbCh2OiB1bmtub3duKTogdiBpcyBUcmFuc2NyaXB0TW9kZWwge1xuICByZXR1cm4gVFJBTlNDUklQVF9NT0RFTFMuc29tZSgobSkgPT4gbS5pZCA9PT0gdik7XG59XG5cbmZ1bmN0aW9uIGJvb2wodjogdW5rbm93biwgZmFsbGJhY2s6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnYm9vbGVhbicgPyB2IDogZmFsbGJhY2s7XG59XG5cbi8qKlxuICogUHJvZCBvbmx5IGhvbm91cnMgYGhpZGVFbmFibGVkYDsgZXZlcnl0aGluZyBlbHNlIGlzIGZvcmNlZCB0byBwcm9kIGRlZmF1bHRzIChwcm9kIGNhbiBuZXZlciBzaG93IHBhbmVscykuXG4gKiBEZXYgbWVyZ2VzIHN0b3JlZCB2YWx1ZXMgb3ZlciBkZXYgZGVmYXVsdHMsIGlnbm9yaW5nIHdyb25nIHR5cGVzIGFuZCBjbGFtcGluZyB0aGUgdGhyZXNob2xkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlU2V0dGluZ3Moc3RvcmVkOiB1bmtub3duLCBmbGF2b3I6IEZsYXZvcik6IFNldHRpbmdzIHtcbiAgY29uc3QgcyA9IChzdG9yZWQgJiYgdHlwZW9mIHN0b3JlZCA9PT0gJ29iamVjdCcgPyBzdG9yZWQgOiB7fSkgYXMgUGFydGlhbDxSZWNvcmQ8a2V5b2YgU2V0dGluZ3MsIHVua25vd24+PjtcbiAgY29uc3QgZCA9IERFRkFVTFRfU0VUVElOR1NbZmxhdm9yXTtcbiAgaWYgKGZsYXZvciA9PT0gJ3Byb2QnKSB7XG4gICAgcmV0dXJuIHsgLi4uZCwgaGlkZUVuYWJsZWQ6IGJvb2wocy5oaWRlRW5hYmxlZCwgZC5oaWRlRW5hYmxlZCkgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGhpZGVFbmFibGVkOiBib29sKHMuaGlkZUVuYWJsZWQsIGQuaGlkZUVuYWJsZWQpLFxuICAgIHNob3dSZXN1bHRzOiBib29sKHMuc2hvd1Jlc3VsdHMsIGQuc2hvd1Jlc3VsdHMpLFxuICAgIHRocmVzaG9sZDogY2xhbXBUaHJlc2hvbGQocy50aHJlc2hvbGQsIGQudGhyZXNob2xkKSxcbiAgICB2aXNpb25FbmFibGVkOiBib29sKHMudmlzaW9uRW5hYmxlZCwgZC52aXNpb25FbmFibGVkKSxcbiAgICB0cmFuc2NyaXB0TW9kZWw6IGlzVHJhbnNjcmlwdE1vZGVsKHMudHJhbnNjcmlwdE1vZGVsKSA/IHMudHJhbnNjcmlwdE1vZGVsIDogZC50cmFuc2NyaXB0TW9kZWwsXG4gICAgc2hvd1RyYW5zY3JpcHQ6IGJvb2wocy5zaG93VHJhbnNjcmlwdCwgZC5zaG93VHJhbnNjcmlwdCksXG4gICAgc2hvd1N0YXR1czogYm9vbChzLnNob3dTdGF0dXMsIGQuc2hvd1N0YXR1cyksXG4gIH07XG59XG5cbi8qKiBDbGFzc2lmaWNhdGlvbiBydW5zIChhbmQgYW55dGhpbmcgaXMgc2VudCBhbnl3aGVyZSkgb25seSB3aGVuIHRoaXMgaXMgdHJ1ZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0NsYXNzaWZpY2F0aW9uQWN0aXZlKHM6IFNldHRpbmdzKTogYm9vbGVhbiB7XG4gIHJldHVybiBzLmhpZGVFbmFibGVkIHx8IHMuc2hvd1Jlc3VsdHM7XG59XG4iLCAiLy8gTmF0aXZlIE1lc3NhZ2luZyBjbGllbnQgZm9yIHRoZSBjb21wYW5pb246IGxhenkgY29ubmVjdCwgaGVsbG8sIGlkLW1hdGNoZWQgcmVxdWVzdHMsIHRpbWVvdXRzLFxuLy8gZmFpbC1mYXN0IGJhY2tvZmYgYWZ0ZXIgYSBkaXNjb25uZWN0LiBTcGVjIFx1MDBBNzQuMlxuXG5pbXBvcnQgdHlwZSB7IENvbXBhbmlvblN0YXR1cywgSGVsbG9SZXNwb25zZSwgSG9zdFJlcXVlc3QsIEhvc3RSZXNwb25zZSwgU3RhdHVzU25hcHNob3QgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvcHJvdG9jb2wnO1xuaW1wb3J0IHR5cGUgeyBFcnJvckluZm8sIEZsYXZvciB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC90eXBlcyc7XG5cbmV4cG9ydCBjb25zdCBUSU1FT1VUUyA9IHsgaGVsbG86IDUwMDAsIGNsYXNzaWZ5OiAxMDAwMCwgdHJhbnNjcmliZTogMTIwMDAwIH0gYXMgY29uc3Q7XG5leHBvcnQgY29uc3QgQkFDS09GRl9NUyA9IFsxMDAwLCAyMDAwLCA1MDAwLCAxMDAwMCwgMzAwMDBdIGFzIGNvbnN0O1xuXG50eXBlIERpc3RyaWJ1dGl2ZU9taXQ8VCwgSyBleHRlbmRzIGtleW9mIGFueT4gPSBUIGV4dGVuZHMgdW5rbm93biA/IE9taXQ8VCwgSz4gOiBuZXZlcjtcbmV4cG9ydCB0eXBlIEhvc3RDYWxsID0gRGlzdHJpYnV0aXZlT21pdDxIb3N0UmVxdWVzdCwgJ2lkJz47XG5cbmV4cG9ydCBjbGFzcyBOYXRpdmVDYWxsRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGluZm86IEVycm9ySW5mbztcbiAgY29uc3RydWN0b3IoaW5mbzogRXJyb3JJbmZvKSB7XG4gICAgc3VwZXIoaW5mby5tZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSAnTmF0aXZlQ2FsbEVycm9yJztcbiAgICB0aGlzLmluZm8gPSBpbmZvO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUG9ydExpa2Uge1xuICBwb3N0TWVzc2FnZShtOiB1bmtub3duKTogdm9pZDtcbiAgZGlzY29ubmVjdCgpOiB2b2lkO1xuICBvbk1lc3NhZ2U6IHsgYWRkTGlzdGVuZXIoY2I6IChtOiBhbnkpID0+IHZvaWQpOiB2b2lkIH07XG4gIG9uRGlzY29ubmVjdDogeyBhZGRMaXN0ZW5lcihjYjogKCkgPT4gdm9pZCk6IHZvaWQgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBOYXRpdmVBcGkge1xuICAvKiogUmVzb2x2ZXMgb25seSBgb2s6dHJ1ZWAgcmVzcG9uc2VzOyByZWplY3RzIHdpdGggTmF0aXZlQ2FsbEVycm9yLiAqL1xuICByZXF1ZXN0PFIgZXh0ZW5kcyBIb3N0UmVzcG9uc2UgPSBIb3N0UmVzcG9uc2U+KGNhbGw6IEhvc3RDYWxsLCB0aW1lb3V0TXM/OiBudW1iZXIpOiBQcm9taXNlPFI+O1xuICBnZXRTdGF0dXMoKTogUGljazxTdGF0dXNTbmFwc2hvdCwgJ2NvbXBhbmlvbicgfCAnY29tcGFuaW9uVmVyc2lvbicgfCAnamV2Q29uZmlndXJlZCcgfCAnY2xhdWRlRm91bmQnIHwgJ2xhc3RFcnJvcic+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE5hdGl2ZUNsaWVudE9wdGlvbnMge1xuICBjb25uZWN0OiAoKSA9PiBQb3J0TGlrZTtcbiAgZmxhdm9yOiBGbGF2b3I7XG4gIGV4dFZlcnNpb246IHN0cmluZztcbiAgbGFzdEVycm9yPzogKCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBub3c/OiAoKSA9PiBudW1iZXI7XG4gIG9uU3RhdHVzPzogKHM6IENvbXBhbmlvblN0YXR1cykgPT4gdm9pZDtcbn1cblxuaW50ZXJmYWNlIFBlbmRpbmcge1xuICByZXNvbHZlOiAocjogSG9zdFJlc3BvbnNlKSA9PiB2b2lkO1xuICByZWplY3Q6IChlOiBOYXRpdmVDYWxsRXJyb3IpID0+IHZvaWQ7XG4gIHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pjtcbn1cblxuY29uc3Qgb2ZmbGluZSA9IChtZXNzYWdlOiBzdHJpbmcpID0+IG5ldyBOYXRpdmVDYWxsRXJyb3IoeyBjb2RlOiAnQ09NUEFOSU9OX09GRkxJTkUnLCBtZXNzYWdlIH0pO1xuXG5leHBvcnQgY2xhc3MgTmF0aXZlQ2xpZW50IGltcGxlbWVudHMgTmF0aXZlQXBpIHtcbiAgcHJpdmF0ZSByZWFkb25seSBvOiBOYXRpdmVDbGllbnRPcHRpb25zO1xuICBwcml2YXRlIHJlYWRvbmx5IG5vdzogKCkgPT4gbnVtYmVyO1xuICBwcml2YXRlIHBvcnQ/OiBQb3J0TGlrZTtcbiAgcHJpdmF0ZSBzZXEgPSAwO1xuICBwcml2YXRlIHJlYWRvbmx5IHBlbmRpbmcgPSBuZXcgTWFwPHN0cmluZywgUGVuZGluZz4oKTtcbiAgcHJpdmF0ZSBzdGF0dXM6IENvbXBhbmlvblN0YXR1cyA9ICdjb25uZWN0aW5nJztcbiAgcHJpdmF0ZSBjb21wYW5pb25WZXJzaW9uPzogc3RyaW5nO1xuICBwcml2YXRlIGpldkNvbmZpZ3VyZWQ/OiBib29sZWFuO1xuICBwcml2YXRlIGNsYXVkZUZvdW5kPzogYm9vbGVhbjtcbiAgcHJpdmF0ZSBsYXN0RXJyb3I/OiBzdHJpbmc7XG4gIHByaXZhdGUgZmFpbHVyZXMgPSAwO1xuICBwcml2YXRlIHJldHJ5QXQgPSAwO1xuXG4gIGNvbnN0cnVjdG9yKG86IE5hdGl2ZUNsaWVudE9wdGlvbnMpIHtcbiAgICB0aGlzLm8gPSBvO1xuICAgIHRoaXMubm93ID0gby5ub3cgPz8gRGF0ZS5ub3c7XG4gIH1cblxuICBnZXRTdGF0dXMoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbXBhbmlvbjogdGhpcy5zdGF0dXMsXG4gICAgICBjb21wYW5pb25WZXJzaW9uOiB0aGlzLmNvbXBhbmlvblZlcnNpb24sXG4gICAgICBqZXZDb25maWd1cmVkOiB0aGlzLmpldkNvbmZpZ3VyZWQsXG4gICAgICBjbGF1ZGVGb3VuZDogdGhpcy5jbGF1ZGVGb3VuZCxcbiAgICAgIGxhc3RFcnJvcjogdGhpcy5sYXN0RXJyb3IsXG4gICAgfTtcbiAgfVxuXG4gIHJlcXVlc3Q8UiBleHRlbmRzIEhvc3RSZXNwb25zZSA9IEhvc3RSZXNwb25zZT4oY2FsbDogSG9zdENhbGwsIHRpbWVvdXRNczogbnVtYmVyID0gVElNRU9VVFNbY2FsbC50eXBlXSk6IFByb21pc2U8Uj4ge1xuICAgIGlmICghdGhpcy5wb3J0KSB7XG4gICAgICBpZiAodGhpcy5ub3coKSA8IHRoaXMucmV0cnlBdCkgcmV0dXJuIFByb21pc2UucmVqZWN0KG9mZmxpbmUodGhpcy5sYXN0RXJyb3IgPz8gJ2NvbXBhbmlvbiBvZmZsaW5lJykpO1xuICAgICAgdGhpcy5vcGVuKCk7XG4gICAgICBpZiAoIXRoaXMucG9ydCkgcmV0dXJuIFByb21pc2UucmVqZWN0KG9mZmxpbmUodGhpcy5sYXN0RXJyb3IgPz8gJ2NvbXBhbmlvbiBvZmZsaW5lJykpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5zZW5kKHRoaXMucG9ydCwgY2FsbCwgdGltZW91dE1zKSBhcyBQcm9taXNlPFI+O1xuICB9XG5cbiAgcHJpdmF0ZSBvcGVuKCk6IHZvaWQge1xuICAgIHRoaXMuc2V0U3RhdHVzKCdjb25uZWN0aW5nJyk7XG4gICAgbGV0IHBvcnQ6IFBvcnRMaWtlO1xuICAgIHRyeSB7XG4gICAgICBwb3J0ID0gdGhpcy5vLmNvbm5lY3QoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0aGlzLmZhaWwoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5wb3J0ID0gcG9ydDtcbiAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobSkgPT4ge1xuICAgICAgaWYgKHRoaXMucG9ydCA9PT0gcG9ydCkgdGhpcy5vbk1lc3NhZ2UobSk7XG4gICAgfSk7XG4gICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgICAgaWYgKHRoaXMucG9ydCA9PT0gcG9ydCkgdGhpcy5mYWlsKHRoaXMuby5sYXN0RXJyb3I/LigpID8/ICdkaXNjb25uZWN0ZWQnKTtcbiAgICB9KTtcbiAgICB0aGlzLnNlbmQocG9ydCwgeyB0eXBlOiAnaGVsbG8nLCBmbGF2b3I6IHRoaXMuby5mbGF2b3IsIGV4dFZlcnNpb246IHRoaXMuby5leHRWZXJzaW9uIH0sIFRJTUVPVVRTLmhlbGxvKS50aGVuKFxuICAgICAgKHIpID0+IHtcbiAgICAgICAgaWYgKHRoaXMucG9ydCAhPT0gcG9ydCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBoID0gciBhcyBIZWxsb1Jlc3BvbnNlO1xuICAgICAgICB0aGlzLmNvbXBhbmlvblZlcnNpb24gPSBoLmNvbXBhbmlvblZlcnNpb247XG4gICAgICAgIHRoaXMuamV2Q29uZmlndXJlZCA9IGguamV2Q29uZmlndXJlZDtcbiAgICAgICAgdGhpcy5jbGF1ZGVGb3VuZCA9IGguY2xhdWRlRm91bmQ7XG4gICAgICAgIHRoaXMubGFzdEVycm9yID0gdW5kZWZpbmVkO1xuICAgICAgICB0aGlzLmZhaWx1cmVzID0gMDtcbiAgICAgICAgdGhpcy5zZXRTdGF0dXMoJ29ubGluZScpO1xuICAgICAgfSxcbiAgICAgIChlOiBOYXRpdmVDYWxsRXJyb3IpID0+IHtcbiAgICAgICAgLy8gQSBkaXNjb25uZWN0IGhhcyBhbHJlYWR5IGJlZW4gaGFuZGxlZCBieSBvbkRpc2Nvbm5lY3Q7IGEgdGltZW91dCBvciBlcnJvciByZXBseSBtZWFucyB0aGVcbiAgICAgICAgLy8gY29tcGFuaW9uIGlzIHVudXNhYmxlLCBzbyBkcm9wIGl0IGFuZCBiYWNrIG9mZiBsaWtlIGEgZGlzY29ubmVjdC5cbiAgICAgICAgaWYgKHRoaXMucG9ydCAhPT0gcG9ydCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBvcnQuZGlzY29ubmVjdCgpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBBbHJlYWR5IGRlYWQuXG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5mYWlsKGUuaW5mby5tZXNzYWdlKTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfVxuXG4gIHByaXZhdGUgc2VuZChwb3J0OiBQb3J0TGlrZSwgY2FsbDogSG9zdENhbGwsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTxIb3N0UmVzcG9uc2U+IHtcbiAgICBjb25zdCBpZCA9IFN0cmluZygrK3RoaXMuc2VxKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdFJlc3BvbnNlPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKGlkKTtcbiAgICAgICAgcmVqZWN0KG5ldyBOYXRpdmVDYWxsRXJyb3IoeyBjb2RlOiAnQ09NUEFOSU9OX1RJTUVPVVQnLCBtZXNzYWdlOiBgJHtjYWxsLnR5cGV9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc30gbXNgIH0pKTtcbiAgICAgIH0sIHRpbWVvdXRNcyk7XG4gICAgICB0aGlzLnBlbmRpbmcuc2V0KGlkLCB7IHJlc29sdmUsIHJlamVjdCwgdGltZXIgfSk7XG4gICAgICB0cnkge1xuICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgLi4uY2FsbCwgaWQgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIFBvc3RpbmcgdG8gYSBwb3J0IHRoYXQgZGllZCBiZWZvcmUgb25EaXNjb25uZWN0IGZpcmVkLlxuICAgICAgICBpZiAodGhpcy5wb3J0ID09PSBwb3J0KSB0aGlzLmZhaWwoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgb25NZXNzYWdlKG06IHVua25vd24pOiB2b2lkIHtcbiAgICBpZiAoIW0gfHwgdHlwZW9mIG0gIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgY29uc3QgciA9IG0gYXMgSG9zdFJlc3BvbnNlO1xuICAgIGNvbnN0IHAgPSB0aGlzLnBlbmRpbmcuZ2V0KHIuaWQpO1xuICAgIGlmICghcCkgcmV0dXJuO1xuICAgIGNsZWFyVGltZW91dChwLnRpbWVyKTtcbiAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKHIuaWQpO1xuICAgIGlmIChyLm9rID09PSB0cnVlKSBwLnJlc29sdmUocik7XG4gICAgZWxzZSBwLnJlamVjdChuZXcgTmF0aXZlQ2FsbEVycm9yKHIuZXJyb3IgPz8geyBjb2RlOiAnSU5URVJOQUwnLCBtZXNzYWdlOiAnbWFsZm9ybWVkIGNvbXBhbmlvbiByZXNwb25zZScgfSkpO1xuICB9XG5cbiAgLyoqIFBvcnQgaXMgZ29uZTogZ28gb2ZmbGluZSwgcmVqZWN0IGV2ZXJ5dGhpbmcgcGVuZGluZywgc2NoZWR1bGUgdGhlIGVhcmxpZXN0IHJlY29ubmVjdC4gKi9cbiAgcHJpdmF0ZSBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMucG9ydCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmxhc3RFcnJvciA9IG1lc3NhZ2U7XG4gICAgdGhpcy5mYWlsdXJlcysrO1xuICAgIHRoaXMucmV0cnlBdCA9IHRoaXMubm93KCkgKyBCQUNLT0ZGX01TW01hdGgubWluKHRoaXMuZmFpbHVyZXMgLSAxLCBCQUNLT0ZGX01TLmxlbmd0aCAtIDEpXTtcbiAgICBjb25zdCBwZW5kaW5nID0gWy4uLnRoaXMucGVuZGluZy52YWx1ZXMoKV07XG4gICAgdGhpcy5wZW5kaW5nLmNsZWFyKCk7XG4gICAgZm9yIChjb25zdCBwIG9mIHBlbmRpbmcpIHtcbiAgICAgIGNsZWFyVGltZW91dChwLnRpbWVyKTtcbiAgICAgIHAucmVqZWN0KG9mZmxpbmUobWVzc2FnZSkpO1xuICAgIH1cbiAgICB0aGlzLnNldFN0YXR1cygnb2ZmbGluZScpO1xuICB9XG5cbiAgcHJpdmF0ZSBzZXRTdGF0dXMoczogQ29tcGFuaW9uU3RhdHVzKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RhdHVzID09PSBzKSByZXR1cm47XG4gICAgdGhpcy5zdGF0dXMgPSBzO1xuICAgIHRoaXMuby5vblN0YXR1cz8uKHMpO1xuICB9XG59XG4iLCAiLy8gUnVicmljIHIxOiB0aGUgSmV2IHF1ZXN0aW9uIHNldCAob3duZXIncyBRMTIgdGFibGUpIGFuZCB0aGUgZGV0ZXJtaW5pc3RpYyBKZXYgaW5wdXQgYnVpbGRlci4gU3BlYyBcdTAwQTczLjJcblxuaW1wb3J0IHR5cGUge1xuICBKZXZNZWRpYVN0YXRlLFxuICBKZXZQb3N0U3RhdGUsXG4gIEpldlF1b3RlZFN0YXRlLFxuICBKZXZTdGF0ZSxcbiAgTWVkaWFSZWYsXG4gIE1lZGlhVHJhbnNjcmlwdCxcbiAgUG9zdFNuYXBzaG90LFxufSBmcm9tICcuL3R5cGVzJztcblxuZXhwb3J0IGNvbnN0IFJVQlJJQ19WRVJTSU9OID0gJ3IxJztcblxuZXhwb3J0IGNvbnN0IEhJREVfQ0FURUdPUklFUyA9IFtcbiAgJ291dHJhZ2VfYmFpdCcsXG4gICdjdWx0dXJlX3dhcicsXG4gICdlbmdhZ2VtZW50X2JhaXQnLFxuICAnaGFyYXNzbWVudCcsXG4gICdmZWFyX21vbmdlcmluZycsXG4gICdkcmFtYScsXG4gICdzZW5zYXRpb25hbF9ncmFwaGljJyxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBLRUVQX0NBVEVHT1JJRVMgPSBbXG4gICduZXV0cmFsX25ld3MnLFxuICAnc2luY2VyZV9wZXJzb25hbCcsXG4gICdzdWJzdGFudGl2ZV9jcml0aWNpc20nLFxuICAnaHVtb3InLFxuICAnYmVuaWduX290aGVyJyxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBJTlRFTlNJVFlfTEVWRUxTID0gWydDYWxtJywgJ01pbGQnLCAnTW9kZXJhdGUnLCAnU3Ryb25nJywgJ0luZmxhbW1hdG9yeSddIGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgSkVWX1FVRVNUSU9OUyA9IHtcbiAgcmFnZWJhaXQ6IHtcbiAgICB0eXBlOiAnbm91bCcsXG4gICAgaW5zdHJ1Y3Rpb25zOlxuICAgICAgJ1Nob3VsZCB0aGlzIHBvc3QgYmUgaGlkZGVuIGZvciBhIHJlYWRlciB3aG8gd2FudHMgYSBjYWxtLCBsb3ctc3RyZXNzIHRpbWVsaW5lPyBIaWRlIHBvc3RzIGRlc2lnbmVkIG9yIGxpa2VseSB0byBwcm92b2tlIGFuZ2VyLCBvdXRyYWdlLCBjb250ZW1wdCwgZmVhciBvciBkb29tIGluIGEgdHlwaWNhbCByZWFkZXIsIHJhdGhlciB0aGFuIHRvIGluZm9ybSwgaGVscCBvciBlbnRlcnRhaW4uIEp1ZGdlIHRoZSBwb3N0LCBpdHMgcXVvdGVkIHBvc3QsIGxpbmsgY2FyZCBhbmQgbWVkaWEgdHJhbnNjcmlwdHMgdG9nZXRoZXIgYXMgb25lIHVuaXQuJyxcbiAgICBjcml0ZXJpYToge1xuICAgICAgdHJ1ZTogJ091dHJhZ2UgYmFpdCBvciBkdW5raW5nOyBwb2xpdGljYWwgb3IgY3VsdHVyZS13YXIgZmlnaHRpbmc7IGVuZ2FnZW1lbnQgYmFpdCAocmF0aW8sIFJUIGlmIHlvdSBhZ3JlZSwgZGVsaWJlcmF0ZWx5IHdyb25nIGhvdCB0YWtlcyk7IGluc3VsdHMgb3IgaGFyYXNzbWVudCBhaW1lZCBhdCBwZW9wbGUgb3IgZ3JvdXBzOyBmZWFyLW1vbmdlcmluZyAoY29sbGFwc2UsIGRvb20sIGhlYWx0aCBzY2FyZXMpOyBpbmZsdWVuY2VyIG9yIGNlbGVicml0eSBkcmFtYTsgc2Vuc2F0aW9uYWwgb3IgZ3JhcGhpYyBjcmltZSwgdmlvbGVuY2UsIHdhciBvciBkaXNhc3RlciBjb250ZW50LicsXG4gICAgICBmYWxzZTpcbiAgICAgICAgJ05ldXRyYWwgZmFjdHVhbCBuZXdzLCBldmVuIGFib3V0IGNyaW1lLCB3YXIsIHBvbGl0aWNzIG9yIGRpc2FzdGVyczsgc2FkIGJ1dCBzaW5jZXJlIHBlcnNvbmFsIHBvc3RzIChncmllZiwgaWxsbmVzcyk7IGhhcnNoIGJ1dCBzdWJzdGFudGl2ZSBjcml0aWNpc20gb3IgbmVnYXRpdmUgcmV2aWV3czsgc2FyY2FzbSBvciBtZW1lcyB0aGF0IGFyZSBmdW5ueSByYXRoZXIgdGhhbiBob3N0aWxlOyBldmVyeWRheSwgaW5mb3JtYXRpdmUsIGhlbHBmdWwgb3IgcG9zaXRpdmUgcG9zdHMuJyxcbiAgICB9LFxuICB9LFxuICBjYXRlZ29yeToge1xuICAgIHR5cGU6ICdjaG9pY2UnLFxuICAgIGluc3RydWN0aW9uczogJ1doaWNoIGtpbmQgb2YgcG9zdCBpcyB0aGlzIChwb3N0LCBxdW90ZWQgcG9zdCwgY2FyZCBhbmQgbWVkaWEgdG9nZXRoZXIpPycsXG4gICAgY3JpdGVyaWE6IHtcbiAgICAgIG91dHJhZ2VfYmFpdDogJ091dHJhZ2UgYmFpdCBvciBkdW5rIHF1b3RlLXBvc3QgKFwiY2FuIHlvdSBiZWxpZXZlLi4uXCIpJyxcbiAgICAgIGN1bHR1cmVfd2FyOiAnUG9saXRpY2FsIG9yIGN1bHR1cmUtd2FyIGZpZ2h0aW5nJyxcbiAgICAgIGVuZ2FnZW1lbnRfYmFpdDogJ0VuZ2FnZW1lbnQgYmFpdDogcmF0aW8sIFJUIGlmIHlvdSBhZ3JlZSwgZGVsaWJlcmF0ZWx5IHdyb25nIGhvdCB0YWtlJyxcbiAgICAgIGhhcmFzc21lbnQ6ICdJbnN1bHRzIG9yIGhhcmFzc21lbnQgYWltZWQgYXQgcGVvcGxlIG9yIGdyb3VwcycsXG4gICAgICBmZWFyX21vbmdlcmluZzogJ0ZlYXItbW9uZ2VyaW5nOiBjb2xsYXBzZSwgZG9vbSwgaGVhbHRoIHNjYXJlcycsXG4gICAgICBkcmFtYTogJ0luZmx1ZW5jZXIgb3IgY2VsZWJyaXR5IGRyYW1hJyxcbiAgICAgIHNlbnNhdGlvbmFsX2dyYXBoaWM6ICdTZW5zYXRpb25hbCBvciBncmFwaGljIGNyaW1lLCB2aW9sZW5jZSwgd2FyIG9yIGRpc2FzdGVyIGNvbnRlbnQnLFxuICAgICAgbmV1dHJhbF9uZXdzOiAnTmV1dHJhbCBmYWN0dWFsIG5ld3MsIGV2ZW4gYWJvdXQgY3JpbWUsIHdhciwgcG9saXRpY3Mgb3IgZGlzYXN0ZXJzJyxcbiAgICAgIHNpbmNlcmVfcGVyc29uYWw6ICdTYWQgYnV0IHNpbmNlcmUgcGVyc29uYWwgcG9zdCAoZ3JpZWYsIGlsbG5lc3MpJyxcbiAgICAgIHN1YnN0YW50aXZlX2NyaXRpY2lzbTogJ0hhcnNoIGJ1dCBzdWJzdGFudGl2ZSBjcml0aWNpc20gb3IgbmVnYXRpdmUgcmV2aWV3JyxcbiAgICAgIGh1bW9yOiAnU2FyY2FzbSBvciBtZW1lIHRoYXQgaXMgZnVubnkgcmF0aGVyIHRoYW4gaG9zdGlsZScsXG4gICAgICBiZW5pZ25fb3RoZXI6ICdBbnl0aGluZyBlbHNlOiBldmVyeWRheSwgaW5mb3JtYXRpdmUsIGhlbHBmdWwgb3IgcG9zaXRpdmUnLFxuICAgIH0sXG4gIH0sXG4gIGVtb3Rpb246IHtcbiAgICB0eXBlOiAnY2hvaWNlJyxcbiAgICBpbnN0cnVjdGlvbnM6ICdXaGljaCBlbW90aW9uIGlzIHRoaXMgcG9zdCBtb3N0IGxpa2VseSB0byBldm9rZSBpbiBhIHR5cGljYWwgcmVhZGVyPycsXG4gICAgY3JpdGVyaWE6IHtcbiAgICAgIGFuZ2VyX291dHJhZ2U6ICdBbmdlciBvciBvdXRyYWdlJyxcbiAgICAgIGZlYXJfYW54aWV0eTogJ0ZlYXIgb3IgYW54aWV0eScsXG4gICAgICBkaXNndXN0X2NvbnRlbXB0OiAnRGlzZ3VzdCBvciBjb250ZW1wdCcsXG4gICAgICBtb2NrZXJ5X2R1bmtpbmc6ICdNb2NrZXJ5IG9yIGR1bmtpbmcgb24gc29tZW9uZScsXG4gICAgICBzYWRuZXNzX2dyaWVmOiAnU2FkbmVzcyBvciBncmllZicsXG4gICAgICBuZXV0cmFsX2luZm9ybWF0aXZlOiAnTmV1dHJhbCBvciBpbmZvcm1hdGl2ZScsXG4gICAgICBwb3NpdGl2ZV9hbXVzZWQ6ICdQb3NpdGl2ZSwgYW11c2VkIG9yIHVwbGlmdGVkJyxcbiAgICB9LFxuICB9LFxuICBpbnRlbnNpdHk6IHtcbiAgICB0eXBlOiAnc2NvcmUnLFxuICAgIGluc3RydWN0aW9uczogJ0hvdyBlbW90aW9uYWxseSBpbmZsYW1tYXRvcnkgaXMgdGhpcyBwb3N0IGZvciBhIHR5cGljYWwgcmVhZGVyPycsXG4gICAgY3JpdGVyaWE6IFsuLi5JTlRFTlNJVFlfTEVWRUxTXSxcbiAgfSxcbiAgdG9waWM6IHtcbiAgICB0eXBlOiAnY2hvaWNlJyxcbiAgICBpbnN0cnVjdGlvbnM6ICdXaGF0IGlzIHRoZSBtYWluIHRvcGljIG9mIHRoaXMgcG9zdD8nLFxuICAgIGNyaXRlcmlhOiB7XG4gICAgICBwb2xpdGljczogJ1BvbGl0aWNzLCBlbGVjdGlvbnMsIGdvdmVybm1lbnQnLFxuICAgICAgY3VsdHVyZV93YXI6ICdDdWx0dXJlLXdhciBvciBpZGVudGl0eSBjb25mbGljdCcsXG4gICAgICBjcmltZV92aW9sZW5jZTogJ0NyaW1lIG9yIHZpb2xlbmNlJyxcbiAgICAgIHdhcl9jb25mbGljdDogJ1dhciBvciBhcm1lZCBjb25mbGljdCcsXG4gICAgICBkaXNhc3RlcjogJ0Rpc2FzdGVyLCBhY2NpZGVudCBvciBjYXRhc3Ryb3BoZScsXG4gICAgICBlY29ub215X2J1c2luZXNzOiAnRWNvbm9teSwgbW9uZXkgb3IgYnVzaW5lc3MnLFxuICAgICAgdGVjaF9haTogJ1RlY2hub2xvZ3kgb3IgQUknLFxuICAgICAgc2NpZW5jZV9oZWFsdGg6ICdTY2llbmNlIG9yIGhlYWx0aCcsXG4gICAgICBjZWxlYnJpdHlfZW50ZXJ0YWlubWVudDogJ0NlbGVicml0aWVzLCBlbnRlcnRhaW5tZW50IG9yIGluZmx1ZW5jZXJzJyxcbiAgICAgIHNwb3J0czogJ1Nwb3J0cycsXG4gICAgICBwZXJzb25hbF9saWZlOiAnUGVyc29uYWwgbGlmZSBvciBldmVyeWRheSBleHBlcmllbmNlcycsXG4gICAgICBvdGhlcjogJ090aGVyJyxcbiAgICB9LFxuICB9LFxufSBhcyBjb25zdDtcblxuY29uc3QgR0VORVJJQ19BTFQgPSAvXihpbWFnZXxwaG90b3xwaWN0dXJlfGVtYmVkZGVkIHZpZGVvfHZpZGVvfGdpZikkL2k7XG5cbi8qKiBBbHQgdGV4dCB3b3J0aCBzZW5kaW5nOiBub24tZW1wdHkgYW5kIG5vdCBYJ3MgZ2VuZXJpYyBwbGFjZWhvbGRlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZWFuaW5nZnVsQWx0KGFsdDogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgYSA9IGFsdD8udHJpbSgpO1xuICBpZiAoIWEgfHwgR0VORVJJQ19BTFQudGVzdChhKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIGE7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRBdXRob3IoaGFuZGxlOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGggPSBoYW5kbGUudHJpbSgpO1xuICBjb25zdCBuID0gbmFtZS50cmltKCk7XG4gIHJldHVybiBuICYmIG4gIT09IGggPyBgJHtofSAoJHtufSlgIDogaDtcbn1cblxuZnVuY3Rpb24gbWVkaWFTdGF0ZShtOiBNZWRpYVJlZiwgYnlLZXk6IE1hcDxzdHJpbmcsIE1lZGlhVHJhbnNjcmlwdD4gfCB1bmRlZmluZWQpOiBKZXZNZWRpYVN0YXRlIHtcbiAgY29uc3Qgb3V0OiBKZXZNZWRpYVN0YXRlID0geyBraW5kOiBtLmtpbmQgfTtcbiAgY29uc3QgYWx0ID0gbWVhbmluZ2Z1bEFsdChtLmFsdCk7XG4gIGlmIChhbHQpIG91dC5hbHQgPSBhbHQ7XG4gIGNvbnN0IHQgPSBieUtleT8uZ2V0KG0ua2V5KTtcbiAgaWYgKHQpIHtcbiAgICBvdXQudmlzaWJsZV90ZXh0ID0gdC52aXNpYmxlVGV4dDtcbiAgICBvdXQuZGVzY3JpcHRpb24gPSB0LmRlc2NyaXB0aW9uO1xuICAgIG91dC5jdWVzID0gWy4uLnQuY3Vlc107XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBEZXRlcm1pbmlzdGljIEpldiBpbnB1dCBmb3IgYSBwb3N0LiBXaXRob3V0IHRyYW5zY3JpcHRzIHRoaXMgaXMgdGhlIHRleHQgcGFzc1xuICogKG1lZGlhIGNhcnJ5IG9ubHkga2luZC9hbHQsIG1lZGlhX3N0YXR1cyBcIm5vdF90cmFuc2NyaWJlZFwiKTsgd2l0aCB0cmFuc2NyaXB0cyBpdCBpcyB0aGUgZnVsbCBwYXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRKZXZTdGF0ZShzbmFwc2hvdDogUG9zdFNuYXBzaG90LCB0cmFuc2NyaXB0cz86IE1lZGlhVHJhbnNjcmlwdFtdKTogSmV2U3RhdGUge1xuICBjb25zdCBieUtleSA9IHRyYW5zY3JpcHRzID8gbmV3IE1hcCh0cmFuc2NyaXB0cy5tYXAoKHQpID0+IFt0LmtleSwgdF0pKSA6IHVuZGVmaW5lZDtcbiAgY29uc3Qgb3V0ZXJNZWRpYSA9IHNuYXBzaG90Lm1lZGlhLmZpbHRlcigobSkgPT4gIW0uaW5RdW90ZSkubWFwKChtKSA9PiBtZWRpYVN0YXRlKG0sIGJ5S2V5KSk7XG4gIGNvbnN0IHF1b3RlZE1lZGlhID0gc25hcHNob3QubWVkaWEuZmlsdGVyKChtKSA9PiBtLmluUXVvdGUpLm1hcCgobSkgPT4gbWVkaWFTdGF0ZShtLCBieUtleSkpO1xuXG4gIGNvbnN0IHBvc3Q6IEpldlBvc3RTdGF0ZSA9IHtcbiAgICBhdXRob3I6IGZvcm1hdEF1dGhvcihzbmFwc2hvdC5hdXRob3JIYW5kbGUsIHNuYXBzaG90LmF1dGhvck5hbWUpLFxuICAgIHRleHQ6IHNuYXBzaG90LnRleHQsXG4gIH07XG4gIGlmIChzbmFwc2hvdC50cnVuY2F0ZWQpIHBvc3QudGV4dF90cnVuY2F0ZWQgPSB0cnVlO1xuICBpZiAoc25hcHNob3QucmVwb3N0ZWRCeSkgcG9zdC5yZXBvc3RlZF9ieSA9IHNuYXBzaG90LnJlcG9zdGVkQnk7XG4gIGlmIChzbmFwc2hvdC5wcm9tb3RlZCkgcG9zdC5wcm9tb3RlZCA9IHRydWU7XG4gIGlmIChzbmFwc2hvdC5jYXJkKSB7XG4gICAgY29uc3QgY2FyZDogSmV2UG9zdFN0YXRlWydsaW5rX2NhcmQnXSA9IHt9O1xuICAgIGlmIChzbmFwc2hvdC5jYXJkLmRvbWFpbikgY2FyZC5kb21haW4gPSBzbmFwc2hvdC5jYXJkLmRvbWFpbjtcbiAgICBpZiAoc25hcHNob3QuY2FyZC50aXRsZSkgY2FyZC50aXRsZSA9IHNuYXBzaG90LmNhcmQudGl0bGU7XG4gICAgaWYgKHNuYXBzaG90LmNhcmQuZGVzY3JpcHRpb24pIGNhcmQuZGVzY3JpcHRpb24gPSBzbmFwc2hvdC5jYXJkLmRlc2NyaXB0aW9uO1xuICAgIGlmIChPYmplY3Qua2V5cyhjYXJkKS5sZW5ndGggPiAwKSBwb3N0LmxpbmtfY2FyZCA9IGNhcmQ7XG4gIH1cbiAgaWYgKG91dGVyTWVkaWEubGVuZ3RoID4gMCkgcG9zdC5tZWRpYSA9IG91dGVyTWVkaWE7XG4gIGlmIChzbmFwc2hvdC5xdW90ZWQpIHtcbiAgICBjb25zdCBxOiBKZXZRdW90ZWRTdGF0ZSA9IHtcbiAgICAgIGF1dGhvcjogZm9ybWF0QXV0aG9yKHNuYXBzaG90LnF1b3RlZC5hdXRob3JIYW5kbGUsIHNuYXBzaG90LnF1b3RlZC5hdXRob3JOYW1lKSxcbiAgICAgIHRleHQ6IHNuYXBzaG90LnF1b3RlZC50ZXh0LFxuICAgIH07XG4gICAgaWYgKHNuYXBzaG90LnF1b3RlZC50cnVuY2F0ZWQpIHEudGV4dF90cnVuY2F0ZWQgPSB0cnVlO1xuICAgIGlmIChxdW90ZWRNZWRpYS5sZW5ndGggPiAwKSBxLm1lZGlhID0gcXVvdGVkTWVkaWE7XG4gICAgcG9zdC5xdW90ZWRfcG9zdCA9IHE7XG4gIH1cblxuICBjb25zdCBtZWRpYV9zdGF0dXMgPVxuICAgIHNuYXBzaG90Lm1lZGlhLmxlbmd0aCA9PT0gMCA/ICdub25lJyA6IHRyYW5zY3JpcHRzID8gJ3RyYW5zY3JpYmVkJyA6ICdub3RfdHJhbnNjcmliZWQnO1xuICByZXR1cm4geyBwb3N0LCBtZWRpYV9zdGF0dXMgfTtcbn1cbiIsICIvLyBIaWRlL2tlZXAgZGVjaXNpb24gZnJvbSBKZXYgYW5zd2Vycy4gUHVyZSBhbmQgZmFpbC1vcGVuLiBTcGVjIFx1MDBBNzMuM1xuXG5pbXBvcnQgeyBISURFX0NBVEVHT1JJRVMsIElOVEVOU0lUWV9MRVZFTFMgfSBmcm9tICcuL3J1YnJpYyc7XG5pbXBvcnQgdHlwZSB7IEpldkFuc3dlcnMgfSBmcm9tICcuL3R5cGVzJztcblxuZXhwb3J0IGNvbnN0IFJVTEVfQl9JTlRFTlNJVFkgPSAyLjU7XG5leHBvcnQgY29uc3QgUlVMRV9CX01BUkdJTiA9IDAuMTtcbmV4cG9ydCBjb25zdCBSVUxFX0JfQ0FQID0gMC45OTtcblxuZXhwb3J0IGludGVyZmFjZSBSYW5rZWQge1xuICBrZXk6IHN0cmluZztcbiAgcDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlY2lzaW9uIHtcbiAgaGlkZTogYm9vbGVhbjtcbiAgcmVhc29uczogc3RyaW5nW107XG4gIHJhZ2ViYWl0PzogbnVtYmVyO1xuICBoaWRlQ2F0ZWdvcnlNYXNzPzogbnVtYmVyO1xuICBpbnRlbnNpdHk/OiBudW1iZXI7XG4gIHRvcENhdGVnb3J5PzogUmFua2VkO1xuICB0b3BFbW90aW9uPzogUmFua2VkO1xuICB0b3BUb3BpYz86IFJhbmtlZDtcbn1cblxuZnVuY3Rpb24gaXNOdW0odjogdW5rbm93bik6IHYgaXMgbnVtYmVyIHtcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodik7XG59XG5cbmZ1bmN0aW9uIGlzUHJvYk1hcCh2OiB1bmtub3duKTogdiBpcyBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+IHtcbiAgcmV0dXJuICEhdiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LnZhbHVlcyh2IGFzIG9iamVjdCkuZXZlcnkoaXNOdW0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNWYWxpZEFuc3dlcnMoYTogdW5rbm93bik6IGEgaXMgSmV2QW5zd2VycyB7XG4gIGlmICghYSB8fCB0eXBlb2YgYSAhPT0gJ29iamVjdCcpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgeCA9IGEgYXMgUmVjb3JkPHN0cmluZywgYW55PjtcbiAgcmV0dXJuIChcbiAgICBpc051bSh4LnJhZ2ViYWl0Py5ub3VsKSAmJlxuICAgIGlzUHJvYk1hcCh4LmNhdGVnb3J5Py5wcm9iYWJpbGl0aWVzKSAmJlxuICAgIGlzUHJvYk1hcCh4LmVtb3Rpb24/LnByb2JhYmlsaXRpZXMpICYmXG4gICAgaXNQcm9iTWFwKHgudG9waWM/LnByb2JhYmlsaXRpZXMpICYmXG4gICAgaXNOdW0oeC5pbnRlbnNpdHk/LnNjb3JlKVxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9wS2V5KHByb2JhYmlsaXRpZXM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4pOiBSYW5rZWQgfCB1bmRlZmluZWQge1xuICBsZXQgYmVzdDogUmFua2VkIHwgdW5kZWZpbmVkO1xuICBmb3IgKGNvbnN0IFtrZXksIHBdIG9mIE9iamVjdC5lbnRyaWVzKHByb2JhYmlsaXRpZXMpKSB7XG4gICAgaWYgKCFiZXN0IHx8IHAgPiBiZXN0LnApIGJlc3QgPSB7IGtleSwgcCB9O1xuICB9XG4gIHJldHVybiBiZXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW50ZW5zaXR5TGFiZWwoc2NvcmU6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGkgPSBNYXRoLm1pbihJTlRFTlNJVFlfTEVWRUxTLmxlbmd0aCAtIDEsIE1hdGgubWF4KDAsIE1hdGgucm91bmQoc2NvcmUpKSk7XG4gIHJldHVybiBJTlRFTlNJVFlfTEVWRUxTW2ldO1xufVxuXG5jb25zdCBmMiA9IChuOiBudW1iZXIpID0+IG4udG9GaXhlZCgyKTtcbmNvbnN0IGYxID0gKG46IG51bWJlcikgPT4gbi50b0ZpeGVkKDEpO1xuXG4vKipcbiAqIHJ1bGUgQTogcmFnZWJhaXQgXHUyMjY1IFRcbiAqIHJ1bGUgQjogaGlkZS1jYXRlZ29yeSBtYXNzIFx1MjI2NSBtaW4oVCArIDAuMTAsIDAuOTkpIEFORCBpbnRlbnNpdHkgXHUyMjY1IDIuNVxuICogTWlzc2luZy9tYWxmb3JtZWQgYW5zd2VycyBcdTIxOTIga2VlcCAoZmFpbCBvcGVuKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlY2lkZShhbnN3ZXJzOiBKZXZBbnN3ZXJzIHwgdW5kZWZpbmVkIHwgbnVsbCwgdGhyZXNob2xkOiBudW1iZXIpOiBEZWNpc2lvbiB7XG4gIGlmICghaXNWYWxpZEFuc3dlcnMoYW5zd2VycykpIHJldHVybiB7IGhpZGU6IGZhbHNlLCByZWFzb25zOiBbJ25vIHZlcmRpY3QnXSB9O1xuXG4gIGNvbnN0IFQgPSB0aHJlc2hvbGQ7XG4gIGNvbnN0IHAgPSBhbnN3ZXJzLnJhZ2ViYWl0Lm5vdWw7XG4gIGNvbnN0IHByb2JzID0gYW5zd2Vycy5jYXRlZ29yeS5wcm9iYWJpbGl0aWVzO1xuICBjb25zdCBjID0gSElERV9DQVRFR09SSUVTLnJlZHVjZSgoc3VtLCBrKSA9PiBzdW0gKyAoaXNOdW0ocHJvYnNba10pID8gcHJvYnNba10gOiAwKSwgMCk7XG4gIGNvbnN0IGkgPSBhbnN3ZXJzLmludGVuc2l0eS5zY29yZTtcbiAgY29uc3QgdEIgPSBNYXRoLm1pbihUICsgUlVMRV9CX01BUkdJTiwgUlVMRV9CX0NBUCk7XG5cbiAgY29uc3QgdG9wQ2F0ZWdvcnkgPSB0b3BLZXkocHJvYnMpO1xuICBjb25zdCB0b3BFbW90aW9uID0gdG9wS2V5KGFuc3dlcnMuZW1vdGlvbi5wcm9iYWJpbGl0aWVzKTtcbiAgY29uc3QgdG9wVG9waWMgPSB0b3BLZXkoYW5zd2Vycy50b3BpYy5wcm9iYWJpbGl0aWVzKTtcblxuICBjb25zdCByZWFzb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBydWxlQSA9IHAgPj0gVDtcbiAgY29uc3QgcnVsZUIgPSBjID49IHRCICYmIGkgPj0gUlVMRV9CX0lOVEVOU0lUWTtcbiAgaWYgKHJ1bGVBKSByZWFzb25zLnB1c2goYHJhZ2ViYWl0ICR7ZjIocCl9IFx1MjI2NSAke2YyKFQpfWApO1xuICBpZiAocnVsZUIpIHtcbiAgICByZWFzb25zLnB1c2goXG4gICAgICBgaGlkZS1raW5kcyAke2YyKGMpfSBcdTIyNjUgJHtmMih0Qil9ICYgaW50ZW5zaXR5ICR7ZjEoaSl9IFx1MjI2NSAke2YxKFJVTEVfQl9JTlRFTlNJVFkpfWAgK1xuICAgICAgICAodG9wQ2F0ZWdvcnkgPyBgICh0b3A6ICR7dG9wQ2F0ZWdvcnkua2V5fSlgIDogJycpLFxuICAgICk7XG4gIH1cbiAgaWYgKCFydWxlQSAmJiAhcnVsZUIpIHJlYXNvbnMucHVzaChgcmFnZWJhaXQgJHtmMihwKX0gPCAke2YyKFQpfWApO1xuXG4gIHJldHVybiB7XG4gICAgaGlkZTogcnVsZUEgfHwgcnVsZUIsXG4gICAgcmVhc29ucyxcbiAgICByYWdlYmFpdDogcCxcbiAgICBoaWRlQ2F0ZWdvcnlNYXNzOiBjLFxuICAgIGludGVuc2l0eTogaSxcbiAgICB0b3BDYXRlZ29yeSxcbiAgICB0b3BFbW90aW9uLFxuICAgIHRvcFRvcGljLFxuICB9O1xufVxuIiwgIi8vIERldGVybWluaXN0aWMgc2VyaWFsaXNhdGlvbiArIGEgc21hbGwgc3luYyBoYXNoIGZvciBpbi1tZW1vcnkga2V5cyAoY29udGVudCBzY3JpcHQsIFNXIExSVSkuXG4vLyBUaGUgY29tcGFuaW9uIHVzZXMgc2hhMjU2IChub2RlOmNyeXB0bykgZm9yIG9uLWRpc2sga2V5cy5cblxuLyoqIEpTT04gd2l0aCBvYmplY3Qga2V5cyBzb3J0ZWQgcmVjdXJzaXZlbHk7IGB1bmRlZmluZWRgIG1lbWJlcnMgYXJlIGRyb3BwZWQgKGFzIEpTT04uc3RyaW5naWZ5IGRvZXMpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YWJsZVN0cmluZ2lmeSh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShzb3J0RGVlcCh2YWx1ZSkpO1xufVxuXG5mdW5jdGlvbiBzb3J0RGVlcCh2OiB1bmtub3duKTogdW5rbm93biB7XG4gIGlmIChBcnJheS5pc0FycmF5KHYpKSByZXR1cm4gdi5tYXAoKHgpID0+ICh4ID09PSB1bmRlZmluZWQgPyBudWxsIDogc29ydERlZXAoeCkpKTtcbiAgaWYgKHYgJiYgdHlwZW9mIHYgPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyh2IGFzIG9iamVjdCkuc29ydCgpKSB7XG4gICAgICBjb25zdCB2YWwgPSAodiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gICAgICBpZiAodmFsICE9PSB1bmRlZmluZWQpIG91dFtrXSA9IHNvcnREZWVwKHZhbCk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cbiAgcmV0dXJuIHY7XG59XG5cbi8qKiBjeXJiNTM6IGZhc3QgNTMtYml0IHN0cmluZyBoYXNoLCByZXR1cm5lZCBhcyBiYXNlLTM2LiBOb3QgY3J5cHRvZ3JhcGhpYy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNoNTMoc3RyOiBzdHJpbmcsIHNlZWQgPSAwKTogc3RyaW5nIHtcbiAgbGV0IGgxID0gMHhkZWFkYmVlZiBeIHNlZWQ7XG4gIGxldCBoMiA9IDB4NDFjNmNlNTcgXiBzZWVkO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHN0ci5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGNoID0gc3RyLmNoYXJDb2RlQXQoaSk7XG4gICAgaDEgPSBNYXRoLmltdWwoaDEgXiBjaCwgMjY1NDQzNTc2MSk7XG4gICAgaDIgPSBNYXRoLmltdWwoaDIgXiBjaCwgMTU5NzMzNDY3Nyk7XG4gIH1cbiAgaDEgPSBNYXRoLmltdWwoaDEgXiAoaDEgPj4+IDE2KSwgMjI0NjgyMjUwNyk7XG4gIGgxIF49IE1hdGguaW11bChoMiBeIChoMiA+Pj4gMTMpLCAzMjY2NDg5OTA5KTtcbiAgaDIgPSBNYXRoLmltdWwoaDIgXiAoaDIgPj4+IDE2KSwgMjI0NjgyMjUwNyk7XG4gIGgyIF49IE1hdGguaW11bChoMSBeIChoMSA+Pj4gMTMpLCAzMjY2NDg5OTA5KTtcbiAgcmV0dXJuICg0Mjk0OTY3Mjk2ICogKDIwOTcxNTEgJiBoMikgKyAoaDEgPj4+IDApKS50b1N0cmluZygzNik7XG59XG4iLCAiLy8gRmV0Y2hlcyB0aGUgbWVkaWEgWCBhbHJlYWR5IGRpc3BsYXlzIChwYnMudHdpbWcuY29tKSBhbmQgYmFzZTY0LWVuY29kZXMgaXQgZm9yIGB0cmFuc2NyaWJlYC4gU3BlYyBcdTAwQTc0LjJcblxuaW1wb3J0IHsgTUFYX1ZJU0lPTl9JVEVNUywgdHlwZSBUcmFuc2NyaWJlSXRlbSB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9wcm90b2NvbCc7XG5pbXBvcnQgdHlwZSB7IE1lZGlhUmVmIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3R5cGVzJztcblxuZXhwb3J0IGNvbnN0IE1BWF9NRURJQV9CWVRFUyA9IDMuNSAqIDEwMjQgKiAxMDI0O1xuLyoqIEEgc3RhbGxlZCBtZWRpYSBmZXRjaCBmYWlscyBhZnRlciB0aGlzIGxvbmcsIHNvIHRoZSBwb3N0J3MgdmlzaW9uIHBhc3MgZW5kcyBpbnN0ZWFkIG9mIHBlbmRpbmcgZm9yZXZlci4gKi9cbmV4cG9ydCBjb25zdCBNRURJQV9GRVRDSF9USU1FT1VUX01TID0gMTVfMDAwO1xuXG5jb25zdCBDSFVOSyA9IDB4ODAwMDtcblxuZXhwb3J0IGZ1bmN0aW9uIGFycmF5QnVmZmVyVG9CYXNlNjQoYnVmOiBBcnJheUJ1ZmZlcik6IHN0cmluZyB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYnVmKTtcbiAgbGV0IGJpbiA9ICcnO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSArPSBDSFVOSykge1xuICAgIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKC4uLmJ5dGVzLnN1YmFycmF5KGksIGkgKyBDSFVOSykpO1xuICB9XG4gIHJldHVybiBidG9hKGJpbik7XG59XG5cbi8qKiBPbmx5IG1lZGlhIFggYWxyZWFkeSBkaXNwbGF5czogaHR0cHMgb24gcGJzLnR3aW1nLmNvbSAoaGFyZCBydWxlOyB0aGUgc2Nhbm5lciBjaGVja3MgdGhpcyB0b28pLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQWxsb3dlZE1lZGlhVXJsKHVybDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdSA9IG5ldyBVUkwodXJsKTtcbiAgICByZXR1cm4gdS5wcm90b2NvbCA9PT0gJ2h0dHBzOicgJiYgdS5ob3N0bmFtZSA9PT0gJ3Bicy50d2ltZy5jb20nO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hPbmUobTogTWVkaWFSZWYsIGZldGNoSW1wbDogdHlwZW9mIGZldGNoLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8VHJhbnNjcmliZUl0ZW0gfCB1bmRlZmluZWQ+IHtcbiAgaWYgKCFpc0FsbG93ZWRNZWRpYVVybChtLnVybCkpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoSW1wbChtLnVybCwgeyBjcmVkZW50aWFsczogJ29taXQnLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgaWYgKCFyZXMub2spIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG1lZGlhVHlwZSA9IChyZXMuaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpID8/ICcnKS5zcGxpdCgnOycpWzBdLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoIW1lZGlhVHlwZS5zdGFydHNXaXRoKCdpbWFnZS8nKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKE51bWJlcihyZXMuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykpID4gTUFYX01FRElBX0JZVEVTKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBidWYgPSBhd2FpdCByZXMuYXJyYXlCdWZmZXIoKTtcbiAgaWYgKGJ1Zi5ieXRlTGVuZ3RoID4gTUFYX01FRElBX0JZVEVTKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4geyBrZXk6IG0ua2V5LCBraW5kOiBtLmtpbmQsIGluUXVvdGU6IG0uaW5RdW90ZSwgYWx0OiBtLmFsdCwgbWVkaWFUeXBlLCBkYXRhQmFzZTY0OiBhcnJheUJ1ZmZlclRvQmFzZTY0KGJ1ZikgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoTWVkaWFJdGVtcyhcbiAgbWVkaWE6IE1lZGlhUmVmW10sXG4gIGZldGNoSW1wbDogdHlwZW9mIGZldGNoID0gZmV0Y2gsXG4gIG1heDogbnVtYmVyID0gTUFYX1ZJU0lPTl9JVEVNUyxcbiAgdGltZW91dE1zOiBudW1iZXIgPSBNRURJQV9GRVRDSF9USU1FT1VUX01TLFxuKTogUHJvbWlzZTx7IGl0ZW1zOiBUcmFuc2NyaWJlSXRlbVtdOyBmYWlsZWQ6IHN0cmluZ1tdIH0+IHtcbiAgY29uc3QgcGlja2VkID0gbWVkaWEuc2xpY2UoMCwgbWF4KTtcbiAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKHBpY2tlZC5tYXAoKG0pID0+IGZldGNoT25lKG0sIGZldGNoSW1wbCwgdGltZW91dE1zKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpKSk7XG4gIGNvbnN0IGl0ZW1zOiBUcmFuc2NyaWJlSXRlbVtdID0gW107XG4gIGNvbnN0IGZhaWxlZDogc3RyaW5nW10gPSBbXTtcbiAgcmVzdWx0cy5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgaWYgKGl0ZW0pIGl0ZW1zLnB1c2goaXRlbSk7XG4gICAgZWxzZSBmYWlsZWQucHVzaChwaWNrZWRbaV0ua2V5KTtcbiAgfSk7XG4gIHJldHVybiB7IGl0ZW1zLCBmYWlsZWQgfTtcbn1cbiIsICIvLyBDb25jdXJyZW5jeSBhbmQgY2FjaGluZyBwcmltaXRpdmVzIGZvciB0aGUgc2VydmljZSB3b3JrZXIgcGlwZWxpbmUuIFNwZWMgXHUwMEE3NC4yXG5cbi8qKiBBc3luYyBzZW1hcGhvcmU6IGF0IG1vc3QgYG1heGAgYHJ1bmAgY2FsbGJhY2tzIGluIGZsaWdodDsgdGhlIHJlc3Qgd2FpdCBGSUZPLiAqL1xuZXhwb3J0IGNsYXNzIFNlbWFwaG9yZSB7XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF4OiBudW1iZXI7XG4gIHByaXZhdGUgcnVubmluZyA9IDA7XG4gIHByaXZhdGUgcmVhZG9ubHkgcXVldWU6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IobWF4OiBudW1iZXIpIHtcbiAgICB0aGlzLm1heCA9IG1heDtcbiAgfVxuXG4gIGdldCBhY3RpdmUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5ydW5uaW5nO1xuICB9XG5cbiAgZ2V0IHdhaXRpbmcoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5xdWV1ZS5sZW5ndGg7XG4gIH1cblxuICBhc3luYyBydW48VD4oZm46ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcbiAgICBhd2FpdCB0aGlzLmFjcXVpcmUoKTtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGZuKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMucmVsZWFzZSgpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWNxdWlyZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5ydW5uaW5nIDwgdGhpcy5tYXgpIHtcbiAgICAgIHRoaXMucnVubmluZysrO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHRoaXMucXVldWUucHVzaChyZXNvbHZlKSk7XG4gIH1cblxuICBwcml2YXRlIHJlbGVhc2UoKTogdm9pZCB7XG4gICAgY29uc3QgbmV4dCA9IHRoaXMucXVldWUuc2hpZnQoKTtcbiAgICAvLyBIYW5kIHRoZSBzbG90IHN0cmFpZ2h0IHRvIHRoZSBuZXh0IHdhaXRlcjsgYHJ1bm5pbmdgIHN0YXlzIHRoZSBzYW1lLlxuICAgIGlmIChuZXh0KSBuZXh0KCk7XG4gICAgZWxzZSB0aGlzLnJ1bm5pbmctLTtcbiAgfVxufVxuXG4vKiogTWFwLWJhY2tlZCBMUlU6IGBnZXRgIHJlZnJlc2hlcyByZWNlbmN5OyBgc2V0YCBldmljdHMgdGhlIGxlYXN0IHJlY2VudGx5IHVzZWQgcGFzdCBgbWF4YC4gKi9cbmV4cG9ydCBjbGFzcyBMcnVDYWNoZTxLLCBWPiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgbWF4OiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgbWFwID0gbmV3IE1hcDxLLCBWPigpO1xuXG4gIGNvbnN0cnVjdG9yKG1heDogbnVtYmVyKSB7XG4gICAgdGhpcy5tYXggPSBtYXg7XG4gIH1cblxuICBnZXQgc2l6ZSgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLm1hcC5zaXplO1xuICB9XG5cbiAgZ2V0KGs6IEspOiBWIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIXRoaXMubWFwLmhhcyhrKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjb25zdCB2ID0gdGhpcy5tYXAuZ2V0KGspIGFzIFY7XG4gICAgdGhpcy5tYXAuZGVsZXRlKGspO1xuICAgIHRoaXMubWFwLnNldChrLCB2KTtcbiAgICByZXR1cm4gdjtcbiAgfVxuXG4gIHNldChrOiBLLCB2OiBWKTogdm9pZCB7XG4gICAgdGhpcy5tYXAuZGVsZXRlKGspO1xuICAgIHRoaXMubWFwLnNldChrLCB2KTtcbiAgICB3aGlsZSAodGhpcy5tYXAuc2l6ZSA+IHRoaXMubWF4KSB0aGlzLm1hcC5kZWxldGUodGhpcy5tYXAua2V5cygpLm5leHQoKS52YWx1ZSBhcyBLKTtcbiAgfVxufVxuXG4vKiogRGVkdXBlcyBjb25jdXJyZW50IHdvcms6IGNhbGxlcnMgd2l0aCB0aGUgc2FtZSBrZXkgc2hhcmUgb25lIHByb21pc2UgdW50aWwgaXQgc2V0dGxlcy4gKi9cbmV4cG9ydCBjbGFzcyBJbkZsaWdodDxLLCBWPiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgbWFwID0gbmV3IE1hcDxLLCBQcm9taXNlPFY+PigpO1xuXG4gIHJ1bihrZXk6IEssIGZuOiAoKSA9PiBQcm9taXNlPFY+KTogUHJvbWlzZTxWPiB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLm1hcC5nZXQoa2V5KTtcbiAgICBpZiAoZXhpc3RpbmcpIHJldHVybiBleGlzdGluZztcbiAgICAvLyBEZWZlcnJlZCBzdGFydCBzbyBhIHN5bmNocm9ub3VzIHRocm93IGNhbid0IHNldHRsZSBiZWZvcmUgdGhlIGVudHJ5IGlzIHN0b3JlZC5cbiAgICBjb25zdCBwOiBQcm9taXNlPFY+ID0gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKGZuKVxuICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5tYXAuZ2V0KGtleSkgPT09IHApIHRoaXMubWFwLmRlbGV0ZShrZXkpO1xuICAgICAgfSk7XG4gICAgdGhpcy5tYXAuc2V0KGtleSwgcCk7XG4gICAgcmV0dXJuIHA7XG4gIH1cbn1cbiIsICIvLyBQZXItcG9zdCBwaXBlbGluZTogdGV4dCBwYXNzLCB0aGVuICh3aGVuIHVzZWZ1bCkgYSB2aXNpb24gcGFzcy4gRXJyb3JzIGFyZSBlbWl0dGVkLCBuZXZlciB0aHJvd25cbi8vIChmYWlsIG9wZW4pLiBTcGVjIFx1MDBBNzQuMiwgXHUwMEE3NlxuXG5pbXBvcnQgdHlwZSB7IENsYXNzaWZ5UmVzcG9uc2UsIFBvc3RNc2csIFJlc3VsdE1zZywgVHJhbnNjcmliZUl0ZW0sIFRyYW5zY3JpYmVSZXNwb25zZSB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9wcm90b2NvbCc7XG5pbXBvcnQgdHlwZSB7IEVycm9ySW5mbywgSmV2UmVzdWx0LCBKZXZTdGF0ZSwgTWVkaWFSZWYsIFBvc3RTbmFwc2hvdCwgUmF0ZUxpbWl0SW5mbywgU2V0dGluZ3MsIFZpc2lvblN0YXR1cyB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC90eXBlcyc7XG5pbXBvcnQgeyBidWlsZEpldlN0YXRlIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3J1YnJpYyc7XG5pbXBvcnQgeyBkZWNpZGUgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvZGVjaWRlJztcbmltcG9ydCB7IGhhc2g1Mywgc3RhYmxlU3RyaW5naWZ5IH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL2hhc2gnO1xuaW1wb3J0IHsgZmV0Y2hNZWRpYUl0ZW1zIH0gZnJvbSAnLi9tZWRpYSc7XG5pbXBvcnQgeyBOYXRpdmVDYWxsRXJyb3IsIFRJTUVPVVRTLCB0eXBlIE5hdGl2ZUFwaSB9IGZyb20gJy4vbmF0aXZlJztcbmltcG9ydCB7IEluRmxpZ2h0LCBMcnVDYWNoZSwgU2VtYXBob3JlIH0gZnJvbSAnLi9xdWV1ZSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGlwZWxpbmVTdGF0cyB7XG4gIHJlY29yZChraW5kOiAndGV4dCcgfCAndmlzaW9uJyB8ICdmdWxsJywgbXM6IG51bWJlcik6IHZvaWQ7XG4gIHNldFJhdGVMaW1pdChyOiBSYXRlTGltaXRJbmZvIHwgdW5kZWZpbmVkKTogdm9pZDtcbiAgcGVuZGluZzogeyB0ZXh0OiBudW1iZXI7IHZpc2lvbjogbnVtYmVyIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGlwZWxpbmVEZXBzIHtcbiAgbmF0aXZlOiBOYXRpdmVBcGk7XG4gIHNldHRpbmdzOiAoKSA9PiBTZXR0aW5ncztcbiAgZmV0Y2hNZWRpYTogKG06IE1lZGlhUmVmW10pID0+IFByb21pc2U8eyBpdGVtczogVHJhbnNjcmliZUl0ZW1bXTsgZmFpbGVkOiBzdHJpbmdbXSB9PjtcbiAgdGV4dFNlbTogU2VtYXBob3JlO1xuICB2aXNpb25TZW06IFNlbWFwaG9yZTtcbiAgbHJ1OiBMcnVDYWNoZTxzdHJpbmcsIEpldlJlc3VsdD47XG4gIGluZmxpZ2h0OiBJbkZsaWdodDxzdHJpbmcsIEpldlJlc3VsdD47XG4gIG5vdzogKCkgPT4gbnVtYmVyO1xuICBzdGF0czogUGlwZWxpbmVTdGF0cztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBpcGVsaW5lRGVwcyhcbiAgbmF0aXZlOiBOYXRpdmVBcGksXG4gIHNldHRpbmdzOiAoKSA9PiBTZXR0aW5ncyxcbiAgc3RhdHM6IFBpcGVsaW5lU3RhdHMsXG4gIGZldGNoTWVkaWE6IFBpcGVsaW5lRGVwc1snZmV0Y2hNZWRpYSddID0gKG0pID0+IGZldGNoTWVkaWFJdGVtcyhtKSxcbik6IFBpcGVsaW5lRGVwcyB7XG4gIHJldHVybiB7XG4gICAgbmF0aXZlLFxuICAgIHNldHRpbmdzLFxuICAgIGZldGNoTWVkaWEsXG4gICAgdGV4dFNlbTogbmV3IFNlbWFwaG9yZSg2KSxcbiAgICB2aXNpb25TZW06IG5ldyBTZW1hcGhvcmUoMiksXG4gICAgbHJ1OiBuZXcgTHJ1Q2FjaGUoNTAwKSxcbiAgICBpbmZsaWdodDogbmV3IEluRmxpZ2h0KCksXG4gICAgbm93OiBEYXRlLm5vdyxcbiAgICBzdGF0cyxcbiAgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsYXNzaWZ5Q2FjaGVkKHN0YXRlOiBKZXZTdGF0ZSwgZGVwczogUGlwZWxpbmVEZXBzKTogUHJvbWlzZTxKZXZSZXN1bHQ+IHtcbiAgY29uc3Qga2V5ID0gaGFzaDUzKHN0YWJsZVN0cmluZ2lmeShzdGF0ZSkpO1xuICBjb25zdCBoaXQgPSBkZXBzLmxydS5nZXQoa2V5KTtcbiAgaWYgKGhpdCkgcmV0dXJuIHsgLi4uaGl0LCBjYWNoZWQ6IHRydWUgfTtcbiAgcmV0dXJuIGRlcHMuaW5mbGlnaHQucnVuKGtleSwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHIgPSBhd2FpdCBkZXBzLnRleHRTZW0ucnVuKCgpID0+XG4gICAgICBkZXBzLm5hdGl2ZS5yZXF1ZXN0PENsYXNzaWZ5UmVzcG9uc2U+KHsgdHlwZTogJ2NsYXNzaWZ5Jywgc3RhdGUgfSwgVElNRU9VVFMuY2xhc3NpZnkpLFxuICAgICk7XG4gICAgZGVwcy5scnUuc2V0KGtleSwgci5yZXN1bHQpO1xuICAgIHJldHVybiByLnJlc3VsdDtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGVycm9ySW5mbyhlOiB1bmtub3duKTogRXJyb3JJbmZvIHtcbiAgaWYgKGUgaW5zdGFuY2VvZiBOYXRpdmVDYWxsRXJyb3IpIHJldHVybiBlLmluZm87XG4gIHJldHVybiB7IGNvZGU6ICdJTlRFUk5BTCcsIG1lc3NhZ2U6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9O1xufVxuXG5mdW5jdGlvbiB2aXNpb25TdGF0dXMoc25hcHNob3Q6IFBvc3RTbmFwc2hvdCwgczogU2V0dGluZ3MsIGpldjogSmV2UmVzdWx0IHwgdW5kZWZpbmVkKTogVmlzaW9uU3RhdHVzIHtcbiAgaWYgKHNuYXBzaG90Lm1lZGlhLmxlbmd0aCA9PT0gMCkgcmV0dXJuICdub25lJztcbiAgaWYgKCFzLnZpc2lvbkVuYWJsZWQpIHJldHVybiAnZGlzYWJsZWQnO1xuICAvLyBObyB0ZXh0IHZlcmRpY3QgKHRleHQgcGFzcyBmYWlsZWQpOiBubyB2aXNpb24gcGFzcyBmb2xsb3dzLCBzbyBkb24ndCByZXBvcnQgJ3BlbmRpbmcnLlxuICBpZiAoIWpldikgcmV0dXJuICdmYWlsZWQnO1xuICBpZiAoZGVjaWRlKGpldi5hbnN3ZXJzLCBzLnRocmVzaG9sZCkuaGlkZSkgcmV0dXJuICdza2lwcGVkX2ZsYWdnZWQnO1xuICByZXR1cm4gJ3BlbmRpbmcnO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc1Bvc3QobXNnOiBQb3N0TXNnLCBlbWl0OiAocjogUmVzdWx0TXNnKSA9PiB2b2lkLCBkZXBzOiBQaXBlbGluZURlcHMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBhd2FpdCBydW4obXNnLCBlbWl0LCBkZXBzKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gT25seSBgZW1pdGAgaXRzZWxmIGNhbiB0aHJvdyBoZXJlOyB0aGUgcG9zdCBzdGF5cyB2aXNpYmxlIGVpdGhlciB3YXkuXG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuKG1zZzogUG9zdE1zZywgZW1pdDogKHI6IFJlc3VsdE1zZykgPT4gdm9pZCwgZGVwczogUGlwZWxpbmVEZXBzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgc25hcHNob3QsIHNuYXBIYXNoIH0gPSBtc2c7XG4gIGNvbnN0IHsgc3RhdHMgfSA9IGRlcHM7XG4gIGNvbnN0IHMgPSBkZXBzLnNldHRpbmdzKCk7XG4gIGNvbnN0IGJhc2UgPSB7IHR5cGU6ICdyZXN1bHQnLCBwb3N0SWQ6IHNuYXBzaG90LnBvc3RJZCwgc25hcEhhc2ggfSBhcyBjb25zdDtcbiAgY29uc3QgdDAgPSBkZXBzLm5vdygpO1xuXG4gIC8vIDEuIFRleHQgcGFzcy5cbiAgbGV0IGpldjogSmV2UmVzdWx0O1xuICBzdGF0cy5wZW5kaW5nLnRleHQrKztcbiAgdHJ5IHtcbiAgICBqZXYgPSBhd2FpdCBjbGFzc2lmeUNhY2hlZChidWlsZEpldlN0YXRlKHNuYXBzaG90KSwgZGVwcyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBlbWl0KHsgLi4uYmFzZSwgc3RhZ2U6ICd0ZXh0JywgdmlzaW9uOiB2aXNpb25TdGF0dXMoc25hcHNob3QsIHMsIHVuZGVmaW5lZCksIGVycm9yOiBlcnJvckluZm8oZSksIHRpbWluZ3M6IHsgdGV4dE1zOiBkZXBzLm5vdygpIC0gdDAgfSB9KTtcbiAgICByZXR1cm47XG4gIH0gZmluYWxseSB7XG4gICAgc3RhdHMucGVuZGluZy50ZXh0LS07XG4gIH1cbiAgY29uc3QgdGV4dE1zID0gZGVwcy5ub3coKSAtIHQwO1xuICBzdGF0cy5yZWNvcmQoJ3RleHQnLCB0ZXh0TXMpO1xuXG4gIC8vIDJcdTIwMTMzLiBUZXh0IHJlc3VsdCwgd2l0aCB0aGUgdmlzaW9uIGRlY2lzaW9uLlxuICBjb25zdCB2aXNpb24gPSB2aXNpb25TdGF0dXMoc25hcHNob3QsIHMsIGpldik7XG4gIGVtaXQoeyAuLi5iYXNlLCBzdGFnZTogJ3RleHQnLCBqZXYsIHZpc2lvbiwgdGltaW5nczogeyB0ZXh0TXMgfSB9KTtcbiAgaWYgKHZpc2lvbiAhPT0gJ3BlbmRpbmcnKSByZXR1cm47XG5cbiAgLy8gNFx1MjAxMzcuIFZpc2lvbiBwYXNzLlxuICBsZXQgZnVsbDogUmVzdWx0TXNnO1xuICBzdGF0cy5wZW5kaW5nLnZpc2lvbisrO1xuICB0cnkge1xuICAgIGNvbnN0IHR2ID0gZGVwcy5ub3coKTtcbiAgICBjb25zdCB7IGl0ZW1zIH0gPSBhd2FpdCBkZXBzLmZldGNoTWVkaWEoc25hcHNob3QubWVkaWEpO1xuICAgIGlmIChpdGVtcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGZ1bGwgPSB7XG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIHN0YWdlOiAnZnVsbCcsXG4gICAgICAgIHZpc2lvbjogJ2ZhaWxlZCcsXG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdNRURJQV9GRVRDSF9GQUlMRUQnLCBtZXNzYWdlOiAnbm8gbWVkaWEgY291bGQgYmUgZmV0Y2hlZCcgfSxcbiAgICAgICAgdGltaW5nczogeyB0ZXh0TXMgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHRyID0gYXdhaXQgZGVwcy52aXNpb25TZW0ucnVuKCgpID0+XG4gICAgICAgIGRlcHMubmF0aXZlLnJlcXVlc3Q8VHJhbnNjcmliZVJlc3BvbnNlPihcbiAgICAgICAgICB7IHR5cGU6ICd0cmFuc2NyaWJlJywgbW9kZWw6IHMudHJhbnNjcmlwdE1vZGVsLCBpdGVtcyB9LFxuICAgICAgICAgIFRJTUVPVVRTLnRyYW5zY3JpYmUsXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgY29uc3QgdmlzaW9uTXMgPSBkZXBzLm5vdygpIC0gdHY7XG4gICAgICBzdGF0cy5zZXRSYXRlTGltaXQodHIucmF0ZUxpbWl0KTtcbiAgICAgIHN0YXRzLnJlY29yZCgndmlzaW9uJywgdmlzaW9uTXMpO1xuXG4gICAgICBjb25zdCB0ZiA9IGRlcHMubm93KCk7XG4gICAgICBjb25zdCBqZXYyID0gYXdhaXQgY2xhc3NpZnlDYWNoZWQoYnVpbGRKZXZTdGF0ZShzbmFwc2hvdCwgdHIudHJhbnNjcmlwdHMpLCBkZXBzKTtcbiAgICAgIGNvbnN0IGZ1bGxNcyA9IGRlcHMubm93KCkgLSB0ZjtcbiAgICAgIHN0YXRzLnJlY29yZCgnZnVsbCcsIGZ1bGxNcyk7XG5cbiAgICAgIGZ1bGwgPSB7XG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIHN0YWdlOiAnZnVsbCcsXG4gICAgICAgIGpldjogamV2MixcbiAgICAgICAgdmlzaW9uOiAnZG9uZScsXG4gICAgICAgIHRyYW5zY3JpcHRzOiB0ci50cmFuc2NyaXB0cyxcbiAgICAgICAgdGltaW5nczogeyB0ZXh0TXMsIHZpc2lvbk1zLCBmdWxsTXMgfSxcbiAgICAgIH07XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gOC4gVGhlIHRleHQgdmVyZGljdCBzdGFuZHMuXG4gICAgZnVsbCA9IHsgLi4uYmFzZSwgc3RhZ2U6ICdmdWxsJywgdmlzaW9uOiAnZmFpbGVkJywgZXJyb3I6IGVycm9ySW5mbyhlKSwgdGltaW5nczogeyB0ZXh0TXMgfSB9O1xuICB9IGZpbmFsbHkge1xuICAgIHN0YXRzLnBlbmRpbmcudmlzaW9uLS07XG4gIH1cbiAgZW1pdChmdWxsKTtcbn1cbiIsICIvLyBcIk4gaGlkZGVuIHRvZGF5XCIgYm9va2tlZXBpbmcgaGVscGVycyBzaGFyZWQgYnkgdGhlIHNlcnZpY2Ugd29ya2VyICh3cml0ZXIpIGFuZCBwb3B1cCAocmVhZGVyKS5cblxuaW1wb3J0IHR5cGUgeyBIaWRkZW5TdGF0cyB9IGZyb20gJy4vcHJvdG9jb2wnO1xuXG4vKiogTG9jYWwgY2FsZW5kYXIgZGF5IGFzIFwiWVlZWS1NTS1ERFwiLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2FsRGF5KGQ6IERhdGUpOiBzdHJpbmcge1xuICBjb25zdCB5ID0gZC5nZXRGdWxsWWVhcigpO1xuICBjb25zdCBtID0gU3RyaW5nKGQuZ2V0TW9udGgoKSArIDEpLnBhZFN0YXJ0KDIsICcwJyk7XG4gIGNvbnN0IGRheSA9IFN0cmluZyhkLmdldERhdGUoKSkucGFkU3RhcnQoMiwgJzAnKTtcbiAgcmV0dXJuIGAke3l9LSR7bX0tJHtkYXl9YDtcbn1cblxuLyoqIENvdW50IG9mIHBvc3RzIGhpZGRlbiB0b2RheSBmcm9tIHRoZSBzdG9yZWQgc3RhdHMgcmVjb3JkICgwIGlmIG1pc3NpbmcsIG1hbGZvcm1lZCBvciBmcm9tIGFub3RoZXIgZGF5KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoaWRkZW5Db3VudEZyb20oc3RhdHM6IHVua25vd24sIG5vdzogRGF0ZSk6IG51bWJlciB7XG4gIGNvbnN0IHMgPSBzdGF0cyBhcyBQYXJ0aWFsPEhpZGRlblN0YXRzPiB8IHVuZGVmaW5lZDtcbiAgaWYgKCFzIHx8IHR5cGVvZiBzICE9PSAnb2JqZWN0JyB8fCBzLmRheSAhPT0gbG9jYWxEYXkobm93KSB8fCAhQXJyYXkuaXNBcnJheShzLmhpZGRlbklkcykpIHJldHVybiAwO1xuICByZXR1cm4gcy5oaWRkZW5JZHMubGVuZ3RoO1xufVxuIiwgIi8vIGNocm9tZS5zdG9yYWdlLmxvY2FsIHdyaXRlcnM6IFwiaGlkZGVuIHRvZGF5XCIgaWRzIGFuZCB0aGUgZmVlZGJhY2sgbG9nLiBTcGVjIFx1MDBBNzQuMlxuXG5pbXBvcnQgeyBTVE9SQUdFX0tFWVMsIHR5cGUgRmVlZGJhY2tFbnRyeSwgdHlwZSBIaWRkZW5TdGF0cyB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9wcm90b2NvbCc7XG5pbXBvcnQgeyBsb2NhbERheSB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9kYXknO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN0b3JhZ2VBcmVhTGlrZSB7XG4gIGdldChrZXlzOiBzdHJpbmcgfCBzdHJpbmdbXSk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICBzZXQoaXRlbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGNvbnN0IE1BWF9ISURERU5fSURTID0gMTAwMDA7XG5leHBvcnQgY29uc3QgTUFYX0ZFRURCQUNLID0gNTAwMDtcblxuLy8gUmVhZC1tb2RpZnktd3JpdGUgbXVzdCBub3QgaW50ZXJsZWF2ZSAoZS5nLiB0d28gYGhpZGRlbmAgbWVzc2FnZXMgZm9yIHRoZSBzYW1lIHBvc3QpLlxubGV0IGNoYWluOiBQcm9taXNlPHVua25vd24+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbmZ1bmN0aW9uIGxvY2tlZDxUPihmbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBwID0gY2hhaW4udGhlbihmbik7XG4gIGNoYWluID0gcC5jYXRjaCgoKSA9PiB7fSk7XG4gIHJldHVybiBwO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkSGlkZGVuKHN0b3JhZ2U6IFN0b3JhZ2VBcmVhTGlrZSwgcG9zdElkOiBzdHJpbmcsIG5vdzogRGF0ZSA9IG5ldyBEYXRlKCkpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gbG9ja2VkKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkYXkgPSBsb2NhbERheShub3cpO1xuICAgIGNvbnN0IHN0b3JlZCA9IChhd2FpdCBzdG9yYWdlLmdldChTVE9SQUdFX0tFWVMuc3RhdHMpKVtTVE9SQUdFX0tFWVMuc3RhdHNdIGFzIFBhcnRpYWw8SGlkZGVuU3RhdHM+IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IGlkcyA9XG4gICAgICBzdG9yZWQgJiYgdHlwZW9mIHN0b3JlZCA9PT0gJ29iamVjdCcgJiYgc3RvcmVkLmRheSA9PT0gZGF5ICYmIEFycmF5LmlzQXJyYXkoc3RvcmVkLmhpZGRlbklkcylcbiAgICAgICAgPyBzdG9yZWQuaGlkZGVuSWRzXG4gICAgICAgIDogW107XG4gICAgaWYgKCFpZHMuaW5jbHVkZXMocG9zdElkKSkgaWRzLnB1c2gocG9zdElkKTtcbiAgICBjb25zdCBzdGF0czogSGlkZGVuU3RhdHMgPSB7IGRheSwgaGlkZGVuSWRzOiBpZHMuc2xpY2UoLU1BWF9ISURERU5fSURTKSB9O1xuICAgIGF3YWl0IHN0b3JhZ2Uuc2V0KHsgW1NUT1JBR0VfS0VZUy5zdGF0c106IHN0YXRzIH0pO1xuICAgIHJldHVybiBzdGF0cy5oaWRkZW5JZHMubGVuZ3RoO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFwcGVuZEZlZWRiYWNrKHN0b3JhZ2U6IFN0b3JhZ2VBcmVhTGlrZSwgZW50cnk6IEZlZWRiYWNrRW50cnkpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gbG9ja2VkKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBzdG9yZWQgPSAoYXdhaXQgc3RvcmFnZS5nZXQoU1RPUkFHRV9LRVlTLmZlZWRiYWNrKSlbU1RPUkFHRV9LRVlTLmZlZWRiYWNrXTtcbiAgICBjb25zdCBmZWVkYmFjayA9IFsuLi4oQXJyYXkuaXNBcnJheShzdG9yZWQpID8gc3RvcmVkIDogW10pLCBlbnRyeV0uc2xpY2UoLU1BWF9GRUVEQkFDSyk7XG4gICAgYXdhaXQgc3RvcmFnZS5zZXQoeyBbU1RPUkFHRV9LRVlTLmZlZWRiYWNrXTogZmVlZGJhY2sgfSk7XG4gICAgcmV0dXJuIGZlZWRiYWNrLmxlbmd0aDtcbiAgfSk7XG59XG4iLCAiLy8gU2VydmljZSB3b3JrZXIgZW50cnk6IGNocm9tZS4qIHdpcmluZyBvbmx5LiBMb2dpYyBsaXZlcyBpbiBuYXRpdmUvcGlwZWxpbmUvc3RvcmUgKHVuaXQtdGVzdGVkKS5cblxuaW1wb3J0IHtcbiAgSE9TVF9OQU1FLFxuICBQT1JUX05BTUUsXG4gIFNUT1JBR0VfS0VZUyxcbiAgdHlwZSBDb250ZW50VG9TdyxcbiAgdHlwZSBIZWFsdGhNc2csXG4gIHR5cGUgUmVzdWx0TXNnLFxuICB0eXBlIFN0YXR1c1NuYXBzaG90LFxufSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvcHJvdG9jb2wnO1xuaW1wb3J0IHsgZWZmZWN0aXZlU2V0dGluZ3MsIGlzQ2xhc3NpZmljYXRpb25BY3RpdmUgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvc2V0dGluZ3MnO1xuaW1wb3J0IHR5cGUgeyBSYXRlTGltaXRJbmZvLCBTZXR0aW5ncyB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC90eXBlcyc7XG5pbXBvcnQgeyBOYXRpdmVDbGllbnQgfSBmcm9tICcuL25hdGl2ZSc7XG5pbXBvcnQgeyBjcmVhdGVQaXBlbGluZURlcHMsIHByb2Nlc3NQb3N0LCB0eXBlIFBpcGVsaW5lU3RhdHMgfSBmcm9tICcuL3BpcGVsaW5lJztcbmltcG9ydCB7IGFwcGVuZEZlZWRiYWNrLCByZWNvcmRIaWRkZW4gfSBmcm9tICcuL3N0b3JlJztcblxuY29uc3QgZmxhdm9yID0gX19GTEFWT1JfXztcbmNvbnN0IG5vb3AgPSAoKSA9PiB7fTtcblxuLy8gLS0tLSBTZXR0aW5ncyAtLS0tXG5cbmxldCBzZXR0aW5nczogU2V0dGluZ3MgPSBlZmZlY3RpdmVTZXR0aW5ncyh1bmRlZmluZWQsIGZsYXZvcik7XG5jb25zdCBzZXR0aW5nc1JlYWR5ID0gY2hyb21lLnN0b3JhZ2UubG9jYWxcbiAgLmdldChTVE9SQUdFX0tFWVMuc2V0dGluZ3MpXG4gIC50aGVuKChyKSA9PiB7XG4gICAgc2V0dGluZ3MgPSBlZmZlY3RpdmVTZXR0aW5ncyhyW1NUT1JBR0VfS0VZUy5zZXR0aW5nc10sIGZsYXZvcik7XG4gIH0pXG4gIC5jYXRjaChub29wKVxuICAuZmluYWxseSh1cGRhdGVCYWRnZSk7XG5cbmNocm9tZS5zdG9yYWdlLm9uQ2hhbmdlZC5hZGRMaXN0ZW5lcigoY2hhbmdlcywgYXJlYSkgPT4ge1xuICBpZiAoYXJlYSAhPT0gJ2xvY2FsJyB8fCAhKFNUT1JBR0VfS0VZUy5zZXR0aW5ncyBpbiBjaGFuZ2VzKSkgcmV0dXJuO1xuICBzZXR0aW5ncyA9IGVmZmVjdGl2ZVNldHRpbmdzKGNoYW5nZXNbU1RPUkFHRV9LRVlTLnNldHRpbmdzXS5uZXdWYWx1ZSwgZmxhdm9yKTtcbiAgdXBkYXRlQmFkZ2UoKTtcbn0pO1xuXG4vLyAtLS0tIENvbXBhbmlvbiAtLS0tXG5cbmNvbnN0IG5hdGl2ZSA9IG5ldyBOYXRpdmVDbGllbnQoe1xuICBjb25uZWN0OiAoKSA9PiBjaHJvbWUucnVudGltZS5jb25uZWN0TmF0aXZlKEhPU1RfTkFNRSksXG4gIGZsYXZvcixcbiAgZXh0VmVyc2lvbjogY2hyb21lLnJ1bnRpbWUuZ2V0TWFuaWZlc3QoKS52ZXJzaW9uLFxuICBsYXN0RXJyb3I6ICgpID0+IGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcj8ubWVzc2FnZSxcbiAgb25TdGF0dXM6IHVwZGF0ZUJhZGdlLFxufSk7XG5cbmZ1bmN0aW9uIHVwZGF0ZUJhZGdlKCk6IHZvaWQge1xuICBjb25zdCBhbGFybSA9IG5hdGl2ZS5nZXRTdGF0dXMoKS5jb21wYW5pb24gPT09ICdvZmZsaW5lJyAmJiBpc0NsYXNzaWZpY2F0aW9uQWN0aXZlKHNldHRpbmdzKTtcbiAgaWYgKGFsYXJtKSB7XG4gICAgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0ZXh0OiAnIScgfSkuY2F0Y2gobm9vcCk7XG4gICAgY2hyb21lLmFjdGlvbi5zZXRCYWRnZUJhY2tncm91bmRDb2xvcih7IGNvbG9yOiAnI2Q5MzAyNScgfSkuY2F0Y2gobm9vcCk7XG4gICAgY2hyb21lLmFjdGlvbi5zZXRUaXRsZSh7IHRpdGxlOiAnTG93IENvcnRpc29sOiBjb21wYW5pb24gb2ZmbGluZSwgbm90aGluZyBpcyBmaWx0ZXJlZCcgfSkuY2F0Y2gobm9vcCk7XG4gIH0gZWxzZSB7XG4gICAgY2hyb21lLmFjdGlvbi5zZXRCYWRnZVRleHQoeyB0ZXh0OiAnJyB9KS5jYXRjaChub29wKTtcbiAgICBjaHJvbWUuYWN0aW9uLnNldFRpdGxlKHsgdGl0bGU6IGZsYXZvciA9PT0gJ2RldicgPyAnTG93IENvcnRpc29sIChEZXYpJyA6ICdMb3cgQ29ydGlzb2wnIH0pLmNhdGNoKG5vb3ApO1xuICB9XG59XG5cbi8vIC0tLS0gU3RhdHMgLS0tLVxuXG50eXBlIEtpbmQgPSAndGV4dCcgfCAndmlzaW9uJyB8ICdmdWxsJztcbmNvbnN0IFNBTVBMRVMgPSA1MDtcbmNvbnN0IHNhbXBsZXM6IFJlY29yZDxLaW5kLCBudW1iZXJbXT4gPSB7IHRleHQ6IFtdLCB2aXNpb246IFtdLCBmdWxsOiBbXSB9O1xubGV0IHJhdGVMaW1pdDogUmF0ZUxpbWl0SW5mbyB8IHVuZGVmaW5lZDtcbmxldCBzZWxlY3RvckhlYWx0aDogT21pdDxIZWFsdGhNc2csICd0eXBlJz4gfCB1bmRlZmluZWQ7XG5cbmNvbnN0IHN0YXRzOiBQaXBlbGluZVN0YXRzID0ge1xuICBwZW5kaW5nOiB7IHRleHQ6IDAsIHZpc2lvbjogMCB9LFxuICByZWNvcmQoa2luZCwgbXMpIHtcbiAgICBjb25zdCBhID0gc2FtcGxlc1traW5kXTtcbiAgICBhLnB1c2gobXMpO1xuICAgIGlmIChhLmxlbmd0aCA+IFNBTVBMRVMpIGEuc2hpZnQoKTtcbiAgfSxcbiAgc2V0UmF0ZUxpbWl0KHIpIHtcbiAgICAvLyBGdWxseSBjYWNoZWQgdHJhbnNjcmliZXMgcmVwb3J0IG5vIHJhdGUgbGltaXQ7IGtlZXAgdGhlIGxhc3Qga25vd24gb25lLlxuICAgIGlmIChyKSByYXRlTGltaXQgPSByO1xuICB9LFxufTtcblxuZnVuY3Rpb24gYXZnKGtpbmQ6IEtpbmQpOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBjb25zdCBhID0gc2FtcGxlc1traW5kXTtcbiAgcmV0dXJuIGEubGVuZ3RoID8gTWF0aC5yb3VuZChhLnJlZHVjZSgoeCwgeSkgPT4geCArIHksIDApIC8gYS5sZW5ndGgpIDogdW5kZWZpbmVkO1xufVxuXG5jb25zdCBkZXBzID0gY3JlYXRlUGlwZWxpbmVEZXBzKG5hdGl2ZSwgKCkgPT4gc2V0dGluZ3MsIHN0YXRzKTtcblxuLy8gLS0tLSBDb250ZW50IHBvcnRzIC0tLS1cblxuZnVuY3Rpb24gc2FmZVBvc3QocG9ydDogY2hyb21lLnJ1bnRpbWUuUG9ydCwgcjogUmVzdWx0TXNnKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgcG9ydC5wb3N0TWVzc2FnZShyKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVGhlIHRhYiB3ZW50IGF3YXk7IGl0IHJlLXNlbmRzIHVucmVzb2x2ZWQgcG9zdHMgd2hlbiBpdCByZWNvbm5lY3RzLlxuICB9XG59XG5cbmNocm9tZS5ydW50aW1lLm9uQ29ubmVjdC5hZGRMaXN0ZW5lcigocG9ydCkgPT4ge1xuICBpZiAocG9ydC5uYW1lICE9PSBQT1JUX05BTUUpIHJldHVybjtcbiAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZzogQ29udGVudFRvU3cpID0+IHtcbiAgICBpZiAoIW1zZyB8fCB0eXBlb2YgbXNnICE9PSAnb2JqZWN0JykgcmV0dXJuO1xuICAgIHN3aXRjaCAobXNnLnR5cGUpIHtcbiAgICAgIGNhc2UgJ3Bvc3QnOlxuICAgICAgICB2b2lkIHNldHRpbmdzUmVhZHkudGhlbigoKSA9PiB7XG4gICAgICAgICAgaWYgKGlzQ2xhc3NpZmljYXRpb25BY3RpdmUoc2V0dGluZ3MpKSByZXR1cm4gcHJvY2Vzc1Bvc3QobXNnLCAocikgPT4gc2FmZVBvc3QocG9ydCwgciksIGRlcHMpO1xuICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdoaWRkZW4nOlxuICAgICAgICByZWNvcmRIaWRkZW4oY2hyb21lLnN0b3JhZ2UubG9jYWwsIG1zZy5wb3N0SWQpLmNhdGNoKG5vb3ApO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2ZlZWRiYWNrJzpcbiAgICAgICAgYXBwZW5kRmVlZGJhY2soY2hyb21lLnN0b3JhZ2UubG9jYWwsIG1zZy5lbnRyeSkuY2F0Y2gobm9vcCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaGVhbHRoJzpcbiAgICAgICAgc2VsZWN0b3JIZWFsdGggPSB7IG9rOiBtc2cub2ssIGNlbGxzOiBtc2cuY2VsbHMsIGFydGljbGVzOiBtc2cuYXJ0aWNsZXMsIHBhcnNlZDogbXNnLnBhcnNlZCB9O1xuICAgICAgICBicmVhaztcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0gUG9wdXAgLS0tLVxuXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZzogdW5rbm93biwgX3NlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gIGlmICgobXNnIGFzIHsgdHlwZT86IHVua25vd24gfSB8IG51bGwpPy50eXBlICE9PSAnZ2V0U3RhdHVzJykgcmV0dXJuO1xuICBjb25zdCBzdGF0dXM6IFN0YXR1c1NuYXBzaG90ID0ge1xuICAgIC4uLm5hdGl2ZS5nZXRTdGF0dXMoKSxcbiAgICBwZW5kaW5nOiB7IC4uLnN0YXRzLnBlbmRpbmcgfSxcbiAgICBhdmdNczogeyB0ZXh0OiBhdmcoJ3RleHQnKSwgdmlzaW9uOiBhdmcoJ3Zpc2lvbicpLCBmdWxsOiBhdmcoJ2Z1bGwnKSB9LFxuICAgIHJhdGVMaW1pdCxcbiAgICBzZWxlY3RvckhlYWx0aCxcbiAgfTtcbiAgc2VuZFJlc3BvbnNlKHN0YXR1cyk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQWlCTyxNQUFNLFlBQVk7QUFDbEIsTUFBTSxZQUFZO0FBQ2xCLE1BQU0sbUJBQW1CO0FBRXpCLE1BQU0sZUFBZTtBQUFBLElBQzFCLFVBQVU7QUFBQSxJQUNWLE9BQU87QUFBQSxJQUNQLFVBQVU7QUFBQSxFQUNaOzs7QUNyQk8sTUFBTSxnQkFBZ0I7QUFDdEIsTUFBTSxnQkFBZ0I7QUFHdEIsTUFBTSxvQkFBb0I7QUFBQSxJQUMvQixZQUFZO0FBQUEsSUFDWixVQUFVO0FBQUEsSUFDVixjQUFjO0FBQUEsRUFDaEI7QUFLTyxNQUFNLG9CQUEyRTtBQUFBLElBQ3RGLEVBQUUsSUFBSSxtQkFBbUIsT0FBTyxxQkFBcUI7QUFBQSxJQUNyRCxFQUFFLElBQUkscUJBQXFCLE9BQU8sYUFBYTtBQUFBLEVBQ2pEO0FBRU8sTUFBTSwyQkFBNEM7QUFFbEQsTUFBTSxtQkFBaUU7QUFBQSxJQUM1RSxNQUFNO0FBQUEsTUFDSixhQUFhO0FBQUEsTUFDYixhQUFhO0FBQUEsTUFDYixXQUFXLGtCQUFrQjtBQUFBLE1BQzdCLGVBQWU7QUFBQSxNQUNmLGlCQUFpQjtBQUFBLE1BQ2pCLGdCQUFnQjtBQUFBLE1BQ2hCLFlBQVk7QUFBQSxJQUNkO0FBQUEsSUFDQSxLQUFLO0FBQUE7QUFBQSxNQUVILGFBQWE7QUFBQSxNQUNiLGFBQWE7QUFBQSxNQUNiLFdBQVcsa0JB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LHVCQUF1QixRQUFRLEVBQUcsUUFBTyxZQUFZLEtBQUssQ0FBQyxNQUFNLFNBQVMsTUFBTSxDQUFDLEdBQUcsSUFBSTtBQUFBLFVBQzlGLENBQUM7QUFDRDtBQUFBLFFBQ0YsS0FBSztBQUNILHVCQUFhLE9BQU8sUUFBUSxPQUFPLElBQUksTUFBTSxFQUFFLE1BQU0sSUFBSTtBQUN6RDtBQUFBLFFBQ0YsS0FBSztBQUNILHlCQUFlLE9BQU8sUUFBUSxPQUFPLElBQUksS0FBSyxFQUFFLE1BQU0sSUFBSTtBQUMxRDtBQUFBLFFBQ0YsS0FBSztBQUNILDJCQUFpQixFQUFFLElBQUksSUFBSSxJQUFJLE9BQU8sSUFBSSxPQUFPLFVBQVUsSUFBSSxVQUFVLFFBQVEsSUFBSSxPQUFPO0FBQzVGO0FBQUEsTUFDSjtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUlELFNBQU8sUUFBUSxVQUFVLFlBQVksQ0FBQyxLQUFjLFNBQVMsaUJBQWlCO0FBQzVFLFFBQUssS0FBbUMsU0FBUyxZQUFhO0FBQzlELFVBQU0sU0FBeUI7QUFBQSxNQUM3QixHQUFHLE9BQU8sVUFBVTtBQUFBLE1BQ3BCLFNBQVMsRUFBRSxHQUFHLE1BQU0sUUFBUTtBQUFBLE1BQzVCLE9BQU8sRUFBRSxNQUFNLElBQUksTUFBTSxHQUFHLFFBQVEsSUFBSSxRQUFRLEdBQUcsTUFBTSxJQUFJLE1BQU0sRUFBRTtBQUFBLE1BQ3JFO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFDQSxpQkFBYSxNQUFNO0FBQUEsRUFDckIsQ0FBQzsiLAogICJuYW1lcyI6IFsiZmxhdm9yIiwgIm5hdGl2ZSIsICJzZXR0aW5ncyIsICJzdGF0cyIsICJkZXBzIiwgInN0YXRzIl0KfQo=
