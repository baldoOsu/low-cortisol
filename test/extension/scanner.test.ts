// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exemptReason, extractText, mediaKey, normalizeMediaUrl, snapshotArticle } from '../../extension/src/content/scanner';
import { checkHealth, findArticles, ownHandleOf, postIdOf, quoteOf, scanRoot } from '../../extension/src/content/selectors';
import { pageInfo } from '../../extension/src/content/page';
import { loadFixture } from './fixtures';

const byId = (doc: Document, suffix: string) => findArticles(doc).find((a) => postIdOf(a)?.endsWith(suffix))!;

describe('scanner on home-timeline fixture', () => {
  it('finds the 12 primary-column posts, ignores the sidebar and knows the owner', () => {
    const doc = loadFixture('home-timeline.html');
    expect(findArticles(scanRoot(doc)!)).toHaveLength(12);
    expect(ownHandleOf(doc)).toBe('@owner');
    expect(checkHealth(scanRoot(doc)!)).toMatchObject({ ok: true, parsed: 12 });
  });

  it('plain text post', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '001'))!;
    expect(s).toMatchObject({ postId: '1800000000000000001', url: 'https://x.com/alice/status/1800000000000000001', authorHandle: '@alice', authorName: 'Alice', promoted: false, truncated: false, media: [] });
    expect(s.text.length).toBeGreaterThan(0);
  });

  it('emoji img alt becomes text and br becomes newline', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '002'))!;
    expect(s.text).toContain('😡');
    expect(s.text).toContain('\n');
  });

  it('photos keep meaningful alt, normalise size and key by media id', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '003'))!;
    expect(s.media[0]).toEqual({ kind: 'image', url: 'https://pbs.twimg.com/media/GAbc123?format=jpg&name=medium', key: 'media/GAbc123', alt: 'A crowd at a rally', inQuote: false });
    expect(s.media).toHaveLength(2);
  });

  it('video and GIF posters', () => {
    const doc = loadFixture('home-timeline.html');
    expect(snapshotArticle(byId(doc, '004'))!.media[0]).toMatchObject({ kind: 'video_poster', key: 'ext_tw_video_thumb/1799/pu/img/vid1' });
    expect(snapshotArticle(byId(doc, '005'))!.media[0]).toMatchObject({ kind: 'gif_poster', key: 'tweet_video_thumb/GifXyz' });
  });

  it('link card text and image', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '006'))!;
    expect(s.card).toEqual({ domain: 'example.com', title: 'Headline here', description: 'Short description' });
    expect(s.media).toEqual([expect.objectContaining({ kind: 'card_image', key: 'card_img/1800/abc', inQuote: false })]);
  });

  it('quote post is judged as one unit with quoted media flagged', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '007'))!;
    expect(s.text).toBe('lol look at this');
    expect(s.quoted).toMatchObject({ authorHandle: '@carol' });
    expect(s.media).toEqual([expect.objectContaining({ key: 'media/QQQ', inQuote: true })]);
  });

  it('promoted, repost, truncated', () => {
    const doc = loadFixture('home-timeline.html');
    expect(snapshotArticle(byId(doc, '008'))!.promoted).toBe(true);
    expect(snapshotArticle(byId(doc, '009'))!.repostedBy).toBe('Bob');
    expect(snapshotArticle(byId(doc, '010'))!.truncated).toBe(true);
  });

  it('image-only post has empty text but a snapshot', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '012'))!;
    expect(s.text).toBe('');
    expect(s.media).toHaveLength(1);
  });

  it('own posts and non-filtered pages are exempt', () => {
    const doc = loadFixture('home-timeline.html');
    const ctx = { page: pageInfo('https://x.com/home'), ownHandle: ownHandleOf(doc), root: scanRoot(doc) };
    const own = byId(doc, '011');
    expect(exemptReason(own, snapshotArticle(own), ctx)).toBe('own');
    const plain = byId(doc, '001');
    expect(exemptReason(plain, snapshotArticle(plain), ctx)).toBeNull();
    expect(exemptReason(plain, snapshotArticle(plain), { ...ctx, page: pageInfo('https://x.com/alice') })).toBe('page');
    const sidebar = doc.querySelector('[data-testid="sidebarColumn"] article')!;
    expect(exemptReason(sidebar, snapshotArticle(sidebar), ctx)).toBe('outside');
  });
});

