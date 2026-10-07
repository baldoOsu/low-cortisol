# Contributing

Thanks for helping improve Low Cortisol.

## Setup

Requirements: **Node.js 20+**, Git, and (for live smokes) a TypeSafe API key and Claude Code logged in.

```sh
git clone <repo-url>
cd low-cortisol   # or your local folder name
npm ci
npm run check     # typecheck + tests
npm run build     # refreshes dist/dev, dist/prod, dist/companion
```

Windows install of the companion for manual testing: see [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md).

## Guidelines

- Do **not** commit secrets: `TYPESAFE_API_KEY`, `config.json`, `.env*`, or private `.pem` keys.
- Prefer small, focused pull requests with tests for behavior changes.
- Match existing TypeScript style: strict types, relative extension-less imports, no new runtime npm dependencies unless discussed.
- Keep fail-open behavior: classification or companion errors must leave posts visible.
- Never add code that acts on X (likes, mutes, replies, navigation) or that reads DMs.

## Useful scripts

| Script | Purpose |
|---|---|
| `npm run check` | `tsc --noEmit` + Vitest |
| `npm run build` | Extension + companion bundles |
| `npm run smoke:jev` | Live Jev probe (needs key; prints no secrets) |
| `npm run smoke:vision` | Live image transcript via local `claude` |
| `npm run eval:feedback -- file.jsonl` | Threshold sweep on exported labels |

## License

By contributing, you agree that your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
