// Every X DOM selector lives here (spec §4.1), so selector drift is a one-file patch.

export const SEL = {
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
  actionBar: '[role="group"]',
} as const;

const STATUS_HREF = /\/status\/(\d+)/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** The only subtree ever scanned: X's primary column (never the sidebar or the DM drawer). */
export function scanRoot(doc: Document): Element | null {
  return doc.querySelector(SEL.primaryColumn);
}

/** Outer post articles only; an article nested inside another article is part of that post. */
export function findArticles(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SEL.article)).filter(
    (a) => !a.parentElement?.closest(SEL.article),
  );
}

export function cellOf(article: Element): HTMLElement | null {
  return article.closest<HTMLElement>(SEL.cell);
}

/** The quoted post: a div[role=link] in the article holding its own User-Name, not the outer author's. */
export function quoteOf(article: Element): Element | null {
  const outerName = article.querySelector(SEL.userName);
  for (const el of Array.from(article.querySelectorAll(SEL.quote))) {
    if (outerName && el.contains(outerName)) continue;
    if (el.querySelector(SEL.userName)) return el;
  }
  return null;
}

/** The post id in a /status/<id> href, or null. */
export function statusIdOf(link: Element): string | null {
  return STATUS_HREF.exec(link.getAttribute('href') ?? '')?.[1] ?? null;
}

/**
 * The permalink: the first a[href*="/status/"] in `scope` that contains a <time> and is not inside `exclude`.
 * Photo (/status/<id>/photo/1) and analytics links have no <time>, so they never match.
 */
export function permalinkOf(scope: Element, exclude: Element | null): Element | null {
  for (const a of Array.from(scope.querySelectorAll('a[href*="/status/"]'))) {
    if (exclude?.contains(a) || !a.querySelector('time')) continue;
    if (statusIdOf(a)) return a;
  }
  return null;
}

export function postIdOf(article: Element): string | null {
  const link = permalinkOf(article, quoteOf(article));
  return link && statusIdOf(link);
}

export function ownHandleOf(doc: Document): string | null {
  const href = doc.querySelector(SEL.ownProfileLink)?.getAttribute('href');
  if (!href) return null;
  let first: string | undefined;
  try {
    first = new URL(href, 'https://x.com').pathname.split('/').filter(Boolean)[0];
  } catch {
    return null;
  }
  return first && HANDLE_RE.test(first) ? `@${first}` : null;
}

/** Selector health: ok is false only when cells and articles render but no article yields a postId. */
export function checkHealth(root: ParentNode): { cells: number; articles: number; parsed: number; ok: boolean } {
  const cells = root.querySelectorAll(SEL.cell).length;
  const found = findArticles(root);
  const parsed = found.filter((a) => postIdOf(a) !== null).length;
  return { cells, articles: found.length, parsed, ok: !(cells > 0 && found.length > 0 && parsed === 0) };
}