describe('scanner details on home-timeline fixture', () => {
  it('quoted post fields, and the quote does not leak into the outer post', () => {
    const doc = loadFixture('home-timeline.html');
    const a = byId(doc, '007');
    const s = snapshotArticle(a)!;
    expect(s).toMatchObject({ authorHandle: '@alice', authorName: 'Alice', truncated: false });
    expect(s.quoted).toEqual({ authorHandle: '@carol', authorName: 'Carol', text: 'You will not believe what they did this time', truncated: false });
    expect(s.media).toEqual([{ kind: 'image', url: 'https://pbs.twimg.com/media/QQQ?format=png&name=small', key: 'media/QQQ', alt: 'Image', inQuote: true }]);
    expect(quoteOf(a)!.textContent).toContain('@carol');
  });

  it('plain posts have no quote, card or repost, and carry lang', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '001'))!;
    expect(s.quoted).toBeUndefined();
    expect(s.card).toBeUndefined();
    expect(s.repostedBy).toBeUndefined();
    expect(s.lang).toBe('en');
  });

  it('text keeps links, mentions and hashtags in document order', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '010'))!;
    expect(s.text).toMatch(/^Thread on the budget vote, cc @bob #budget/);
  });

  it('photo links (/status/…/photo/1) are not mistaken for the permalink', () => {
    const doc = loadFixture('home-timeline.html');
    expect(snapshotArticle(byId(doc, '003'))!.url).toBe('https://x.com/alice/status/1800000000000000003');
  });

  it('second photo keeps its generic alt and a distinct key', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '003'))!;
    expect(s.media[1]).toEqual({ kind: 'image', url: 'https://pbs.twimg.com/media/GAbc124?format=jpg&name=medium', key: 'media/GAbc124', alt: 'Image', inQuote: false });
  });

  it('repost is authored by the original poster, not the reposter', () => {
    const s = snapshotArticle(byId(loadFixture('home-timeline.html'), '009'))!;
    expect(s.authorHandle).toBe('@erin');
  });

  it('checkHealth flags selector drift when cells and articles exist but nothing parses', () => {
    const doc = loadFixture('home-timeline.html');
    for (const t of Array.from(doc.querySelectorAll('[data-testid="primaryColumn"] article time'))) t.remove();
    expect(checkHealth(scanRoot(doc)!)).toEqual({ cells: 12, articles: 12, parsed: 0, ok: false });
  });
});

describe('scanner on synthetic markup', () => {
  const article = (inner: string) => {
    document.body.innerHTML = `<div data-testid="primaryColumn"><div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">${inner}</article></div></div>`;
    return document.querySelector('article')!;
  };
  const head =
    '<div data-testid="User-Name"><a href="/zed" role="link"><span>Zed</span></a><a href="/zed" role="link" tabindex="-1"><span>@zed</span></a>' +
    '<a href="/zed/status/1800000000000000500" role="link"><time datetime="2026-09-30T10:00:00.000Z">1h</time></a></div>';

  it('an "Ad" label marks a post promoted', () => {
    expect(snapshotArticle(article(`${head}<div><span>Ad</span></div>`))!.promoted).toBe(true);
  });

  it('a post whose text is "Ad" is not promoted', () => {
    expect(snapshotArticle(article(`${head}<div data-testid="tweetText" lang="en"><span>Ad</span></div>`))!.promoted).toBe(false);
  });

  it('articles without a permalink produce no snapshot', () => {
    expect(snapshotArticle(article('<div data-testid="tweetText"><span>hello</span></div>'))).toBeNull();
  });

  it('a quoted post with a /status/ link carries its postId', () => {
    const quote =
      '<div role="link" tabindex="0"><div data-testid="User-Name"><span>Carol</span><span>@carol</span>' +
      '<a href="/carol/status/1700000000000000001"><time datetime="2026-09-29T10:00:00.000Z">Sep 29</time></a></div>' +
      '<div data-testid="tweetText"><span>quoted</span></div></div>';
    const a = article(`${head}<div data-testid="tweetText"><span>outer</span></div>${quote}`);
    expect(postIdOf(a)).toBe('1800000000000000500');
    expect(snapshotArticle(a)!.quoted).toEqual({ postId: '1700000000000000001', authorHandle: '@carol', authorName: 'Carol', text: 'quoted', truncated: false });
  });

  it('media are deduplicated by key and non-pbs images are ignored', () => {
    const photo = (src: string) => `<div data-testid="tweetPhoto"><img alt="Image" src="${src}"></div>`;
    const a = article(
      head +
        photo('https://pbs.twimg.com/media/Dup?format=jpg&name=small') +
        photo('https://pbs.twimg.com/media/Dup?format=png&name=large') +
        photo('https://evil.example/x.jpg'),
    );
    expect(snapshotArticle(a)!.media.map((m) => m.key)).toEqual(['media/Dup']);
  });

  it('a "GIF" badge in the player marks a poster as a GIF even without tweet_video_thumb', () => {
    const player = '<div data-testid="videoPlayer"><video poster="https://pbs.twimg.com/amplify_video_thumb/9/img/g.jpg"></video><div><span>GIF</span></div></div>';
    expect(snapshotArticle(article(head + player))!.media).toEqual([
      { kind: 'gif_poster', url: 'https://pbs.twimg.com/amplify_video_thumb/9/img/g.jpg', key: 'amplify_video_thumb/9/img/g', inQuote: false },
    ]);
  });

  it('a card with no text and no image is omitted', () => {
    expect(snapshotArticle(article(`${head}<div data-testid="card.wrapper"><div></div></div>`))!.card).toBeUndefined();
  });
});

