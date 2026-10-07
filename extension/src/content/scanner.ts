// Article → PostSnapshot, plus exemptions (spec §4.1). Reads the DOM only; never uses innerText.

import type { LinkCard, MediaKind, MediaRef, PostSnapshot, QuotedPost } from '../../../shared/types';
import { shouldFilter, type PageInfo } from './page';
import { SEL, cellOf, findArticles, permalinkOf, postIdOf, quoteOf, statusIdOf } from './selectors';

const X_ORIGIN = 'https://x.com';
const PERMALINK_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/;
const HANDLE_TEXT = /^@[A-Za-z0-9_]{1,15}$/;
const DOMAIN_TEXT = /^(From\s+)?([a-z0-9-]+\.)+[a-z]{2,}$/i;
const LARGE_SIZES = new Set(['large', 'orig', '4096x4096']);

/** Text as X renders it: text nodes as-is, img[alt] (emoji) as its alt, br as "\n"; only the ends are trimmed. */
export function extractText(el: Element | null): string {
  if (!el) return '';
  let out = '';
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue ?? '';
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const e = child as Element;
        if (e.localName === 'br') out += '\n';
        else if (e.localName === 'img') out += e.getAttribute('alt') ?? '';
        else walk(e);
      }
    }
  };
  walk(el);
  return out.trim();
}

/** Stable media id: pbs /media/<id> → "media/<id>"; other pbs paths minus extension; else the URL without query. */
export function mediaKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.hostname === 'pbs.twimg.com') {
    const media = /^\/media\/([^/.]+)/.exec(u.pathname);
    if (media) return `media/${media[1]}`;
    return u.pathname.replace(/^\//, '').replace(/\.[A-Za-z0-9]+$/, '');
  }
  return u.origin + u.pathname;
}

/** name=large|orig|4096x4096 → name=medium; every other URL is returned exactly as rendered (HTTP-cache friendly). */
export function normalizeMediaUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!LARGE_SIZES.has(u.searchParams.get('name') ?? '')) return url;
  u.searchParams.set('name', 'medium');
  return u.toString();
}

function isPbs(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com';
  } catch {
    return false;
  }
}

/** All matches of `sel` in `scope` that are not inside `exclude` (the quoted post). */
function outsideAll(scope: Element, sel: string, exclude: Element | null): Element[] {
  return Array.from(scope.querySelectorAll(sel)).filter((el) => !exclude?.contains(el));
}

function outside(scope: Element, sel: string, exclude: Element | null): Element | null {
  return outsideAll(scope, sel, exclude)[0] ?? null;
}

/** Trimmed, non-empty text-node values in document order. */
function leafTexts(el: Element): string[] {
  const out: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.nodeValue ?? '').trim();
        if (t) out.push(t);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    }
  };
  walk(el);
  return out;
}

/** Author from a User-Name block: the @handle text and the display name (the profile link, else the first child). */
function authorOf(userName: Element | null): { handle: string; name: string } {
  if (!userName) return { handle: '', name: '' };
  // Last match wins: a display name may itself look like "@something"; the real handle follows it.
  const handle = leafTexts(userName).filter((t) => HANDLE_TEXT.test(t)).pop() ?? '';
  const nameLink = Array.from(userName.querySelectorAll('a')).find(
    (a) => !a.querySelector('time') && !extractText(a).startsWith('@'),
  );
  // Quoted posts render User-Name without links; the display name is then the first block.
  return { handle, name: extractText(nameLink ?? userName.firstElementChild) };
}

/** Photos, then video/GIF posters, then the card image, from `scope` minus `exclude`. Dedupes by key into `out`. */
function collectMedia(scope: Element, exclude: Element | null, inQuote: boolean, out: MediaRef[], seen: Set<string>): void {
  const add = (kind: MediaKind, raw: string | null, alt?: string): void => {
    if (!raw || !isPbs(raw)) return;
    const key = mediaKey(raw);
    if (seen.has(key)) return;
    seen.add(key);
    const ref: MediaRef = { kind, url: normalizeMediaUrl(raw), key, inQuote };
    if (alt) ref.alt = alt;
    out.push(ref);
  };

  for (const img of outsideAll(scope, `${SEL.photo} img`, exclude)) {
    add('image', img.getAttribute('src'), img.getAttribute('alt')?.trim() || undefined);
  }
  for (const video of outsideAll(scope, `${SEL.videoPlayer} video[poster]`, exclude)) {
    const poster = video.getAttribute('poster');
    const player = video.closest(SEL.videoPlayer);
    const gif = !!poster?.includes('tweet_video_thumb') || (!!player && leafTexts(player).includes('GIF'));
    add(gif ? 'gif_poster' : 'video_poster', poster);
  }
  const card = outside(scope, SEL.card, exclude);
  const cardImg = card && Array.from(card.querySelectorAll('img')).find((img) => isPbs(img.getAttribute('src') ?? ''));
  if (cardImg) add('card_image', cardImg.getAttribute('src'));
}

