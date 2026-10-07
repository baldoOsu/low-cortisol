# Privacy

Low Cortisol is designed to keep as much processing as possible on your machine. This document describes what leaves your computer and what stays local.

## Summary

| Destination | What is sent | When |
|---|---|---|
| **TypeSafe** (`api.typesafe.ai`) | Post text and related metadata for classification (see below) | Every post that is classified |
| **Claude** (via your local `claude` CLI / Max login) | Images (and alt text) for posts that need a vision transcript | Only when vision is enabled and text alone did not already trigger a hide |
| **Nowhere else** | — | No analytics, crash telemetry, or phone-home beyond the configured APIs above |

The extension never sends data to X beyond fetching `pbs.twimg.com` media that X already displays in the page. It never reads DMs and never likes, mutes, blocks, replies, posts, or follows.

## What TypeSafe receives

Per classified post, the companion sends a structured state to Jev that may include:

- Author handle and display name
- Post text (visible text only in v1)
- Quoted post author and text (if any)
- Link-card domain, title, and description (if any)
- Image alt text
- Claude image transcripts (when vision ran)

It does **not** send your X cookies, DMs, password, browsing history outside the scanned feed, or your TypeSafe API key to any other party.

`TYPESAFE_API_KEY` is used only as an HTTP authorization credential to TypeSafe. It is never logged, printed, sent to the extension, or passed to `claude`.

## What Claude receives

For posts that still need vision after the text pass, the companion sends image bytes (photos, GIF/video posters, link-card images, media in quoted posts; at most six per post) plus alt text to your local `claude` process. That uses **your** Claude Code login (Max), not an Anthropic API key from this repo.

The companion strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL` from the child environment so the Max login is used.

## Local storage

| Location | Contents | Retention |
|---|---|---|
| `%LOCALAPPDATA%\LowCortisol\cache` (or `$LOW_CORTISOL_HOME/cache`) | Jev verdicts and image transcripts | About 30 days (configurable) |
| `%LOCALAPPDATA%\LowCortisol\logs\companion.log` | Event names, status codes, latencies, error codes | Rotated / left on disk until you delete them |
| `%LOCALAPPDATA%\LowCortisol\config.json` | Optional API key (if you chose file storage), `claude` path, concurrency settings | Until you uninstall with `-Purge` or delete the file |
| Chrome extension storage | Settings, “hidden today” count, and (dev) feedback labels | Until you clear them or remove the extension |

Logs are metadata only: no post text, no images, no API key.

## Fail-open

If the companion is offline, a key is missing, or classification fails, posts stay visible. Nothing is hidden on error.

## Config example

See [`config.example.json`](config.example.json) for the shape of the companion config file. Copy it outside the repo (the installer writes under `%LOCALAPPDATA%\LowCortisol`). Never commit a real `config.json` or API key.