describe('status page and DMs', () => {
  it('focal and ancestor are exempt; replies are filtered', () => {
    const doc = loadFixture('status-page.html');
    const ctx = { page: pageInfo('https://x.com/dave/status/1800000000000000102'), ownHandle: null, root: scanRoot(doc) };
    const reason = (id: string) => { const a = byId(doc, id); return exemptReason(a, snapshotArticle(a), ctx); };
    expect([reason('101'), reason('102'), reason('103'), reason('104')]).toEqual(['ancestor', 'focal', null, null]);
  });

  it('a status page whose focal post is not rendered yet exempts everything', () => {
    const doc = loadFixture('status-page.html');
    const ctx = { page: pageInfo('https://x.com/dave/status/1800000000000000999'), ownHandle: null, root: scanRoot(doc) };
    const a = byId(doc, '103');
    expect(exemptReason(a, snapshotArticle(a), ctx)).toBe('no-focal');
  });

  it('DM drawer articles are never in the scan root', () => {
    const doc = loadFixture('dm-drawer.html');
    expect(findArticles(scanRoot(doc)!)).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('mediaKey and normalizeMediaUrl', () => {
    expect(mediaKey('https://pbs.twimg.com/media/GAbc123?format=jpg&name=small')).toBe('media/GAbc123');
    expect(mediaKey('https://pbs.twimg.com/amplify_video_thumb/1/img/abc.jpg')).toBe('amplify_video_thumb/1/img/abc');
    expect(normalizeMediaUrl('https://pbs.twimg.com/media/A?format=jpg&name=orig')).toBe('https://pbs.twimg.com/media/A?format=jpg&name=medium');
    expect(normalizeMediaUrl('https://pbs.twimg.com/media/A?format=jpg&name=small')).toBe('https://pbs.twimg.com/media/A?format=jpg&name=small');
  });
  it('extractText handles null', () => expect(extractText(null)).toBe(''));

  it('mediaKey edge cases', () => {
    expect(mediaKey('https://pbs.twimg.com/media/GAbc123.jpg')).toBe('media/GAbc123');
    expect(mediaKey('https://video.twimg.com/tweet_video/abc.mp4?tag=1')).toBe('https://video.twimg.com/tweet_video/abc.mp4');
    expect(mediaKey('not a url')).toBe('not a url');
  });

  it('normalizeMediaUrl rewrites 4096x4096 and leaves other URLs alone', () => {
    expect(normalizeMediaUrl('https://pbs.twimg.com/media/A?format=jpg&name=4096x4096')).toBe('https://pbs.twimg.com/media/A?format=jpg&name=medium');
    expect(normalizeMediaUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg')).toBe('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg');
  });

  it('extractText walks text, emoji alt and br, and trims only the ends', () => {
    const el = document.createElement('div');
    el.innerHTML = '  <span>a  b</span><img alt="🔥" src="x"><img src="y"><br><span>c</span>  ';
    expect(extractText(el)).toBe('a  b🔥\nc');
  });
});
