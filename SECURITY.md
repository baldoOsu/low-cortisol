# Security

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories on this repository (or by opening a private contact with the maintainer if Advisories are not enabled yet). Do **not** file a public issue that includes secrets, live API keys, or exploit details against third-party services.

We aim to acknowledge reports promptly and will coordinate a fix before any public disclosure.

## Secrets and keys

- **TypeSafe API key** (`TYPESAFE_API_KEY`): store it as a user environment variable or in `%LOCALAPPDATA%\LowCortisol\config.json` (installer `-KeyStore File`). Never commit it, paste it into issues/PRs, or put it under this repo.
- **Claude**: uses your local Claude Code login. Do not put Anthropic API keys into this project; the companion deliberately strips Anthropic API env vars from the `claude` child process.
- **Extension signing keys**: only public keys under `extension/keys/*.pub.b64` are committed (they pin stable extension IDs). Private `.pem` files must never be committed (see `.gitignore`).

## Rotation

If a TypeSafe key may have leaked:

1. Revoke or rotate it in the TypeSafe dashboard.
2. Clear the old value:
   ```powershell
   [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $null, 'User')
   ```
   and remove `typesafeApiKey` from `%LOCALAPPDATA%\LowCortisol\config.json` if present.
3. Re-run `dist\companion\install-windows.ps1` and fully restart Chrome.

## Threat model (short)

- The extension only talks to the local Native Messaging companion and fetches media from `pbs.twimg.com` that X already shows.
- The companion only talks to `api.typesafe.ai` and the local `claude` CLI.
- Fail-open: errors leave posts visible.
- Native Messaging `allowed_origins` are pinned to the published extension IDs in `dist/extension-ids.json`.

## Supply chain

Prefer `npm ci` from a clean checkout. Review changes to `scripts/`, the installer PowerShell, and Native Messaging registration before running them on a machine with secrets.
