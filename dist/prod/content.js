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
  function ownedBy(article, el) {
    const inner = el.parentElement?.closest(SEL.article);
    return !inner || inner === article || !article.contains(inner);
  }
  function hostsOf(article) {
    return Array.from(article.querySelectorAll(`[${PANEL_ATTR}]`)).filter((h) => ownedBy(article, h));
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
      if (false) {
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
      if (false) {
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
      flavor: "prod",
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
