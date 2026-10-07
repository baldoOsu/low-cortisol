"use strict";
(() => {
  // shared/rubric.ts
  var RUBRIC_VERSION = "r1";
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
  function intensityLabel(score) {
    const i = Math.min(INTENSITY_LEVELS.length - 1, Math.max(0, Math.round(score)));
    return INTENSITY_LEVELS[i];
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

  // shared/protocol.ts
  var PORT_NAME = "lc";
  var STORAGE_KEYS = {
    settings: "settings",
    stats: "stats",
    feedback: "feedback"
  };

  // shared/results.ts
  function mergeResult(prev, msg) {
    const base = prev && prev.snapHash === msg.snapHash ? { ...prev } : { postId: msg.postId, snapHash: msg.snapHash, vision: msg.vision };
    if (msg.stage === "text") base.text = msg;
    else base.full = msg;
    base.vision = msg.vision;
    if (msg.transcripts) base.transcripts = msg.transcripts;
    if (msg.error) base.error = msg.error;
    return base;
  }
  function effectiveJev(state) {
    return state?.full?.jev ?? state?.text?.jev;
  }
  function effectiveStage(state) {
    if (state?.full?.jev) return "full";
    if (state?.text?.jev) return "text";
    return void 0;
  }

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
  function effectiveSettings(stored, flavor) {
    const s = stored && typeof stored === "object" ? stored : {};
    const d = DEFAULT_SETTINGS[flavor];
    if (flavor === "prod") {
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

  // extension/src/content/hider.ts
  var HIDDEN_ATTR = "data-lc-hidden";
  var STYLE_ID = "lc-style";
  var CELL_SELECTOR = 'div[data-testid="cellInnerDiv"]';
  var STYLE_TEXT = `[${HIDDEN_ATTR}] > * { display: none !important; }
[${HIDDEN_ATTR}] { border: 0 !important; margin: 0 !important; padding: 0 !important; }
article[${HIDDEN_ATTR}] { display: none !important; }
`;
  function ensureStyles(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  function hideTargetOf(article) {
    return article.closest(CELL_SELECTOR) ?? article;
  }
  function hidePost(article, opts = {}) {
    const doc = article.ownerDocument;
    ensureStyles(doc);
    const t = hideTargetOf(article);
    if (t.hasAttribute(HIDDEN_ATTR)) return false;
    const win = opts.win ?? doc.defaultView;
    const mutate = () => t.setAttribute(HIDDEN_ATTR, "1");
    if (win && t.getBoundingClientRect().bottom <= 0) {
      const cells = opts.cells?.() ?? [...doc.querySelectorAll(CELL_SELECTOR)];
      const anchor = pickAnchor(cells, t);
      if (anchor) {
        preserveAnchor(anchor, mutate, win, opts.timeoutMs ?? 1e3);
        return true;
      }
    }
    mutate();
    return true;
  }
  function unhidePost(article) {
    const t = hideTargetOf(article);
    if (!t.hasAttribute(HIDDEN_ATTR)) return false;
    t.removeAttribute(HIDDEN_ATTR);
    return true;
  }
  function unhideAll(doc) {
    const hidden = doc.querySelectorAll(`[${HIDDEN_ATTR}]`);
    hidden.forEach((el) => el.removeAttribute(HIDDEN_ATTR));
    return hidden.length;
  }
  function pickAnchor(cells, target) {
    for (const cell of cells) {
      if (cell === target || cell.hasAttribute(HIDDEN_ATTR)) continue;
      if (cell.getBoundingClientRect().top >= 0) return cell;
    }
    return null;
  }
  function preserveAnchor(anchor, mutate, win, timeoutMs = 1e3) {
    const existing = active.get(anchor);
    if (existing && !existing.stopped) {
      mutate();
      existing.correct();
      if (!existing.stopped) existing.extend(timeoutMs);
      return;
    }
    const docTop = () => anchor.getBoundingClientRect().top + (win.scrollY ?? 0);
    const content = () => anchor.querySelector("article") ?? anchor.firstElementChild;
    const original = content();
    let base = docTop();
    let generation = 0;
    const observer = new MutationObserver((records) => records.forEach(correct));
    const state = {
      stopped: false,
      correct,
      extend(ms) {
        const g = ++generation;
        win.setTimeout(() => {
          if (g === generation) stop();
        }, ms);
      }
    };
    function stop() {
      state.stopped = true;
      observer.disconnect();
      if (active.get(anchor) === state) active.delete(anchor);
    }
    function correct() {
      if (state.stopped) return;
      if (!anchor.isConnected || content() !== original) return stop();
      const d = docTop() - base;
      if (Math.abs(d) < 1) return;
      win.scrollBy(0, d);
      base = docTop();
    }
    mutate();
    correct();
    if (state.stopped) return;
    active.set(anchor, state);
    observer.observe(anchor, { attributes: true, attributeFilter: ["style"] });
    state.extend(timeoutMs);
  }
  var active = /* @__PURE__ */ new WeakMap();

  // extension/src/content/page.ts
  var STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  var HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  var RESERVED = /* @__PURE__ */ new Set([
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "i",
    "settings",
    "compose",
    "login",
    "logout",
    "tos",
    "privacy",
    "jobs"
  ]);
  var FILTERED = /* @__PURE__ */ new Set(["home", "list", "search", "explore", "status"]);
  function pageInfo(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      return { kind: "other" };
    }
    const segs = path.split("/").filter(Boolean);
    const first = (segs[0] ?? "").toLowerCase();
    if (!first || first === "home") return { kind: "home" };
    if (first === "messages") return { kind: "messages" };
    const status = STATUS_RE.exec(path);
    if (status) return { kind: "status", focalId: status[2] };
    if (first === "search") return { kind: "search" };
    if (first === "explore") return { kind: "explore" };
    if (first === "notifications") return { kind: "notifications" };
    if (first === "i") {
      const second = segs[1]?.toLowerCase();
      if (second === "lists" && /^\d+$/.test(segs[2] ?? "")) return { kind: "list" };
      if (second === "bookmarks") return { kind: "bookmarks" };
      return { kind: "other" };
    }
    if (!RESERVED.has(first) && HANDLE_RE.test(segs[0])) return { kind: "profile" };
    return { kind: "other" };
  }
  function shouldFilter(kind) {
    return FILTERED.has(kind);
  }

  // extension/src/content/selectors.ts
  var SEL = {
    article: 'article[data-testid="tweet"]',
    cell: 'div[data-testid="cellInnerDiv"]',
    primaryColumn: '[data-testid="primaryColumn"]',
    tweetText: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    photo: '[data-testid="tweetPhoto"]',
    videoPlayer: '[data-testid="videoPlayer"]',
    card: '[data-testid="card.wrapper"]',
    socialContext: '[data-testid="socialContext"]',
    showMore: '[data-testid="tweet-text-show-more-link"]',
    ownProfileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
    placement: '[data-testid="placementTracking"]',
    quote: 'div[role="link"]',
    /** The engagement row (reply / repost / like / views). */
    actionBar: '[role="group"]'
  };
  var STATUS_HREF = /\/status\/(\d+)/;
  var HANDLE_RE2 = /^[A-Za-z0-9_]{1,15}$/;
  function scanRoot(doc) {
    return doc.querySelector(SEL.primaryColumn);
  }
  function findArticles(root) {
    return Array.from(root.querySelectorAll(SEL.article)).filter(
      (a) => !a.parentElement?.closest(SEL.article)
    );
  }
  function cellOf(article) {
    return article.closest(SEL.cell);
  }
  function quoteOf(article) {
    const outerName = article.querySelector(SEL.userName);
    for (const el of Array.from(article.querySelectorAll(SEL.quote))) {
      if (outerName && el.contains(outerName)) continue;
      if (el.querySelector(SEL.userName)) return el;
    }
    return null;
  }
  function statusIdOf(link) {
    return STATUS_HREF.exec(link.getAttribute("href") ?? "")?.[1] ?? null;
  }
  function permalinkOf(scope, exclude) {
    for (const a of Array.from(scope.querySelectorAll('a[href*="/status/"]'))) {
      if (exclude?.contains(a) || !a.querySelector("time")) continue;
      if (statusIdOf(a)) return a;
    }
    return null;
  }
  function postIdOf(article) {
    const link = permalinkOf(article, quoteOf(article));
    return link && statusIdOf(link);
  }
  function ownHandleOf(doc) {
    const href = doc.querySelector(SEL.ownProfileLink)?.getAttribute("href");
    if (!href) return null;
    let first;
    try {
      first = new URL(href, "https://x.com").pathname.split("/").filter(Boolean)[0];
    } catch {
      return null;
    }
    return first && HANDLE_RE2.test(first) ? `@${first}` : null;
  }
  function checkHealth(root) {
    const cells = root.querySelectorAll(SEL.cell).length;
    const found = findArticles(root);
    const parsed = found.filter((a) => postIdOf(a) !== null).length;
    return { cells, articles: found.length, parsed, ok: !(cells > 0 && found.length > 0 && parsed === 0) };
  }

  // extension/src/content/panel.ts
  var PANEL_ATTR = "data-lc-panel";
  var STOPPED_EVENTS = ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "keydown", "touchstart"];
  var PANEL_CSS = `
:host { display: block; }
.lc { font: 12px/1.4 ui-monospace, Consolas, monospace; color: inherit; margin: 6px 0 2px; }
.row { display: flex; align-items: center; gap: 6px; }
.chip {
  font: inherit; font-weight: 600; padding: 1px 6px; border-radius: 4px;
  color: #71767b; background: rgba(113,118,123,.14); border: 1px solid rgba(113,118,123,.35);
}
.chip.under { color: #00ba7c; background: rgba(0,186,124,.12); border-color: rgba(0,186,124,.45); }
.chip.over { color: #f4212e; background: rgba(244,33,46,.12); border-color: rgba(244,33,46,.45); }
.tog {
  width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  background: #8b98a5; color: #fff; font: 800 12px/1 system-ui, sans-serif;
}
.tog span { display: inline-block; transform: rotate(90deg); transition: transform .15s; }
.tog[aria-expanded="true"] span { transform: rotate(-90deg); }
.details {
  white-space: pre-wrap; margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  border-left: 4px solid #9aa0a6; background: rgba(127,127,127,.08);
}
.details[hidden] { display: none; }
.details.hide { border-left-color: #d93025; }
.details.keep { border-left-color: #188038; }
.details button { font: inherit; margin: 4px 6px 0 0; }
`;
  var f22 = (n) => n.toFixed(2);
  var f12 = (n) => n.toFixed(1);
  var ranked = (r) => r ? `${r.key} ${f22(r.p)}` : "-";
  var num = (n, f) => n === void 0 ? "-" : f(n);
  function scoreChip(m) {
    const p = effectiveJev(m.state) ? m.decision.ragebait : void 0;
    if (p === void 0) return { text: m.state?.error ? "{err}" : "{\u2026}", tone: "none" };
    return { text: `{${f22(p)}}`, tone: p >= m.settings.threshold ? "over" : "under" };
  }
  function panelVerdict(m) {
    if (!effectiveJev(m.state)) return m.state?.error ? "ERROR" : "PENDING";
    return m.decision.hide ? "HIDE" : "KEEP";
  }
  function visionLine(state) {
    switch (state?.vision) {
      case void 0:
      case "pending":
        return "vision: pending";
      case "none":
        return "vision: none";
      case "disabled":
        return "vision: disabled";
      case "skipped_flagged":
        return "vision: skipped (flagged by text)";
      case "failed":
        return `vision: failed: ${state.full?.error?.code ?? state.error?.code ?? "unknown"}`;
      case "done": {
        const ts = state.transcripts ?? [];
        return `vision: done ${ts.length} item(s)` + (ts[0] ? ` (${ts[0].model})` : "");
      }
    }
  }
  function timingLine(state) {
    const t = { ...state?.text?.timings, ...state?.full?.timings };
    const parts = [];
    if (t.textMs !== void 0) parts.push(`text ${t.textMs} ms${state?.text?.jev?.cached ? " (cache)" : ""}`);
    if (t.visionMs !== void 0) parts.push(`vision ${(t.visionMs / 1e3).toFixed(1)} s`);
    if (t.fullMs !== void 0) parts.push(`full ${t.fullMs} ms`);
    return parts.length ? `timing: ${parts.join(" \xB7 ")}` : void 0;
  }
  function panelLines(m) {
    const { state, decision: d, settings } = m;
    const verdict = panelVerdict(m);
    const jev = effectiveJev(state);
    const lines = [
      `LOW CORTISOL \xB7 dev   ${verdict}` + (verdict === "HIDE" && !settings.hideEnabled ? " (would hide)" : "") + (verdict === "ERROR" ? ` ${state?.error?.code}` : "")
    ];
    if (jev) {
      lines.push(`reason: ${d.reasons.join("; ")}`);
      lines.push(
        `ragebait ${num(d.ragebait, f22)} \xB7 category ${ranked(d.topCategory)} (hide-kinds ${num(d.hideCategoryMass, f22)}) \xB7 emotion ${ranked(d.topEmotion)}`
      );
      const i = d.intensity;
      lines.push(
        `intensity ${i === void 0 ? "-" : `${f12(i)} ${intensityLabel(i)}`} \xB7 topic ${ranked(d.topTopic)} \xB7 ${jev.model} \xB7 ${RUBRIC_VERSION}`
      );
    }
    lines.push(visionLine(state));
    if (settings.showTranscript) {
      (state?.transcripts ?? []).forEach((t, k) => {
        lines.push(
          `transcript #${k + 1} ${t.kind}${t.inQuote ? " (quote)" : ""}: "${t.visibleText.slice(0, 160)}" \u2014 ${t.description.slice(0, 200)}${t.cues.length ? " [" + t.cues.join(", ") + "]" : ""}`
        );
      });
    }
    if (settings.showStatus) {
      const timing = timingLine(state);
      if (timing) lines.push(timing);
    }
    return lines;
  }
  function ownedBy(article, el) {
    const inner = el.parentElement?.closest(SEL.article);
    return !inner || inner === article || !article.contains(inner);
  }
  function hostsOf(article) {
    return Array.from(article.querySelectorAll(`[${PANEL_ATTR}]`)).filter((h) => ownedBy(article, h));
  }
  function ownLast(article, sel) {
    const quote = quoteOf(article);
    const own = Array.from(article.querySelectorAll(sel)).filter(
      (el) => ownedBy(article, el) && !quote?.contains(el)
    );
    return own[own.length - 1];
  }
  function place(article, host) {
    const bar = ownLast(article, SEL.actionBar);
    if (bar) {
      if (bar.previousElementSibling !== host) bar.before(host);
      return;
    }
    const text = ownLast(article, SEL.tweetText);
    if (text) {
      if (text.nextElementSibling !== host) text.after(host);
      return;
    }
    if (article.lastElementChild !== host) article.appendChild(host);
  }
  function createHost(article) {
    const doc = article.ownerDocument;
    const host = doc.createElement("div");
    host.setAttribute(PANEL_ATTR, "");
    for (const type of STOPPED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = PANEL_CSS;
    const chip = doc.createElement("code");
    chip.className = "chip";
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "tog";
    toggle.title = "Low Cortisol details";
    toggle.setAttribute("aria-expanded", "false");
    const arrow = doc.createElement("span");
    arrow.textContent = ">";
    toggle.append(arrow);
    const row = doc.createElement("div");
    row.className = "row";
    row.append(chip, toggle);
    const details = doc.createElement("div");
    details.className = "details";
    details.hidden = true;
    toggle.addEventListener("click", () => {
      details.hidden = !details.hidden;
      toggle.setAttribute("aria-expanded", String(!details.hidden));
    });
    const box = doc.createElement("div");
    box.className = "lc";
    box.append(row, details);
    root.append(style, box);
    return host;
  }
  function renderPanel(article, m, onFeedback) {
    const doc = article.ownerDocument;
    const [first, ...extra] = hostsOf(article);
    extra.forEach((h) => h.remove());
    if (first && !first.shadowRoot) first.remove();
    const host = first?.shadowRoot ? first : createHost(article);
    place(article, host);
    const root = host.shadowRoot;
    const chip = scoreChip(m);
    const chipEl = root.querySelector(".chip");
    chipEl.className = `chip ${chip.tone}`;
    chipEl.textContent = chip.text;
    const box = root.querySelector(".details");
    const verdict = panelVerdict(m);
    box.className = `details ${verdict === "HIDE" ? "hide" : verdict === "KEEP" ? "keep" : "pending"}`;
    box.replaceChildren(doc.createTextNode(panelLines(m).join("\n") + "\n"));
    const enabled = !!effectiveJev(m.state);
    for (const [text, label] of [["Should hide", "hide"], ["Should keep", "keep"]]) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.disabled = !enabled;
      btn.addEventListener("click", () => onFeedback(label));
      box.append(btn);
    }
    if (m.saved) box.append(doc.createTextNode(`saved \u2713 (${m.saved})`));
    return host;
  }
  function removePanel(article) {
    hostsOf(article).forEach((h) => h.remove());
  }
  function removeAllPanels(doc) {
    const panels = doc.querySelectorAll(`[${PANEL_ATTR}]`);
    panels.forEach((p) => p.remove());
    return panels.length;
  }

  // extension/src/content/scanner.ts
  var X_ORIGIN = "https://x.com";
  var PERMALINK_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/;
  var HANDLE_TEXT = /^@[A-Za-z0-9_]{1,15}$/;
  var DOMAIN_TEXT = /^(From\s+)?([a-z0-9-]+\.)+[a-z]{2,}$/i;
  var LARGE_SIZES = /* @__PURE__ */ new Set(["large", "orig", "4096x4096"]);
  function extractText(el) {
    if (!el) return "";
    let out = "";
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue ?? "";
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const e = child;
          if (e.localName === "br") out += "\n";
          else if (e.localName === "img") out += e.getAttribute("alt") ?? "";
          else walk(e);
        }
      }
    };
    walk(el);
    return out.trim();
  }
  function mediaKey(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return url;
    }
    if (u.hostname === "pbs.twimg.com") {
      const media = /^\/media\/([^/.]+)/.exec(u.pathname);
      if (media) return `media/${media[1]}`;
      return u.pathname.replace(/^\//, "").replace(/\.[A-Za-z0-9]+$/, "");
    }
    return u.origin + u.pathname;
  }
  function normalizeMediaUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return url;
    }
    if (!LARGE_SIZES.has(u.searchParams.get("name") ?? "")) return url;
    u.searchParams.set("name", "medium");
    return u.toString();
  }
  function isPbs(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && u.hostname === "pbs.twimg.com";
    } catch {
      return false;
    }
  }
  function outsideAll(scope, sel, exclude) {
    return Array.from(scope.querySelectorAll(sel)).filter((el) => !exclude?.contains(el));
  }
  function outside(scope, sel, exclude) {
    return outsideAll(scope, sel, exclude)[0] ?? null;
  }
  function leafTexts(el) {
    const out = [];
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = (child.nodeValue ?? "").trim();
          if (t) out.push(t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      }
    };
    walk(el);
    return out;
  }
  function authorOf(userName) {
    if (!userName) return { handle: "", name: "" };
    const handle = leafTexts(userName).filter((t) => HANDLE_TEXT.test(t)).pop() ?? "";
    const nameLink = Array.from(userName.querySelectorAll("a")).find(
      (a) => !a.querySelector("time") && !extractText(a).startsWith("@")
    );
    return { handle, name: extractText(nameLink ?? userName.firstElementChild) };
  }
  function collectMedia(scope, exclude, inQuote, out, seen) {
    const add = (kind, raw, alt) => {
      if (!raw || !isPbs(raw)) return;
      const key = mediaKey(raw);
      if (seen.has(key)) return;
      seen.add(key);
      const ref = { kind, url: normalizeMediaUrl(raw), key, inQuote };
      if (alt) ref.alt = alt;
      out.push(ref);
    };
    for (const img of outsideAll(scope, `${SEL.photo} img`, exclude)) {
      add("image", img.getAttribute("src"), img.getAttribute("alt")?.trim() || void 0);
    }
    for (const video of outsideAll(scope, `${SEL.videoPlayer} video[poster]`, exclude)) {
      const poster = video.getAttribute("poster");
      const player = video.closest(SEL.videoPlayer);
      const gif = !!poster?.includes("tweet_video_thumb") || !!player && leafTexts(player).includes("GIF");
      add(gif ? "gif_poster" : "video_poster", poster);
    }
    const card = outside(scope, SEL.card, exclude);
    const cardImg = card && Array.from(card.querySelectorAll("img")).find((img) => isPbs(img.getAttribute("src") ?? ""));
    if (cardImg) add("card_image", cardImg.getAttribute("src"));
  }
  function cardOf(wrapper) {
    if (!wrapper) return void 0;
    let domain;
    const others = [];
    for (const t of leafTexts(wrapper)) {
      if (!domain && DOMAIN_TEXT.test(t)) domain = t.replace(/^From\s+/i, "");
      else others.push(t);
    }
    const card = {};
    if (domain) card.domain = domain;
    if (others[0]) card.title = others[0];
    if (others[1]) card.description = others[1];
    return Object.keys(card).length ? card : void 0;
  }
  function quotedOf(quote) {
    const { handle, name } = authorOf(quote.querySelector(SEL.userName));
    const quoted = {
      authorHandle: handle,
      authorName: name,
      text: extractText(quote.querySelector(SEL.tweetText)),
      truncated: !!quote.querySelector(SEL.showMore)
    };
    const link = permalinkOf(quote, null) ?? quote.querySelector('a[href*="/status/"]');
    const postId = link && statusIdOf(link);
    if (postId) quoted.postId = postId;
    return quoted;
  }
  function isPromoted(article) {
    if (cellOf(article)?.querySelector(SEL.placement)) return true;
    return Array.from(article.querySelectorAll("span")).some(
      (span) => span.childElementCount === 0 && /^(Ad|Promoted)$/.test((span.textContent ?? "").trim()) && !span.closest(SEL.tweetText)
    );
  }
  function snapshotArticle(article) {
    const quote = quoteOf(article);
    const link = permalinkOf(article, quote);
    const postId = link && statusIdOf(link);
    if (!link || !postId) return null;
    let path;
    try {
      path = new URL(link.getAttribute("href") ?? "", X_ORIGIN).pathname;
    } catch {
      return null;
    }
    const hrefHandle = PERMALINK_PATH.exec(path)?.[1];
    const url = hrefHandle ? `${X_ORIGIN}/${hrefHandle}/status/${postId}` : `${X_ORIGIN}/i/web/status/${postId}`;
    const author = authorOf(outside(article, SEL.userName, quote));
    const textEl = outside(article, SEL.tweetText, quote);
    const media = [];
    const seen = /* @__PURE__ */ new Set();
    collectMedia(article, quote, false, media, seen);
    if (quote) collectMedia(quote, null, true, media, seen);
    const snap = {
      postId,
      url,
      authorHandle: author.handle || (hrefHandle ? `@${hrefHandle}` : ""),
      authorName: author.name,
      text: extractText(textEl),
      truncated: !!outside(article, SEL.showMore, quote),
      promoted: isPromoted(article),
      media
    };
    const lang = textEl?.getAttribute("lang");
    if (lang) snap.lang = lang;
    const social = outside(article, SEL.socialContext, quote);
    const repostedBy = /^(.*?)\s+reposted$/i.exec(extractText(social))?.[1].trim();
    if (repostedBy) snap.repostedBy = repostedBy;
    const card = cardOf(outside(article, SEL.card, quote));
    if (card) snap.card = card;
    if (quote) snap.quoted = quotedOf(quote);
    return snap;
  }
  function exemptReason(article, snap, ctx) {
    if (!shouldFilter(ctx.page.kind)) return "page";
    if (!ctx.root || !ctx.root.contains(article)) return "outside";
    if (snap && ctx.ownHandle && snap.authorHandle.toLowerCase() === ctx.ownHandle.toLowerCase()) return "own";
    if (ctx.page.kind === "status") {
      const focalId = ctx.page.focalId;
      const focal = focalId ? findArticles(ctx.root).find((a) => postIdOf(a) === focalId) : void 0;
      if (!focal) return "no-focal";
      if (article === focal) return "focal";
      if (article.compareDocumentPosition(focal) & Node.DOCUMENT_POSITION_FOLLOWING) return "ancestor";
    }
    return null;
  }

  // extension/src/content/main.ts
  var EXEMPT_ATTR = "data-lc-exempt";
  var SCAN_DEBOUNCE_MS = 100;
  var URL_POLL_MS = 500;
  var RECONNECT_BASE_MS = 1e3;
  var RECONNECT_MAX_MS = 3e4;
  var CONNECT_MIN_INTERVAL_MS = 1e3;
  var ERROR_RETRY_MS = 3e4;
  var OUTBOX_MAX = 200;
  var ContentController = class {
    constructor(deps) {
      this.deps = deps;
      this.settings = effectiveSettings(void 0, deps.flavor);
    }
    deps;
    settings;
    results = /* @__PURE__ */ new Map();
    /** The last snapshot sent per post; results for any other snapHash are dropped. */
    sent = /* @__PURE__ */ new Map();
    /** The snapshot each stored result was computed from (feedback records its exact Jev state). */
    resultSnaps = /* @__PURE__ */ new Map();
    hiddenReported = /* @__PURE__ */ new Set();
    saved = /* @__PURE__ */ new Map();
    /** Articles with an active observeNear, and its cancel function. */
    watching = /* @__PURE__ */ new Map();
    /** Status pages: focal id → ids of the focal post and its ancestors, seen while the focal was in the DOM. */
    threadExempt = /* @__PURE__ */ new Map();
    port = null;
    outbox = [];
    reconnectAttempt = 0;
    reconnectTimer = void 0;
    lastConnectAt = -Infinity;
    scanTimer = void 0;
    pollTimer = void 0;
    observer = null;
    lastHref = "";
    lastHealthOk;
    stopped = false;
    async start() {
      let raw;
      try {
        raw = await this.deps.loadSettings();
      } catch {
        raw = void 0;
      }
      if (this.stopped) return;
      this.settings = effectiveSettings(raw, this.deps.flavor);
      this.deps.onSettingsChanged((r) => {
        if (!this.stopped) this.applySettings(r);
      });
      this.connect();
      this.observer = new MutationObserver((records) => {
        if (records.some((r) => !isOwnMutation(r))) this.scheduleScan();
      });
      this.observer.observe(this.deps.doc.body, { childList: true, subtree: true, characterData: true });
      this.deps.win.addEventListener("popstate", this.onPopState);
      this.lastHref = this.deps.locationHref();
      this.pollTimer = this.deps.setTimer(this.poll, URL_POLL_MS);
      this.scan();
    }
    stop() {
      this.stopped = true;
      this.observer?.disconnect();
      this.observer = null;
      this.deps.win.removeEventListener("popstate", this.onPopState);
      for (const t of [this.scanTimer, this.pollTimer, this.reconnectTimer]) {
        if (t !== void 0) this.deps.clearTimer(t);
      }
      this.scanTimer = this.pollTimer = this.reconnectTimer = void 0;
      this.unwatchAll();
      const port = this.port;
      this.port = null;
      try {
        port?.disconnect();
      } catch {
      }
    }
    scan() {
      if (this.stopped) return;
      const ctx = this.context();
      if (!ctx) {
        this.clearAll();
        if (this.filteredPage()) {
          this.reportHealth({ ok: false, cells: this.deps.doc.querySelectorAll(SEL.cell).length, articles: 0, parsed: 0 });
        }
        return;
      }
      this.reconcile(ctx);
      this.pruneWatching();
      for (const article of findArticles(ctx.root)) {
        if (this.stopped) return;
        const snap = snapshotArticle(article);
        if (!snap) continue;
        const reason = this.exempt(article, snap, ctx);
        if (reason) {
          article.setAttribute(EXEMPT_ATTR, reason);
          removePanel(article);
          unhidePost(article);
          continue;
        }
        article.removeAttribute(EXEMPT_ATTR);
        this.retryIfErrored(snap.postId, article);
        const h = hash53(stableStringify(snap));
        if (this.sent.get(snap.postId)?.snapHash !== h && !this.watching.has(article)) {
          let fired = false;
          const cancel = this.deps.observeNear(article, () => {
            fired = true;
            this.watching.delete(article);
            this.send(snap, h);
          });
          if (!fired) this.watching.set(article, cancel);
        }
        this.apply(article, snap.postId, ctx);
      }
      if (this.stopped) return;
      this.reportHealth(checkHealth(ctx.root));
    }
    handleResult(msg) {
      const entry = this.sent.get(msg.postId);
      if (!entry || msg.snapHash !== entry.snapHash) return;
      this.results.set(msg.postId, mergeResult(this.results.get(msg.postId), msg));
      this.resultSnaps.set(msg.postId, entry.snapshot);
      this.applyPost(msg.postId);
    }
    applySettings(raw) {
      this.settings = effectiveSettings(raw, this.deps.flavor);
      this.scan();
    }
    // ---- Scanning ----
    /** This page when it is filtered and classification is on; null otherwise. */
    filteredPage() {
      const page = pageInfo(this.deps.locationHref());
      if (page.kind === "messages") return null;
      return shouldFilter(page.kind) && isClassificationActive(this.settings) ? page : null;
    }
    /** The scan context when this page is filtered, classification is on and the scan root exists. */
    context() {
      const { doc } = this.deps;
      const page = this.filteredPage();
      const root = page && scanRoot(doc);
      return page && root ? { page, ownHandle: ownHandleOf(doc), root } : null;
    }
    /**
     * exemptReason, plus memory for status threads: while the focal post is in the DOM, the ids of the
     * focal post and its ancestors are remembered per focal id. Once X's virtual list drops the focal
     * article, only those ids stay exempt and every other article is a reply, filtered as usual.
     * 'no-focal' (everything exempt) remains only when this page's focal post was never seen.
     */
    exempt(article, snap, ctx) {
      const reason = exemptReason(article, snap, ctx);
      const focalId = ctx.page.kind === "status" ? ctx.page.focalId : void 0;
      const postId = snap?.postId ?? postIdOf(article);
      if (!focalId || !postId) return reason;
      let thread = this.threadExempt.get(focalId);
      if (reason === "focal" || reason === "ancestor") {
        if (!thread) this.threadExempt.set(focalId, thread = /* @__PURE__ */ new Set());
        thread.add(postId);
        return reason;
      }
      if (reason !== "no-focal" || !thread) return reason;
      if (!thread.has(postId)) return null;
      return postId === focalId ? "focal" : "ancestor";
    }
    clearAll() {
      this.unwatchAll();
      unhideAll(this.deps.doc);
      removeAllPanels(this.deps.doc);
    }
    /** Unhide every hidden cell whose (possibly recycled) article is gone or no longer decided "hide". */
    reconcile(ctx) {
      for (const el of Array.from(this.deps.doc.querySelectorAll(`[${HIDDEN_ATTR}]`))) {
        const article = el.matches(SEL.article) ? el : findArticles(el)[0];
        const postId = article && ctx.root.contains(article) ? postIdOf(article) : null;
        if (!postId || !this.settings.hideEnabled || !this.decision(postId).hide) el.removeAttribute(HIDDEN_ATTR);
      }
    }
    /** Re-send a post whose last result was an error without answers, at most once per ERROR_RETRY_MS. */
    retryIfErrored(postId, article) {
      const entry = this.sent.get(postId);
      const st = this.results.get(postId);
      if (!entry || !st?.error || effectiveJev(st) || this.watching.has(article)) return;
      if (this.deps.now() - entry.at >= ERROR_RETRY_MS) this.forget(postId);
    }
    /** Drop the sent record so the next scan sends the post again; a state without answers is dropped too. */
    forget(postId) {
      this.sent.delete(postId);
      if (!effectiveJev(this.results.get(postId))) {
        this.results.delete(postId);
        this.resultSnaps.delete(postId);
      }
    }
    /** A usable result for this exact snapshot, with no vision pass still in flight. */
    isResolved(postId, snapHash) {
      const st = this.results.get(postId);
      return st?.snapHash === snapHash && !!effectiveJev(st) && st.vision !== "pending";
    }
    pruneWatching() {
      for (const [el, cancel] of this.watching) {
        if (el.isConnected) continue;
        cancel();
        this.watching.delete(el);
      }
    }
    unwatchAll() {
      for (const cancel of this.watching.values()) cancel();
      this.watching.clear();
    }
    send(snapshot, snapHash) {
      if (this.stopped || !this.context()) return;
      this.sent.set(snapshot.postId, { snapHash, snapshot, at: this.deps.now() });
      this.post({ type: "post", snapshot, snapHash });
    }
    /** Report selector health to the SW when it flips. */
    reportHealth({ ok, cells, articles, parsed }) {
      if (ok === this.lastHealthOk) return;
      this.lastHealthOk = ok;
      this.post({ type: "health", ok, cells, articles, parsed });
      if (this.deps.flavor === "dev" && !ok) {
        console.warn("[Low Cortisol] selector health", { ok, cells, articles, parsed });
      }
    }
    // ---- Applying verdicts ----
    decision(postId) {
      return decide(effectiveJev(this.results.get(postId))?.answers, this.settings.threshold);
    }
    /** Re-apply every eligible article in the scan root that shows `postId`. */
    applyPost(postId) {
      const ctx = this.stopped ? null : this.context();
      if (!ctx) return;
      for (const article of findArticles(ctx.root)) {
        if (this.stopped) return;
        if (postIdOf(article) !== postId) continue;
        if (this.exempt(article, snapshotArticle(article), ctx)) continue;
        this.apply(article, postId, ctx);
      }
    }
    apply(article, postId, ctx) {
      if (this.stopped) return;
      const st = this.results.get(postId);
      const d = this.decision(postId);
      if (this.settings.hideEnabled && d.hide) {
        removePanel(article);
        const cells = () => Array.from(ctx.root.querySelectorAll(SEL.cell));
        if (hidePost(article, { win: this.deps.win, cells }) && !this.hiddenReported.has(postId)) {
          this.hiddenReported.add(postId);
          this.post({ type: "hidden", postId });
        }
        return;
      }
      unhidePost(article);
      if (this.deps.flavor === "dev" && this.settings.showResults) {
        renderPanel(
          article,
          { postId, state: st, decision: d, settings: this.settings, saved: this.saved.get(postId) },
          (label) => this.feedback(postId, label)
        );
      } else {
        removePanel(article);
      }
    }
    feedback(postId, label) {
      if (this.stopped) return;
      const st = this.results.get(postId);
      const jev = effectiveJev(st);
      const stage = effectiveStage(st);
      const snap = this.resultSnaps.get(postId);
      if (!st || !jev || !stage || !snap) return;
      const entry = {
        at: new Date(this.deps.now()).toISOString(),
        flavor: this.deps.flavor,
        postId,
        url: snap.url,
        label,
        verdict: this.decision(postId).hide ? "hide" : "keep",
        threshold: this.settings.threshold,
        rubricVersion: RUBRIC_VERSION,
        jevModel: jev.model,
        stage,
        answers: jev.answers,
        state: buildJevState(snap, stage === "full" ? st.transcripts : void 0)
      };
      this.post({ type: "feedback", entry });
      this.saved.set(postId, label);
      this.applyPost(postId);
    }
    // ---- Port ----
    post(m) {
      if (this.port) {
        try {
          this.port.postMessage(m);
          return;
        } catch {
        }
      }
      if ((m.type === "hidden" || m.type === "feedback") && this.outbox.length < OUTBOX_MAX) this.outbox.push(m);
      this.reconnectNow();
    }
    connect() {
      if (this.stopped) return;
      this.lastConnectAt = this.deps.now();
      let port;
      try {
        port = this.deps.connect();
      } catch {
        if (this.deps.contextValid && !this.deps.contextValid()) {
          this.stop();
          this.clearAll();
          return;
        }
        this.scheduleReconnect();
        return;
      }
      this.port = port;
      const connectedAt = this.deps.now();
      port.onMessage.addListener((m) => {
        if (this.port !== port || this.stopped) return;
        this.reconnectAttempt = 0;
        if (m && m.type === "result") this.handleResult(m);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        if (this.deps.now() - connectedAt >= RECONNECT_MAX_MS) this.reconnectAttempt = 0;
        this.scheduleReconnect();
      });
    }
    /** Something must be sent and the port is down: reconnect now instead of waiting out the backoff. */
    reconnectNow() {
      if (this.stopped || this.port || this.deps.now() - this.lastConnectAt < CONNECT_MIN_INTERVAL_MS) return;
      if (this.reconnectTimer !== void 0) {
        this.deps.clearTimer(this.reconnectTimer);
        this.reconnectTimer = void 0;
      }
      this.reconnect();
    }
    scheduleReconnect() {
      if (this.stopped || this.reconnectTimer !== void 0) return;
      const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
      this.reconnectAttempt++;
      this.reconnectTimer = this.deps.setTimer(() => {
        this.reconnectTimer = void 0;
        this.reconnect();
      }, ms);
    }
    /** Reconnect, flush queued messages, re-send every unresolved post and re-report selector health. */
    reconnect() {
      this.connect();
      if (!this.port) return;
      const queued = this.outbox;
      this.outbox = [];
      queued.forEach((m) => this.post(m));
      if (isClassificationActive(this.settings)) {
        for (const [postId, entry] of this.sent) {
          if (this.isResolved(postId, entry.snapHash)) continue;
          entry.at = this.deps.now();
          this.post({ type: "post", snapshot: entry.snapshot, snapHash: entry.snapHash });
        }
      }
      this.lastHealthOk = void 0;
      this.scheduleScan();
    }
    // ---- Triggers ----
    scheduleScan() {
      if (this.stopped || this.scanTimer !== void 0) return;
      this.scanTimer = this.deps.setTimer(() => {
        this.scanTimer = void 0;
        this.scan();
      }, SCAN_DEBOUNCE_MS);
    }
    poll = () => {
      if (this.stopped) return;
      this.checkUrl();
      this.pollTimer = this.deps.setTimer(this.poll, URL_POLL_MS);
    };
    onPopState = () => {
      if (!this.stopped) this.checkUrl();
    };
    checkUrl() {
      const href = this.deps.locationHref();
      if (href === this.lastHref) return;
      this.lastHref = href;
      this.scan();
    }
  };
  function isOwnMutation(r) {
    if (r.type !== "childList") return false;
    const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
    return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.hasAttribute(PANEL_ATTR));
  }
  function realDeps() {
    return {
      doc: document,
      win: window,
      flavor: "dev",
      connect: () => {
        const port = chrome.runtime.connect({ name: PORT_NAME });
        port.onDisconnect.addListener(() => void chrome.runtime.lastError);
        return port;
      },
      loadSettings: async () => (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings],
      onSettingsChanged: (cb) => chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && STORAGE_KEYS.settings in changes) cb(changes[STORAGE_KEYS.settings].newValue);
      }),
      observeNear: (el, cb) => {
        const io = new IntersectionObserver(
          (entries) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            io.disconnect();
            cb();
          },
          { rootMargin: "2000px 0px" }
        );
        io.observe(el);
        return () => io.disconnect();
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h),
      locationHref: () => location.href,
      contextValid: () => !!chrome.runtime?.id
    };
  }
  if (typeof chrome !== "undefined" && chrome.runtime?.id) void new ContentController(realDeps()).start();
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc2hhcmVkL3J1YnJpYy50cyIsICIuLi8uLi9zaGFyZWQvZGVjaWRlLnRzIiwgIi4uLy4uL3NoYXJlZC9oYXNoLnRzIiwgIi4uLy4uL3NoYXJlZC9wcm90b2NvbC50cyIsICIuLi8uLi9zaGFyZWQvcmVzdWx0cy50cyIsICIuLi8uLi9zaGFyZWQvc2V0dGluZ3MudHMiLCAiLi4vLi4vZXh0ZW5zaW9uL3NyYy9jb250ZW50L2hpZGVyLnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvY29udGVudC9wYWdlLnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvY29udGVudC9zZWxlY3RvcnMudHMiLCAiLi4vLi4vZXh0ZW5zaW9uL3NyYy9jb250ZW50L3BhbmVsLnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvY29udGVudC9zY2FubmVyLnRzIiwgIi4uLy4uL2V4dGVuc2lvbi9zcmMvY29udGVudC9tYWluLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBSdWJyaWMgcjE6IHRoZSBKZXYgcXVlc3Rpb24gc2V0IChvd25lcidzIFExMiB0YWJsZSkgYW5kIHRoZSBkZXRlcm1pbmlzdGljIEpldiBpbnB1dCBidWlsZGVyLiBTcGVjIFx1MDBBNzMuMlxuXG5pbXBvcnQgdHlwZSB7XG4gIEpldk1lZGlhU3RhdGUsXG4gIEpldlBvc3RTdGF0ZSxcbiAgSmV2UXVvdGVkU3RhdGUsXG4gIEpldlN0YXRlLFxuICBNZWRpYVJlZixcbiAgTWVkaWFUcmFuc2NyaXB0LFxuICBQb3N0U25hcHNob3QsXG59IGZyb20gJy4vdHlwZXMnO1xuXG5leHBvcnQgY29uc3QgUlVCUklDX1ZFUlNJT04gPSAncjEnO1xuXG5leHBvcnQgY29uc3QgSElERV9DQVRFR09SSUVTID0gW1xuICAnb3V0cmFnZV9iYWl0JyxcbiAgJ2N1bHR1cmVfd2FyJyxcbiAgJ2VuZ2FnZW1lbnRfYmFpdCcsXG4gICdoYXJhc3NtZW50JyxcbiAgJ2ZlYXJfbW9uZ2VyaW5nJyxcbiAgJ2RyYW1hJyxcbiAgJ3NlbnNhdGlvbmFsX2dyYXBoaWMnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IEtFRVBfQ0FURUdPUklFUyA9IFtcbiAgJ25ldXRyYWxfbmV3cycsXG4gICdzaW5jZXJlX3BlcnNvbmFsJyxcbiAgJ3N1YnN0YW50aXZlX2NyaXRpY2lzbScsXG4gICdodW1vcicsXG4gICdiZW5pZ25fb3RoZXInLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IElOVEVOU0lUWV9MRVZFTFMgPSBbJ0NhbG0nLCAnTWlsZCcsICdNb2RlcmF0ZScsICdTdHJvbmcnLCAnSW5mbGFtbWF0b3J5J10gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBKRVZfUVVFU1RJT05TID0ge1xuICByYWdlYmFpdDoge1xuICAgIHR5cGU6ICdub3VsJyxcbiAgICBpbnN0cnVjdGlvbnM6XG4gICAgICAnU2hvdWxkIHRoaXMgcG9zdCBiZSBoaWRkZW4gZm9yIGEgcmVhZGVyIHdobyB3YW50cyBhIGNhbG0sIGxvdy1zdHJlc3MgdGltZWxpbmU/IEhpZGUgcG9zdHMgZGVzaWduZWQgb3IgbGlrZWx5IHRvIHByb3Zva2UgYW5nZXIsIG91dHJhZ2UsIGNvbnRlbXB0LCBmZWFyIG9yIGRvb20gaW4gYSB0eXBpY2FsIHJlYWRlciwgcmF0aGVyIHRoYW4gdG8gaW5mb3JtLCBoZWxwIG9yIGVudGVydGFpbi4gSnVkZ2UgdGhlIHBvc3QsIGl0cyBxdW90ZWQgcG9zdCwgbGluayBjYXJkIGFuZCBtZWRpYSB0cmFuc2NyaXB0cyB0b2dldGhlciBhcyBvbmUgdW5pdC4nLFxuICAgIGNyaXRlcmlhOiB7XG4gICAgICB0cnVlOiAnT3V0cmFnZSBiYWl0IG9yIGR1bmtpbmc7IHBvbGl0aWNhbCBvciBjdWx0dXJlLXdhciBmaWdodGluZzsgZW5nYWdlbWVudCBiYWl0IChyYXRpbywgUlQgaWYgeW91IGFncmVlLCBkZWxpYmVyYXRlbHkgd3JvbmcgaG90IHRha2VzKTsgaW5zdWx0cyBvciBoYXJhc3NtZW50IGFpbWVkIGF0IHBlb3BsZSBvciBncm91cHM7IGZlYXItbW9uZ2VyaW5nIChjb2xsYXBzZSwgZG9vbSwgaGVhbHRoIHNjYXJlcyk7IGluZmx1ZW5jZXIgb3IgY2VsZWJyaXR5IGRyYW1hOyBzZW5zYXRpb25hbCBvciBncmFwaGljIGNyaW1lLCB2aW9sZW5jZSwgd2FyIG9yIGRpc2FzdGVyIGNvbnRlbnQuJyxcbiAgICAgIGZhbHNlOlxuICAgICAgICAnTmV1dHJhbCBmYWN0dWFsIG5ld3MsIGV2ZW4gYWJvdXQgY3JpbWUsIHdhciwgcG9saXRpY3Mgb3IgZGlzYXN0ZXJzOyBzYWQgYnV0IHNpbmNlcmUgcGVyc29uYWwgcG9zdHMgKGdyaWVmLCBpbGxuZXNzKTsgaGFyc2ggYnV0IHN1YnN0YW50aXZlIGNyaXRpY2lzbSBvciBuZWdhdGl2ZSByZXZpZXdzOyBzYXJjYXNtIG9yIG1lbWVzIHRoYXQgYXJlIGZ1bm55IHJhdGhlciB0aGFuIGhvc3RpbGU7IGV2ZXJ5ZGF5LCBpbmZvcm1hdGl2ZSwgaGVscGZ1bCBvciBwb3NpdGl2ZSBwb3N0cy4nLFxuICAgIH0sXG4gIH0sXG4gIGNhdGVnb3J5OiB7XG4gICAgdHlwZTogJ2Nob2ljZScsXG4gICAgaW5zdHJ1Y3Rpb25zOiAnV2hpY2gga2luZCBvZiBwb3N0IGlzIHRoaXMgKHBvc3QsIHF1b3RlZCBwb3N0LCBjYXJkIGFuZCBtZWRpYSB0b2dldGhlcik/JyxcbiAgICBjcml0ZXJpYToge1xuICAgICAgb3V0cmFnZV9iYWl0OiAnT3V0cmFnZSBiYWl0IG9yIGR1bmsgcXVvdGUtcG9zdCAoXCJjYW4geW91IGJlbGlldmUuLi5cIiknLFxuICAgICAgY3VsdHVyZV93YXI6ICdQb2xpdGljYWwgb3IgY3VsdHVyZS13YXIgZmlnaHRpbmcnLFxuICAgICAgZW5nYWdlbWVudF9iYWl0OiAnRW5nYWdlbWVudCBiYWl0OiByYXRpbywgUlQgaWYgeW91IGFncmVlLCBkZWxpYmVyYXRlbHkgd3JvbmcgaG90IHRha2UnLFxuICAgICAgaGFyYXNzbWVudDogJ0luc3VsdHMgb3IgaGFyYXNzbWVudCBhaW1lZCBhdCBwZW9wbGUgb3IgZ3JvdXBzJyxcbiAgICAgIGZlYXJfbW9uZ2VyaW5nOiAnRmVhci1tb25nZXJpbmc6IGNvbGxhcHNlLCBkb29tLCBoZWFsdGggc2NhcmVzJyxcbiAgICAgIGRyYW1hOiAnSW5mbHVlbmNlciBvciBjZWxlYnJpdHkgZHJhbWEnLFxuICAgICAgc2Vuc2F0aW9uYWxfZ3JhcGhpYzogJ1NlbnNhdGlvbmFsIG9yIGdyYXBoaWMgY3JpbWUsIHZpb2xlbmNlLCB3YXIgb3IgZGlzYXN0ZXIgY29udGVudCcsXG4gICAgICBuZXV0cmFsX25ld3M6ICdOZXV0cmFsIGZhY3R1YWwgbmV3cywgZXZlbiBhYm91dCBjcmltZSwgd2FyLCBwb2xpdGljcyBvciBkaXNhc3RlcnMnLFxuICAgICAgc2luY2VyZV9wZXJzb25hbDogJ1NhZCBidXQgc2luY2VyZSBwZXJzb25hbCBwb3N0IChncmllZiwgaWxsbmVzcyknLFxuICAgICAgc3Vic3RhbnRpdmVfY3JpdGljaXNtOiAnSGFyc2ggYnV0IHN1YnN0YW50aXZlIGNyaXRpY2lzbSBvciBuZWdhdGl2ZSByZXZpZXcnLFxuICAgICAgaHVtb3I6ICdTYXJjYXNtIG9yIG1lbWUgdGhhdCBpcyBmdW5ueSByYXRoZXIgdGhhbiBob3N0aWxlJyxcbiAgICAgIGJlbmlnbl9vdGhlcjogJ0FueXRoaW5nIGVsc2U6IGV2ZXJ5ZGF5LCBpbmZvcm1hdGl2ZSwgaGVscGZ1bCBvciBwb3NpdGl2ZScsXG4gICAgfSxcbiAgfSxcbiAgZW1vdGlvbjoge1xuICAgIHR5cGU6ICdjaG9pY2UnLFxuICAgIGluc3RydWN0aW9uczogJ1doaWNoIGVtb3Rpb24gaXMgdGhpcyBwb3N0IG1vc3QgbGlrZWx5IHRvIGV2b2tlIGluIGEgdHlwaWNhbCByZWFkZXI/JyxcbiAgICBjcml0ZXJpYToge1xuICAgICAgYW5nZXJfb3V0cmFnZTogJ0FuZ2VyIG9yIG91dHJhZ2UnLFxuICAgICAgZmVhcl9hbnhpZXR5OiAnRmVhciBvciBhbnhpZXR5JyxcbiAgICAgIGRpc2d1c3RfY29udGVtcHQ6ICdEaXNndXN0IG9yIGNvbnRlbXB0JyxcbiAgICAgIG1vY2tlcnlfZHVua2luZzogJ01vY2tlcnkgb3IgZHVua2luZyBvbiBzb21lb25lJyxcbiAgICAgIHNhZG5lc3NfZ3JpZWY6ICdTYWRuZXNzIG9yIGdyaWVmJyxcbiAgICAgIG5ldXRyYWxfaW5mb3JtYXRpdmU6ICdOZXV0cmFsIG9yIGluZm9ybWF0aXZlJyxcbiAgICAgIHBvc2l0aXZlX2FtdXNlZDogJ1Bvc2l0aXZlLCBhbXVzZWQgb3IgdXBsaWZ0ZWQnLFxuICAgIH0sXG4gIH0sXG4gIGludGVuc2l0eToge1xuICAgIHR5cGU6ICdzY29yZScsXG4gICAgaW5zdHJ1Y3Rpb25zOiAnSG93IGVtb3Rpb25hbGx5IGluZmxhbW1hdG9yeSBpcyB0aGlzIHBvc3QgZm9yIGEgdHlwaWNhbCByZWFkZXI/JyxcbiAgICBjcml0ZXJpYTogWy4uLklOVEVOU0lUWV9MRVZFTFNdLFxuICB9LFxuICB0b3BpYzoge1xuICAgIHR5cGU6ICdjaG9pY2UnLFxuICAgIGluc3RydWN0aW9uczogJ1doYXQgaXMgdGhlIG1haW4gdG9waWMgb2YgdGhpcyBwb3N0PycsXG4gICAgY3JpdGVyaWE6IHtcbiAgICAgIHBvbGl0aWNzOiAnUG9saXRpY3MsIGVsZWN0aW9ucywgZ292ZXJubWVudCcsXG4gICAgICBjdWx0dXJlX3dhcjogJ0N1bHR1cmUtd2FyIG9yIGlkZW50aXR5IGNvbmZsaWN0JyxcbiAgICAgIGNyaW1lX3Zpb2xlbmNlOiAnQ3JpbWUgb3IgdmlvbGVuY2UnLFxuICAgICAgd2FyX2NvbmZsaWN0OiAnV2FyIG9yIGFybWVkIGNvbmZsaWN0JyxcbiAgICAgIGRpc2FzdGVyOiAnRGlzYXN0ZXIsIGFjY2lkZW50IG9yIGNhdGFzdHJvcGhlJyxcbiAgICAgIGVjb25vbXlfYnVzaW5lc3M6ICdFY29ub215LCBtb25leSBvciBidXNpbmVzcycsXG4gICAgICB0ZWNoX2FpOiAnVGVjaG5vbG9neSBvciBBSScsXG4gICAgICBzY2llbmNlX2hlYWx0aDogJ1NjaWVuY2Ugb3IgaGVhbHRoJyxcbiAgICAgIGNlbGVicml0eV9lbnRlcnRhaW5tZW50OiAnQ2VsZWJyaXRpZXMsIGVudGVydGFpbm1lbnQgb3IgaW5mbHVlbmNlcnMnLFxuICAgICAgc3BvcnRzOiAnU3BvcnRzJyxcbiAgICAgIHBlcnNvbmFsX2xpZmU6ICdQZXJzb25hbCBsaWZlIG9yIGV2ZXJ5ZGF5IGV4cGVyaWVuY2VzJyxcbiAgICAgIG90aGVyOiAnT3RoZXInLFxuICAgIH0sXG4gIH0sXG59IGFzIGNvbnN0O1xuXG5jb25zdCBHRU5FUklDX0FMVCA9IC9eKGltYWdlfHBob3RvfHBpY3R1cmV8ZW1iZWRkZWQgdmlkZW98dmlkZW98Z2lmKSQvaTtcblxuLyoqIEFsdCB0ZXh0IHdvcnRoIHNlbmRpbmc6IG5vbi1lbXB0eSBhbmQgbm90IFgncyBnZW5lcmljIHBsYWNlaG9sZGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lYW5pbmdmdWxBbHQoYWx0OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBhID0gYWx0Py50cmltKCk7XG4gIGlmICghYSB8fCBHRU5FUklDX0FMVC50ZXN0KGEpKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gYTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEF1dGhvcihoYW5kbGU6IHN0cmluZywgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgaCA9IGhhbmRsZS50cmltKCk7XG4gIGNvbnN0IG4gPSBuYW1lLnRyaW0oKTtcbiAgcmV0dXJuIG4gJiYgbiAhPT0gaCA/IGAke2h9ICgke259KWAgOiBoO1xufVxuXG5mdW5jdGlvbiBtZWRpYVN0YXRlKG06IE1lZGlhUmVmLCBieUtleTogTWFwPHN0cmluZywgTWVkaWFUcmFuc2NyaXB0PiB8IHVuZGVmaW5lZCk6IEpldk1lZGlhU3RhdGUge1xuICBjb25zdCBvdXQ6IEpldk1lZGlhU3RhdGUgPSB7IGtpbmQ6IG0ua2luZCB9O1xuICBjb25zdCBhbHQgPSBtZWFuaW5nZnVsQWx0KG0uYWx0KTtcbiAgaWYgKGFsdCkgb3V0LmFsdCA9IGFsdDtcbiAgY29uc3QgdCA9IGJ5S2V5Py5nZXQobS5rZXkpO1xuICBpZiAodCkge1xuICAgIG91dC52aXNpYmxlX3RleHQgPSB0LnZpc2libGVUZXh0O1xuICAgIG91dC5kZXNjcmlwdGlvbiA9IHQuZGVzY3JpcHRpb247XG4gICAgb3V0LmN1ZXMgPSBbLi4udC5jdWVzXTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIERldGVybWluaXN0aWMgSmV2IGlucHV0IGZvciBhIHBvc3QuIFdpdGhvdXQgdHJhbnNjcmlwdHMgdGhpcyBpcyB0aGUgdGV4dCBwYXNzXG4gKiAobWVkaWEgY2Fycnkgb25seSBraW5kL2FsdCwgbWVkaWFfc3RhdHVzIFwibm90X3RyYW5zY3JpYmVkXCIpOyB3aXRoIHRyYW5zY3JpcHRzIGl0IGlzIHRoZSBmdWxsIHBhc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEpldlN0YXRlKHNuYXBzaG90OiBQb3N0U25hcHNob3QsIHRyYW5zY3JpcHRzPzogTWVkaWFUcmFuc2NyaXB0W10pOiBKZXZTdGF0ZSB7XG4gIGNvbnN0IGJ5S2V5ID0gdHJhbnNjcmlwdHMgPyBuZXcgTWFwKHRyYW5zY3JpcHRzLm1hcCgodCkgPT4gW3Qua2V5LCB0XSkpIDogdW5kZWZpbmVkO1xuICBjb25zdCBvdXRlck1lZGlhID0gc25hcHNob3QubWVkaWEuZmlsdGVyKChtKSA9PiAhbS5pblF1b3RlKS5tYXAoKG0pID0+IG1lZGlhU3RhdGUobSwgYnlLZXkpKTtcbiAgY29uc3QgcXVvdGVkTWVkaWEgPSBzbmFwc2hvdC5tZWRpYS5maWx0ZXIoKG0pID0+IG0uaW5RdW90ZSkubWFwKChtKSA9PiBtZWRpYVN0YXRlKG0sIGJ5S2V5KSk7XG5cbiAgY29uc3QgcG9zdDogSmV2UG9zdFN0YXRlID0ge1xuICAgIGF1dGhvcjogZm9ybWF0QXV0aG9yKHNuYXBzaG90LmF1dGhvckhhbmRsZSwgc25hcHNob3QuYXV0aG9yTmFtZSksXG4gICAgdGV4dDogc25hcHNob3QudGV4dCxcbiAgfTtcbiAgaWYgKHNuYXBzaG90LnRydW5jYXRlZCkgcG9zdC50ZXh0X3RydW5jYXRlZCA9IHRydWU7XG4gIGlmIChzbmFwc2hvdC5yZXBvc3RlZEJ5KSBwb3N0LnJlcG9zdGVkX2J5ID0gc25hcHNob3QucmVwb3N0ZWRCeTtcbiAgaWYgKHNuYXBzaG90LnByb21vdGVkKSBwb3N0LnByb21vdGVkID0gdHJ1ZTtcbiAgaWYgKHNuYXBzaG90LmNhcmQpIHtcbiAgICBjb25zdCBjYXJkOiBKZXZQb3N0U3RhdGVbJ2xpbmtfY2FyZCddID0ge307XG4gICAgaWYgKHNuYXBzaG90LmNhcmQuZG9tYWluKSBjYXJkLmRvbWFpbiA9IHNuYXBzaG90LmNhcmQuZG9tYWluO1xuICAgIGlmIChzbmFwc2hvdC5jYXJkLnRpdGxlKSBjYXJkLnRpdGxlID0gc25hcHNob3QuY2FyZC50aXRsZTtcbiAgICBpZiAoc25hcHNob3QuY2FyZC5kZXNjcmlwdGlvbikgY2FyZC5kZXNjcmlwdGlvbiA9IHNuYXBzaG90LmNhcmQuZGVzY3JpcHRpb247XG4gICAgaWYgKE9iamVjdC5rZXlzKGNhcmQpLmxlbmd0aCA+IDApIHBvc3QubGlua19jYXJkID0gY2FyZDtcbiAgfVxuICBpZiAob3V0ZXJNZWRpYS5sZW5ndGggPiAwKSBwb3N0Lm1lZGlhID0gb3V0ZXJNZWRpYTtcbiAgaWYgKHNuYXBzaG90LnF1b3RlZCkge1xuICAgIGNvbnN0IHE6IEpldlF1b3RlZFN0YXRlID0ge1xuICAgICAgYXV0aG9yOiBmb3JtYXRBdXRob3Ioc25hcHNob3QucXVvdGVkLmF1dGhvckhhbmRsZSwgc25hcHNob3QucXVvdGVkLmF1dGhvck5hbWUpLFxuICAgICAgdGV4dDogc25hcHNob3QucXVvdGVkLnRleHQsXG4gICAgfTtcbiAgICBpZiAoc25hcHNob3QucXVvdGVkLnRydW5jYXRlZCkgcS50ZXh0X3RydW5jYXRlZCA9IHRydWU7XG4gICAgaWYgKHF1b3RlZE1lZGlhLmxlbmd0aCA+IDApIHEubWVkaWEgPSBxdW90ZWRNZWRpYTtcbiAgICBwb3N0LnF1b3RlZF9wb3N0ID0gcTtcbiAgfVxuXG4gIGNvbnN0IG1lZGlhX3N0YXR1cyA9XG4gICAgc25hcHNob3QubWVkaWEubGVuZ3RoID09PSAwID8gJ25vbmUnIDogdHJhbnNjcmlwdHMgPyAndHJhbnNjcmliZWQnIDogJ25vdF90cmFuc2NyaWJlZCc7XG4gIHJldHVybiB7IHBvc3QsIG1lZGlhX3N0YXR1cyB9O1xufVxuIiwgIi8vIEhpZGUva2VlcCBkZWNpc2lvbiBmcm9tIEpldiBhbnN3ZXJzLiBQdXJlIGFuZCBmYWlsLW9wZW4uIFNwZWMgXHUwMEE3My4zXG5cbmltcG9ydCB7IEhJREVfQ0FURUdPUklFUywgSU5URU5TSVRZX0xFVkVMUyB9IGZyb20gJy4vcnVicmljJztcbmltcG9ydCB0eXBlIHsgSmV2QW5zd2VycyB9IGZyb20gJy4vdHlwZXMnO1xuXG5leHBvcnQgY29uc3QgUlVMRV9CX0lOVEVOU0lUWSA9IDIuNTtcbmV4cG9ydCBjb25zdCBSVUxFX0JfTUFSR0lOID0gMC4xO1xuZXhwb3J0IGNvbnN0IFJVTEVfQl9DQVAgPSAwLjk5O1xuXG5leHBvcnQgaW50ZXJmYWNlIFJhbmtlZCB7XG4gIGtleTogc3RyaW5nO1xuICBwOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVjaXNpb24ge1xuICBoaWRlOiBib29sZWFuO1xuICByZWFzb25zOiBzdHJpbmdbXTtcbiAgcmFnZWJhaXQ/OiBudW1iZXI7XG4gIGhpZGVDYXRlZ29yeU1hc3M/OiBudW1iZXI7XG4gIGludGVuc2l0eT86IG51bWJlcjtcbiAgdG9wQ2F0ZWdvcnk/OiBSYW5rZWQ7XG4gIHRvcEVtb3Rpb24/OiBSYW5rZWQ7XG4gIHRvcFRvcGljPzogUmFua2VkO1xufVxuXG5mdW5jdGlvbiBpc051bSh2OiB1bmtub3duKTogdiBpcyBudW1iZXIge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2KTtcbn1cblxuZnVuY3Rpb24gaXNQcm9iTWFwKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIG51bWJlcj4ge1xuICByZXR1cm4gISF2ICYmIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiBPYmplY3QudmFsdWVzKHYgYXMgb2JqZWN0KS5ldmVyeShpc051bSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkQW5zd2VycyhhOiB1bmtub3duKTogYSBpcyBKZXZBbnN3ZXJzIHtcbiAgaWYgKCFhIHx8IHR5cGVvZiBhICE9PSAnb2JqZWN0JykgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB4ID0gYSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICByZXR1cm4gKFxuICAgIGlzTnVtKHgucmFnZWJhaXQ/Lm5vdWwpICYmXG4gICAgaXNQcm9iTWFwKHguY2F0ZWdvcnk/LnByb2JhYmlsaXRpZXMpICYmXG4gICAgaXNQcm9iTWFwKHguZW1vdGlvbj8ucHJvYmFiaWxpdGllcykgJiZcbiAgICBpc1Byb2JNYXAoeC50b3BpYz8ucHJvYmFiaWxpdGllcykgJiZcbiAgICBpc051bSh4LmludGVuc2l0eT8uc2NvcmUpXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0b3BLZXkocHJvYmFiaWxpdGllczogUmVjb3JkPHN0cmluZywgbnVtYmVyPik6IFJhbmtlZCB8IHVuZGVmaW5lZCB7XG4gIGxldCBiZXN0OiBSYW5rZWQgfCB1bmRlZmluZWQ7XG4gIGZvciAoY29uc3QgW2tleSwgcF0gb2YgT2JqZWN0LmVudHJpZXMocHJvYmFiaWxpdGllcykpIHtcbiAgICBpZiAoIWJlc3QgfHwgcCA+IGJlc3QucCkgYmVzdCA9IHsga2V5LCBwIH07XG4gIH1cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnRlbnNpdHlMYWJlbChzY29yZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgaSA9IE1hdGgubWluKElOVEVOU0lUWV9MRVZFTFMubGVuZ3RoIC0gMSwgTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChzY29yZSkpKTtcbiAgcmV0dXJuIElOVEVOU0lUWV9MRVZFTFNbaV07XG59XG5cbmNvbnN0IGYyID0gKG46IG51bWJlcikgPT4gbi50b0ZpeGVkKDIpO1xuY29uc3QgZjEgPSAobjogbnVtYmVyKSA9PiBuLnRvRml4ZWQoMSk7XG5cbi8qKlxuICogcnVsZSBBOiByYWdlYmFpdCBcdTIyNjUgVFxuICogcnVsZSBCOiBoaWRlLWNhdGVnb3J5IG1hc3MgXHUyMjY1IG1pbihUICsgMC4xMCwgMC45OSkgQU5EIGludGVuc2l0eSBcdTIyNjUgMi41XG4gKiBNaXNzaW5nL21hbGZvcm1lZCBhbnN3ZXJzIFx1MjE5MiBrZWVwIChmYWlsIG9wZW4pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVjaWRlKGFuc3dlcnM6IEpldkFuc3dlcnMgfCB1bmRlZmluZWQgfCBudWxsLCB0aHJlc2hvbGQ6IG51bWJlcik6IERlY2lzaW9uIHtcbiAgaWYgKCFpc1ZhbGlkQW5zd2VycyhhbnN3ZXJzKSkgcmV0dXJuIHsgaGlkZTogZmFsc2UsIHJlYXNvbnM6IFsnbm8gdmVyZGljdCddIH07XG5cbiAgY29uc3QgVCA9IHRocmVzaG9sZDtcbiAgY29uc3QgcCA9IGFuc3dlcnMucmFnZWJhaXQubm91bDtcbiAgY29uc3QgcHJvYnMgPSBhbnN3ZXJzLmNhdGVnb3J5LnByb2JhYmlsaXRpZXM7XG4gIGNvbnN0IGMgPSBISURFX0NBVEVHT1JJRVMucmVkdWNlKChzdW0sIGspID0+IHN1bSArIChpc051bShwcm9ic1trXSkgPyBwcm9ic1trXSA6IDApLCAwKTtcbiAgY29uc3QgaSA9IGFuc3dlcnMuaW50ZW5zaXR5LnNjb3JlO1xuICBjb25zdCB0QiA9IE1hdGgubWluKFQgKyBSVUxFX0JfTUFSR0lOLCBSVUxFX0JfQ0FQKTtcblxuICBjb25zdCB0b3BDYXRlZ29yeSA9IHRvcEtleShwcm9icyk7XG4gIGNvbnN0IHRvcEVtb3Rpb24gPSB0b3BLZXkoYW5zd2Vycy5lbW90aW9uLnByb2JhYmlsaXRpZXMpO1xuICBjb25zdCB0b3BUb3BpYyA9IHRvcEtleShhbnN3ZXJzLnRvcGljLnByb2JhYmlsaXRpZXMpO1xuXG4gIGNvbnN0IHJlYXNvbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJ1bGVBID0gcCA+PSBUO1xuICBjb25zdCBydWxlQiA9IGMgPj0gdEIgJiYgaSA+PSBSVUxFX0JfSU5URU5TSVRZO1xuICBpZiAocnVsZUEpIHJlYXNvbnMucHVzaChgcmFnZWJhaXQgJHtmMihwKX0gXHUyMjY1ICR7ZjIoVCl9YCk7XG4gIGlmIChydWxlQikge1xuICAgIHJlYXNvbnMucHVzaChcbiAgICAgIGBoaWRlLWtpbmRzICR7ZjIoYyl9IFx1MjI2NSAke2YyKHRCKX0gJiBpbnRlbnNpdHkgJHtmMShpKX0gXHUyMjY1ICR7ZjEoUlVMRV9CX0lOVEVOU0lUWSl9YCArXG4gICAgICAgICh0b3BDYXRlZ29yeSA/IGAgKHRvcDogJHt0b3BDYXRlZ29yeS5rZXl9KWAgOiAnJyksXG4gICAgKTtcbiAgfVxuICBpZiAoIXJ1bGVBICYmICFydWxlQikgcmVhc29ucy5wdXNoKGByYWdlYmFpdCAke2YyKHApfSA8ICR7ZjIoVCl9YCk7XG5cbiAgcmV0dXJuIHtcbiAgICBoaWRlOiBydWxlQSB8fCBydWxlQixcbiAgICByZWFzb25zLFxuICAgIHJhZ2ViYWl0OiBwLFxuICAgIGhpZGVDYXRlZ29yeU1hc3M6IGMsXG4gICAgaW50ZW5zaXR5OiBpLFxuICAgIHRvcENhdGVnb3J5LFxuICAgIHRvcEVtb3Rpb24sXG4gICAgdG9wVG9waWMsXG4gIH07XG59XG4iLCAiLy8gRGV0ZXJtaW5pc3RpYyBzZXJpYWxpc2F0aW9uICsgYSBzbWFsbCBzeW5jIGhhc2ggZm9yIGluLW1lbW9yeSBrZXlzIChjb250ZW50IHNjcmlwdCwgU1cgTFJVKS5cbi8vIFRoZSBjb21wYW5pb24gdXNlcyBzaGEyNTYgKG5vZGU6Y3J5cHRvKSBmb3Igb24tZGlzayBrZXlzLlxuXG4vKiogSlNPTiB3aXRoIG9iamVjdCBrZXlzIHNvcnRlZCByZWN1cnNpdmVseTsgYHVuZGVmaW5lZGAgbWVtYmVycyBhcmUgZHJvcHBlZCAoYXMgSlNPTi5zdHJpbmdpZnkgZG9lcykuICovXG5leHBvcnQgZnVuY3Rpb24gc3RhYmxlU3RyaW5naWZ5KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHNvcnREZWVwKHZhbHVlKSk7XG59XG5cbmZ1bmN0aW9uIHNvcnREZWVwKHY6IHVua25vd24pOiB1bmtub3duIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkodikpIHJldHVybiB2Lm1hcCgoeCkgPT4gKHggPT09IHVuZGVmaW5lZCA/IG51bGwgOiBzb3J0RGVlcCh4KSkpO1xuICBpZiAodiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcpIHtcbiAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKHYgYXMgb2JqZWN0KS5zb3J0KCkpIHtcbiAgICAgIGNvbnN0IHZhbCA9ICh2IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXTtcbiAgICAgIGlmICh2YWwgIT09IHVuZGVmaW5lZCkgb3V0W2tdID0gc29ydERlZXAodmFsKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuICByZXR1cm4gdjtcbn1cblxuLyoqIGN5cmI1MzogZmFzdCA1My1iaXQgc3RyaW5nIGhhc2gsIHJldHVybmVkIGFzIGJhc2UtMzYuIE5vdCBjcnlwdG9ncmFwaGljLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc2g1MyhzdHI6IHN0cmluZywgc2VlZCA9IDApOiBzdHJpbmcge1xuICBsZXQgaDEgPSAweGRlYWRiZWVmIF4gc2VlZDtcbiAgbGV0IGgyID0gMHg0MWM2Y2U1NyBeIHNlZWQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc3RyLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgY2ggPSBzdHIuY2hhckNvZGVBdChpKTtcbiAgICBoMSA9IE1hdGguaW11bChoMSBeIGNoLCAyNjU0NDM1NzYxKTtcbiAgICBoMiA9IE1hdGguaW11bChoMiBeIGNoLCAxNTk3MzM0Njc3KTtcbiAgfVxuICBoMSA9IE1hdGguaW11bChoMSBeIChoMSA+Pj4gMTYpLCAyMjQ2ODIyNTA3KTtcbiAgaDEgXj0gTWF0aC5pbXVsKGgyIF4gKGgyID4+PiAxMyksIDMyNjY0ODk5MDkpO1xuICBoMiA9IE1hdGguaW11bChoMiBeIChoMiA+Pj4gMTYpLCAyMjQ2ODIyNTA3KTtcbiAgaDIgXj0gTWF0aC5pbXVsKGgxIF4gKGgxID4+PiAxMyksIDMyNjY0ODk5MDkpO1xuICByZXR1cm4gKDQyOTQ5NjcyOTYgKiAoMjA5NzE1MSAmIGgyKSArIChoMSA+Pj4gMCkpLnRvU3RyaW5nKDM2KTtcbn1cbiIsICIvLyBNZXNzYWdlIGNvbnRyYWN0czogZXh0ZW5zaW9uIFx1MjE5NCBjb21wYW5pb24gKE5hdGl2ZSBNZXNzYWdpbmcpLCBjb250ZW50IFx1MjE5NCBzZXJ2aWNlIHdvcmtlciwgcG9wdXAgXHUyMTk0IFNXLlxuLy8gU3BlYzogZG9jcy9zdXBlcnBvd2Vycy9zcGVjcy8yMDI2LTA5LTMwLWxvdy1jb3J0aXNvbC1kZXNpZ24ubWQgXHUwMEE3NC4yLCBcdTAwQTc1XG5cbmltcG9ydCB0eXBlIHtcbiAgRXJyb3JJbmZvLFxuICBGbGF2b3IsXG4gIEpldkFuc3dlcnMsXG4gIEpldlJlc3VsdCxcbiAgSmV2U3RhdGUsXG4gIE1lZGlhS2luZCxcbiAgTWVkaWFUcmFuc2NyaXB0LFxuICBQb3N0U25hcHNob3QsXG4gIFJhdGVMaW1pdEluZm8sXG4gIFRyYW5zY3JpcHRNb2RlbCxcbiAgVmlzaW9uU3RhdHVzLFxufSBmcm9tICcuL3R5cGVzJztcblxuZXhwb3J0IGNvbnN0IEhPU1RfTkFNRSA9ICdjb20ubG93Y29ydGlzb2wuY29tcGFuaW9uJztcbmV4cG9ydCBjb25zdCBQT1JUX05BTUUgPSAnbGMnO1xuZXhwb3J0IGNvbnN0IE1BWF9WSVNJT05fSVRFTVMgPSA2O1xuXG5leHBvcnQgY29uc3QgU1RPUkFHRV9LRVlTID0ge1xuICBzZXR0aW5nczogJ3NldHRpbmdzJyxcbiAgc3RhdHM6ICdzdGF0cycsXG4gIGZlZWRiYWNrOiAnZmVlZGJhY2snLFxufSBhcyBjb25zdDtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLSBFeHRlbnNpb24gXHUyMTk0IGNvbXBhbmlvbiAtLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNjcmliZUl0ZW0ge1xuICBrZXk6IHN0cmluZztcbiAga2luZDogTWVkaWFLaW5kO1xuICBpblF1b3RlOiBib29sZWFuO1xuICBhbHQ/OiBzdHJpbmc7XG4gIC8qKiBlLmcuIFwiaW1hZ2UvanBlZ1wiICovXG4gIG1lZGlhVHlwZTogc3RyaW5nO1xuICBkYXRhQmFzZTY0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGVsbG9SZXF1ZXN0IHtcbiAgaWQ6IHN0cmluZztcbiAgdHlwZTogJ2hlbGxvJztcbiAgZmxhdm9yOiBGbGF2b3I7XG4gIGV4dFZlcnNpb246IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDbGFzc2lmeVJlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICB0eXBlOiAnY2xhc3NpZnknO1xuICBzdGF0ZTogSmV2U3RhdGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNjcmliZVJlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICB0eXBlOiAndHJhbnNjcmliZSc7XG4gIG1vZGVsOiBUcmFuc2NyaXB0TW9kZWw7XG4gIGl0ZW1zOiBUcmFuc2NyaWJlSXRlbVtdO1xufVxuXG5leHBvcnQgdHlwZSBIb3N0UmVxdWVzdCA9IEhlbGxvUmVxdWVzdCB8IENsYXNzaWZ5UmVxdWVzdCB8IFRyYW5zY3JpYmVSZXF1ZXN0O1xuZXhwb3J0IHR5cGUgSG9zdFJlcXVlc3RUeXBlID0gSG9zdFJlcXVlc3RbJ3R5cGUnXTtcblxuZXhwb3J0IGludGVyZmFjZSBIZWxsb1Jlc3BvbnNlIHtcbiAgaWQ6IHN0cmluZztcbiAgb2s6IHRydWU7XG4gIHR5cGU6ICdoZWxsbyc7XG4gIGNvbXBhbmlvblZlcnNpb246IHN0cmluZztcbiAgamV2Q29uZmlndXJlZDogYm9vbGVhbjtcbiAgY2xhdWRlRm91bmQ6IGJvb2xlYW47XG4gIGNsYXVkZVBhdGg/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2xhc3NpZnlSZXNwb25zZSB7XG4gIGlkOiBzdHJpbmc7XG4gIG9rOiB0cnVlO1xuICB0eXBlOiAnY2xhc3NpZnknO1xuICByZXN1bHQ6IEpldlJlc3VsdDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUcmFuc2NyaWJlT3V0cHV0IHtcbiAgdHJhbnNjcmlwdHM6IE1lZGlhVHJhbnNjcmlwdFtdO1xuICBsYXRlbmN5TXM6IG51bWJlcjtcbiAgLyoqIEtleXMgc2VydmVkIGZyb20gdGhlIGNvbXBhbmlvbiBjYWNoZSAobm8gY2xhdWRlIGNhbGwgbmVlZGVkIGZvciB0aGVtKS4gKi9cbiAgY2FjaGVkS2V5czogc3RyaW5nW107XG4gIHJhdGVMaW1pdD86IFJhdGVMaW1pdEluZm87XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhbnNjcmliZVJlc3BvbnNlIGV4dGVuZHMgVHJhbnNjcmliZU91dHB1dCB7XG4gIGlkOiBzdHJpbmc7XG4gIG9rOiB0cnVlO1xuICB0eXBlOiAndHJhbnNjcmliZSc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXJyb3JSZXNwb25zZSB7XG4gIGlkOiBzdHJpbmc7XG4gIG9rOiBmYWxzZTtcbiAgdHlwZTogSG9zdFJlcXVlc3RUeXBlIHwgJ3Vua25vd24nO1xuICBlcnJvcjogRXJyb3JJbmZvO1xufVxuXG5leHBvcnQgdHlwZSBIb3N0UmVzcG9uc2UgPSBIZWxsb1Jlc3BvbnNlIHwgQ2xhc3NpZnlSZXNwb25zZSB8IFRyYW5zY3JpYmVSZXNwb25zZSB8IEVycm9yUmVzcG9uc2U7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0gQ29udGVudCBzY3JpcHQgXHUyMTk0IHNlcnZpY2Ugd29ya2VyIChwb3J0IFBPUlRfTkFNRSkgLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIFBvc3RNc2cge1xuICB0eXBlOiAncG9zdCc7XG4gIHNuYXBzaG90OiBQb3N0U25hcHNob3Q7XG4gIC8qKiBoYXNoNTMoc3RhYmxlU3RyaW5naWZ5KHNuYXBzaG90KSk7IGVjaG9lZCBiYWNrIGluIHJlc3VsdHMgc28gc3RhbGUgcmVzdWx0cyBjYW4gYmUgaWdub3JlZC4gKi9cbiAgc25hcEhhc2g6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIaWRkZW5Nc2cge1xuICB0eXBlOiAnaGlkZGVuJztcbiAgcG9zdElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmVlZGJhY2tNc2cge1xuICB0eXBlOiAnZmVlZGJhY2snO1xuICBlbnRyeTogRmVlZGJhY2tFbnRyeTtcbn1cblxuLyoqIFNlbGVjdG9yIGhlYWx0aCBmcm9tIGNoZWNrSGVhbHRoKCk7IHNlbnQgb25seSB3aGVuIGBva2AgZmxpcHMgKHNwZWMgXHUwMEE3NC4xKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSGVhbHRoTXNnIHtcbiAgdHlwZTogJ2hlYWx0aCc7XG4gIG9rOiBib29sZWFuO1xuICBjZWxsczogbnVtYmVyO1xuICBhcnRpY2xlczogbnVtYmVyO1xuICBwYXJzZWQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IHR5cGUgQ29udGVudFRvU3cgPSBQb3N0TXNnIHwgSGlkZGVuTXNnIHwgRmVlZGJhY2tNc2cgfCBIZWFsdGhNc2c7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzdWx0VGltaW5ncyB7XG4gIHRleHRNcz86IG51bWJlcjtcbiAgdmlzaW9uTXM/OiBudW1iZXI7XG4gIGZ1bGxNcz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXN1bHRNc2cge1xuICB0eXBlOiAncmVzdWx0JztcbiAgcG9zdElkOiBzdHJpbmc7XG4gIHNuYXBIYXNoOiBzdHJpbmc7XG4gIHN0YWdlOiAndGV4dCcgfCAnZnVsbCc7XG4gIGpldj86IEpldlJlc3VsdDtcbiAgdmlzaW9uOiBWaXNpb25TdGF0dXM7XG4gIHRyYW5zY3JpcHRzPzogTWVkaWFUcmFuc2NyaXB0W107XG4gIGVycm9yPzogRXJyb3JJbmZvO1xuICB0aW1pbmdzOiBSZXN1bHRUaW1pbmdzO1xufVxuXG5leHBvcnQgdHlwZSBTd1RvQ29udGVudCA9IFJlc3VsdE1zZztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLSBQb3B1cCBcdTIxOTQgc2VydmljZSB3b3JrZXIgLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIEdldFN0YXR1c01zZyB7XG4gIHR5cGU6ICdnZXRTdGF0dXMnO1xufVxuXG5leHBvcnQgdHlwZSBDb21wYW5pb25TdGF0dXMgPSAnY29ubmVjdGluZycgfCAnb25saW5lJyB8ICdvZmZsaW5lJztcblxuZXhwb3J0IGludGVyZmFjZSBTdGF0dXNTbmFwc2hvdCB7XG4gIGNvbXBhbmlvbjogQ29tcGFuaW9uU3RhdHVzO1xuICBjb21wYW5pb25WZXJzaW9uPzogc3RyaW5nO1xuICBqZXZDb25maWd1cmVkPzogYm9vbGVhbjtcbiAgY2xhdWRlRm91bmQ/OiBib29sZWFuO1xuICBsYXN0RXJyb3I/OiBzdHJpbmc7XG4gIHBlbmRpbmc6IHsgdGV4dDogbnVtYmVyOyB2aXNpb246IG51bWJlciB9O1xuICBhdmdNczogeyB0ZXh0PzogbnVtYmVyOyB2aXNpb24/OiBudW1iZXI7IGZ1bGw/OiBudW1iZXIgfTtcbiAgcmF0ZUxpbWl0PzogUmF0ZUxpbWl0SW5mbztcbiAgLyoqIExhc3Qgc2VsZWN0b3IgaGVhbHRoIHJlcG9ydGVkIGJ5IGFueSB0YWIuICovXG4gIHNlbGVjdG9ySGVhbHRoPzogT21pdDxIZWFsdGhNc2csICd0eXBlJz47XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0gU3RvcmFnZSByZWNvcmRzIC0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBIaWRkZW5TdGF0cyB7XG4gIC8qKiBMb2NhbCBjYWxlbmRhciBkYXksIFwiWVlZWS1NTS1ERFwiLiAqL1xuICBkYXk6IHN0cmluZztcbiAgaGlkZGVuSWRzOiBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGZWVkYmFja0VudHJ5IHtcbiAgLyoqIElTTyB0aW1lc3RhbXAuICovXG4gIGF0OiBzdHJpbmc7XG4gIGZsYXZvcjogRmxhdm9yO1xuICBwb3N0SWQ6IHN0cmluZztcbiAgdXJsOiBzdHJpbmc7XG4gIC8qKiBUaGUgb3duZXIncyBsYWJlbC4gKi9cbiAgbGFiZWw6ICdoaWRlJyB8ICdrZWVwJztcbiAgLyoqIFdoYXQgTG93IENvcnRpc29sIGRlY2lkZWQgYXQgYHRocmVzaG9sZGAuICovXG4gIHZlcmRpY3Q6ICdoaWRlJyB8ICdrZWVwJztcbiAgdGhyZXNob2xkOiBudW1iZXI7XG4gIHJ1YnJpY1ZlcnNpb246IHN0cmluZztcbiAgamV2TW9kZWw6IHN0cmluZztcbiAgc3RhZ2U6ICd0ZXh0JyB8ICdmdWxsJztcbiAgYW5zd2VyczogSmV2QW5zd2VycztcbiAgLyoqIEV4YWN0IEpldiBpbnB1dCAoaW5jbHVkZXMgdHJhbnNjcmlwdHMgb24gdGhlIGZ1bGwgc3RhZ2UpLiAqL1xuICBzdGF0ZTogSmV2U3RhdGU7XG59XG4iLCAiLy8gQ29udGVudC1zaWRlIGFnZ3JlZ2F0aW9uIG9mIHRleHQvZnVsbCBzdGFnZSByZXN1bHRzIGZvciBvbmUgcG9zdC4gUHVyZS5cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHRNc2cgfSBmcm9tICcuL3Byb3RvY29sJztcbmltcG9ydCB0eXBlIHsgRXJyb3JJbmZvLCBKZXZSZXN1bHQsIE1lZGlhVHJhbnNjcmlwdCwgVmlzaW9uU3RhdHVzIH0gZnJvbSAnLi90eXBlcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUG9zdFJlc3VsdFN0YXRlIHtcbiAgcG9zdElkOiBzdHJpbmc7XG4gIHNuYXBIYXNoOiBzdHJpbmc7XG4gIHRleHQ/OiBSZXN1bHRNc2c7XG4gIGZ1bGw/OiBSZXN1bHRNc2c7XG4gIHZpc2lvbjogVmlzaW9uU3RhdHVzO1xuICB0cmFuc2NyaXB0cz86IE1lZGlhVHJhbnNjcmlwdFtdO1xuICAvKiogTW9zdCByZWNlbnQgZXJyb3IgZnJvbSBlaXRoZXIgc3RhZ2UuICovXG4gIGVycm9yPzogRXJyb3JJbmZvO1xufVxuXG4vKipcbiAqIE1lcmdlIGEgcmVzdWx0IGludG8gdGhlIHBvc3QncyBzdGF0ZS4gQSByZXN1bHQgZm9yIGEgZGlmZmVyZW50IHNuYXBIYXNoIHRoYW4gYHByZXZgIHN0YXJ0cyBhXG4gKiBmcmVzaCBzdGF0ZSAodGhlIHNuYXBzaG90IGNoYW5nZWQsIGUuZy4gYSBjYXJkIGxvYWRlZCBsYXRlKSBcdTIwMTQgY2FsbGVycyBtdXN0IGRyb3AgcmVzdWx0cyB3aG9zZVxuICogc25hcEhhc2ggaXMgbm90IHRoZSBvbmUgdGhleSBsYXN0IHNlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZVJlc3VsdChwcmV2OiBQb3N0UmVzdWx0U3RhdGUgfCB1bmRlZmluZWQsIG1zZzogUmVzdWx0TXNnKTogUG9zdFJlc3VsdFN0YXRlIHtcbiAgY29uc3QgYmFzZTogUG9zdFJlc3VsdFN0YXRlID1cbiAgICBwcmV2ICYmIHByZXYuc25hcEhhc2ggPT09IG1zZy5zbmFwSGFzaFxuICAgICAgPyB7IC4uLnByZXYgfVxuICAgICAgOiB7IHBvc3RJZDogbXNnLnBvc3RJZCwgc25hcEhhc2g6IG1zZy5zbmFwSGFzaCwgdmlzaW9uOiBtc2cudmlzaW9uIH07XG4gIGlmIChtc2cuc3RhZ2UgPT09ICd0ZXh0JykgYmFzZS50ZXh0ID0gbXNnO1xuICBlbHNlIGJhc2UuZnVsbCA9IG1zZztcbiAgYmFzZS52aXNpb24gPSBtc2cudmlzaW9uO1xuICBpZiAobXNnLnRyYW5zY3JpcHRzKSBiYXNlLnRyYW5zY3JpcHRzID0gbXNnLnRyYW5zY3JpcHRzO1xuICBpZiAobXNnLmVycm9yKSBiYXNlLmVycm9yID0gbXNnLmVycm9yO1xuICByZXR1cm4gYmFzZTtcbn1cblxuLyoqIFRoZSBKZXYgcmVzdWx0IHRvIGRlY2lkZSBvbjogdGhlIGZ1bGwgKHZpc2lvbikgcGFzcyB3aGVuIHByZXNlbnQsIGVsc2UgdGhlIHRleHQgcGFzcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlZmZlY3RpdmVKZXYoc3RhdGU6IFBvc3RSZXN1bHRTdGF0ZSB8IHVuZGVmaW5lZCk6IEpldlJlc3VsdCB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBzdGF0ZT8uZnVsbD8uamV2ID8/IHN0YXRlPy50ZXh0Py5qZXY7XG59XG5cbi8qKiBXaGljaCBzdGFnZSBgZWZmZWN0aXZlSmV2YCBjYW1lIGZyb20uICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlU3RhZ2Uoc3RhdGU6IFBvc3RSZXN1bHRTdGF0ZSB8IHVuZGVmaW5lZCk6ICd0ZXh0JyB8ICdmdWxsJyB8IHVuZGVmaW5lZCB7XG4gIGlmIChzdGF0ZT8uZnVsbD8uamV2KSByZXR1cm4gJ2Z1bGwnO1xuICBpZiAoc3RhdGU/LnRleHQ/LmpldikgcmV0dXJuICd0ZXh0JztcbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cbiIsICIvLyBTZXR0aW5ncyBkZWZhdWx0cyBwZXIgZmxhdm9yIGFuZCB0aGUgcHJvZC9kZXYgXCJlZmZlY3RpdmUgc2V0dGluZ3NcIiBydWxlLiBTcGVjIFx1MDBBNzMuMVxuXG5pbXBvcnQgdHlwZSB7IEZsYXZvciwgU2V0dGluZ3MsIFRyYW5zY3JpcHRNb2RlbCB9IGZyb20gJy4vdHlwZXMnO1xuXG5leHBvcnQgY29uc3QgVEhSRVNIT0xEX01JTiA9IDAuNTtcbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfTUFYID0gMC45NTtcbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfU1RFUCA9IDAuMDU7XG5cbmV4cG9ydCBjb25zdCBUSFJFU0hPTERfUFJFU0VUUyA9IHtcbiAgYWdncmVzc2l2ZTogMC41NSxcbiAgYmFsYW5jZWQ6IDAuNyxcbiAgY29uc2VydmF0aXZlOiAwLjg1LFxufSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgVGhyZXNob2xkUHJlc2V0ID0ga2V5b2YgdHlwZW9mIFRIUkVTSE9MRF9QUkVTRVRTO1xuXG4vKiogTW9kZWwgaWRzIHZlcmlmaWVkIHdpdGggQ2xhdWRlIENvZGUgQ0xJIDIuMS4yODEgb24gMjAyNi0wOS0zMCAoc2VlIGRvY3Mvb3duZXItYW5zd2Vycy5tZCkuICovXG5leHBvcnQgY29uc3QgVFJBTlNDUklQVF9NT0RFTFM6IFJlYWRvbmx5QXJyYXk8eyBpZDogVHJhbnNjcmlwdE1vZGVsOyBsYWJlbDogc3RyaW5nIH0+ID0gW1xuICB7IGlkOiAnY2xhdWRlLW9wdXMtNS01JywgbGFiZWw6ICdPcHVzIDUuNSAoZGVmYXVsdCknIH0sXG4gIHsgaWQ6ICdjbGF1ZGUtc29ubmV0LTUtNScsIGxhYmVsOiAnU29ubmV0IDUuNScgfSxcbl07XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1RSQU5TQ1JJUFRfTU9ERUw6IFRyYW5zY3JpcHRNb2RlbCA9ICdjbGF1ZGUtb3B1cy01LTUnO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogUmVhZG9ubHk8UmVjb3JkPEZsYXZvciwgUmVhZG9ubHk8U2V0dGluZ3M+Pj4gPSB7XG4gIHByb2Q6IHtcbiAgICBoaWRlRW5hYmxlZDogdHJ1ZSxcbiAgICBzaG93UmVzdWx0czogZmFsc2UsXG4gICAgdGhyZXNob2xkOiBUSFJFU0hPTERfUFJFU0VUUy5iYWxhbmNlZCxcbiAgICB2aXNpb25FbmFibGVkOiB0cnVlLFxuICAgIHRyYW5zY3JpcHRNb2RlbDogREVGQVVMVF9UUkFOU0NSSVBUX01PREVMLFxuICAgIHNob3dUcmFuc2NyaXB0OiBmYWxzZSxcbiAgICBzaG93U3RhdHVzOiBmYWxzZSxcbiAgfSxcbiAgZGV2OiB7XG4gICAgLy8gRGV2IHN0YXJ0cyBpbiBsYWJlbGluZyBtb2RlOiBzaG93cyB3aGF0IGl0IHdvdWxkIGhpZGUgd2l0aG91dCBoaWRpbmcuXG4gICAgaGlkZUVuYWJsZWQ6IGZhbHNlLFxuICAgIHNob3dSZXN1bHRzOiB0cnVlLFxuICAgIHRocmVzaG9sZDogVEhSRVNIT0xEX1BSRVNFVFMuYmFsYW5jZWQsXG4gICAgdmlzaW9uRW5hYmxlZDogdHJ1ZSxcbiAgICB0cmFuc2NyaXB0TW9kZWw6IERFRkFVTFRfVFJBTlNDUklQVF9NT0RFTCxcbiAgICBzaG93VHJhbnNjcmlwdDogdHJ1ZSxcbiAgICBzaG93U3RhdHVzOiB0cnVlLFxuICB9LFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNsYW1wVGhyZXNob2xkKG46IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIgPSBUSFJFU0hPTERfUFJFU0VUUy5iYWxhbmNlZCk6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgbiAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0Zpbml0ZShuKSkgcmV0dXJuIGZhbGxiYWNrO1xuICBjb25zdCBjbGFtcGVkID0gTWF0aC5taW4oVEhSRVNIT0xEX01BWCwgTWF0aC5tYXgoVEhSRVNIT0xEX01JTiwgbikpO1xuICByZXR1cm4gTWF0aC5yb3VuZChjbGFtcGVkICogMTAwKSAvIDEwMDtcbn1cblxuZnVuY3Rpb24gaXNUcmFuc2NyaXB0TW9kZWwodjogdW5rbm93bik6IHYgaXMgVHJhbnNjcmlwdE1vZGVsIHtcbiAgcmV0dXJuIFRSQU5TQ1JJUFRfTU9ERUxTLnNvbWUoKG0pID0+IG0uaWQgPT09IHYpO1xufVxuXG5mdW5jdGlvbiBib29sKHY6IHVua25vd24sIGZhbGxiYWNrOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ2Jvb2xlYW4nID8gdiA6IGZhbGxiYWNrO1xufVxuXG4vKipcbiAqIFByb2Qgb25seSBob25vdXJzIGBoaWRlRW5hYmxlZGA7IGV2ZXJ5dGhpbmcgZWxzZSBpcyBmb3JjZWQgdG8gcHJvZCBkZWZhdWx0cyAocHJvZCBjYW4gbmV2ZXIgc2hvdyBwYW5lbHMpLlxuICogRGV2IG1lcmdlcyBzdG9yZWQgdmFsdWVzIG92ZXIgZGV2IGRlZmF1bHRzLCBpZ25vcmluZyB3cm9uZyB0eXBlcyBhbmQgY2xhbXBpbmcgdGhlIHRocmVzaG9sZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVmZmVjdGl2ZVNldHRpbmdzKHN0b3JlZDogdW5rbm93biwgZmxhdm9yOiBGbGF2b3IpOiBTZXR0aW5ncyB7XG4gIGNvbnN0IHMgPSAoc3RvcmVkICYmIHR5cGVvZiBzdG9yZWQgPT09ICdvYmplY3QnID8gc3RvcmVkIDoge30pIGFzIFBhcnRpYWw8UmVjb3JkPGtleW9mIFNldHRpbmdzLCB1bmtub3duPj47XG4gIGNvbnN0IGQgPSBERUZBVUxUX1NFVFRJTkdTW2ZsYXZvcl07XG4gIGlmIChmbGF2b3IgPT09ICdwcm9kJykge1xuICAgIHJldHVybiB7IC4uLmQsIGhpZGVFbmFibGVkOiBib29sKHMuaGlkZUVuYWJsZWQsIGQuaGlkZUVuYWJsZWQpIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBoaWRlRW5hYmxlZDogYm9vbChzLmhpZGVFbmFibGVkLCBkLmhpZGVFbmFibGVkKSxcbiAgICBzaG93UmVzdWx0czogYm9vbChzLnNob3dSZXN1bHRzLCBkLnNob3dSZXN1bHRzKSxcbiAgICB0aHJlc2hvbGQ6IGNsYW1wVGhyZXNob2xkKHMudGhyZXNob2xkLCBkLnRocmVzaG9sZCksXG4gICAgdmlzaW9uRW5hYmxlZDogYm9vbChzLnZpc2lvbkVuYWJsZWQsIGQudmlzaW9uRW5hYmxlZCksXG4gICAgdHJhbnNjcmlwdE1vZGVsOiBpc1RyYW5zY3JpcHRNb2RlbChzLnRyYW5zY3JpcHRNb2RlbCkgPyBzLnRyYW5zY3JpcHRNb2RlbCA6IGQudHJhbnNjcmlwdE1vZGVsLFxuICAgIHNob3dUcmFuc2NyaXB0OiBib29sKHMuc2hvd1RyYW5zY3JpcHQsIGQuc2hvd1RyYW5zY3JpcHQpLFxuICAgIHNob3dTdGF0dXM6IGJvb2wocy5zaG93U3RhdHVzLCBkLnNob3dTdGF0dXMpLFxuICB9O1xufVxuXG4vKiogQ2xhc3NpZmljYXRpb24gcnVucyAoYW5kIGFueXRoaW5nIGlzIHNlbnQgYW55d2hlcmUpIG9ubHkgd2hlbiB0aGlzIGlzIHRydWUuICovXG5leHBvcnQgZnVuY3Rpb24gaXNDbGFzc2lmaWNhdGlvbkFjdGl2ZShzOiBTZXR0aW5ncyk6IGJvb2xlYW4ge1xuICByZXR1cm4gcy5oaWRlRW5hYmxlZCB8fCBzLnNob3dSZXN1bHRzO1xufVxuIiwgIi8vIENvbXBsZXRlLCBzdHViLWZyZWUgaGlkaW5nIG9mIGEgcG9zdCdzIHRpbWVsaW5lIGNlbGwgKGFuc3dlciAxOWIpLCBrZWVwaW5nIHRoZSByZWFkZXIncyBzY3JvbGxcbi8vIHBvc2l0aW9uIHN0YWJsZSB3aGVuIHRoZSBoaWRkZW4gY2VsbCBpcyBhYm92ZSB0aGUgdmlld3BvcnQuIFRvdWNoZXMgb25seSBISURERU5fQVRUUiBhbmQgU1RZTEVfSUQuXG5cbmV4cG9ydCBjb25zdCBISURERU5fQVRUUiA9ICdkYXRhLWxjLWhpZGRlbic7XG5leHBvcnQgY29uc3QgU1RZTEVfSUQgPSAnbGMtc3R5bGUnO1xuXG5jb25zdCBDRUxMX1NFTEVDVE9SID0gJ2RpdltkYXRhLXRlc3RpZD1cImNlbGxJbm5lckRpdlwiXSc7XG5cbmNvbnN0IFNUWUxFX1RFWFQgPSBgWyR7SElEREVOX0FUVFJ9XSA+ICogeyBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7IH1cblske0hJRERFTl9BVFRSfV0geyBib3JkZXI6IDAgIWltcG9ydGFudDsgbWFyZ2luOiAwICFpbXBvcnRhbnQ7IHBhZGRpbmc6IDAgIWltcG9ydGFudDsgfVxuYXJ0aWNsZVske0hJRERFTl9BVFRSfV0geyBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7IH1cbmA7XG5cbi8qKiBJbnNlcnQgdGhlIG9uZSBzaGFyZWQgc3R5bGVzaGVldCBpZiBpdCBpcyBub3QgdGhlcmUgeWV0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVN0eWxlcyhkb2M6IERvY3VtZW50KTogdm9pZCB7XG4gIGlmIChkb2MuZ2V0RWxlbWVudEJ5SWQoU1RZTEVfSUQpKSByZXR1cm47XG4gIGNvbnN0IHN0eWxlID0gZG9jLmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7XG4gIHN0eWxlLmlkID0gU1RZTEVfSUQ7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gU1RZTEVfVEVYVDtcbiAgKGRvYy5oZWFkID8/IGRvYy5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuLyoqIFRoZSBlbGVtZW50IHRoYXQgZ2V0cyBoaWRkZW46IHRoZSBwb3N0J3MgdGltZWxpbmUgY2VsbCwgZWxzZSB0aGUgYXJ0aWNsZSBpdHNlbGYuICovXG5leHBvcnQgZnVuY3Rpb24gaGlkZVRhcmdldE9mKGFydGljbGU6IEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIHJldHVybiAoYXJ0aWNsZS5jbG9zZXN0KENFTExfU0VMRUNUT1IpID8/IGFydGljbGUpIGFzIEhUTUxFbGVtZW50O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNIaWRkZW4oYXJ0aWNsZTogRWxlbWVudCk6IGJvb2xlYW4ge1xuICByZXR1cm4gaGlkZVRhcmdldE9mKGFydGljbGUpLmhhc0F0dHJpYnV0ZShISURERU5fQVRUUik7XG59XG5cbi8qKiBIaWRlIHRoZSBwb3N0J3MgY2VsbC4gUmV0dXJucyB0cnVlIGlmIGl0IHdhcyBuZXdseSBoaWRkZW4uICovXG5leHBvcnQgZnVuY3Rpb24gaGlkZVBvc3QoXG4gIGFydGljbGU6IEVsZW1lbnQsXG4gIG9wdHM6IHsgd2luPzogV2luZG93OyBjZWxscz86ICgpID0+IEVsZW1lbnRbXTsgdGltZW91dE1zPzogbnVtYmVyIH0gPSB7fSxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBkb2MgPSBhcnRpY2xlLm93bmVyRG9jdW1lbnQ7XG4gIGVuc3VyZVN0eWxlcyhkb2MpO1xuICBjb25zdCB0ID0gaGlkZVRhcmdldE9mKGFydGljbGUpO1xuICBpZiAodC5oYXNBdHRyaWJ1dGUoSElEREVOX0FUVFIpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHdpbiA9IG9wdHMud2luID8/IGRvYy5kZWZhdWx0VmlldztcbiAgY29uc3QgbXV0YXRlID0gKCkgPT4gdC5zZXRBdHRyaWJ1dGUoSElEREVOX0FUVFIsICcxJyk7XG5cbiAgaWYgKHdpbiAmJiB0LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmJvdHRvbSA8PSAwKSB7XG4gICAgLy8gRW50aXJlbHkgYWJvdmUgdGhlIHZpZXdwb3J0OiBjb2xsYXBzaW5nIGl0IHdvdWxkIHNoaWZ0IGV2ZXJ5dGhpbmcgdGhlIHJlYWRlciBzZWVzLlxuICAgIGNvbnN0IGNlbGxzID0gb3B0cy5jZWxscz8uKCkgPz8gWy4uLmRvYy5xdWVyeVNlbGVjdG9yQWxsKENFTExfU0VMRUNUT1IpXTtcbiAgICBjb25zdCBhbmNob3IgPSBwaWNrQW5jaG9yKGNlbGxzLCB0KTtcbiAgICBpZiAoYW5jaG9yKSB7XG4gICAgICBwcmVzZXJ2ZUFuY2hvcihhbmNob3IsIG11dGF0ZSwgd2luLCBvcHRzLnRpbWVvdXRNcyA/PyAxMDAwKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICBtdXRhdGUoKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBSZXR1cm5zIHRydWUgaWYgdGhlIHBvc3Qgd2FzIGhpZGRlbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmhpZGVQb3N0KGFydGljbGU6IEVsZW1lbnQpOiBib29sZWFuIHtcbiAgY29uc3QgdCA9IGhpZGVUYXJnZXRPZihhcnRpY2xlKTtcbiAgaWYgKCF0Lmhhc0F0dHJpYnV0ZShISURERU5fQVRUUikpIHJldHVybiBmYWxzZTtcbiAgdC5yZW1vdmVBdHRyaWJ1dGUoSElEREVOX0FUVFIpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIFVuaGlkZSBldmVyeXRoaW5nOyByZXR1cm5zIGhvdyBtYW55IGVsZW1lbnRzIHdlcmUgdW5oaWRkZW4uICovXG5leHBvcnQgZnVuY3Rpb24gdW5oaWRlQWxsKGRvYzogRG9jdW1lbnQpOiBudW1iZXIge1xuICBjb25zdCBoaWRkZW4gPSBkb2MucXVlcnlTZWxlY3RvckFsbChgWyR7SElEREVOX0FUVFJ9XWApO1xuICBoaWRkZW4uZm9yRWFjaCgoZWwpID0+IGVsLnJlbW92ZUF0dHJpYnV0ZShISURERU5fQVRUUikpO1xuICByZXR1cm4gaGlkZGVuLmxlbmd0aDtcbn1cblxuLyoqIEZpcnN0IGNlbGwgb3RoZXIgdGhhbiBgdGFyZ2V0YCwgbm90IGhpZGRlbiwgd2hvc2UgdG9wIGlzIGF0IG9yIGJlbG93IHRoZSB2aWV3cG9ydCB0b3AuICovXG5leHBvcnQgZnVuY3Rpb24gcGlja0FuY2hvcihjZWxsczogRWxlbWVudFtdLCB0YXJnZXQ6IEVsZW1lbnQpOiBFbGVtZW50IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgY2VsbCBvZiBjZWxscykge1xuICAgIGlmIChjZWxsID09PSB0YXJnZXQgfHwgY2VsbC5oYXNBdHRyaWJ1dGUoSElEREVOX0FUVFIpKSBjb250aW51ZTtcbiAgICBpZiAoY2VsbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS50b3AgPj0gMCkgcmV0dXJuIGNlbGw7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogUnVuIGBtdXRhdGVgLCB0aGVuIGNvbXBlbnNhdGUgdGhlIGxheW91dCBzaGlmdCBpdCBjYXVzZWQgc28gYGFuY2hvcmAgc3RheXMgd2hlcmUgaXQgd2FzIG9uIHNjcmVlbi5cbiAqIFggcmUtbGF5cyBvdXQgaXRzIHZpcnR1YWxpc2VkIGxpc3QgYXN5bmNocm9ub3VzbHkgKHN0eWxlLnRyYW5zZm9ybSBvbiBjZWxscyksIHNvIGtlZXAgY29tcGVuc2F0aW5nXG4gKiBvbiB0aGUgYW5jaG9yJ3Mgc3R5bGUgY2hhbmdlcyBmb3IgYHRpbWVvdXRNc2AuIE9ubHkgdGhlIGFuY2hvcidzIGRvY3VtZW50IHBvc2l0aW9uIChyZWN0LnRvcCArXG4gKiBzY3JvbGxZKSBpcyB0cmFja2VkLCBzbyB0aGUgcmVhZGVyJ3Mgb3duIHNjcm9sbGluZyBpcyBuZXZlciB1bmRvbmUuIFN0b3BzIGVhcmx5IGlmIHRoZSBhbmNob3IgaXNcbiAqIGRldGFjaGVkIG9yIFggcmVjeWNsZXMgdGhlIGNlbGwgZm9yIGFub3RoZXIgcG9zdCAoaXRzIGZpcnN0IGFydGljbGUvY2hpbGQgY2hhbmdlcykuXG4gKiBPbmUgcHJlc2VydmF0aW9uIHBlciBhbmNob3I6IGlmIHRoZSBhbmNob3IgaXMgYWxyZWFkeSBiZWluZyBwcmVzZXJ2ZWQsIGEgZnVydGhlciBoaWRlIHJldXNlcyB0aGF0XG4gKiBvYnNlcnZlciBhbmQgYmFzZWxpbmUgYW5kIGV4dGVuZHMgaXRzIHRpbWVvdXQsIHNvIGEgY29tYmluZWQgcmUtbGF5b3V0IGlzIGNvbXBlbnNhdGVkIGV4YWN0bHkgb25jZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZXNlcnZlQW5jaG9yKGFuY2hvcjogRWxlbWVudCwgbXV0YXRlOiAoKSA9PiB2b2lkLCB3aW46IFdpbmRvdywgdGltZW91dE1zID0gMTAwMCk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZyA9IGFjdGl2ZS5nZXQoYW5jaG9yKTtcbiAgaWYgKGV4aXN0aW5nICYmICFleGlzdGluZy5zdG9wcGVkKSB7XG4gICAgbXV0YXRlKCk7XG4gICAgZXhpc3RpbmcuY29ycmVjdCgpO1xuICAgIGlmICghZXhpc3Rpbmcuc3RvcHBlZCkgZXhpc3RpbmcuZXh0ZW5kKHRpbWVvdXRNcyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGRvY1RvcCA9ICgpID0+IGFuY2hvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS50b3AgKyAod2luLnNjcm9sbFkgPz8gMCk7XG4gIGNvbnN0IGNvbnRlbnQgPSAoKSA9PiBhbmNob3IucXVlcnlTZWxlY3RvcignYXJ0aWNsZScpID8/IGFuY2hvci5maXJzdEVsZW1lbnRDaGlsZDtcbiAgY29uc3Qgb3JpZ2luYWwgPSBjb250ZW50KCk7XG4gIGxldCBiYXNlID0gZG9jVG9wKCk7XG4gIGxldCBnZW5lcmF0aW9uID0gMDtcbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigocmVjb3JkcykgPT4gcmVjb3Jkcy5mb3JFYWNoKGNvcnJlY3QpKTtcbiAgY29uc3Qgc3RhdGU6IFByZXNlcnZhdGlvbiA9IHtcbiAgICBzdG9wcGVkOiBmYWxzZSxcbiAgICBjb3JyZWN0LFxuICAgIGV4dGVuZChtcykge1xuICAgICAgY29uc3QgZyA9ICsrZ2VuZXJhdGlvbjtcbiAgICAgIHdpbi5zZXRUaW1lb3V0KCgpID0+IHsgaWYgKGcgPT09IGdlbmVyYXRpb24pIHN0b3AoKTsgfSwgbXMpO1xuICAgIH0sXG4gIH07XG4gIGZ1bmN0aW9uIHN0b3AoKSB7XG4gICAgc3RhdGUuc3RvcHBlZCA9IHRydWU7XG4gICAgb2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICAgIGlmIChhY3RpdmUuZ2V0KGFuY2hvcikgPT09IHN0YXRlKSBhY3RpdmUuZGVsZXRlKGFuY2hvcik7XG4gIH1cbiAgZnVuY3Rpb24gY29ycmVjdCgpIHtcbiAgICBpZiAoc3RhdGUuc3RvcHBlZCkgcmV0dXJuO1xuICAgIGlmICghYW5jaG9yLmlzQ29ubmVjdGVkIHx8IGNvbnRlbnQoKSAhPT0gb3JpZ2luYWwpIHJldHVybiBzdG9wKCk7XG4gICAgY29uc3QgZCA9IGRvY1RvcCgpIC0gYmFzZTtcbiAgICBpZiAoTWF0aC5hYnMoZCkgPCAxKSByZXR1cm47XG4gICAgd2luLnNjcm9sbEJ5KDAsIGQpO1xuICAgIGJhc2UgPSBkb2NUb3AoKTtcbiAgfVxuICBtdXRhdGUoKTtcbiAgY29ycmVjdCgpO1xuICBpZiAoc3RhdGUuc3RvcHBlZCkgcmV0dXJuO1xuICBhY3RpdmUuc2V0KGFuY2hvciwgc3RhdGUpO1xuICBvYnNlcnZlci5vYnNlcnZlKGFuY2hvciwgeyBhdHRyaWJ1dGVzOiB0cnVlLCBhdHRyaWJ1dGVGaWx0ZXI6IFsnc3R5bGUnXSB9KTtcbiAgc3RhdGUuZXh0ZW5kKHRpbWVvdXRNcyk7XG59XG5cbmludGVyZmFjZSBQcmVzZXJ2YXRpb24ge1xuICBzdG9wcGVkOiBib29sZWFuO1xuICAvKiogU2Nyb2xsIGJ5IHRoZSBhbmNob3IncyBzaGlmdCBzaW5jZSB0aGUgbGFzdCBjb3JyZWN0aW9uIChpZGVtcG90ZW50KS4gKi9cbiAgY29ycmVjdCgpOiB2b2lkO1xuICAvKiogUmVzdGFydCB0aGUgc3RvcCB0aW1lci4gKi9cbiAgZXh0ZW5kKHRpbWVvdXRNczogbnVtYmVyKTogdm9pZDtcbn1cblxuY29uc3QgYWN0aXZlID0gbmV3IFdlYWtNYXA8RWxlbWVudCwgUHJlc2VydmF0aW9uPigpO1xuIiwgIi8vIFggcm91dGUgXHUyMTkyIHBhZ2Uga2luZC4gU3BlYyBcdTAwQTc0LjE6IG9ubHkgaG9tZSwgbGlzdHMsIHNlYXJjaCwgZXhwbG9yZSBhbmQgc3RhdHVzIHBhZ2VzIGFyZSBmaWx0ZXJlZCAoUTE4KS5cblxuZXhwb3J0IHR5cGUgUGFnZUtpbmQgPVxuICB8ICdob21lJ1xuICB8ICdsaXN0J1xuICB8ICdzZWFyY2gnXG4gIHwgJ2V4cGxvcmUnXG4gIHwgJ3N0YXR1cydcbiAgfCAncHJvZmlsZSdcbiAgfCAnbm90aWZpY2F0aW9ucydcbiAgfCAnYm9va21hcmtzJ1xuICB8ICdtZXNzYWdlcydcbiAgfCAnb3RoZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBhZ2VJbmZvIHtcbiAga2luZDogUGFnZUtpbmQ7XG4gIGZvY2FsSWQ/OiBzdHJpbmc7XG59XG5cbmNvbnN0IFNUQVRVU19SRSA9IC9eXFwvKFtBLVphLXowLTlfXXsxLDE1fSlcXC9zdGF0dXNcXC8oXFxkKykvO1xuY29uc3QgSEFORExFX1JFID0gL15bQS1aYS16MC05X117MSwxNX0kLztcbmNvbnN0IFJFU0VSVkVEID0gbmV3IFNldChbXG4gICdob21lJywgJ2V4cGxvcmUnLCAnc2VhcmNoJywgJ25vdGlmaWNhdGlvbnMnLCAnbWVzc2FnZXMnLCAnaScsXG4gICdzZXR0aW5ncycsICdjb21wb3NlJywgJ2xvZ2luJywgJ2xvZ291dCcsICd0b3MnLCAncHJpdmFjeScsICdqb2JzJyxcbl0pO1xuY29uc3QgRklMVEVSRUQ6IFJlYWRvbmx5U2V0PFBhZ2VLaW5kPiA9IG5ldyBTZXQ8UGFnZUtpbmQ+KFsnaG9tZScsICdsaXN0JywgJ3NlYXJjaCcsICdleHBsb3JlJywgJ3N0YXR1cyddKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhZ2VJbmZvKHVybDogc3RyaW5nKTogUGFnZUluZm8ge1xuICBsZXQgcGF0aDogc3RyaW5nO1xuICB0cnkge1xuICAgIHBhdGggPSBuZXcgVVJMKHVybCkucGF0aG5hbWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IGtpbmQ6ICdvdGhlcicgfTtcbiAgfVxuICBjb25zdCBzZWdzID0gcGF0aC5zcGxpdCgnLycpLmZpbHRlcihCb29sZWFuKTtcbiAgY29uc3QgZmlyc3QgPSAoc2Vnc1swXSA/PyAnJykudG9Mb3dlckNhc2UoKTtcblxuICBpZiAoIWZpcnN0IHx8IGZpcnN0ID09PSAnaG9tZScpIHJldHVybiB7IGtpbmQ6ICdob21lJyB9O1xuICAvLyBETXMgYXJlIGNoZWNrZWQgYmVmb3JlIGFueXRoaW5nIGVsc2Ugc28gbm8gcm91dGUgcGF0dGVybiBjYW4gZXZlciBtYWtlIHRoZW0gZmlsdGVyYWJsZS5cbiAgaWYgKGZpcnN0ID09PSAnbWVzc2FnZXMnKSByZXR1cm4geyBraW5kOiAnbWVzc2FnZXMnIH07XG4gIGNvbnN0IHN0YXR1cyA9IFNUQVRVU19SRS5leGVjKHBhdGgpO1xuICBpZiAoc3RhdHVzKSByZXR1cm4geyBraW5kOiAnc3RhdHVzJywgZm9jYWxJZDogc3RhdHVzWzJdIH07XG4gIGlmIChmaXJzdCA9PT0gJ3NlYXJjaCcpIHJldHVybiB7IGtpbmQ6ICdzZWFyY2gnIH07XG4gIGlmIChmaXJzdCA9PT0gJ2V4cGxvcmUnKSByZXR1cm4geyBraW5kOiAnZXhwbG9yZScgfTtcbiAgaWYgKGZpcnN0ID09PSAnbm90aWZpY2F0aW9ucycpIHJldHVybiB7IGtpbmQ6ICdub3RpZmljYXRpb25zJyB9O1xuICBpZiAoZmlyc3QgPT09ICdpJykge1xuICAgIGNvbnN0IHNlY29uZCA9IHNlZ3NbMV0/LnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKHNlY29uZCA9PT0gJ2xpc3RzJyAmJiAvXlxcZCskLy50ZXN0KHNlZ3NbMl0gPz8gJycpKSByZXR1cm4geyBraW5kOiAnbGlzdCcgfTtcbiAgICBpZiAoc2Vjb25kID09PSAnYm9va21hcmtzJykgcmV0dXJuIHsga2luZDogJ2Jvb2ttYXJrcycgfTtcbiAgICByZXR1cm4geyBraW5kOiAnb3RoZXInIH07XG4gIH1cbiAgaWYgKCFSRVNFUlZFRC5oYXMoZmlyc3QpICYmIEhBTkRMRV9SRS50ZXN0KHNlZ3NbMF0pKSByZXR1cm4geyBraW5kOiAncHJvZmlsZScgfTtcbiAgcmV0dXJuIHsga2luZDogJ290aGVyJyB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkRmlsdGVyKGtpbmQ6IFBhZ2VLaW5kKTogYm9vbGVhbiB7XG4gIHJldHVybiBGSUxURVJFRC5oYXMoa2luZCk7XG59XG4iLCAiLy8gRXZlcnkgWCBET00gc2VsZWN0b3IgbGl2ZXMgaGVyZSAoc3BlYyBcdTAwQTc0LjEpLCBzbyBzZWxlY3RvciBkcmlmdCBpcyBhIG9uZS1maWxlIHBhdGNoLlxuXG5leHBvcnQgY29uc3QgU0VMID0ge1xuICBhcnRpY2xlOiAnYXJ0aWNsZVtkYXRhLXRlc3RpZD1cInR3ZWV0XCJdJyxcbiAgY2VsbDogJ2RpdltkYXRhLXRlc3RpZD1cImNlbGxJbm5lckRpdlwiXScsXG4gIHByaW1hcnlDb2x1bW46ICdbZGF0YS10ZXN0aWQ9XCJwcmltYXJ5Q29sdW1uXCJdJyxcbiAgdHdlZXRUZXh0OiAnW2RhdGEtdGVzdGlkPVwidHdlZXRUZXh0XCJdJyxcbiAgdXNlck5hbWU6ICdbZGF0YS10ZXN0aWQ9XCJVc2VyLU5hbWVcIl0nLFxuICBwaG90bzogJ1tkYXRhLXRlc3RpZD1cInR3ZWV0UGhvdG9cIl0nLFxuICB2aWRlb1BsYXllcjogJ1tkYXRhLXRlc3RpZD1cInZpZGVvUGxheWVyXCJdJyxcbiAgY2FyZDogJ1tkYXRhLXRlc3RpZD1cImNhcmQud3JhcHBlclwiXScsXG4gIHNvY2lhbENvbnRleHQ6ICdbZGF0YS10ZXN0aWQ9XCJzb2NpYWxDb250ZXh0XCJdJyxcbiAgc2hvd01vcmU6ICdbZGF0YS10ZXN0aWQ9XCJ0d2VldC10ZXh0LXNob3ctbW9yZS1saW5rXCJdJyxcbiAgb3duUHJvZmlsZUxpbms6ICdhW2RhdGEtdGVzdGlkPVwiQXBwVGFiQmFyX1Byb2ZpbGVfTGlua1wiXScsXG4gIHBsYWNlbWVudDogJ1tkYXRhLXRlc3RpZD1cInBsYWNlbWVudFRyYWNraW5nXCJdJyxcbiAgcXVvdGU6ICdkaXZbcm9sZT1cImxpbmtcIl0nLFxuICAvKiogVGhlIGVuZ2FnZW1lbnQgcm93IChyZXBseSAvIHJlcG9zdCAvIGxpa2UgLyB2aWV3cykuICovXG4gIGFjdGlvbkJhcjogJ1tyb2xlPVwiZ3JvdXBcIl0nLFxufSBhcyBjb25zdDtcblxuY29uc3QgU1RBVFVTX0hSRUYgPSAvXFwvc3RhdHVzXFwvKFxcZCspLztcbmNvbnN0IEhBTkRMRV9SRSA9IC9eW0EtWmEtejAtOV9dezEsMTV9JC87XG5cbi8qKiBUaGUgb25seSBzdWJ0cmVlIGV2ZXIgc2Nhbm5lZDogWCdzIHByaW1hcnkgY29sdW1uIChuZXZlciB0aGUgc2lkZWJhciBvciB0aGUgRE0gZHJhd2VyKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuUm9vdChkb2M6IERvY3VtZW50KTogRWxlbWVudCB8IG51bGwge1xuICByZXR1cm4gZG9jLnF1ZXJ5U2VsZWN0b3IoU0VMLnByaW1hcnlDb2x1bW4pO1xufVxuXG4vKiogT3V0ZXIgcG9zdCBhcnRpY2xlcyBvbmx5OyBhbiBhcnRpY2xlIG5lc3RlZCBpbnNpZGUgYW5vdGhlciBhcnRpY2xlIGlzIHBhcnQgb2YgdGhhdCBwb3N0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRBcnRpY2xlcyhyb290OiBQYXJlbnROb2RlKTogSFRNTEVsZW1lbnRbXSB7XG4gIHJldHVybiBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oU0VMLmFydGljbGUpKS5maWx0ZXIoXG4gICAgKGEpID0+ICFhLnBhcmVudEVsZW1lbnQ/LmNsb3Nlc3QoU0VMLmFydGljbGUpLFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2VsbE9mKGFydGljbGU6IEVsZW1lbnQpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICByZXR1cm4gYXJ0aWNsZS5jbG9zZXN0PEhUTUxFbGVtZW50PihTRUwuY2VsbCk7XG59XG5cbi8qKiBUaGUgcXVvdGVkIHBvc3Q6IGEgZGl2W3JvbGU9bGlua10gaW4gdGhlIGFydGljbGUgaG9sZGluZyBpdHMgb3duIFVzZXItTmFtZSwgbm90IHRoZSBvdXRlciBhdXRob3Incy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBxdW90ZU9mKGFydGljbGU6IEVsZW1lbnQpOiBFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IG91dGVyTmFtZSA9IGFydGljbGUucXVlcnlTZWxlY3RvcihTRUwudXNlck5hbWUpO1xuICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20oYXJ0aWNsZS5xdWVyeVNlbGVjdG9yQWxsKFNFTC5xdW90ZSkpKSB7XG4gICAgaWYgKG91dGVyTmFtZSAmJiBlbC5jb250YWlucyhvdXRlck5hbWUpKSBjb250aW51ZTtcbiAgICBpZiAoZWwucXVlcnlTZWxlY3RvcihTRUwudXNlck5hbWUpKSByZXR1cm4gZWw7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBUaGUgcG9zdCBpZCBpbiBhIC9zdGF0dXMvPGlkPiBocmVmLCBvciBudWxsLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXR1c0lkT2YobGluazogRWxlbWVudCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gU1RBVFVTX0hSRUYuZXhlYyhsaW5rLmdldEF0dHJpYnV0ZSgnaHJlZicpID8/ICcnKT8uWzFdID8/IG51bGw7XG59XG5cbi8qKlxuICogVGhlIHBlcm1hbGluazogdGhlIGZpcnN0IGFbaHJlZio9XCIvc3RhdHVzL1wiXSBpbiBgc2NvcGVgIHRoYXQgY29udGFpbnMgYSA8dGltZT4gYW5kIGlzIG5vdCBpbnNpZGUgYGV4Y2x1ZGVgLlxuICogUGhvdG8gKC9zdGF0dXMvPGlkPi9waG90by8xKSBhbmQgYW5hbHl0aWNzIGxpbmtzIGhhdmUgbm8gPHRpbWU+LCBzbyB0aGV5IG5ldmVyIG1hdGNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGVybWFsaW5rT2Yoc2NvcGU6IEVsZW1lbnQsIGV4Y2x1ZGU6IEVsZW1lbnQgfCBudWxsKTogRWxlbWVudCB8IG51bGwge1xuICBmb3IgKGNvbnN0IGEgb2YgQXJyYXkuZnJvbShzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdhW2hyZWYqPVwiL3N0YXR1cy9cIl0nKSkpIHtcbiAgICBpZiAoZXhjbHVkZT8uY29udGFpbnMoYSkgfHwgIWEucXVlcnlTZWxlY3RvcigndGltZScpKSBjb250aW51ZTtcbiAgICBpZiAoc3RhdHVzSWRPZihhKSkgcmV0dXJuIGE7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwb3N0SWRPZihhcnRpY2xlOiBFbGVtZW50KTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGxpbmsgPSBwZXJtYWxpbmtPZihhcnRpY2xlLCBxdW90ZU9mKGFydGljbGUpKTtcbiAgcmV0dXJuIGxpbmsgJiYgc3RhdHVzSWRPZihsaW5rKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG93bkhhbmRsZU9mKGRvYzogRG9jdW1lbnQpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgaHJlZiA9IGRvYy5xdWVyeVNlbGVjdG9yKFNFTC5vd25Qcm9maWxlTGluayk/LmdldEF0dHJpYnV0ZSgnaHJlZicpO1xuICBpZiAoIWhyZWYpIHJldHVybiBudWxsO1xuICBsZXQgZmlyc3Q6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBmaXJzdCA9IG5ldyBVUkwoaHJlZiwgJ2h0dHBzOi8veC5jb20nKS5wYXRobmFtZS5zcGxpdCgnLycpLmZpbHRlcihCb29sZWFuKVswXTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIGZpcnN0ICYmIEhBTkRMRV9SRS50ZXN0KGZpcnN0KSA/IGBAJHtmaXJzdH1gIDogbnVsbDtcbn1cblxuLyoqIFNlbGVjdG9yIGhlYWx0aDogb2sgaXMgZmFsc2Ugb25seSB3aGVuIGNlbGxzIGFuZCBhcnRpY2xlcyByZW5kZXIgYnV0IG5vIGFydGljbGUgeWllbGRzIGEgcG9zdElkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrSGVhbHRoKHJvb3Q6IFBhcmVudE5vZGUpOiB7IGNlbGxzOiBudW1iZXI7IGFydGljbGVzOiBudW1iZXI7IHBhcnNlZDogbnVtYmVyOyBvazogYm9vbGVhbiB9IHtcbiAgY29uc3QgY2VsbHMgPSByb290LnF1ZXJ5U2VsZWN0b3JBbGwoU0VMLmNlbGwpLmxlbmd0aDtcbiAgY29uc3QgZm91bmQgPSBmaW5kQXJ0aWNsZXMocm9vdCk7XG4gIGNvbnN0IHBhcnNlZCA9IGZvdW5kLmZpbHRlcigoYSkgPT4gcG9zdElkT2YoYSkgIT09IG51bGwpLmxlbmd0aDtcbiAgcmV0dXJuIHsgY2VsbHMsIGFydGljbGVzOiBmb3VuZC5sZW5ndGgsIHBhcnNlZCwgb2s6ICEoY2VsbHMgPiAwICYmIGZvdW5kLmxlbmd0aCA+IDAgJiYgcGFyc2VkID09PSAwKSB9O1xufVxuIiwgIi8vIERldi1vbmx5IHJlc3VsdHMgcGFuZWwgcmVuZGVyZWQgaW5zaWRlIGVhY2ggcG9zdCAodGhlIGNhbGxlciBndWFyZHMgd2l0aCBfX0ZMQVZPUl9fKTogYSBjb21wYWN0XG4vLyBge3Njb3JlfWAgY2hpcCBwbHVzIGEgdG9nZ2xlLCBwbGFjZWQgdW5kZXIgdGhlIHBvc3QgdGV4dCBqdXN0IGFib3ZlIHRoZSBlbmdhZ2VtZW50IHJvdywgd2hvc2Vcbi8vIGNvbGxhcHNlZC1ieS1kZWZhdWx0IGRldGFpbHMgc3RhY2sgYmVsb3cgaXQgKG5ldmVyIGJlc2lkZSB0aGUgcG9zdCwgc28gdGhlIGZlZWQga2VlcHMgaXRzIHdpZHRoKS5cbi8vIFBvc3QtZGVyaXZlZCB0ZXh0IGlzIHVudHJ1c3RlZDogZXZlcnl0aGluZyBpcyByZW5kZXJlZCBhcyB0ZXh0IG5vZGVzLCBuZXZlciBpbm5lckhUTUwuXG5cbmltcG9ydCB7IGludGVuc2l0eUxhYmVsLCB0eXBlIERlY2lzaW9uLCB0eXBlIFJhbmtlZCB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9kZWNpZGUnO1xuaW1wb3J0IHsgZWZmZWN0aXZlSmV2LCB0eXBlIFBvc3RSZXN1bHRTdGF0ZSB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9yZXN1bHRzJztcbmltcG9ydCB7IFJVQlJJQ19WRVJTSU9OIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3J1YnJpYyc7XG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzIH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL3R5cGVzJztcbmltcG9ydCB7IFNFTCwgcXVvdGVPZiB9IGZyb20gJy4vc2VsZWN0b3JzJztcblxuZXhwb3J0IGNvbnN0IFBBTkVMX0FUVFIgPSAnZGF0YS1sYy1wYW5lbCc7XG5cbmV4cG9ydCB0eXBlIFBhbmVsVmVyZGljdCA9ICdISURFJyB8ICdLRUVQJyB8ICdQRU5ESU5HJyB8ICdFUlJPUic7XG4vKiogQ2hpcCBjb2xvcjogcmVkIGF0IG9yIGFib3ZlIHRoZSBoaWRlIHRocmVzaG9sZCwgZ3JlZW4gYmVsb3cgaXQsIGdyYXkgd2l0aG91dCBhIHNjb3JlLiAqL1xuZXhwb3J0IHR5cGUgU2NvcmVUb25lID0gJ292ZXInIHwgJ3VuZGVyJyB8ICdub25lJztcblxuZXhwb3J0IGludGVyZmFjZSBQYW5lbE1vZGVsIHtcbiAgcG9zdElkOiBzdHJpbmc7XG4gIHN0YXRlOiBQb3N0UmVzdWx0U3RhdGUgfCB1bmRlZmluZWQ7XG4gIGRlY2lzaW9uOiBEZWNpc2lvbjtcbiAgc2V0dGluZ3M6IFNldHRpbmdzO1xuICBzYXZlZD86ICdoaWRlJyB8ICdrZWVwJztcbn1cblxuLy8gU3RvcHBlZCBvbiB0aGUgaG9zdCBzbyBYIG5ldmVyIHNlZXMgY2xpY2tzL2tleXMgaW5zaWRlIHRoZSBwYW5lbCAoaXQgd291bGQgb3BlbiB0aGUgcG9zdCkuXG4vLyBCdWJibGUgcGhhc2Ugb25seTogYSBjYXB0dXJlLXBoYXNlIHN0b3Agb24gdGhlIGhvc3Qgd291bGQgYWxzbyBibG9jayB0aGUgcGFuZWwncyBvd24gYnV0dG9uc1xuLy8gKHRoZSBob3N0IGlzIGF0LXRhcmdldCBmb3IgZXZlbnRzIGZyb20gaXRzIHNoYWRvdyB0cmVlKSwgYW5kIGNhbm5vdCBhZmZlY3QgYW5jZXN0b3JzIGFueXdheS5cbmNvbnN0IFNUT1BQRURfRVZFTlRTID0gWydjbGljaycsICdtb3VzZWRvd24nLCAnbW91c2V1cCcsICdwb2ludGVyZG93bicsICdwb2ludGVydXAnLCAnYXV4Y2xpY2snLCAna2V5ZG93bicsICd0b3VjaHN0YXJ0J107XG5cbmNvbnN0IFBBTkVMX0NTUyA9IGBcbjpob3N0IHsgZGlzcGxheTogYmxvY2s7IH1cbi5sYyB7IGZvbnQ6IDEycHgvMS40IHVpLW1vbm9zcGFjZSwgQ29uc29sYXMsIG1vbm9zcGFjZTsgY29sb3I6IGluaGVyaXQ7IG1hcmdpbjogNnB4IDAgMnB4OyB9XG4ucm93IHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IH1cbi5jaGlwIHtcbiAgZm9udDogaW5oZXJpdDsgZm9udC13ZWlnaHQ6IDYwMDsgcGFkZGluZzogMXB4IDZweDsgYm9yZGVyLXJhZGl1czogNHB4O1xuICBjb2xvcjogIzcxNzY3YjsgYmFja2dyb3VuZDogcmdiYSgxMTMsMTE4LDEyMywuMTQpOyBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDExMywxMTgsMTIzLC4zNSk7XG59XG4uY2hpcC51bmRlciB7IGNvbG9yOiAjMDBiYTdjOyBiYWNrZ3JvdW5kOiByZ2JhKDAsMTg2LDEyNCwuMTIpOyBib3JkZXItY29sb3I6IHJnYmEoMCwxODYsMTI0LC40NSk7IH1cbi5jaGlwLm92ZXIgeyBjb2xvcjogI2Y0MjEyZTsgYmFja2dyb3VuZDogcmdiYSgyNDQsMzMsNDYsLjEyKTsgYm9yZGVyLWNvbG9yOiByZ2JhKDI0NCwzMyw0NiwuNDUpOyB9XG4udG9nIHtcbiAgd2lkdGg6IDE4cHg7IGhlaWdodDogMThweDsgcGFkZGluZzogMDsgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiA1MCU7IGN1cnNvcjogcG9pbnRlcjtcbiAgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyO1xuICBiYWNrZ3JvdW5kOiAjOGI5OGE1OyBjb2xvcjogI2ZmZjsgZm9udDogODAwIDEycHgvMSBzeXN0ZW0tdWksIHNhbnMtc2VyaWY7XG59XG4udG9nIHNwYW4geyBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IHRyYW5zZm9ybTogcm90YXRlKDkwZGVnKTsgdHJhbnNpdGlvbjogdHJhbnNmb3JtIC4xNXM7IH1cbi50b2dbYXJpYS1leHBhbmRlZD1cInRydWVcIl0gc3BhbiB7IHRyYW5zZm9ybTogcm90YXRlKC05MGRlZyk7IH1cbi5kZXRhaWxzIHtcbiAgd2hpdGUtc3BhY2U6IHByZS13cmFwOyBtYXJnaW4tdG9wOiA2cHg7IHBhZGRpbmc6IDZweCA4cHg7IGJvcmRlci1yYWRpdXM6IDZweDtcbiAgYm9yZGVyLWxlZnQ6IDRweCBzb2xpZCAjOWFhMGE2OyBiYWNrZ3JvdW5kOiByZ2JhKDEyNywxMjcsMTI3LC4wOCk7XG59XG4uZGV0YWlsc1toaWRkZW5dIHsgZGlzcGxheTogbm9uZTsgfVxuLmRldGFpbHMuaGlkZSB7IGJvcmRlci1sZWZ0LWNvbG9yOiAjZDkzMDI1OyB9XG4uZGV0YWlscy5rZWVwIHsgYm9yZGVyLWxlZnQtY29sb3I6ICMxODgwMzg7IH1cbi5kZXRhaWxzIGJ1dHRvbiB7IGZvbnQ6IGluaGVyaXQ7IG1hcmdpbjogNHB4IDZweCAwIDA7IH1cbmA7XG5cbmNvbnN0IGYyID0gKG46IG51bWJlcikgPT4gbi50b0ZpeGVkKDIpO1xuY29uc3QgZjEgPSAobjogbnVtYmVyKSA9PiBuLnRvRml4ZWQoMSk7XG5jb25zdCByYW5rZWQgPSAocjogUmFua2VkIHwgdW5kZWZpbmVkKSA9PiAociA/IGAke3Iua2V5fSAke2YyKHIucCl9YCA6ICctJyk7XG5jb25zdCBudW0gPSAobjogbnVtYmVyIHwgdW5kZWZpbmVkLCBmOiAobjogbnVtYmVyKSA9PiBzdHJpbmcpID0+IChuID09PSB1bmRlZmluZWQgPyAnLScgOiBmKG4pKTtcblxuLyoqIFRoZSBjaGlwJ3MgdGV4dCBhbmQgdG9uZTogdGhlIEpldiByYWdlYmFpdCBzY29yZSBhZ2FpbnN0IHRoZSBjb25maWd1cmVkIGhpZGUgdGhyZXNob2xkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjb3JlQ2hpcChtOiBQYW5lbE1vZGVsKTogeyB0ZXh0OiBzdHJpbmc7IHRvbmU6IFNjb3JlVG9uZSB9IHtcbiAgY29uc3QgcCA9IGVmZmVjdGl2ZUpldihtLnN0YXRlKSA/IG0uZGVjaXNpb24ucmFnZWJhaXQgOiB1bmRlZmluZWQ7XG4gIGlmIChwID09PSB1bmRlZmluZWQpIHJldHVybiB7IHRleHQ6IG0uc3RhdGU/LmVycm9yID8gJ3tlcnJ9JyA6ICd7XHUyMDI2fScsIHRvbmU6ICdub25lJyB9O1xuICByZXR1cm4geyB0ZXh0OiBgeyR7ZjIocCl9fWAsIHRvbmU6IHAgPj0gbS5zZXR0aW5ncy50aHJlc2hvbGQgPyAnb3ZlcicgOiAndW5kZXInIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYW5lbFZlcmRpY3QobTogUGFuZWxNb2RlbCk6IFBhbmVsVmVyZGljdCB7XG4gIGlmICghZWZmZWN0aXZlSmV2KG0uc3RhdGUpKSByZXR1cm4gbS5zdGF0ZT8uZXJyb3IgPyAnRVJST1InIDogJ1BFTkRJTkcnO1xuICByZXR1cm4gbS5kZWNpc2lvbi5oaWRlID8gJ0hJREUnIDogJ0tFRVAnO1xufVxuXG5mdW5jdGlvbiB2aXNpb25MaW5lKHN0YXRlOiBQb3N0UmVzdWx0U3RhdGUgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHN0YXRlPy52aXNpb24pIHtcbiAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICBjYXNlICdwZW5kaW5nJzpcbiAgICAgIHJldHVybiAndmlzaW9uOiBwZW5kaW5nJztcbiAgICBjYXNlICdub25lJzpcbiAgICAgIHJldHVybiAndmlzaW9uOiBub25lJztcbiAgICBjYXNlICdkaXNhYmxlZCc6XG4gICAgICByZXR1cm4gJ3Zpc2lvbjogZGlzYWJsZWQnO1xuICAgIGNhc2UgJ3NraXBwZWRfZmxhZ2dlZCc6XG4gICAgICByZXR1cm4gJ3Zpc2lvbjogc2tpcHBlZCAoZmxhZ2dlZCBieSB0ZXh0KSc7XG4gICAgY2FzZSAnZmFpbGVkJzpcbiAgICAgIHJldHVybiBgdmlzaW9uOiBmYWlsZWQ6ICR7c3RhdGUuZnVsbD8uZXJyb3I/LmNvZGUgPz8gc3RhdGUuZXJyb3I/LmNvZGUgPz8gJ3Vua25vd24nfWA7XG4gICAgY2FzZSAnZG9uZSc6IHtcbiAgICAgIGNvbnN0IHRzID0gc3RhdGUudHJhbnNjcmlwdHMgPz8gW107XG4gICAgICByZXR1cm4gYHZpc2lvbjogZG9uZSAke3RzLmxlbmd0aH0gaXRlbShzKWAgKyAodHNbMF0gPyBgICgke3RzWzBdLm1vZGVsfSlgIDogJycpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB0aW1pbmdMaW5lKHN0YXRlOiBQb3N0UmVzdWx0U3RhdGUgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB0ID0geyAuLi5zdGF0ZT8udGV4dD8udGltaW5ncywgLi4uc3RhdGU/LmZ1bGw/LnRpbWluZ3MgfTtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmICh0LnRleHRNcyAhPT0gdW5kZWZpbmVkKSBwYXJ0cy5wdXNoKGB0ZXh0ICR7dC50ZXh0TXN9IG1zJHtzdGF0ZT8udGV4dD8uamV2Py5jYWNoZWQgPyAnIChjYWNoZSknIDogJyd9YCk7XG4gIGlmICh0LnZpc2lvbk1zICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYHZpc2lvbiAkeyh0LnZpc2lvbk1zIC8gMTAwMCkudG9GaXhlZCgxKX0gc2ApO1xuICBpZiAodC5mdWxsTXMgIT09IHVuZGVmaW5lZCkgcGFydHMucHVzaChgZnVsbCAke3QuZnVsbE1zfSBtc2ApO1xuICByZXR1cm4gcGFydHMubGVuZ3RoID8gYHRpbWluZzogJHtwYXJ0cy5qb2luKCcgXHUwMEI3ICcpfWAgOiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYW5lbExpbmVzKG06IFBhbmVsTW9kZWwpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHsgc3RhdGUsIGRlY2lzaW9uOiBkLCBzZXR0aW5ncyB9ID0gbTtcbiAgY29uc3QgdmVyZGljdCA9IHBhbmVsVmVyZGljdChtKTtcbiAgY29uc3QgamV2ID0gZWZmZWN0aXZlSmV2KHN0YXRlKTtcbiAgY29uc3QgbGluZXMgPSBbXG4gICAgYExPVyBDT1JUSVNPTCBcdTAwQjcgZGV2ICAgJHt2ZXJkaWN0fWAgK1xuICAgICAgKHZlcmRpY3QgPT09ICdISURFJyAmJiAhc2V0dGluZ3MuaGlkZUVuYWJsZWQgPyAnICh3b3VsZCBoaWRlKScgOiAnJykgK1xuICAgICAgKHZlcmRpY3QgPT09ICdFUlJPUicgPyBgICR7c3RhdGU/LmVycm9yPy5jb2RlfWAgOiAnJyksXG4gIF07XG4gIGlmIChqZXYpIHtcbiAgICBsaW5lcy5wdXNoKGByZWFzb246ICR7ZC5yZWFzb25zLmpvaW4oJzsgJyl9YCk7XG4gICAgbGluZXMucHVzaChcbiAgICAgIGByYWdlYmFpdCAke251bShkLnJhZ2ViYWl0LCBmMil9IFx1MDBCNyBjYXRlZ29yeSAke3JhbmtlZChkLnRvcENhdGVnb3J5KX0gKGhpZGUta2luZHMgJHtudW0oZC5oaWRlQ2F0ZWdvcnlNYXNzLCBmMil9KWAgK1xuICAgICAgICBgIFx1MDBCNyBlbW90aW9uICR7cmFua2VkKGQudG9wRW1vdGlvbil9YCxcbiAgICApO1xuICAgIGNvbnN0IGkgPSBkLmludGVuc2l0eTtcbiAgICBsaW5lcy5wdXNoKFxuICAgICAgYGludGVuc2l0eSAke2kgPT09IHVuZGVmaW5lZCA/ICctJyA6IGAke2YxKGkpfSAke2ludGVuc2l0eUxhYmVsKGkpfWB9IFx1MDBCNyB0b3BpYyAke3JhbmtlZChkLnRvcFRvcGljKX1gICtcbiAgICAgICAgYCBcdTAwQjcgJHtqZXYubW9kZWx9IFx1MDBCNyAke1JVQlJJQ19WRVJTSU9OfWAsXG4gICAgKTtcbiAgfVxuICBsaW5lcy5wdXNoKHZpc2lvbkxpbmUoc3RhdGUpKTtcbiAgaWYgKHNldHRpbmdzLnNob3dUcmFuc2NyaXB0KSB7XG4gICAgKHN0YXRlPy50cmFuc2NyaXB0cyA/PyBbXSkuZm9yRWFjaCgodCwgaykgPT4ge1xuICAgICAgbGluZXMucHVzaChcbiAgICAgICAgYHRyYW5zY3JpcHQgIyR7ayArIDF9ICR7dC5raW5kfSR7dC5pblF1b3RlID8gJyAocXVvdGUpJyA6ICcnfTogXCIke3QudmlzaWJsZVRleHQuc2xpY2UoMCwgMTYwKX1cImAgK1xuICAgICAgICAgIGAgXHUyMDE0ICR7dC5kZXNjcmlwdGlvbi5zbGljZSgwLCAyMDApfSR7dC5jdWVzLmxlbmd0aCA/ICcgWycgKyB0LmN1ZXMuam9pbignLCAnKSArICddJyA6ICcnfWAsXG4gICAgICApO1xuICAgIH0pO1xuICB9XG4gIGlmIChzZXR0aW5ncy5zaG93U3RhdHVzKSB7XG4gICAgY29uc3QgdGltaW5nID0gdGltaW5nTGluZShzdGF0ZSk7XG4gICAgaWYgKHRpbWluZykgbGluZXMucHVzaCh0aW1pbmcpO1xuICB9XG4gIHJldHVybiBsaW5lcztcbn1cblxuLyoqIEZhbHNlIHdoZW4gYGVsYCBzaXRzIGluc2lkZSBhIHBvc3QgbmVzdGVkIGluIGBhcnRpY2xlYC4gKi9cbmZ1bmN0aW9uIG93bmVkQnkoYXJ0aWNsZTogRWxlbWVudCwgZWw6IEVsZW1lbnQpOiBib29sZWFuIHtcbiAgY29uc3QgaW5uZXIgPSBlbC5wYXJlbnRFbGVtZW50Py5jbG9zZXN0KFNFTC5hcnRpY2xlKTtcbiAgcmV0dXJuICFpbm5lciB8fCBpbm5lciA9PT0gYXJ0aWNsZSB8fCAhYXJ0aWNsZS5jb250YWlucyhpbm5lcik7XG59XG5cbi8qKiBUaGlzIGFydGljbGUncyBvd24gaG9zdHMgKG5ldmVyIG9uZSBpbnNpZGUgYSBuZXN0ZWQgYXJ0aWNsZSkuICovXG5mdW5jdGlvbiBob3N0c09mKGFydGljbGU6IEVsZW1lbnQpOiBIVE1MRWxlbWVudFtdIHtcbiAgcmV0dXJuIEFycmF5LmZyb20oYXJ0aWNsZS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihgWyR7UEFORUxfQVRUUn1dYCkpLmZpbHRlcigoaCkgPT4gb3duZWRCeShhcnRpY2xlLCBoKSk7XG59XG5cbi8qKiBUaGUgbGFzdCBlbGVtZW50IG1hdGNoaW5nIGBzZWxgIHRoYXQgYmVsb25ncyB0byB0aGUgcG9zdCBpdHNlbGYgKG5vdCBhIHF1b3RlZCBvciBuZXN0ZWQgcG9zdCkuICovXG5mdW5jdGlvbiBvd25MYXN0KGFydGljbGU6IEVsZW1lbnQsIHNlbDogc3RyaW5nKTogRWxlbWVudCB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHF1b3RlID0gcXVvdGVPZihhcnRpY2xlKTtcbiAgY29uc3Qgb3duID0gQXJyYXkuZnJvbShhcnRpY2xlLnF1ZXJ5U2VsZWN0b3JBbGwoc2VsKSkuZmlsdGVyKFxuICAgIChlbCkgPT4gb3duZWRCeShhcnRpY2xlLCBlbCkgJiYgIXF1b3RlPy5jb250YWlucyhlbCksXG4gICk7XG4gIHJldHVybiBvd25bb3duLmxlbmd0aCAtIDFdO1xufVxuXG4vKiogVW5kZXIgdGhlIHBvc3QgdGV4dCwganVzdCBhYm92ZSB0aGUgZW5nYWdlbWVudCByb3c7IGZhbGxiYWNrczogcmlnaHQgYWZ0ZXIgdGhlIHRleHQsIHRoZW4gbGFzdCBjaGlsZC4gKi9cbmZ1bmN0aW9uIHBsYWNlKGFydGljbGU6IEVsZW1lbnQsIGhvc3Q6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IGJhciA9IG93bkxhc3QoYXJ0aWNsZSwgU0VMLmFjdGlvbkJhcik7XG4gIGlmIChiYXIpIHtcbiAgICBpZiAoYmFyLnByZXZpb3VzRWxlbWVudFNpYmxpbmcgIT09IGhvc3QpIGJhci5iZWZvcmUoaG9zdCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHRleHQgPSBvd25MYXN0KGFydGljbGUsIFNFTC50d2VldFRleHQpO1xuICBpZiAodGV4dCkge1xuICAgIGlmICh0ZXh0Lm5leHRFbGVtZW50U2libGluZyAhPT0gaG9zdCkgdGV4dC5hZnRlcihob3N0KTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGFydGljbGUubGFzdEVsZW1lbnRDaGlsZCAhPT0gaG9zdCkgYXJ0aWNsZS5hcHBlbmRDaGlsZChob3N0KTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSG9zdChhcnRpY2xlOiBFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBkb2MgPSBhcnRpY2xlLm93bmVyRG9jdW1lbnQ7XG4gIGNvbnN0IGhvc3QgPSBkb2MuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gIGhvc3Quc2V0QXR0cmlidXRlKFBBTkVMX0FUVFIsICcnKTtcbiAgZm9yIChjb25zdCB0eXBlIG9mIFNUT1BQRURfRVZFTlRTKSBob3N0LmFkZEV2ZW50TGlzdGVuZXIodHlwZSwgKGUpID0+IGUuc3RvcFByb3BhZ2F0aW9uKCkpO1xuICBjb25zdCByb290ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7XG4gIGNvbnN0IHN0eWxlID0gZG9jLmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gUEFORUxfQ1NTO1xuXG4gIGNvbnN0IGNoaXAgPSBkb2MuY3JlYXRlRWxlbWVudCgnY29kZScpO1xuICBjaGlwLmNsYXNzTmFtZSA9ICdjaGlwJztcbiAgY29uc3QgdG9nZ2xlID0gZG9jLmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICB0b2dnbGUudHlwZSA9ICdidXR0b24nO1xuICB0b2dnbGUuY2xhc3NOYW1lID0gJ3RvZyc7XG4gIHRvZ2dsZS50aXRsZSA9ICdMb3cgQ29ydGlzb2wgZGV0YWlscyc7XG4gIHRvZ2dsZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCAnZmFsc2UnKTtcbiAgY29uc3QgYXJyb3cgPSBkb2MuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xuICBhcnJvdy50ZXh0Q29udGVudCA9ICc+JztcbiAgdG9nZ2xlLmFwcGVuZChhcnJvdyk7XG4gIGNvbnN0IHJvdyA9IGRvYy5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgcm93LmNsYXNzTmFtZSA9ICdyb3cnO1xuICByb3cuYXBwZW5kKGNoaXAsIHRvZ2dsZSk7XG5cbiAgY29uc3QgZGV0YWlscyA9IGRvYy5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgZGV0YWlscy5jbGFzc05hbWUgPSAnZGV0YWlscyc7XG4gIGRldGFpbHMuaGlkZGVuID0gdHJ1ZTtcbiAgdG9nZ2xlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgIGRldGFpbHMuaGlkZGVuID0gIWRldGFpbHMuaGlkZGVuO1xuICAgIHRvZ2dsZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnLCBTdHJpbmcoIWRldGFpbHMuaGlkZGVuKSk7XG4gIH0pO1xuXG4gIGNvbnN0IGJveCA9IGRvYy5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgYm94LmNsYXNzTmFtZSA9ICdsYyc7XG4gIGJveC5hcHBlbmQocm93LCBkZXRhaWxzKTtcbiAgcm9vdC5hcHBlbmQoc3R5bGUsIGJveCk7XG4gIHJldHVybiBob3N0O1xufVxuXG4vKiogQ3JlYXRlIG9yIHVwZGF0ZSB0aGUgYXJ0aWNsZSdzIHNpbmdsZSBwYW5lbDsgaXRzIGNvbGxhcHNlZC9leHBhbmRlZCBzdGF0ZSBzdXJ2aXZlcyB1cGRhdGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclBhbmVsKFxuICBhcnRpY2xlOiBFbGVtZW50LFxuICBtOiBQYW5lbE1vZGVsLFxuICBvbkZlZWRiYWNrOiAobGFiZWw6ICdoaWRlJyB8ICdrZWVwJykgPT4gdm9pZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgZG9jID0gYXJ0aWNsZS5vd25lckRvY3VtZW50O1xuICAvLyBBIGhvc3QgY29waWVkIGJ5IG1hcmt1cCAoYSByZWN5Y2xlZC9jbG9uZWQgY2VsbCkgaGFzIG5vIHNoYWRvdyByb290OyBrZWVwIG9uZSBsaXZlIGhvc3Qgb25seS5cbiAgY29uc3QgW2ZpcnN0LCAuLi5leHRyYV0gPSBob3N0c09mKGFydGljbGUpO1xuICBleHRyYS5mb3JFYWNoKChoKSA9PiBoLnJlbW92ZSgpKTtcbiAgaWYgKGZpcnN0ICYmICFmaXJzdC5zaGFkb3dSb290KSBmaXJzdC5yZW1vdmUoKTtcbiAgY29uc3QgaG9zdCA9IGZpcnN0Py5zaGFkb3dSb290ID8gZmlyc3QgOiBjcmVhdGVIb3N0KGFydGljbGUpO1xuICBwbGFjZShhcnRpY2xlLCBob3N0KTtcbiAgY29uc3Qgcm9vdCA9IGhvc3Quc2hhZG93Um9vdCE7XG5cbiAgY29uc3QgY2hpcCA9IHNjb3JlQ2hpcChtKTtcbiAgY29uc3QgY2hpcEVsID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcuY2hpcCcpIGFzIEhUTUxFbGVtZW50O1xuICBjaGlwRWwuY2xhc3NOYW1lID0gYGNoaXAgJHtjaGlwLnRvbmV9YDtcbiAgY2hpcEVsLnRleHRDb250ZW50ID0gY2hpcC50ZXh0O1xuXG4gIGNvbnN0IGJveCA9IHJvb3QucXVlcnlTZWxlY3RvcignLmRldGFpbHMnKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uc3QgdmVyZGljdCA9IHBhbmVsVmVyZGljdChtKTtcbiAgYm94LmNsYXNzTmFtZSA9IGBkZXRhaWxzICR7dmVyZGljdCA9PT0gJ0hJREUnID8gJ2hpZGUnIDogdmVyZGljdCA9PT0gJ0tFRVAnID8gJ2tlZXAnIDogJ3BlbmRpbmcnfWA7XG4gIGJveC5yZXBsYWNlQ2hpbGRyZW4oZG9jLmNyZWF0ZVRleHROb2RlKHBhbmVsTGluZXMobSkuam9pbignXFxuJykgKyAnXFxuJykpO1xuXG4gIGNvbnN0IGVuYWJsZWQgPSAhIWVmZmVjdGl2ZUpldihtLnN0YXRlKTtcbiAgZm9yIChjb25zdCBbdGV4dCwgbGFiZWxdIG9mIFtbJ1Nob3VsZCBoaWRlJywgJ2hpZGUnXSwgWydTaG91bGQga2VlcCcsICdrZWVwJ11dIGFzIGNvbnN0KSB7XG4gICAgY29uc3QgYnRuID0gZG9jLmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGJ0bi50eXBlID0gJ2J1dHRvbic7XG4gICAgYnRuLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICBidG4uZGlzYWJsZWQgPSAhZW5hYmxlZDtcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBvbkZlZWRiYWNrKGxhYmVsKSk7XG4gICAgYm94LmFwcGVuZChidG4pO1xuICB9XG4gIGlmIChtLnNhdmVkKSBib3guYXBwZW5kKGRvYy5jcmVhdGVUZXh0Tm9kZShgc2F2ZWQgXHUyNzEzICgke20uc2F2ZWR9KWApKTtcbiAgcmV0dXJuIGhvc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVQYW5lbChhcnRpY2xlOiBFbGVtZW50KTogdm9pZCB7XG4gIGhvc3RzT2YoYXJ0aWNsZSkuZm9yRWFjaCgoaCkgPT4gaC5yZW1vdmUoKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVBbGxQYW5lbHMoZG9jOiBEb2N1bWVudCk6IG51bWJlciB7XG4gIGNvbnN0IHBhbmVscyA9IGRvYy5xdWVyeVNlbGVjdG9yQWxsKGBbJHtQQU5FTF9BVFRSfV1gKTtcbiAgcGFuZWxzLmZvckVhY2goKHApID0+IHAucmVtb3ZlKCkpO1xuICByZXR1cm4gcGFuZWxzLmxlbmd0aDtcbn1cbiIsICIvLyBBcnRpY2xlIFx1MjE5MiBQb3N0U25hcHNob3QsIHBsdXMgZXhlbXB0aW9ucyAoc3BlYyBcdTAwQTc0LjEpLiBSZWFkcyB0aGUgRE9NIG9ubHk7IG5ldmVyIHVzZXMgaW5uZXJUZXh0LlxuXG5pbXBvcnQgdHlwZSB7IExpbmtDYXJkLCBNZWRpYUtpbmQsIE1lZGlhUmVmLCBQb3N0U25hcHNob3QsIFF1b3RlZFBvc3QgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvdHlwZXMnO1xuaW1wb3J0IHsgc2hvdWxkRmlsdGVyLCB0eXBlIFBhZ2VJbmZvIH0gZnJvbSAnLi9wYWdlJztcbmltcG9ydCB7IFNFTCwgY2VsbE9mLCBmaW5kQXJ0aWNsZXMsIHBlcm1hbGlua09mLCBwb3N0SWRPZiwgcXVvdGVPZiwgc3RhdHVzSWRPZiB9IGZyb20gJy4vc2VsZWN0b3JzJztcblxuY29uc3QgWF9PUklHSU4gPSAnaHR0cHM6Ly94LmNvbSc7XG5jb25zdCBQRVJNQUxJTktfUEFUSCA9IC9eXFwvKFtBLVphLXowLTlfXXsxLDE1fSlcXC9zdGF0dXNcXC9cXGQrLztcbmNvbnN0IEhBTkRMRV9URVhUID0gL15AW0EtWmEtejAtOV9dezEsMTV9JC87XG5jb25zdCBET01BSU5fVEVYVCA9IC9eKEZyb21cXHMrKT8oW2EtejAtOS1dK1xcLikrW2Etel17Mix9JC9pO1xuY29uc3QgTEFSR0VfU0laRVMgPSBuZXcgU2V0KFsnbGFyZ2UnLCAnb3JpZycsICc0MDk2eDQwOTYnXSk7XG5cbi8qKiBUZXh0IGFzIFggcmVuZGVycyBpdDogdGV4dCBub2RlcyBhcy1pcywgaW1nW2FsdF0gKGVtb2ppKSBhcyBpdHMgYWx0LCBiciBhcyBcIlxcblwiOyBvbmx5IHRoZSBlbmRzIGFyZSB0cmltbWVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RUZXh0KGVsOiBFbGVtZW50IHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICghZWwpIHJldHVybiAnJztcbiAgbGV0IG91dCA9ICcnO1xuICBjb25zdCB3YWxrID0gKG5vZGU6IE5vZGUpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20obm9kZS5jaGlsZE5vZGVzKSkge1xuICAgICAgaWYgKGNoaWxkLm5vZGVUeXBlID09PSBOb2RlLlRFWFRfTk9ERSkge1xuICAgICAgICBvdXQgKz0gY2hpbGQubm9kZVZhbHVlID8/ICcnO1xuICAgICAgfSBlbHNlIGlmIChjaGlsZC5ub2RlVHlwZSA9PT0gTm9kZS5FTEVNRU5UX05PREUpIHtcbiAgICAgICAgY29uc3QgZSA9IGNoaWxkIGFzIEVsZW1lbnQ7XG4gICAgICAgIGlmIChlLmxvY2FsTmFtZSA9PT0gJ2JyJykgb3V0ICs9ICdcXG4nO1xuICAgICAgICBlbHNlIGlmIChlLmxvY2FsTmFtZSA9PT0gJ2ltZycpIG91dCArPSBlLmdldEF0dHJpYnV0ZSgnYWx0JykgPz8gJyc7XG4gICAgICAgIGVsc2Ugd2FsayhlKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG4gIHdhbGsoZWwpO1xuICByZXR1cm4gb3V0LnRyaW0oKTtcbn1cblxuLyoqIFN0YWJsZSBtZWRpYSBpZDogcGJzIC9tZWRpYS88aWQ+IFx1MjE5MiBcIm1lZGlhLzxpZD5cIjsgb3RoZXIgcGJzIHBhdGhzIG1pbnVzIGV4dGVuc2lvbjsgZWxzZSB0aGUgVVJMIHdpdGhvdXQgcXVlcnkuICovXG5leHBvcnQgZnVuY3Rpb24gbWVkaWFLZXkodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgdTogVVJMO1xuICB0cnkge1xuICAgIHUgPSBuZXcgVVJMKHVybCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1cmw7XG4gIH1cbiAgaWYgKHUuaG9zdG5hbWUgPT09ICdwYnMudHdpbWcuY29tJykge1xuICAgIGNvbnN0IG1lZGlhID0gL15cXC9tZWRpYVxcLyhbXi8uXSspLy5leGVjKHUucGF0aG5hbWUpO1xuICAgIGlmIChtZWRpYSkgcmV0dXJuIGBtZWRpYS8ke21lZGlhWzFdfWA7XG4gICAgcmV0dXJuIHUucGF0aG5hbWUucmVwbGFjZSgvXlxcLy8sICcnKS5yZXBsYWNlKC9cXC5bQS1aYS16MC05XSskLywgJycpO1xuICB9XG4gIHJldHVybiB1Lm9yaWdpbiArIHUucGF0aG5hbWU7XG59XG5cbi8qKiBuYW1lPWxhcmdlfG9yaWd8NDA5Nng0MDk2IFx1MjE5MiBuYW1lPW1lZGl1bTsgZXZlcnkgb3RoZXIgVVJMIGlzIHJldHVybmVkIGV4YWN0bHkgYXMgcmVuZGVyZWQgKEhUVFAtY2FjaGUgZnJpZW5kbHkpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZU1lZGlhVXJsKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHU6IFVSTDtcbiAgdHJ5IHtcbiAgICB1ID0gbmV3IFVSTCh1cmwpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdXJsO1xuICB9XG4gIGlmICghTEFSR0VfU0laRVMuaGFzKHUuc2VhcmNoUGFyYW1zLmdldCgnbmFtZScpID8/ICcnKSkgcmV0dXJuIHVybDtcbiAgdS5zZWFyY2hQYXJhbXMuc2V0KCduYW1lJywgJ21lZGl1bScpO1xuICByZXR1cm4gdS50b1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiBpc1Bicyh1cmw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IHUgPSBuZXcgVVJMKHVybCk7XG4gICAgcmV0dXJuIHUucHJvdG9jb2wgPT09ICdodHRwczonICYmIHUuaG9zdG5hbWUgPT09ICdwYnMudHdpbWcuY29tJztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBBbGwgbWF0Y2hlcyBvZiBgc2VsYCBpbiBgc2NvcGVgIHRoYXQgYXJlIG5vdCBpbnNpZGUgYGV4Y2x1ZGVgICh0aGUgcXVvdGVkIHBvc3QpLiAqL1xuZnVuY3Rpb24gb3V0c2lkZUFsbChzY29wZTogRWxlbWVudCwgc2VsOiBzdHJpbmcsIGV4Y2x1ZGU6IEVsZW1lbnQgfCBudWxsKTogRWxlbWVudFtdIHtcbiAgcmV0dXJuIEFycmF5LmZyb20oc2NvcGUucXVlcnlTZWxlY3RvckFsbChzZWwpKS5maWx0ZXIoKGVsKSA9PiAhZXhjbHVkZT8uY29udGFpbnMoZWwpKTtcbn1cblxuZnVuY3Rpb24gb3V0c2lkZShzY29wZTogRWxlbWVudCwgc2VsOiBzdHJpbmcsIGV4Y2x1ZGU6IEVsZW1lbnQgfCBudWxsKTogRWxlbWVudCB8IG51bGwge1xuICByZXR1cm4gb3V0c2lkZUFsbChzY29wZSwgc2VsLCBleGNsdWRlKVswXSA/PyBudWxsO1xufVxuXG4vKiogVHJpbW1lZCwgbm9uLWVtcHR5IHRleHQtbm9kZSB2YWx1ZXMgaW4gZG9jdW1lbnQgb3JkZXIuICovXG5mdW5jdGlvbiBsZWFmVGV4dHMoZWw6IEVsZW1lbnQpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlOiBOb2RlKTogdm9pZCA9PiB7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKG5vZGUuY2hpbGROb2RlcykpIHtcbiAgICAgIGlmIChjaGlsZC5ub2RlVHlwZSA9PT0gTm9kZS5URVhUX05PREUpIHtcbiAgICAgICAgY29uc3QgdCA9IChjaGlsZC5ub2RlVmFsdWUgPz8gJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKHQpIG91dC5wdXNoKHQpO1xuICAgICAgfSBlbHNlIGlmIChjaGlsZC5ub2RlVHlwZSA9PT0gTm9kZS5FTEVNRU5UX05PREUpIHtcbiAgICAgICAgd2FsayhjaGlsZCk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuICB3YWxrKGVsKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIEF1dGhvciBmcm9tIGEgVXNlci1OYW1lIGJsb2NrOiB0aGUgQGhhbmRsZSB0ZXh0IGFuZCB0aGUgZGlzcGxheSBuYW1lICh0aGUgcHJvZmlsZSBsaW5rLCBlbHNlIHRoZSBmaXJzdCBjaGlsZCkuICovXG5mdW5jdGlvbiBhdXRob3JPZih1c2VyTmFtZTogRWxlbWVudCB8IG51bGwpOiB7IGhhbmRsZTogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfSB7XG4gIGlmICghdXNlck5hbWUpIHJldHVybiB7IGhhbmRsZTogJycsIG5hbWU6ICcnIH07XG4gIC8vIExhc3QgbWF0Y2ggd2luczogYSBkaXNwbGF5IG5hbWUgbWF5IGl0c2VsZiBsb29rIGxpa2UgXCJAc29tZXRoaW5nXCI7IHRoZSByZWFsIGhhbmRsZSBmb2xsb3dzIGl0LlxuICBjb25zdCBoYW5kbGUgPSBsZWFmVGV4dHModXNlck5hbWUpLmZpbHRlcigodCkgPT4gSEFORExFX1RFWFQudGVzdCh0KSkucG9wKCkgPz8gJyc7XG4gIGNvbnN0IG5hbWVMaW5rID0gQXJyYXkuZnJvbSh1c2VyTmFtZS5xdWVyeVNlbGVjdG9yQWxsKCdhJykpLmZpbmQoXG4gICAgKGEpID0+ICFhLnF1ZXJ5U2VsZWN0b3IoJ3RpbWUnKSAmJiAhZXh0cmFjdFRleHQoYSkuc3RhcnRzV2l0aCgnQCcpLFxuICApO1xuICAvLyBRdW90ZWQgcG9zdHMgcmVuZGVyIFVzZXItTmFtZSB3aXRob3V0IGxpbmtzOyB0aGUgZGlzcGxheSBuYW1lIGlzIHRoZW4gdGhlIGZpcnN0IGJsb2NrLlxuICByZXR1cm4geyBoYW5kbGUsIG5hbWU6IGV4dHJhY3RUZXh0KG5hbWVMaW5rID8/IHVzZXJOYW1lLmZpcnN0RWxlbWVudENoaWxkKSB9O1xufVxuXG4vKiogUGhvdG9zLCB0aGVuIHZpZGVvL0dJRiBwb3N0ZXJzLCB0aGVuIHRoZSBjYXJkIGltYWdlLCBmcm9tIGBzY29wZWAgbWludXMgYGV4Y2x1ZGVgLiBEZWR1cGVzIGJ5IGtleSBpbnRvIGBvdXRgLiAqL1xuZnVuY3Rpb24gY29sbGVjdE1lZGlhKHNjb3BlOiBFbGVtZW50LCBleGNsdWRlOiBFbGVtZW50IHwgbnVsbCwgaW5RdW90ZTogYm9vbGVhbiwgb3V0OiBNZWRpYVJlZltdLCBzZWVuOiBTZXQ8c3RyaW5nPik6IHZvaWQge1xuICBjb25zdCBhZGQgPSAoa2luZDogTWVkaWFLaW5kLCByYXc6IHN0cmluZyB8IG51bGwsIGFsdD86IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGlmICghcmF3IHx8ICFpc1BicyhyYXcpKSByZXR1cm47XG4gICAgY29uc3Qga2V5ID0gbWVkaWFLZXkocmF3KTtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkgcmV0dXJuO1xuICAgIHNlZW4uYWRkKGtleSk7XG4gICAgY29uc3QgcmVmOiBNZWRpYVJlZiA9IHsga2luZCwgdXJsOiBub3JtYWxpemVNZWRpYVVybChyYXcpLCBrZXksIGluUXVvdGUgfTtcbiAgICBpZiAoYWx0KSByZWYuYWx0ID0gYWx0O1xuICAgIG91dC5wdXNoKHJlZik7XG4gIH07XG5cbiAgZm9yIChjb25zdCBpbWcgb2Ygb3V0c2lkZUFsbChzY29wZSwgYCR7U0VMLnBob3RvfSBpbWdgLCBleGNsdWRlKSkge1xuICAgIGFkZCgnaW1hZ2UnLCBpbWcuZ2V0QXR0cmlidXRlKCdzcmMnKSwgaW1nLmdldEF0dHJpYnV0ZSgnYWx0Jyk/LnRyaW0oKSB8fCB1bmRlZmluZWQpO1xuICB9XG4gIGZvciAoY29uc3QgdmlkZW8gb2Ygb3V0c2lkZUFsbChzY29wZSwgYCR7U0VMLnZpZGVvUGxheWVyfSB2aWRlb1twb3N0ZXJdYCwgZXhjbHVkZSkpIHtcbiAgICBjb25zdCBwb3N0ZXIgPSB2aWRlby5nZXRBdHRyaWJ1dGUoJ3Bvc3RlcicpO1xuICAgIGNvbnN0IHBsYXllciA9IHZpZGVvLmNsb3Nlc3QoU0VMLnZpZGVvUGxheWVyKTtcbiAgICBjb25zdCBnaWYgPSAhIXBvc3Rlcj8uaW5jbHVkZXMoJ3R3ZWV0X3ZpZGVvX3RodW1iJykgfHwgKCEhcGxheWVyICYmIGxlYWZUZXh0cyhwbGF5ZXIpLmluY2x1ZGVzKCdHSUYnKSk7XG4gICAgYWRkKGdpZiA/ICdnaWZfcG9zdGVyJyA6ICd2aWRlb19wb3N0ZXInLCBwb3N0ZXIpO1xuICB9XG4gIGNvbnN0IGNhcmQgPSBvdXRzaWRlKHNjb3BlLCBTRUwuY2FyZCwgZXhjbHVkZSk7XG4gIGNvbnN0IGNhcmRJbWcgPSBjYXJkICYmIEFycmF5LmZyb20oY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCdpbWcnKSkuZmluZCgoaW1nKSA9PiBpc1BicyhpbWcuZ2V0QXR0cmlidXRlKCdzcmMnKSA/PyAnJykpO1xuICBpZiAoY2FyZEltZykgYWRkKCdjYXJkX2ltYWdlJywgY2FyZEltZy5nZXRBdHRyaWJ1dGUoJ3NyYycpKTtcbn1cblxuZnVuY3Rpb24gY2FyZE9mKHdyYXBwZXI6IEVsZW1lbnQgfCBudWxsKTogTGlua0NhcmQgfCB1bmRlZmluZWQge1xuICBpZiAoIXdyYXBwZXIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGxldCBkb21haW46IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3Qgb3RoZXJzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHQgb2YgbGVhZlRleHRzKHdyYXBwZXIpKSB7XG4gICAgaWYgKCFkb21haW4gJiYgRE9NQUlOX1RFWFQudGVzdCh0KSkgZG9tYWluID0gdC5yZXBsYWNlKC9eRnJvbVxccysvaSwgJycpO1xuICAgIGVsc2Ugb3RoZXJzLnB1c2godCk7XG4gIH1cbiAgY29uc3QgY2FyZDogTGlua0NhcmQgPSB7fTtcbiAgaWYgKGRvbWFpbikgY2FyZC5kb21haW4gPSBkb21haW47XG4gIGlmIChvdGhlcnNbMF0pIGNhcmQudGl0bGUgPSBvdGhlcnNbMF07XG4gIGlmIChvdGhlcnNbMV0pIGNhcmQuZGVzY3JpcHRpb24gPSBvdGhlcnNbMV07XG4gIHJldHVybiBPYmplY3Qua2V5cyhjYXJkKS5sZW5ndGggPyBjYXJkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBxdW90ZWRPZihxdW90ZTogRWxlbWVudCk6IFF1b3RlZFBvc3Qge1xuICBjb25zdCB7IGhhbmRsZSwgbmFtZSB9ID0gYXV0aG9yT2YocXVvdGUucXVlcnlTZWxlY3RvcihTRUwudXNlck5hbWUpKTtcbiAgY29uc3QgcXVvdGVkOiBRdW90ZWRQb3N0ID0ge1xuICAgIGF1dGhvckhhbmRsZTogaGFuZGxlLFxuICAgIGF1dGhvck5hbWU6IG5hbWUsXG4gICAgdGV4dDogZXh0cmFjdFRleHQocXVvdGUucXVlcnlTZWxlY3RvcihTRUwudHdlZXRUZXh0KSksXG4gICAgdHJ1bmNhdGVkOiAhIXF1b3RlLnF1ZXJ5U2VsZWN0b3IoU0VMLnNob3dNb3JlKSxcbiAgfTtcbiAgY29uc3QgbGluayA9IHBlcm1hbGlua09mKHF1b3RlLCBudWxsKSA/PyBxdW90ZS5xdWVyeVNlbGVjdG9yKCdhW2hyZWYqPVwiL3N0YXR1cy9cIl0nKTtcbiAgY29uc3QgcG9zdElkID0gbGluayAmJiBzdGF0dXNJZE9mKGxpbmspO1xuICBpZiAocG9zdElkKSBxdW90ZWQucG9zdElkID0gcG9zdElkO1xuICByZXR1cm4gcXVvdGVkO1xufVxuXG5mdW5jdGlvbiBpc1Byb21vdGVkKGFydGljbGU6IEVsZW1lbnQpOiBib29sZWFuIHtcbiAgaWYgKGNlbGxPZihhcnRpY2xlKT8ucXVlcnlTZWxlY3RvcihTRUwucGxhY2VtZW50KSkgcmV0dXJuIHRydWU7XG4gIC8vIEFuIFwiQWRcIi9cIlByb21vdGVkXCIgbGFiZWwgaXMgYSBsZWFmIHNwYW47IHBvc3QgdGV4dCB0aGF0IGhhcHBlbnMgdG8gc2F5IFwiQWRcIiBpcyBub3QgYSBsYWJlbC5cbiAgcmV0dXJuIEFycmF5LmZyb20oYXJ0aWNsZS5xdWVyeVNlbGVjdG9yQWxsKCdzcGFuJykpLnNvbWUoXG4gICAgKHNwYW4pID0+XG4gICAgICBzcGFuLmNoaWxkRWxlbWVudENvdW50ID09PSAwICYmXG4gICAgICAvXihBZHxQcm9tb3RlZCkkLy50ZXN0KChzcGFuLnRleHRDb250ZW50ID8/ICcnKS50cmltKCkpICYmXG4gICAgICAhc3Bhbi5jbG9zZXN0KFNFTC50d2VldFRleHQpLFxuICApO1xufVxuXG4vKiogVGhlIHBvc3QgYXMgb25lIHVuaXQgKG91dGVyIHBvc3QgKyBxdW90ZWQgcG9zdCArIGNhcmQgKyBtZWRpYSksIG9yIG51bGwgd2hlbiBubyBwZXJtYWxpbmsvcG9zdElkIGlzIGZvdW5kLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNuYXBzaG90QXJ0aWNsZShhcnRpY2xlOiBFbGVtZW50KTogUG9zdFNuYXBzaG90IHwgbnVsbCB7XG4gIGNvbnN0IHF1b3RlID0gcXVvdGVPZihhcnRpY2xlKTtcbiAgY29uc3QgbGluayA9IHBlcm1hbGlua09mKGFydGljbGUsIHF1b3RlKTtcbiAgY29uc3QgcG9zdElkID0gbGluayAmJiBzdGF0dXNJZE9mKGxpbmspO1xuICBpZiAoIWxpbmsgfHwgIXBvc3RJZCkgcmV0dXJuIG51bGw7XG5cbiAgbGV0IHBhdGg6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBwYXRoID0gbmV3IFVSTChsaW5rLmdldEF0dHJpYnV0ZSgnaHJlZicpID8/ICcnLCBYX09SSUdJTikucGF0aG5hbWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IGhyZWZIYW5kbGUgPSBQRVJNQUxJTktfUEFUSC5leGVjKHBhdGgpPy5bMV07XG4gIGNvbnN0IHVybCA9IGhyZWZIYW5kbGUgPyBgJHtYX09SSUdJTn0vJHtocmVmSGFuZGxlfS9zdGF0dXMvJHtwb3N0SWR9YCA6IGAke1hfT1JJR0lOfS9pL3dlYi9zdGF0dXMvJHtwb3N0SWR9YDtcblxuICBjb25zdCBhdXRob3IgPSBhdXRob3JPZihvdXRzaWRlKGFydGljbGUsIFNFTC51c2VyTmFtZSwgcXVvdGUpKTtcbiAgY29uc3QgdGV4dEVsID0gb3V0c2lkZShhcnRpY2xlLCBTRUwudHdlZXRUZXh0LCBxdW90ZSk7XG4gIGNvbnN0IG1lZGlhOiBNZWRpYVJlZltdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29sbGVjdE1lZGlhKGFydGljbGUsIHF1b3RlLCBmYWxzZSwgbWVkaWEsIHNlZW4pO1xuICBpZiAocXVvdGUpIGNvbGxlY3RNZWRpYShxdW90ZSwgbnVsbCwgdHJ1ZSwgbWVkaWEsIHNlZW4pO1xuXG4gIGNvbnN0IHNuYXA6IFBvc3RTbmFwc2hvdCA9IHtcbiAgICBwb3N0SWQsXG4gICAgdXJsLFxuICAgIGF1dGhvckhhbmRsZTogYXV0aG9yLmhhbmRsZSB8fCAoaHJlZkhhbmRsZSA/IGBAJHtocmVmSGFuZGxlfWAgOiAnJyksXG4gICAgYXV0aG9yTmFtZTogYXV0aG9yLm5hbWUsXG4gICAgdGV4dDogZXh0cmFjdFRleHQodGV4dEVsKSxcbiAgICB0cnVuY2F0ZWQ6ICEhb3V0c2lkZShhcnRpY2xlLCBTRUwuc2hvd01vcmUsIHF1b3RlKSxcbiAgICBwcm9tb3RlZDogaXNQcm9tb3RlZChhcnRpY2xlKSxcbiAgICBtZWRpYSxcbiAgfTtcbiAgY29uc3QgbGFuZyA9IHRleHRFbD8uZ2V0QXR0cmlidXRlKCdsYW5nJyk7XG4gIGlmIChsYW5nKSBzbmFwLmxhbmcgPSBsYW5nO1xuICBjb25zdCBzb2NpYWwgPSBvdXRzaWRlKGFydGljbGUsIFNFTC5zb2NpYWxDb250ZXh0LCBxdW90ZSk7XG4gIGNvbnN0IHJlcG9zdGVkQnkgPSAvXiguKj8pXFxzK3JlcG9zdGVkJC9pLmV4ZWMoZXh0cmFjdFRleHQoc29jaWFsKSk/LlsxXS50cmltKCk7XG4gIGlmIChyZXBvc3RlZEJ5KSBzbmFwLnJlcG9zdGVkQnkgPSByZXBvc3RlZEJ5O1xuICBjb25zdCBjYXJkID0gY2FyZE9mKG91dHNpZGUoYXJ0aWNsZSwgU0VMLmNhcmQsIHF1b3RlKSk7XG4gIGlmIChjYXJkKSBzbmFwLmNhcmQgPSBjYXJkO1xuICBpZiAocXVvdGUpIHNuYXAucXVvdGVkID0gcXVvdGVkT2YocXVvdGUpO1xuICByZXR1cm4gc25hcDtcbn1cblxuZXhwb3J0IHR5cGUgRXhlbXB0UmVhc29uID0gJ3BhZ2UnIHwgJ291dHNpZGUnIHwgJ293bicgfCAnZm9jYWwnIHwgJ2FuY2VzdG9yJyB8ICduby1mb2NhbCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXhlbXB0Q29udGV4dCB7XG4gIHBhZ2U6IFBhZ2VJbmZvO1xuICBvd25IYW5kbGU6IHN0cmluZyB8IG51bGw7XG4gIHJvb3Q6IEVsZW1lbnQgfCBudWxsO1xufVxuXG4vKiogV2h5IHRoaXMgYXJ0aWNsZSBtdXN0IG5ldmVyIGJlIGNsYXNzaWZpZWQgb3IgaGlkZGVuLCBvciBudWxsIHdoZW4gaXQgaXMgZmFpciBnYW1lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4ZW1wdFJlYXNvbihhcnRpY2xlOiBFbGVtZW50LCBzbmFwOiBQb3N0U25hcHNob3QgfCBudWxsLCBjdHg6IEV4ZW1wdENvbnRleHQpOiBFeGVtcHRSZWFzb24gfCBudWxsIHtcbiAgaWYgKCFzaG91bGRGaWx0ZXIoY3R4LnBhZ2Uua2luZCkpIHJldHVybiAncGFnZSc7XG4gIGlmICghY3R4LnJvb3QgfHwgIWN0eC5yb290LmNvbnRhaW5zKGFydGljbGUpKSByZXR1cm4gJ291dHNpZGUnO1xuICBpZiAoc25hcCAmJiBjdHgub3duSGFuZGxlICYmIHNuYXAuYXV0aG9ySGFuZGxlLnRvTG93ZXJDYXNlKCkgPT09IGN0eC5vd25IYW5kbGUudG9Mb3dlckNhc2UoKSkgcmV0dXJuICdvd24nO1xuICBpZiAoY3R4LnBhZ2Uua2luZCA9PT0gJ3N0YXR1cycpIHtcbiAgICBjb25zdCBmb2NhbElkID0gY3R4LnBhZ2UuZm9jYWxJZDtcbiAgICBjb25zdCBmb2NhbCA9IGZvY2FsSWQgPyBmaW5kQXJ0aWNsZXMoY3R4LnJvb3QpLmZpbmQoKGEpID0+IHBvc3RJZE9mKGEpID09PSBmb2NhbElkKSA6IHVuZGVmaW5lZDtcbiAgICBpZiAoIWZvY2FsKSByZXR1cm4gJ25vLWZvY2FsJztcbiAgICBpZiAoYXJ0aWNsZSA9PT0gZm9jYWwpIHJldHVybiAnZm9jYWwnO1xuICAgIGlmIChhcnRpY2xlLmNvbXBhcmVEb2N1bWVudFBvc2l0aW9uKGZvY2FsKSAmIE5vZGUuRE9DVU1FTlRfUE9TSVRJT05fRk9MTE9XSU5HKSByZXR1cm4gJ2FuY2VzdG9yJztcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvLyBDb250ZW50IHNjcmlwdCBvcmNoZXN0cmF0aW9uIChzcGVjIFx1MDBBNzQuMSBtYWluLnRzKTogc2NhbiBcdTIxOTIgc2VuZCBcdTIxOTIgcmVzdWx0IFx1MjE5MiBkZWNpZGUgXHUyMTkyIGhpZGUgLyBkZXYgcGFuZWwuXG4vLyBGYWlsIG9wZW46IG5vdGhpbmcgaXMgaGlkZGVuIHdpdGhvdXQgYSB2ZXJkaWN0OyBlcnJvcnMsIGRpc2Nvbm5lY3RzIGFuZCBpbmFjdGl2ZSBzZXR0aW5ncyBsZWF2ZSBwb3N0cyB2aXNpYmxlLlxuXG5pbXBvcnQgeyBkZWNpZGUsIHR5cGUgRGVjaXNpb24gfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvZGVjaWRlJztcbmltcG9ydCB7IGhhc2g1Mywgc3RhYmxlU3RyaW5naWZ5IH0gZnJvbSAnLi4vLi4vLi4vc2hhcmVkL2hhc2gnO1xuaW1wb3J0IHtcbiAgUE9SVF9OQU1FLFxuICBTVE9SQUdFX0tFWVMsXG4gIHR5cGUgQ29udGVudFRvU3csXG4gIHR5cGUgRmVlZGJhY2tFbnRyeSxcbiAgdHlwZSBSZXN1bHRNc2csXG59IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9wcm90b2NvbCc7XG5pbXBvcnQgeyBlZmZlY3RpdmVKZXYsIGVmZmVjdGl2ZVN0YWdlLCBtZXJnZVJlc3VsdCwgdHlwZSBQb3N0UmVzdWx0U3RhdGUgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvcmVzdWx0cyc7XG5pbXBvcnQgeyBSVUJSSUNfVkVSU0lPTiwgYnVpbGRKZXZTdGF0ZSB9IGZyb20gJy4uLy4uLy4uL3NoYXJlZC9ydWJyaWMnO1xuaW1wb3J0IHsgZWZmZWN0aXZlU2V0dGluZ3MsIGlzQ2xhc3NpZmljYXRpb25BY3RpdmUgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvc2V0dGluZ3MnO1xuaW1wb3J0IHR5cGUgeyBGbGF2b3IsIFBvc3RTbmFwc2hvdCwgU2V0dGluZ3MgfSBmcm9tICcuLi8uLi8uLi9zaGFyZWQvdHlwZXMnO1xuaW1wb3J0IHsgSElEREVOX0FUVFIsIGhpZGVQb3N0LCB1bmhpZGVBbGwsIHVuaGlkZVBvc3QgfSBmcm9tICcuL2hpZGVyJztcbmltcG9ydCB7IHBhZ2VJbmZvLCBzaG91bGRGaWx0ZXIsIHR5cGUgUGFnZUluZm8gfSBmcm9tICcuL3BhZ2UnO1xuaW1wb3J0IHsgUEFORUxfQVRUUiwgcmVtb3ZlQWxsUGFuZWxzLCByZW1vdmVQYW5lbCwgcmVuZGVyUGFuZWwgfSBmcm9tICcuL3BhbmVsJztcbmltcG9ydCB7IGV4ZW1wdFJlYXNvbiwgc25hcHNob3RBcnRpY2xlLCB0eXBlIEV4ZW1wdENvbnRleHQsIHR5cGUgRXhlbXB0UmVhc29uIH0gZnJvbSAnLi9zY2FubmVyJztcbmltcG9ydCB7IFNFTCwgY2hlY2tIZWFsdGgsIGZpbmRBcnRpY2xlcywgb3duSGFuZGxlT2YsIHBvc3RJZE9mLCBzY2FuUm9vdCB9IGZyb20gJy4vc2VsZWN0b3JzJztcblxuZXhwb3J0IGNvbnN0IEVYRU1QVF9BVFRSID0gJ2RhdGEtbGMtZXhlbXB0JztcbmV4cG9ydCBjb25zdCBTQ0FOX0RFQk9VTkNFX01TID0gMTAwO1xuZXhwb3J0IGNvbnN0IFVSTF9QT0xMX01TID0gNTAwO1xuZXhwb3J0IGNvbnN0IFJFQ09OTkVDVF9CQVNFX01TID0gMTAwMDtcbmV4cG9ydCBjb25zdCBSRUNPTk5FQ1RfTUFYX01TID0gMzBfMDAwO1xuLyoqIE9uLWRlbWFuZCByZWNvbm5lY3RzIChhIG1lc3NhZ2UgdG8gc2VuZCB3aGlsZSB0aGUgcG9ydCBpcyBkb3duKSBhcmUgYXQgbW9zdCB0aGlzIGZyZXF1ZW50LiAqL1xuZXhwb3J0IGNvbnN0IENPTk5FQ1RfTUlOX0lOVEVSVkFMX01TID0gMTAwMDtcbi8qKiBBIHBvc3Qgd2hvc2UgcmVzdWx0IGlzIGFuIGVycm9yIHdpdGhvdXQgYW5zd2VycyBpcyByZS1zZW50IG9uIGEgbGF0ZXIgc2NhbiBhZnRlciB0aGlzIGxvbmcuICovXG5leHBvcnQgY29uc3QgRVJST1JfUkVUUllfTVMgPSAzMF8wMDA7XG4vKiogTm9uLXBvc3QgbWVzc2FnZXMga2VwdCB3aGlsZSB0aGUgcG9ydCBpcyBkb3duOyBwb3N0cyBhcmUgcmUtc2VudCBmcm9tIGBzZW50YCBpbnN0ZWFkLiAqL1xuY29uc3QgT1VUQk9YX01BWCA9IDIwMDtcblxuZXhwb3J0IGludGVyZmFjZSBDb250ZW50UG9ydCB7XG4gIHBvc3RNZXNzYWdlKG06IENvbnRlbnRUb1N3KTogdm9pZDtcbiAgZGlzY29ubmVjdCgpOiB2b2lkO1xuICBvbk1lc3NhZ2U6IHsgYWRkTGlzdGVuZXIoY2I6IChtOiBSZXN1bHRNc2cpID0+IHZvaWQpOiB2b2lkIH07XG4gIG9uRGlzY29ubmVjdDogeyBhZGRMaXN0ZW5lcihjYjogKCkgPT4gdm9pZCk6IHZvaWQgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb250ZW50RGVwcyB7XG4gIGRvYzogRG9jdW1lbnQ7XG4gIHdpbjogV2luZG93O1xuICBmbGF2b3I6IEZsYXZvcjtcbiAgY29ubmVjdDogKCkgPT4gQ29udGVudFBvcnQ7XG4gIC8qKiBSYXcgc3RvcmVkIHNldHRpbmdzLiAqL1xuICBsb2FkU2V0dGluZ3M6ICgpID0+IFByb21pc2U8dW5rbm93bj47XG4gIG9uU2V0dGluZ3NDaGFuZ2VkOiAoY2I6IChyYXc6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIC8qKiBDYWxscyBgY2JgIG9uY2Ugd2hlbiBgZWxgIGNvbWVzIHdpdGhpbiAyLDAwMCBweCBvZiB0aGUgdmlld3BvcnQ7IHJldHVybnMgYSBjYW5jZWwgZnVuY3Rpb24uICovXG4gIG9ic2VydmVOZWFyOiAoZWw6IEVsZW1lbnQsIGNiOiAoKSA9PiB2b2lkKSA9PiAoKSA9PiB2b2lkO1xuICBub3c6ICgpID0+IG51bWJlcjtcbiAgc2V0VGltZXI6IChmbjogKCkgPT4gdm9pZCwgbXM6IG51bWJlcikgPT4gdW5rbm93bjtcbiAgY2xlYXJUaW1lcjogKGg6IHVua25vd24pID0+IHZvaWQ7XG4gIGxvY2F0aW9uSHJlZjogKCkgPT4gc3RyaW5nO1xuICAvKiogRmFsc2Ugb25jZSB0aGUgZXh0ZW5zaW9uIHdhcyByZWxvYWRlZC9yZW1vdmVkIHVuZGVyIHRoaXMgc2NyaXB0IChkZWZhdWx0OiBhbHdheXMgdmFsaWQpLiAqL1xuICBjb250ZXh0VmFsaWQ/OiAoKSA9PiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgU2VudFBvc3Qge1xuICBzbmFwSGFzaDogc3RyaW5nO1xuICBzbmFwc2hvdDogUG9zdFNuYXBzaG90O1xuICBhdDogbnVtYmVyO1xufVxuXG50eXBlIFNjYW5Db250ZXh0ID0gRXhlbXB0Q29udGV4dCAmIHsgcm9vdDogRWxlbWVudCB9O1xuXG5leHBvcnQgY2xhc3MgQ29udGVudENvbnRyb2xsZXIge1xuICBwcml2YXRlIHNldHRpbmdzOiBTZXR0aW5ncztcbiAgcHJpdmF0ZSByZWFkb25seSByZXN1bHRzID0gbmV3IE1hcDxzdHJpbmcsIFBvc3RSZXN1bHRTdGF0ZT4oKTtcbiAgLyoqIFRoZSBsYXN0IHNuYXBzaG90IHNlbnQgcGVyIHBvc3Q7IHJlc3VsdHMgZm9yIGFueSBvdGhlciBzbmFwSGFzaCBhcmUgZHJvcHBlZC4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSBzZW50ID0gbmV3IE1hcDxzdHJpbmcsIFNlbnRQb3N0PigpO1xuICAvKiogVGhlIHNuYXBzaG90IGVhY2ggc3RvcmVkIHJlc3VsdCB3YXMgY29tcHV0ZWQgZnJvbSAoZmVlZGJhY2sgcmVjb3JkcyBpdHMgZXhhY3QgSmV2IHN0YXRlKS4gKi9cbiAgcHJpdmF0ZSByZWFkb25seSByZXN1bHRTbmFwcyA9IG5ldyBNYXA8c3RyaW5nLCBQb3N0U25hcHNob3Q+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgaGlkZGVuUmVwb3J0ZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgcHJpdmF0ZSByZWFkb25seSBzYXZlZCA9IG5ldyBNYXA8c3RyaW5nLCAnaGlkZScgfCAna2VlcCc+KCk7XG4gIC8qKiBBcnRpY2xlcyB3aXRoIGFuIGFjdGl2ZSBvYnNlcnZlTmVhciwgYW5kIGl0cyBjYW5jZWwgZnVuY3Rpb24uICovXG4gIHByaXZhdGUgcmVhZG9ubHkgd2F0Y2hpbmcgPSBuZXcgTWFwPEVsZW1lbnQsICgpID0+IHZvaWQ+KCk7XG4gIC8qKiBTdGF0dXMgcGFnZXM6IGZvY2FsIGlkIFx1MjE5MiBpZHMgb2YgdGhlIGZvY2FsIHBvc3QgYW5kIGl0cyBhbmNlc3RvcnMsIHNlZW4gd2hpbGUgdGhlIGZvY2FsIHdhcyBpbiB0aGUgRE9NLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHRocmVhZEV4ZW1wdCA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuICBwcml2YXRlIHBvcnQ6IENvbnRlbnRQb3J0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgb3V0Ym94OiBDb250ZW50VG9Td1tdID0gW107XG4gIHByaXZhdGUgcmVjb25uZWN0QXR0ZW1wdCA9IDA7XG4gIHByaXZhdGUgcmVjb25uZWN0VGltZXI6IHVua25vd24gPSB1bmRlZmluZWQ7XG4gIHByaXZhdGUgbGFzdENvbm5lY3RBdCA9IC1JbmZpbml0eTtcbiAgcHJpdmF0ZSBzY2FuVGltZXI6IHVua25vd24gPSB1bmRlZmluZWQ7XG4gIHByaXZhdGUgcG9sbFRpbWVyOiB1bmtub3duID0gdW5kZWZpbmVkO1xuICBwcml2YXRlIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgbGFzdEhyZWYgPSAnJztcbiAgcHJpdmF0ZSBsYXN0SGVhbHRoT2s6IGJvb2xlYW4gfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgc3RvcHBlZCA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgZGVwczogQ29udGVudERlcHMpIHtcbiAgICB0aGlzLnNldHRpbmdzID0gZWZmZWN0aXZlU2V0dGluZ3ModW5kZWZpbmVkLCBkZXBzLmZsYXZvcik7XG4gIH1cblxuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsZXQgcmF3OiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICByYXcgPSBhd2FpdCB0aGlzLmRlcHMubG9hZFNldHRpbmdzKCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByYXcgPSB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGlmICh0aGlzLnN0b3BwZWQpIHJldHVybjtcbiAgICB0aGlzLnNldHRpbmdzID0gZWZmZWN0aXZlU2V0dGluZ3MocmF3LCB0aGlzLmRlcHMuZmxhdm9yKTtcbiAgICB0aGlzLmRlcHMub25TZXR0aW5nc0NoYW5nZWQoKHIpID0+IHtcbiAgICAgIGlmICghdGhpcy5zdG9wcGVkKSB0aGlzLmFwcGx5U2V0dGluZ3Mocik7XG4gICAgfSk7XG4gICAgdGhpcy5jb25uZWN0KCk7XG5cbiAgICB0aGlzLm9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKHJlY29yZHMpID0+IHtcbiAgICAgIGlmIChyZWNvcmRzLnNvbWUoKHIpID0+ICFpc093bk11dGF0aW9uKHIpKSkgdGhpcy5zY2hlZHVsZVNjYW4oKTtcbiAgICB9KTtcbiAgICB0aGlzLm9ic2VydmVyLm9ic2VydmUodGhpcy5kZXBzLmRvYy5ib2R5LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSwgY2hhcmFjdGVyRGF0YTogdHJ1ZSB9KTtcbiAgICB0aGlzLmRlcHMud2luLmFkZEV2ZW50TGlzdGVuZXIoJ3BvcHN0YXRlJywgdGhpcy5vblBvcFN0YXRlKTtcbiAgICB0aGlzLmxhc3RIcmVmID0gdGhpcy5kZXBzLmxvY2F0aW9uSHJlZigpO1xuICAgIHRoaXMucG9sbFRpbWVyID0gdGhpcy5kZXBzLnNldFRpbWVyKHRoaXMucG9sbCwgVVJMX1BPTExfTVMpO1xuICAgIHRoaXMuc2NhbigpO1xuICB9XG5cbiAgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLnN0b3BwZWQgPSB0cnVlO1xuICAgIHRoaXMub2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcbiAgICB0aGlzLm9ic2VydmVyID0gbnVsbDtcbiAgICB0aGlzLmRlcHMud2luLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvcHN0YXRlJywgdGhpcy5vblBvcFN0YXRlKTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3RoaXMuc2NhblRpbWVyLCB0aGlzLnBvbGxUaW1lciwgdGhpcy5yZWNvbm5lY3RUaW1lcl0pIHtcbiAgICAgIGlmICh0ICE9PSB1bmRlZmluZWQpIHRoaXMuZGVwcy5jbGVhclRpbWVyKHQpO1xuICAgIH1cbiAgICB0aGlzLnNjYW5UaW1lciA9IHRoaXMucG9sbFRpbWVyID0gdGhpcy5yZWNvbm5lY3RUaW1lciA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLnVud2F0Y2hBbGwoKTtcbiAgICBjb25zdCBwb3J0ID0gdGhpcy5wb3J0O1xuICAgIHRoaXMucG9ydCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIHBvcnQ/LmRpc2Nvbm5lY3QoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEFscmVhZHkgZ29uZS5cbiAgICB9XG4gIH1cblxuICBzY2FuKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwZWQpIHJldHVybjtcbiAgICBjb25zdCBjdHggPSB0aGlzLmNvbnRleHQoKTtcbiAgICBpZiAoIWN0eCkge1xuICAgICAgdGhpcy5jbGVhckFsbCgpO1xuICAgICAgLy8gcHJpbWFyeUNvbHVtbiBpdHNlbGYgaXMgbWlzc2luZyBvbiBhIGZpbHRlcmVkIHBhZ2U6IHNlbGVjdG9yIGRyaWZ0IChzcGVjIFx1MDBBNzcpLiBQb3N0cyBzdGF5IHZpc2libGUuXG4gICAgICBpZiAodGhpcy5maWx0ZXJlZFBhZ2UoKSkge1xuICAgICAgICB0aGlzLnJlcG9ydEhlYWx0aCh7IG9rOiBmYWxzZSwgY2VsbHM6IHRoaXMuZGVwcy5kb2MucXVlcnlTZWxlY3RvckFsbChTRUwuY2VsbCkubGVuZ3RoLCBhcnRpY2xlczogMCwgcGFyc2VkOiAwIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnJlY29uY2lsZShjdHgpO1xuICAgIHRoaXMucHJ1bmVXYXRjaGluZygpO1xuXG4gICAgZm9yIChjb25zdCBhcnRpY2xlIG9mIGZpbmRBcnRpY2xlcyhjdHgucm9vdCkpIHtcbiAgICAgIC8vIEFuIG9ycGhhbiBzdG9wKCkgKHZpYSBwb3N0IFx1MjE5MiByZWNvbm5lY3QpIG1heSBydW4gbWlkLXNjYW46IG5vdGhpbmcgbWF5IHRvdWNoIHRoZSBwYWdlIGFmdGVyIGl0LlxuICAgICAgaWYgKHRoaXMuc3RvcHBlZCkgcmV0dXJuO1xuICAgICAgY29uc3Qgc25hcCA9IHNuYXBzaG90QXJ0aWNsZShhcnRpY2xlKTtcbiAgICAgIGlmICghc25hcCkgY29udGludWU7XG4gICAgICBjb25zdCByZWFzb24gPSB0aGlzLmV4ZW1wdChhcnRpY2xlLCBzbmFwLCBjdHgpO1xuICAgICAgaWYgKHJlYXNvbikge1xuICAgICAgICBhcnRpY2xlLnNldEF0dHJpYnV0ZShFWEVNUFRfQVRUUiwgcmVhc29uKTtcbiAgICAgICAgcmVtb3ZlUGFuZWwoYXJ0aWNsZSk7XG4gICAgICAgIHVuaGlkZVBvc3QoYXJ0aWNsZSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYXJ0aWNsZS5yZW1vdmVBdHRyaWJ1dGUoRVhFTVBUX0FUVFIpO1xuICAgICAgdGhpcy5yZXRyeUlmRXJyb3JlZChzbmFwLnBvc3RJZCwgYXJ0aWNsZSk7XG5cbiAgICAgIGNvbnN0IGggPSBoYXNoNTMoc3RhYmxlU3RyaW5naWZ5KHNuYXApKTtcbiAgICAgIGlmICh0aGlzLnNlbnQuZ2V0KHNuYXAucG9zdElkKT8uc25hcEhhc2ggIT09IGggJiYgIXRoaXMud2F0Y2hpbmcuaGFzKGFydGljbGUpKSB7XG4gICAgICAgIGxldCBmaXJlZCA9IGZhbHNlO1xuICAgICAgICBjb25zdCBjYW5jZWwgPSB0aGlzLmRlcHMub2JzZXJ2ZU5lYXIoYXJ0aWNsZSwgKCkgPT4ge1xuICAgICAgICAgIGZpcmVkID0gdHJ1ZTtcbiAgICAgICAgICB0aGlzLndhdGNoaW5nLmRlbGV0ZShhcnRpY2xlKTtcbiAgICAgICAgICB0aGlzLnNlbmQoc25hcCwgaCk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIWZpcmVkKSB0aGlzLndhdGNoaW5nLnNldChhcnRpY2xlLCBjYW5jZWwpO1xuICAgICAgfVxuICAgICAgdGhpcy5hcHBseShhcnRpY2xlLCBzbmFwLnBvc3RJZCwgY3R4KTtcbiAgICB9XG4gICAgaWYgKHRoaXMuc3RvcHBlZCkgcmV0dXJuO1xuICAgIHRoaXMucmVwb3J0SGVhbHRoKGNoZWNrSGVhbHRoKGN0eC5yb290KSk7XG4gIH1cblxuICBoYW5kbGVSZXN1bHQobXNnOiBSZXN1bHRNc2cpOiB2b2lkIHtcbiAgICBjb25zdCBlbnRyeSA9IHRoaXMuc2VudC5nZXQobXNnLnBvc3RJZCk7XG4gICAgaWYgKCFlbnRyeSB8fCBtc2cuc25hcEhhc2ggIT09IGVudHJ5LnNuYXBIYXNoKSByZXR1cm47XG4gICAgdGhpcy5yZXN1bHRzLnNldChtc2cucG9zdElkLCBtZXJnZVJlc3VsdCh0aGlzLnJlc3VsdHMuZ2V0KG1zZy5wb3N0SWQpLCBtc2cpKTtcbiAgICB0aGlzLnJlc3VsdFNuYXBzLnNldChtc2cucG9zdElkLCBlbnRyeS5zbmFwc2hvdCk7XG4gICAgdGhpcy5hcHBseVBvc3QobXNnLnBvc3RJZCk7XG4gIH1cblxuICBhcHBseVNldHRpbmdzKHJhdzogdW5rbm93bik6IHZvaWQge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBlZmZlY3RpdmVTZXR0aW5ncyhyYXcsIHRoaXMuZGVwcy5mbGF2b3IpO1xuICAgIHRoaXMuc2NhbigpO1xuICB9XG5cbiAgLy8gLS0tLSBTY2FubmluZyAtLS0tXG5cbiAgLyoqIFRoaXMgcGFnZSB3aGVuIGl0IGlzIGZpbHRlcmVkIGFuZCBjbGFzc2lmaWNhdGlvbiBpcyBvbjsgbnVsbCBvdGhlcndpc2UuICovXG4gIHByaXZhdGUgZmlsdGVyZWRQYWdlKCk6IFBhZ2VJbmZvIHwgbnVsbCB7XG4gICAgY29uc3QgcGFnZSA9IHBhZ2VJbmZvKHRoaXMuZGVwcy5sb2NhdGlvbkhyZWYoKSk7XG4gICAgLy8gRE1zIGFyZSBuZXZlciB0b3VjaGVkIGJleW9uZCBjbGVhcmluZyBvdXIgb3duIG1hcmtzLlxuICAgIGlmIChwYWdlLmtpbmQgPT09ICdtZXNzYWdlcycpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBzaG91bGRGaWx0ZXIocGFnZS5raW5kKSAmJiBpc0NsYXNzaWZpY2F0aW9uQWN0aXZlKHRoaXMuc2V0dGluZ3MpID8gcGFnZSA6IG51bGw7XG4gIH1cblxuICAvKiogVGhlIHNjYW4gY29udGV4dCB3aGVuIHRoaXMgcGFnZSBpcyBmaWx0ZXJlZCwgY2xhc3NpZmljYXRpb24gaXMgb24gYW5kIHRoZSBzY2FuIHJvb3QgZXhpc3RzLiAqL1xuICBwcml2YXRlIGNvbnRleHQoKTogU2NhbkNvbnRleHQgfCBudWxsIHtcbiAgICBjb25zdCB7IGRvYyB9ID0gdGhpcy5kZXBzO1xuICAgIGNvbnN0IHBhZ2UgPSB0aGlzLmZpbHRlcmVkUGFnZSgpO1xuICAgIGNvbnN0IHJvb3QgPSBwYWdlICYmIHNjYW5Sb290KGRvYyk7XG4gICAgcmV0dXJuIHBhZ2UgJiYgcm9vdCA/IHsgcGFnZSwgb3duSGFuZGxlOiBvd25IYW5kbGVPZihkb2MpLCByb290IH0gOiBudWxsO1xuICB9XG5cbiAgLyoqXG4gICAqIGV4ZW1wdFJlYXNvbiwgcGx1cyBtZW1vcnkgZm9yIHN0YXR1cyB0aHJlYWRzOiB3aGlsZSB0aGUgZm9jYWwgcG9zdCBpcyBpbiB0aGUgRE9NLCB0aGUgaWRzIG9mIHRoZVxuICAgKiBmb2NhbCBwb3N0IGFuZCBpdHMgYW5jZXN0b3JzIGFyZSByZW1lbWJlcmVkIHBlciBmb2NhbCBpZC4gT25jZSBYJ3MgdmlydHVhbCBsaXN0IGRyb3BzIHRoZSBmb2NhbFxuICAgKiBhcnRpY2xlLCBvbmx5IHRob3NlIGlkcyBzdGF5IGV4ZW1wdCBhbmQgZXZlcnkgb3RoZXIgYXJ0aWNsZSBpcyBhIHJlcGx5LCBmaWx0ZXJlZCBhcyB1c3VhbC5cbiAgICogJ25vLWZvY2FsJyAoZXZlcnl0aGluZyBleGVtcHQpIHJlbWFpbnMgb25seSB3aGVuIHRoaXMgcGFnZSdzIGZvY2FsIHBvc3Qgd2FzIG5ldmVyIHNlZW4uXG4gICAqL1xuICBwcml2YXRlIGV4ZW1wdChhcnRpY2xlOiBFbGVtZW50LCBzbmFwOiBQb3N0U25hcHNob3QgfCBudWxsLCBjdHg6IFNjYW5Db250ZXh0KTogRXhlbXB0UmVhc29uIHwgbnVsbCB7XG4gICAgY29uc3QgcmVhc29uID0gZXhlbXB0UmVhc29uKGFydGljbGUsIHNuYXAsIGN0eCk7XG4gICAgY29uc3QgZm9jYWxJZCA9IGN0eC5wYWdlLmtpbmQgPT09ICdzdGF0dXMnID8gY3R4LnBhZ2UuZm9jYWxJZCA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBwb3N0SWQgPSBzbmFwPy5wb3N0SWQgPz8gcG9zdElkT2YoYXJ0aWNsZSk7XG4gICAgaWYgKCFmb2NhbElkIHx8ICFwb3N0SWQpIHJldHVybiByZWFzb247XG4gICAgbGV0IHRocmVhZCA9IHRoaXMudGhyZWFkRXhlbXB0LmdldChmb2NhbElkKTtcbiAgICBpZiAocmVhc29uID09PSAnZm9jYWwnIHx8IHJlYXNvbiA9PT0gJ2FuY2VzdG9yJykge1xuICAgICAgaWYgKCF0aHJlYWQpIHRoaXMudGhyZWFkRXhlbXB0LnNldChmb2NhbElkLCAodGhyZWFkID0gbmV3IFNldCgpKSk7XG4gICAgICB0aHJlYWQuYWRkKHBvc3RJZCk7XG4gICAgICByZXR1cm4gcmVhc29uO1xuICAgIH1cbiAgICBpZiAocmVhc29uICE9PSAnbm8tZm9jYWwnIHx8ICF0aHJlYWQpIHJldHVybiByZWFzb247XG4gICAgaWYgKCF0aHJlYWQuaGFzKHBvc3RJZCkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBwb3N0SWQgPT09IGZvY2FsSWQgPyAnZm9jYWwnIDogJ2FuY2VzdG9yJztcbiAgfVxuXG4gIHByaXZhdGUgY2xlYXJBbGwoKTogdm9pZCB7XG4gICAgdGhpcy51bndhdGNoQWxsKCk7XG4gICAgdW5oaWRlQWxsKHRoaXMuZGVwcy5kb2MpO1xuICAgIHJlbW92ZUFsbFBhbmVscyh0aGlzLmRlcHMuZG9jKTtcbiAgfVxuXG4gIC8qKiBVbmhpZGUgZXZlcnkgaGlkZGVuIGNlbGwgd2hvc2UgKHBvc3NpYmx5IHJlY3ljbGVkKSBhcnRpY2xlIGlzIGdvbmUgb3Igbm8gbG9uZ2VyIGRlY2lkZWQgXCJoaWRlXCIuICovXG4gIHByaXZhdGUgcmVjb25jaWxlKGN0eDogU2NhbkNvbnRleHQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20odGhpcy5kZXBzLmRvYy5xdWVyeVNlbGVjdG9yQWxsKGBbJHtISURERU5fQVRUUn1dYCkpKSB7XG4gICAgICBjb25zdCBhcnRpY2xlID0gZWwubWF0Y2hlcyhTRUwuYXJ0aWNsZSkgPyBlbCA6IGZpbmRBcnRpY2xlcyhlbClbMF07XG4gICAgICBjb25zdCBwb3N0SWQgPSBhcnRpY2xlICYmIGN0eC5yb290LmNvbnRhaW5zKGFydGljbGUpID8gcG9zdElkT2YoYXJ0aWNsZSkgOiBudWxsO1xuICAgICAgaWYgKCFwb3N0SWQgfHwgIXRoaXMuc2V0dGluZ3MuaGlkZUVuYWJsZWQgfHwgIXRoaXMuZGVjaXNpb24ocG9zdElkKS5oaWRlKSBlbC5yZW1vdmVBdHRyaWJ1dGUoSElEREVOX0FUVFIpO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZS1zZW5kIGEgcG9zdCB3aG9zZSBsYXN0IHJlc3VsdCB3YXMgYW4gZXJyb3Igd2l0aG91dCBhbnN3ZXJzLCBhdCBtb3N0IG9uY2UgcGVyIEVSUk9SX1JFVFJZX01TLiAqL1xuICBwcml2YXRlIHJldHJ5SWZFcnJvcmVkKHBvc3RJZDogc3RyaW5nLCBhcnRpY2xlOiBFbGVtZW50KTogdm9pZCB7XG4gICAgY29uc3QgZW50cnkgPSB0aGlzLnNlbnQuZ2V0KHBvc3RJZCk7XG4gICAgY29uc3Qgc3QgPSB0aGlzLnJlc3VsdHMuZ2V0KHBvc3RJZCk7XG4gICAgaWYgKCFlbnRyeSB8fCAhc3Q/LmVycm9yIHx8IGVmZmVjdGl2ZUpldihzdCkgfHwgdGhpcy53YXRjaGluZy5oYXMoYXJ0aWNsZSkpIHJldHVybjtcbiAgICBpZiAodGhpcy5kZXBzLm5vdygpIC0gZW50cnkuYXQgPj0gRVJST1JfUkVUUllfTVMpIHRoaXMuZm9yZ2V0KHBvc3RJZCk7XG4gIH1cblxuICAvKiogRHJvcCB0aGUgc2VudCByZWNvcmQgc28gdGhlIG5leHQgc2NhbiBzZW5kcyB0aGUgcG9zdCBhZ2FpbjsgYSBzdGF0ZSB3aXRob3V0IGFuc3dlcnMgaXMgZHJvcHBlZCB0b28uICovXG4gIHByaXZhdGUgZm9yZ2V0KHBvc3RJZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5zZW50LmRlbGV0ZShwb3N0SWQpO1xuICAgIGlmICghZWZmZWN0aXZlSmV2KHRoaXMucmVzdWx0cy5nZXQocG9zdElkKSkpIHtcbiAgICAgIHRoaXMucmVzdWx0cy5kZWxldGUocG9zdElkKTtcbiAgICAgIHRoaXMucmVzdWx0U25hcHMuZGVsZXRlKHBvc3RJZCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIEEgdXNhYmxlIHJlc3VsdCBmb3IgdGhpcyBleGFjdCBzbmFwc2hvdCwgd2l0aCBubyB2aXNpb24gcGFzcyBzdGlsbCBpbiBmbGlnaHQuICovXG4gIHByaXZhdGUgaXNSZXNvbHZlZChwb3N0SWQ6IHN0cmluZywgc25hcEhhc2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHN0ID0gdGhpcy5yZXN1bHRzLmdldChwb3N0SWQpO1xuICAgIHJldHVybiBzdD8uc25hcEhhc2ggPT09IHNuYXBIYXNoICYmICEhZWZmZWN0aXZlSmV2KHN0KSAmJiBzdC52aXNpb24gIT09ICdwZW5kaW5nJztcbiAgfVxuXG4gIHByaXZhdGUgcHJ1bmVXYXRjaGluZygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IFtlbCwgY2FuY2VsXSBvZiB0aGlzLndhdGNoaW5nKSB7XG4gICAgICBpZiAoZWwuaXNDb25uZWN0ZWQpIGNvbnRpbnVlO1xuICAgICAgY2FuY2VsKCk7XG4gICAgICB0aGlzLndhdGNoaW5nLmRlbGV0ZShlbCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSB1bndhdGNoQWxsKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgY2FuY2VsIG9mIHRoaXMud2F0Y2hpbmcudmFsdWVzKCkpIGNhbmNlbCgpO1xuICAgIHRoaXMud2F0Y2hpbmcuY2xlYXIoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2VuZChzbmFwc2hvdDogUG9zdFNuYXBzaG90LCBzbmFwSGFzaDogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBlZCB8fCAhdGhpcy5jb250ZXh0KCkpIHJldHVybjtcbiAgICB0aGlzLnNlbnQuc2V0KHNuYXBzaG90LnBvc3RJZCwgeyBzbmFwSGFzaCwgc25hcHNob3QsIGF0OiB0aGlzLmRlcHMubm93KCkgfSk7XG4gICAgdGhpcy5wb3N0KHsgdHlwZTogJ3Bvc3QnLCBzbmFwc2hvdCwgc25hcEhhc2ggfSk7XG4gIH1cblxuICAvKiogUmVwb3J0IHNlbGVjdG9yIGhlYWx0aCB0byB0aGUgU1cgd2hlbiBpdCBmbGlwcy4gKi9cbiAgcHJpdmF0ZSByZXBvcnRIZWFsdGgoeyBvaywgY2VsbHMsIGFydGljbGVzLCBwYXJzZWQgfTogUmV0dXJuVHlwZTx0eXBlb2YgY2hlY2tIZWFsdGg+KTogdm9pZCB7XG4gICAgaWYgKG9rID09PSB0aGlzLmxhc3RIZWFsdGhPaykgcmV0dXJuO1xuICAgIHRoaXMubGFzdEhlYWx0aE9rID0gb2s7XG4gICAgdGhpcy5wb3N0KHsgdHlwZTogJ2hlYWx0aCcsIG9rLCBjZWxscywgYXJ0aWNsZXMsIHBhcnNlZCB9KTtcbiAgICBpZiAoX19GTEFWT1JfXyA9PT0gJ2RldicgJiYgdGhpcy5kZXBzLmZsYXZvciA9PT0gJ2RldicgJiYgIW9rKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ1tMb3cgQ29ydGlzb2xdIHNlbGVjdG9yIGhlYWx0aCcsIHsgb2ssIGNlbGxzLCBhcnRpY2xlcywgcGFyc2VkIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLS0gQXBwbHlpbmcgdmVyZGljdHMgLS0tLVxuXG4gIHByaXZhdGUgZGVjaXNpb24ocG9zdElkOiBzdHJpbmcpOiBEZWNpc2lvbiB7XG4gICAgcmV0dXJuIGRlY2lkZShlZmZlY3RpdmVKZXYodGhpcy5yZXN1bHRzLmdldChwb3N0SWQpKT8uYW5zd2VycywgdGhpcy5zZXR0aW5ncy50aHJlc2hvbGQpO1xuICB9XG5cbiAgLyoqIFJlLWFwcGx5IGV2ZXJ5IGVsaWdpYmxlIGFydGljbGUgaW4gdGhlIHNjYW4gcm9vdCB0aGF0IHNob3dzIGBwb3N0SWRgLiAqL1xuICBwcml2YXRlIGFwcGx5UG9zdChwb3N0SWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGN0eCA9IHRoaXMuc3RvcHBlZCA/IG51bGwgOiB0aGlzLmNvbnRleHQoKTtcbiAgICBpZiAoIWN0eCkgcmV0dXJuO1xuICAgIGZvciAoY29uc3QgYXJ0aWNsZSBvZiBmaW5kQXJ0aWNsZXMoY3R4LnJvb3QpKSB7XG4gICAgICBpZiAodGhpcy5zdG9wcGVkKSByZXR1cm47XG4gICAgICBpZiAocG9zdElkT2YoYXJ0aWNsZSkgIT09IHBvc3RJZCkgY29udGludWU7XG4gICAgICBpZiAodGhpcy5leGVtcHQoYXJ0aWNsZSwgc25hcHNob3RBcnRpY2xlKGFydGljbGUpLCBjdHgpKSBjb250aW51ZTtcbiAgICAgIHRoaXMuYXBwbHkoYXJ0aWNsZSwgcG9zdElkLCBjdHgpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXBwbHkoYXJ0aWNsZTogRWxlbWVudCwgcG9zdElkOiBzdHJpbmcsIGN0eDogU2NhbkNvbnRleHQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGVkKSByZXR1cm47XG4gICAgY29uc3Qgc3QgPSB0aGlzLnJlc3VsdHMuZ2V0KHBvc3RJZCk7XG4gICAgY29uc3QgZCA9IHRoaXMuZGVjaXNpb24ocG9zdElkKTtcbiAgICBpZiAodGhpcy5zZXR0aW5ncy5oaWRlRW5hYmxlZCAmJiBkLmhpZGUpIHtcbiAgICAgIC8vIEhpZGRlbiBwb3N0cyB2YW5pc2ggY29tcGxldGVseTogbmV2ZXIgYSBwYW5lbCBvciBzdHViIChhbnN3ZXIgMTliKS5cbiAgICAgIHJlbW92ZVBhbmVsKGFydGljbGUpO1xuICAgICAgY29uc3QgY2VsbHMgPSAoKSA9PiBBcnJheS5mcm9tKGN0eC5yb290LnF1ZXJ5U2VsZWN0b3JBbGwoU0VMLmNlbGwpKTtcbiAgICAgIGlmIChoaWRlUG9zdChhcnRpY2xlLCB7IHdpbjogdGhpcy5kZXBzLndpbiwgY2VsbHMgfSkgJiYgIXRoaXMuaGlkZGVuUmVwb3J0ZWQuaGFzKHBvc3RJZCkpIHtcbiAgICAgICAgdGhpcy5oaWRkZW5SZXBvcnRlZC5hZGQocG9zdElkKTtcbiAgICAgICAgdGhpcy5wb3N0KHsgdHlwZTogJ2hpZGRlbicsIHBvc3RJZCB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdW5oaWRlUG9zdChhcnRpY2xlKTtcbiAgICBpZiAoX19GTEFWT1JfXyA9PT0gJ2RldicgJiYgdGhpcy5kZXBzLmZsYXZvciA9PT0gJ2RldicgJiYgdGhpcy5zZXR0aW5ncy5zaG93UmVzdWx0cykge1xuICAgICAgcmVuZGVyUGFuZWwoXG4gICAgICAgIGFydGljbGUsXG4gICAgICAgIHsgcG9zdElkLCBzdGF0ZTogc3QsIGRlY2lzaW9uOiBkLCBzZXR0aW5nczogdGhpcy5zZXR0aW5ncywgc2F2ZWQ6IHRoaXMuc2F2ZWQuZ2V0KHBvc3RJZCkgfSxcbiAgICAgICAgKGxhYmVsKSA9PiB0aGlzLmZlZWRiYWNrKHBvc3RJZCwgbGFiZWwpLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVtb3ZlUGFuZWwoYXJ0aWNsZSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBmZWVkYmFjayhwb3N0SWQ6IHN0cmluZywgbGFiZWw6ICdoaWRlJyB8ICdrZWVwJyk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwZWQpIHJldHVybjtcbiAgICBjb25zdCBzdCA9IHRoaXMucmVzdWx0cy5nZXQocG9zdElkKTtcbiAgICBjb25zdCBqZXYgPSBlZmZlY3RpdmVKZXYoc3QpO1xuICAgIGNvbnN0IHN0YWdlID0gZWZmZWN0aXZlU3RhZ2Uoc3QpO1xuICAgIGNvbnN0IHNuYXAgPSB0aGlzLnJlc3VsdFNuYXBzLmdldChwb3N0SWQpO1xuICAgIGlmICghc3QgfHwgIWpldiB8fCAhc3RhZ2UgfHwgIXNuYXApIHJldHVybjtcbiAgICBjb25zdCBlbnRyeTogRmVlZGJhY2tFbnRyeSA9IHtcbiAgICAgIGF0OiBuZXcgRGF0ZSh0aGlzLmRlcHMubm93KCkpLnRvSVNPU3RyaW5nKCksXG4gICAgICBmbGF2b3I6IHRoaXMuZGVwcy5mbGF2b3IsXG4gICAgICBwb3N0SWQsXG4gICAgICB1cmw6IHNuYXAudXJsLFxuICAgICAgbGFiZWwsXG4gICAgICB2ZXJkaWN0OiB0aGlzLmRlY2lzaW9uKHBvc3RJZCkuaGlkZSA/ICdoaWRlJyA6ICdrZWVwJyxcbiAgICAgIHRocmVzaG9sZDogdGhpcy5zZXR0aW5ncy50aHJlc2hvbGQsXG4gICAgICBydWJyaWNWZXJzaW9uOiBSVUJSSUNfVkVSU0lPTixcbiAgICAgIGpldk1vZGVsOiBqZXYubW9kZWwsXG4gICAgICBzdGFnZSxcbiAgICAgIGFuc3dlcnM6IGpldi5hbnN3ZXJzLFxuICAgICAgc3RhdGU6IGJ1aWxkSmV2U3RhdGUoc25hcCwgc3RhZ2UgPT09ICdmdWxsJyA/IHN0LnRyYW5zY3JpcHRzIDogdW5kZWZpbmVkKSxcbiAgICB9O1xuICAgIHRoaXMucG9zdCh7IHR5cGU6ICdmZWVkYmFjaycsIGVudHJ5IH0pO1xuICAgIHRoaXMuc2F2ZWQuc2V0KHBvc3RJZCwgbGFiZWwpO1xuICAgIHRoaXMuYXBwbHlQb3N0KHBvc3RJZCk7XG4gIH1cblxuICAvLyAtLS0tIFBvcnQgLS0tLVxuXG4gIHByaXZhdGUgcG9zdChtOiBDb250ZW50VG9Tdyk6IHZvaWQge1xuICAgIGlmICh0aGlzLnBvcnQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRoaXMucG9ydC5wb3N0TWVzc2FnZShtKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIERpc2Nvbm5lY3RlZCBidXQgb25EaXNjb25uZWN0IG5vdCBkZWxpdmVyZWQgeWV0OiBmYWxsIHRocm91Z2ggYW5kIHF1ZXVlLlxuICAgICAgfVxuICAgIH1cbiAgICAvLyBQb3N0cyBhcmUgcmUtc2VudCBmcm9tIGBzZW50YCBvbiByZWNvbm5lY3QgYW5kIGhlYWx0aCBpcyByZS1yZXBvcnRlZDsgaGlkZGVuL2ZlZWRiYWNrIHdhaXQgaGVyZS5cbiAgICBpZiAoKG0udHlwZSA9PT0gJ2hpZGRlbicgfHwgbS50eXBlID09PSAnZmVlZGJhY2snKSAmJiB0aGlzLm91dGJveC5sZW5ndGggPCBPVVRCT1hfTUFYKSB0aGlzLm91dGJveC5wdXNoKG0pO1xuICAgIHRoaXMucmVjb25uZWN0Tm93KCk7XG4gIH1cblxuICBwcml2YXRlIGNvbm5lY3QoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBlZCkgcmV0dXJuO1xuICAgIHRoaXMubGFzdENvbm5lY3RBdCA9IHRoaXMuZGVwcy5ub3coKTtcbiAgICBsZXQgcG9ydDogQ29udGVudFBvcnQ7XG4gICAgdHJ5IHtcbiAgICAgIHBvcnQgPSB0aGlzLmRlcHMuY29ubmVjdCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVGhlIGV4dGVuc2lvbiB3YXMgcmVsb2FkZWQgb3IgcmVtb3ZlZDogdGhpcyBzY3JpcHQgaXMgb3JwaGFuZWQsIHNvIHN0b3AgYW5kIGxlYXZlIFggYXMgaXQgaXMuXG4gICAgICBpZiAodGhpcy5kZXBzLmNvbnRleHRWYWxpZCAmJiAhdGhpcy5kZXBzLmNvbnRleHRWYWxpZCgpKSB7XG4gICAgICAgIHRoaXMuc3RvcCgpO1xuICAgICAgICB0aGlzLmNsZWFyQWxsKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuc2NoZWR1bGVSZWNvbm5lY3QoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5wb3J0ID0gcG9ydDtcbiAgICBjb25zdCBjb25uZWN0ZWRBdCA9IHRoaXMuZGVwcy5ub3coKTtcbiAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobSkgPT4ge1xuICAgICAgaWYgKHRoaXMucG9ydCAhPT0gcG9ydCB8fCB0aGlzLnN0b3BwZWQpIHJldHVybjtcbiAgICAgIHRoaXMucmVjb25uZWN0QXR0ZW1wdCA9IDA7XG4gICAgICBpZiAobSAmJiBtLnR5cGUgPT09ICdyZXN1bHQnKSB0aGlzLmhhbmRsZVJlc3VsdChtKTtcbiAgICB9KTtcbiAgICBwb3J0Lm9uRGlzY29ubmVjdC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgICBpZiAodGhpcy5wb3J0ICE9PSBwb3J0KSByZXR1cm47XG4gICAgICB0aGlzLnBvcnQgPSBudWxsO1xuICAgICAgLy8gQSBwb3J0IHRoYXQgbGl2ZWQgdGhpcyBsb25nIGVuZGVkIGluIGEgbm9ybWFsIFNXIGlkbGUgcmVzdGFydCwgbm90IGEgZmFpbGluZyBjb25uZWN0LlxuICAgICAgaWYgKHRoaXMuZGVwcy5ub3coKSAtIGNvbm5lY3RlZEF0ID49IFJFQ09OTkVDVF9NQVhfTVMpIHRoaXMucmVjb25uZWN0QXR0ZW1wdCA9IDA7XG4gICAgICB0aGlzLnNjaGVkdWxlUmVjb25uZWN0KCk7XG4gICAgfSk7XG4gIH1cblxuICAvKiogU29tZXRoaW5nIG11c3QgYmUgc2VudCBhbmQgdGhlIHBvcnQgaXMgZG93bjogcmVjb25uZWN0IG5vdyBpbnN0ZWFkIG9mIHdhaXRpbmcgb3V0IHRoZSBiYWNrb2ZmLiAqL1xuICBwcml2YXRlIHJlY29ubmVjdE5vdygpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGVkIHx8IHRoaXMucG9ydCB8fCB0aGlzLmRlcHMubm93KCkgLSB0aGlzLmxhc3RDb25uZWN0QXQgPCBDT05ORUNUX01JTl9JTlRFUlZBTF9NUykgcmV0dXJuO1xuICAgIGlmICh0aGlzLnJlY29ubmVjdFRpbWVyICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMuZGVwcy5jbGVhclRpbWVyKHRoaXMucmVjb25uZWN0VGltZXIpO1xuICAgICAgdGhpcy5yZWNvbm5lY3RUaW1lciA9IHVuZGVmaW5lZDtcbiAgICB9XG4gICAgdGhpcy5yZWNvbm5lY3QoKTtcbiAgfVxuXG4gIHByaXZhdGUgc2NoZWR1bGVSZWNvbm5lY3QoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBlZCB8fCB0aGlzLnJlY29ubmVjdFRpbWVyICE9PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICBjb25zdCBtcyA9IE1hdGgubWluKFJFQ09OTkVDVF9NQVhfTVMsIFJFQ09OTkVDVF9CQVNFX01TICogMiAqKiB0aGlzLnJlY29ubmVjdEF0dGVtcHQpO1xuICAgIHRoaXMucmVjb25uZWN0QXR0ZW1wdCsrO1xuICAgIHRoaXMucmVjb25uZWN0VGltZXIgPSB0aGlzLmRlcHMuc2V0VGltZXIoKCkgPT4ge1xuICAgICAgdGhpcy5yZWNvbm5lY3RUaW1lciA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMucmVjb25uZWN0KCk7XG4gICAgfSwgbXMpO1xuICB9XG5cbiAgLyoqIFJlY29ubmVjdCwgZmx1c2ggcXVldWVkIG1lc3NhZ2VzLCByZS1zZW5kIGV2ZXJ5IHVucmVzb2x2ZWQgcG9zdCBhbmQgcmUtcmVwb3J0IHNlbGVjdG9yIGhlYWx0aC4gKi9cbiAgcHJpdmF0ZSByZWNvbm5lY3QoKTogdm9pZCB7XG4gICAgdGhpcy5jb25uZWN0KCk7XG4gICAgaWYgKCF0aGlzLnBvcnQpIHJldHVybjtcbiAgICBjb25zdCBxdWV1ZWQgPSB0aGlzLm91dGJveDtcbiAgICB0aGlzLm91dGJveCA9IFtdO1xuICAgIHF1ZXVlZC5mb3JFYWNoKChtKSA9PiB0aGlzLnBvc3QobSkpO1xuICAgIC8vIFRoZSBTVyBtYXkgaGF2ZSByZXN0YXJ0ZWQgYW5kIGxvc3QgaW4tZmxpZ2h0IHdvcmssIHdoZXRoZXIgb3Igbm90IHRoZSBhcnRpY2xlIGlzIHN0aWxsIGluIHRoZSBET00uXG4gICAgaWYgKGlzQ2xhc3NpZmljYXRpb25BY3RpdmUodGhpcy5zZXR0aW5ncykpIHtcbiAgICAgIGZvciAoY29uc3QgW3Bvc3RJZCwgZW50cnldIG9mIHRoaXMuc2VudCkge1xuICAgICAgICBpZiAodGhpcy5pc1Jlc29sdmVkKHBvc3RJZCwgZW50cnkuc25hcEhhc2gpKSBjb250aW51ZTtcbiAgICAgICAgZW50cnkuYXQgPSB0aGlzLmRlcHMubm93KCk7XG4gICAgICAgIHRoaXMucG9zdCh7IHR5cGU6ICdwb3N0Jywgc25hcHNob3Q6IGVudHJ5LnNuYXBzaG90LCBzbmFwSGFzaDogZW50cnkuc25hcEhhc2ggfSk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFRoZSBTVyBrZWVwcyBzZWxlY3RvciBoZWFsdGggaW4gbWVtb3J5IG9ubHk6IHJlcG9ydCBpdCBhZ2FpbiBvbiB0aGUgbmV4dCBzY2FuLlxuICAgIHRoaXMubGFzdEhlYWx0aE9rID0gdW5kZWZpbmVkO1xuICAgIHRoaXMuc2NoZWR1bGVTY2FuKCk7XG4gIH1cblxuICAvLyAtLS0tIFRyaWdnZXJzIC0tLS1cblxuICBwcml2YXRlIHNjaGVkdWxlU2NhbigpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGVkIHx8IHRoaXMuc2NhblRpbWVyICE9PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICB0aGlzLnNjYW5UaW1lciA9IHRoaXMuZGVwcy5zZXRUaW1lcigoKSA9PiB7XG4gICAgICB0aGlzLnNjYW5UaW1lciA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMuc2NhbigpO1xuICAgIH0sIFNDQU5fREVCT1VOQ0VfTVMpO1xuICB9XG5cbiAgcHJpdmF0ZSByZWFkb25seSBwb2xsID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICh0aGlzLnN0b3BwZWQpIHJldHVybjtcbiAgICB0aGlzLmNoZWNrVXJsKCk7XG4gICAgdGhpcy5wb2xsVGltZXIgPSB0aGlzLmRlcHMuc2V0VGltZXIodGhpcy5wb2xsLCBVUkxfUE9MTF9NUyk7XG4gIH07XG5cbiAgcHJpdmF0ZSByZWFkb25seSBvblBvcFN0YXRlID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICghdGhpcy5zdG9wcGVkKSB0aGlzLmNoZWNrVXJsKCk7XG4gIH07XG5cbiAgcHJpdmF0ZSBjaGVja1VybCgpOiB2b2lkIHtcbiAgICBjb25zdCBocmVmID0gdGhpcy5kZXBzLmxvY2F0aW9uSHJlZigpO1xuICAgIGlmIChocmVmID09PSB0aGlzLmxhc3RIcmVmKSByZXR1cm47XG4gICAgdGhpcy5sYXN0SHJlZiA9IGhyZWY7XG4gICAgdGhpcy5zY2FuKCk7XG4gIH1cbn1cblxuLyoqIE11dGF0aW9ucyB0aGF0IG9ubHkgYWRkL3JlbW92ZSBvdXIgb3duIHBhbmVsIGhvc3RzIG11c3Qgbm90IHRyaWdnZXIgYW5vdGhlciBzY2FuLiAqL1xuZnVuY3Rpb24gaXNPd25NdXRhdGlvbihyOiBNdXRhdGlvblJlY29yZCk6IGJvb2xlYW4ge1xuICBpZiAoci50eXBlICE9PSAnY2hpbGRMaXN0JykgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBub2RlcyA9IFsuLi5BcnJheS5mcm9tKHIuYWRkZWROb2RlcyksIC4uLkFycmF5LmZyb20oci5yZW1vdmVkTm9kZXMpXTtcbiAgcmV0dXJuIG5vZGVzLmxlbmd0aCA+IDAgJiYgbm9kZXMuZXZlcnkoKG4pID0+IG4gaW5zdGFuY2VvZiBFbGVtZW50ICYmIG4uaGFzQXR0cmlidXRlKFBBTkVMX0FUVFIpKTtcbn1cblxuZnVuY3Rpb24gcmVhbERlcHMoKTogQ29udGVudERlcHMge1xuICByZXR1cm4ge1xuICAgIGRvYzogZG9jdW1lbnQsXG4gICAgd2luOiB3aW5kb3csXG4gICAgZmxhdm9yOiBfX0ZMQVZPUl9fLFxuICAgIGNvbm5lY3Q6ICgpID0+IHtcbiAgICAgIGNvbnN0IHBvcnQgPSBjaHJvbWUucnVudGltZS5jb25uZWN0KHsgbmFtZTogUE9SVF9OQU1FIH0pO1xuICAgICAgLy8gUmVhZGluZyBsYXN0RXJyb3IgbWFya3MgaXQgaGFuZGxlZCAob3RoZXJ3aXNlIENocm9tZSBsb2dzIFwiVW5jaGVja2VkIHJ1bnRpbWUubGFzdEVycm9yXCIpLlxuICAgICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4gdm9pZCBjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpO1xuICAgICAgcmV0dXJuIHBvcnQ7XG4gICAgfSxcbiAgICBsb2FkU2V0dGluZ3M6IGFzeW5jICgpID0+IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoU1RPUkFHRV9LRVlTLnNldHRpbmdzKSlbU1RPUkFHRV9LRVlTLnNldHRpbmdzXSxcbiAgICBvblNldHRpbmdzQ2hhbmdlZDogKGNiKSA9PlxuICAgICAgY2hyb21lLnN0b3JhZ2Uub25DaGFuZ2VkLmFkZExpc3RlbmVyKChjaGFuZ2VzLCBhcmVhKSA9PiB7XG4gICAgICAgIGlmIChhcmVhID09PSAnbG9jYWwnICYmIFNUT1JBR0VfS0VZUy5zZXR0aW5ncyBpbiBjaGFuZ2VzKSBjYihjaGFuZ2VzW1NUT1JBR0VfS0VZUy5zZXR0aW5nc10ubmV3VmFsdWUpO1xuICAgICAgfSksXG4gICAgb2JzZXJ2ZU5lYXI6IChlbCwgY2IpID0+IHtcbiAgICAgIGNvbnN0IGlvID0gbmV3IEludGVyc2VjdGlvbk9ic2VydmVyKFxuICAgICAgICAoZW50cmllcykgPT4ge1xuICAgICAgICAgIGlmICghZW50cmllcy5zb21lKChlKSA9PiBlLmlzSW50ZXJzZWN0aW5nKSkgcmV0dXJuO1xuICAgICAgICAgIGlvLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICBjYigpO1xuICAgICAgICB9LFxuICAgICAgICB7IHJvb3RNYXJnaW46ICcyMDAwcHggMHB4JyB9LFxuICAgICAgKTtcbiAgICAgIGlvLm9ic2VydmUoZWwpO1xuICAgICAgcmV0dXJuICgpID0+IGlvLmRpc2Nvbm5lY3QoKTtcbiAgICB9LFxuICAgIG5vdzogKCkgPT4gRGF0ZS5ub3coKSxcbiAgICBzZXRUaW1lcjogKGZuLCBtcykgPT4gd2luZG93LnNldFRpbWVvdXQoZm4sIG1zKSxcbiAgICBjbGVhclRpbWVyOiAoaCkgPT4gd2luZG93LmNsZWFyVGltZW91dChoIGFzIG51bWJlciksXG4gICAgbG9jYXRpb25IcmVmOiAoKSA9PiBsb2NhdGlvbi5ocmVmLFxuICAgIGNvbnRleHRWYWxpZDogKCkgPT4gISFjaHJvbWUucnVudGltZT8uaWQsXG4gIH07XG59XG5cbmlmICh0eXBlb2YgY2hyb21lICE9PSAndW5kZWZpbmVkJyAmJiBjaHJvbWUucnVudGltZT8uaWQpIHZvaWQgbmV3IENvbnRlbnRDb250cm9sbGVyKHJlYWxEZXBzKCkpLnN0YXJ0KCk7XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFZTyxNQUFNLGlCQUFpQjtBQUV2QixNQUFNLGtCQUFrQjtBQUFBLElBQzdCO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQVVPLE1BQU0sbUJBQW1CLENBQUMsUUFBUSxRQUFRLFlBQVksVUFBVSxjQUFjO0FBRTlFLE1BQU0sZ0JBQWdCO0FBQUEsSUFDM0IsVUFBVTtBQUFBLE1BQ1IsTUFBTTtBQUFBLE1BQ04sY0FDRTtBQUFBLE1BQ0YsVUFBVTtBQUFBLFFBQ1IsTUFBTTtBQUFBLFFBQ04sT0FDRTtBQUFBLE1BQ0o7QUFBQSxJQUNGO0FBQUEsSUFDQSxVQUFVO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixjQUFjO0FBQUEsTUFDZCxVQUFVO0FBQUEsUUFDUixjQUFjO0FBQUEsUUFDZCxhQUFhO0FBQUEsUUFDYixpQkFBaUI7QUFBQSxRQUNqQixZQUFZO0FBQUEsUUFDWixnQkFBZ0I7QUFBQSxRQUNoQixPQUFPO0FBQUEsUUFDUCxxQkFBcUI7QUFBQSxRQUNyQixjQUFjO0FBQUEsUUFDZCxrQkFBa0I7QUFBQSxRQUNsQix1QkFBdUI7QUFBQSxRQUN2QixPQUFPO0FBQUEsUUFDUCxjQUFj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