function cardOf(wrapper: Element | null): LinkCard | undefined {
  if (!wrapper) return undefined;
  let domain: string | undefined;
  const others: string[] = [];
  for (const t of leafTexts(wrapper)) {
    if (!domain && DOMAIN_TEXT.test(t)) domain = t.replace(/^From\s+/i, '');
    else others.push(t);
  }
  const card: LinkCard = {};
  if (domain) card.domain = domain;
  if (others[0]) card.title = others[0];
  if (others[1]) card.description = others[1];
  return Object.keys(card).length ? card : undefined;
}

function quotedOf(quote: Element): QuotedPost {
  const { handle, name } = authorOf(quote.querySelector(SEL.userName));
  const quoted: QuotedPost = {
    authorHandle: handle,
    authorName: name,
    text: extractText(quote.querySelector(SEL.tweetText)),
    truncated: !!quote.querySelector(SEL.showMore),
  };
  const link = permalinkOf(quote, null) ?? quote.querySelector('a[href*="/status/"]');
  const postId = link && statusIdOf(link);
  if (postId) quoted.postId = postId;
  return quoted;
}

function isPromoted(article: Element): boolean {
  if (cellOf(article)?.querySelector(SEL.placement)) return true;
  // An "Ad"/"Promoted" label is a leaf span; post text that happens to say "Ad" is not a label.
  return Array.from(article.querySelectorAll('span')).some(
    (span) =>
      span.childElementCount === 0 &&
      /^(Ad|Promoted)$/.test((span.textContent ?? '').trim()) &&
      !span.closest(SEL.tweetText),
  );
}

/** The post as one unit (outer post + quoted post + card + media), or null when no permalink/postId is found. */
export function snapshotArticle(article: Element): PostSnapshot | null {
  const quote = quoteOf(article);
  const link = permalinkOf(article, quote);
  const postId = link && statusIdOf(link);
  if (!link || !postId) return null;

  let path: string;
  try {
    path = new URL(link.getAttribute('href') ?? '', X_ORIGIN).pathname;
  } catch {
    return null;
  }
  const hrefHandle = PERMALINK_PATH.exec(path)?.[1];
  const url = hrefHandle ? `${X_ORIGIN}/${hrefHandle}/status/${postId}` : `${X_ORIGIN}/i/web/status/${postId}`;

  const author = authorOf(outside(article, SEL.userName, quote));
  const textEl = outside(article, SEL.tweetText, quote);
  const media: MediaRef[] = [];
  const seen = new Set<string>();
  collectMedia(article, quote, false, media, seen);
  if (quote) collectMedia(quote, null, true, media, seen);

  const snap: PostSnapshot = {
    postId,
    url,
    authorHandle: author.handle || (hrefHandle ? `@${hrefHandle}` : ''),
    authorName: author.name,
    text: extractText(textEl),
    truncated: !!outside(article, SEL.showMore, quote),
    promoted: isPromoted(article),
    media,
  };
  const lang = textEl?.getAttribute('lang');
  if (lang) snap.lang = lang;
  const social = outside(article, SEL.socialContext, quote);
  const repostedBy = /^(.*?)\s+reposted$/i.exec(extractText(social))?.[1].trim();
  if (repostedBy) snap.repostedBy = repostedBy;
  const card = cardOf(outside(article, SEL.card, quote));
  if (card) snap.card = card;
  if (quote) snap.quoted = quotedOf(quote);
  return snap;
}

export type ExemptReason = 'page' | 'outside' | 'own' | 'focal' | 'ancestor' | 'no-focal';

export interface ExemptContext {
  page: PageInfo;
  ownHandle: string | null;
  root: Element | null;
}

/** Why this article must never be classified or hidden, or null when it is fair game. */
export function exemptReason(article: Element, snap: PostSnapshot | null, ctx: ExemptContext): ExemptReason | null {
  if (!shouldFilter(ctx.page.kind)) return 'page';
  if (!ctx.root || !ctx.root.contains(article)) return 'outside';
  if (snap && ctx.ownHandle && snap.authorHandle.toLowerCase() === ctx.ownHandle.toLowerCase()) return 'own';
  if (ctx.page.kind === 'status') {
    const focalId = ctx.page.focalId;
    const focal = focalId ? findArticles(ctx.root).find((a) => postIdOf(a) === focalId) : undefined;
    if (!focal) return 'no-focal';
    if (article === focal) return 'focal';
    if (article.compareDocumentPosition(focal) & Node.DOCUMENT_POSITION_FOLLOWING) return 'ancestor';
  }
  return null;
}
