# Low Cortisol

Low Cortisol is a Chrome (Manifest V3) extension for [x.com](https://x.com) that hides ragebait and other posts built to provoke negative emotions. [TypeSafe](https://typesafe.ai) **Jev** judges each post’s text. For posts with images, a small **local companion** asks **Claude** (via your own Claude Max login and `claude -p`) for a neutral text transcript, then Jev judges again with that transcript.

Hidden posts are removed completely—no stub or placeholder. If anything fails, posts stay visible (**fail open**).

## Hard rules

Enforced in code and tests:

- **Never act on X** — no likes, mutes, blocks, replies, posts, or follows; no navigation driven by the extension.
- **Never read DMs** — the scanner skips `/messages` and only reads posts in the main column.
- **Only talk to TypeSafe and your local Claude login** — the companion calls `api.typesafe.ai` and spawns `claude`; `TYPESAFE_API_KEY` is never logged, printed, sent to the extension, or passed to `claude`.

## Architecture

```
Your Windows PC
+------------------------- Chrome -------------------------+
| content script (x.com)         service worker            |
|  scanner -> PostSnapshot --port--> pipeline --native--+  |
|  decide() + hider <------result--- media fetch (pbs)  |  |
| popup (prod / dev) <-- storage + getStatus -----------+  |
+-------------------------------------------------------+--+
                                                        | stdio, 4-byte length-prefixed JSON
                              companion (Node, host.cjs)
                              |- Jev client -- HTTPS --> api.typesafe.ai (TYPESAFE_API_KEY)
                              |- transcriber -- spawn -> claude.exe -p (Max login)
                              '- file cache (30 days), log (no secrets)
```

## Builds

Build output is committed under `dist/`, so you can load the extensions without building:

| Folder | What it is |
|---|---|
| `dist/prod` | **Low Cortisol** — Hide ragebait toggle and “N hidden today”. Balanced strictness (0.70) and Opus 5.5. |
| `dist/dev` | **Low Cortisol (Dev)** — per-post panels, strictness slider, vision/model settings, status, feedback export. Starts in labelling mode (shows results, does not hide). |
| `dist/companion` | Native Messaging host (`host.cjs`), Windows install/uninstall scripts, `extension-ids.json` |
| `dist/extension-ids.json` | Pinned dev and prod extension IDs |

Both extensions can load side by side. IDs stay stable because each manifest embeds a pinned public key.

## Quick start

```sh
git clone https://github.com/baldodev/low-cortisol
cd low-cortisol
```

Or clone with your own remote URL. Then:

1. **Load unpacked** in `chrome://extensions` (Developer mode): pick `dist\prod` and/or `dist\dev`.
2. **Install the companion** (Windows) — see **[docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File dist\companion\install-windows.ps1
   ```
3. Fully quit and restart Chrome so it picks up `TYPESAFE_API_KEY` (unless you used `-KeyStore File`).
4. Open x.com and use the extension popup to confirm the companion is online.

### Set `TYPESAFE_API_KEY`

The companion reads the key from the `TYPESAFE_API_KEY` environment variable first, then from `typesafeApiKey` in `%LOCALAPPDATA%\LowCortisol\config.json`.

- **Default:** the installer prompts (input hidden) when the env var is missing.
- **`-KeyStore File`:** stores the key in `config.json` (readable only by your Windows user).
- **`-KeyStore Skip`:** leaves key setup alone.

See [`config.example.json`](config.example.json) for the config file shape. **Never** commit a real key or `config.json`.

## Dev workflow

```sh
npm ci
npm run check                           # typecheck + tests
npm run build                           # refresh dist/
npm run smoke:jev                       # live Jev (needs TYPESAFE_API_KEY; no secrets printed)
npm run smoke:vision                    # live image transcript via local claude
npm run eval:feedback -- file.jsonl     # threshold sweep on exported labels
```

## Switch transcript models

- **Dev:** popup → **Transcript model**: Opus 5.5 (default) or Sonnet 5.5. Applies to the next transcript; cache is per model.
- **Prod:** always Opus 5.5.

## Privacy

- **TypeSafe** receives post text and related metadata for classification (author, text, quote/card fields, alts, image transcripts).
- **Claude** (your login) receives images only when vision runs.
- **Local cache** (≈30 days): verdicts and transcripts under `%LOCALAPPDATA%\LowCortisol`.
- **No product telemetry** beyond those configured API calls.

Full detail: **[PRIVACY.md](PRIVACY.md)**. Security reporting and key rotation: **[SECURITY.md](SECURITY.md)**.

## Status and known risks

v1 (2026-09-30).

1. **X DOM drift** — selectors may need updates when X changes markup; fail-open means nothing is hidden if scanning breaks.
2. **Scroll jumps** when a post above the viewport is removed (anchor correction exists; watch on real feeds).
3. **Claude Max quota** is shared with your other Claude usage; the dev status shows utilization.
4. **Jev calibration** on your feed may need labelling + `npm run eval:feedback`.
5. **Chrome restart** is required after storing the key in the user environment (or use `-KeyStore File`).

## Docs

- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) — Windows companion install
- [PRIVACY.md](PRIVACY.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [LICENSE](LICENSE)
- [docs/TODO.md](docs/TODO.md) — deferred product work
- [docs/superpowers/specs/2026-09-30-low-cortisol-design.md](docs/superpowers/specs/2026-09-30-low-cortisol-design.md) — design spec
- [docs/superpowers/plans/2026-09-30-low-cortisol.md](docs/superpowers/plans/2026-09-30-low-cortisol.md) — historical implementation plan

## License

MIT Copyright 2026 Mihai Robert Peptan — see [LICENSE](LICENSE).
