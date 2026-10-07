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
  var flavor = "prod";
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
