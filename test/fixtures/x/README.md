# X DOM fixtures

These files are the scanner's only model of X's DOM. They are **synthetic**: hand-modelled on X's 2025–2026 web
markup (React Native Web), not saved from a live session. Replace them with real snapshots when you can (see below).

They are used by `test/extension/scanner.test.ts` via `loadFixture(name)` in `test/extension/fixtures.ts`, which
parses the file and copies its `<body>` into the jsdom `document`.

## What they model

Every post uses the real structure the selectors in `extension/src/content/selectors.ts` depend on:

- `div[data-testid="cellInnerDiv"] > div > div > article[data-testid="tweet"][role="article"][tabindex="0"]`, with
  X's nested `css-175oi2r` wrapper divs;
- `div[data-testid="User-Name"]` holding the display-name link (`a[href="/alice"]`), the `@alice` link, and the
  permalink `a[href="/alice/status/<id>"] > time[datetime]`;
- `div[data-testid="tweetText"][lang]`, minified on one line as X ships it, with emoji as
  `<img alt="😡" src="https://abs-0.twimg.com/emoji/…">`, `<br>`s, mention/hashtag/t.co links;
- decoys the scanner must ignore: avatar `img`s on `pbs.twimg.com/profile_images`, photo links
  (`/status/<id>/photo/1`) and analytics links (`/status/<id>/analytics`) that have no `<time>`, and action-bar counts.

Post ids are `1800000000000000NNN` (19 digits); tests find posts by the last three digits.

### `home-timeline.html` (URL: `https://x.com/home`)

The left nav has `a[data-testid="AppTabBar_Profile_Link"][href="/owner"]` (the own handle is `@owner`). The
`primaryColumn` has the For you/Following tabs, the composer, and 12 cells:

| id  | author        | models |
|-----|---------------|--------|
| 001 | @alice (Alice, verified) | plain text |
| 002 | @grace        | text + emoji `img[alt]` + `<br><br>` |
| 003 | @alice        | two photos in `tweetPhoto`: `media/GAbc123` (alt "A crowd at a rally") and `media/GAbc124` (alt "Image"), both `name=large` |
| 004 | @hank         | video: `videoPlayer > video[poster=…/ext_tw_video_thumb/1799/pu/img/vid1.jpg]` with a duration badge |
| 005 | @ivy          | GIF: poster `…/tweet_video_thumb/GifXyz.jpg` and a "GIF" badge |
| 006 | @jack         | small link card `card.wrapper`: image `card_img/1800/abc`, texts "From example.com", "Headline here", "Short description" |
| 007 | @alice        | quote post: outer text "lol look at this"; quoted `div[role="link"]` by @carol (User-Name without links, bare `<time>`) with a photo `media/QQQ` |
| 008 | @brandco      | promoted: `div[data-testid="placementTracking"]` wraps the article inside the cell |
| 009 | @erin         | repost: `socialContext` "Bob reposted" |
| 010 | @kim          | long post with mention, hashtag, t.co link and a `tweet-text-show-more-link` button |
| 011 | @owner        | the owner's own post (exempt) |
| 012 | @frank        | image-only post: one photo, no `tweetText` |

`div[data-testid="sidebarColumn"]` holds one more article (id 900, @sidebar_news) that must be ignored as outside
the scan root.

### `status-page.html` (URL: `https://x.com/dave/status/1800000000000000102`)

A conversation timeline: ancestor 101 (@carl), the focal post 102 (@dave, `tabindex="-1"`, no timestamp in
User-Name; the permalink `<time>` sits in the metadata row with the view count), a reply-composer cell without an
article, then replies 103 (@erin) and 104 (@frank).

### `dm-drawer.html`

A `div[data-testid="DMDrawer"]` in `#layers` holding a message entry with a shared post (an `article`) and message
text, next to an empty `primaryColumn`. Nothing in it may ever be scanned.

## Replacing them with real snapshots

Do this on the owner's PC only, by reading the page (no clicks, posts, likes or any other action on X):

1. Open the page in Chrome (for example `https://x.com/home`), scroll until the posts you want are rendered, then run
   in DevTools: `copy(document.documentElement.outerHTML)` and paste into a new file here.
2. Strip what the tests do not need and what should not be committed: `<script>`/`<style>`/`<link>`/`<svg>` bodies,
   inline data URLs, and any personal data (DMs, notifications, other people's private info). Keep the
   `data-testid`, `role`, `tabindex`, `lang`, `href`, `src`, `alt`, `poster` and `datetime` attributes and the
   wrapper nesting.
3. Rename handles/ids if you want stable test ids, or update the ids in `scanner.test.ts` to match the snapshot.
4. Run `npx vitest run test/extension/scanner.test.ts`. A failure after swapping in a real snapshot means
   `selectors.ts` (or the scanner) has drifted from live X: fix the selector there, not the fixture.

Keep the synthetic cases that a real snapshot lacks (for example a promoted post or a GIF) as separate fixtures so
every scanner path stays covered.
