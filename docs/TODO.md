# Low Cortisol: deferred work

Items deliberately left out of v1 (see design spec section 9). Source tags like Q15 refer to early product decisions captured in the design spec.

- [ ] **Toggles for own posts, followed accounts and the Following tab, plus an allowlist** (Q15). Later version, not in v1. v1 defaults are fixed: the signed-in user's own posts are never hidden, followed accounts **are** filtered, the Following tab **is** filtered, and there is no allowlist.
- [ ] **Always-hide and never-hide lists** (Q13). Later version, not in v1.
- [ ] **Multi-frame video** (Q9). v1 transcribes the video poster only.
- [ ] **Languages other than English** (Q17).
- [ ] **Threshold tuning from about 150 user labels** (Q26). The tool ships in v1 (`npm run eval:feedback`); the labels come later.
- [ ] **Pin `jev-1.x` after tuning** (Q26; brainstorm notes, tuning). v1 uses `jev-latest`.
- [ ] **Full text of truncated ("Show more") posts via GraphQL interception** (brainstorm notes, data sources; no owner question). v1 judges the visible text and marks it truncated.
- [ ] **A long-lived `claude` stream-json process** to cut image-transcript latency (Q28, speed target; brainstorm notes, latency).
- [ ] **Per-category toggles** (Q22: "No per-category toggles" in v1).
- [ ] **Chrome Web Store and other browsers** (Q24). v1 is loaded unpacked in Chrome.
- [ ] **Support for an npm-installed Claude Code (`.cmd` shim)** (Q5; design spec Â§5). v1 expects the native `claude.exe`.

## v1.1 follow-ups (final review)

Minor findings from the v1 final whole-branch review, left for v1.1. All of them fail open today.

- [ ] **Vision queue priority** (M-7). The SW vision queue is an unbounded FIFO. On a fast, long scroll, newly visible posts wait behind posts scrolled past minutes ago, and base64 payloads pile up in SW memory because the media fetch runs before the semaphore. Serve it LIFO, or drop queued vision work for posts that are no longer near the viewport.
- [ ] **Feedback cap vs the `chrome.storage.local` quota** (M-8). `MAX_FEEDBACK = 5000` entries of about 2â€“4 KB each exceeds the 10 MB quota. Once it is hit, every write fails silently, including stats and settings. Cap at about 2,000 entries, or add the `unlimitedStorage` permission.
- [ ] **Bounded per-tab maps in the content script** (M-9). `sent`, `results`, `resultSnaps`, `hiddenReported` and `saved` grow for the life of an X tab, and every unresolved post is re-sent on each reconnect. Use an LRU of about 2,000 postIds.
- [ ] **Anchor preservation on unhide** (M-10). Unhiding (the toggle turned off, or a reconcile/exempt unhide) expands cells above the viewport and pushes the reader's content down.
- [ ] **SW classify timeout vs the Jev worst case** (M-11). The SW `classify` timeout is 10 s, but the companion's Jev worst case is about 19.4 s (3 Ã— 6 s plus backoff). The SW then reports `COMPANION_TIMEOUT` while the companion still holds a Jev slot. v1 keeps the spec values; align them (e.g. classify 20 s, or fewer Jev retries).
- [ ] **`claude` stderr tail in the log** (M-12). On a non-zero exit, `claude.stderr` logs up to 2 KB of CLI stderr. Spec Â§5 says the log holds metadata only, so log the length or a fixed classification instead. The key cannot appear there, because the child env is stripped.
- [ ] **Stale anchor preservation reuse** (fix-wave re-review). `hidePost` reuses an active preservation even if X recycled its anchor cell within the 1 s window; that preservation then stops and neither shift is compensated. If the existing preservation fails its `isConnected`/content check, stop it and start a fresh one.
- [ ] **Transient "bad health" on page load** (fix-wave re-review). When the first scan runs before X renders `primaryColumn`, the missing-root path reports `ok:false, cells:0` (a dev console warning) and flips back a second later. Gate the missing-root report on `cells > 0`.
