# Installing Low Cortisol on Windows

This is for the PC where you browse X in Chrome. Everything installs for your Windows user only; no administrator rights are needed.

## 1. Prerequisites

- **Chrome** (desktop).
- **Node.js 20 or newer:**
  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```
  Open a new PowerShell window afterwards so `node` is on `PATH`.
- **Claude Code, native install** (needed for image transcripts; text filtering works without it):
  ```powershell
  irm https://claude.ai/install.ps1 | iex
  ```
  Then run `claude` once and type `/login`, choosing your **Claude Max** account. Low Cortisol uses the native `claude.exe`; an npm-installed `claude.cmd` shim is not supported in v1.
- Your **TypeSafe API key** (`TYPESAFE_API_KEY`).

## 2. Get the repo folder

Either clone it:

```powershell
git clone <repo-url> C:\LowCortisol
```

or copy the whole folder to, for example, `C:\LowCortisol`. The rest of this guide runs from that folder:

```powershell
cd C:\LowCortisol
```

## 3. (Optional) Build

`dist` is committed, so this is only needed if you changed the code:

```powershell
npm ci
npm run build
```

## 4. Load the extensions

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `dist\prod` (the everyday build) and/or `dist\dev` (the tuning build).
3. The IDs Chrome shows should match `dist\extension-ids.json`. The companion only accepts those two IDs.

## 5. Install the companion

```powershell
powershell -ExecutionPolicy Bypass -File dist\companion\install-windows.ps1
```

It will:
- check Node.js and find `claude.exe`;
- copy the companion to `%LOCALAPPDATA%\LowCortisol\companion` and register it with Chrome (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.lowcortisol.companion`);
- ask for `TYPESAFE_API_KEY` if it isn't already in your user environment. Paste it at the prompt; the input is hidden and the key is never shown. It is stored as a user environment variable;
- save the `claude.exe` path in `%LOCALAPPDATA%\LowCortisol\config.json`;
- run a self-test (Jev probe and Claude CLI check) through `companion\run-host.cmd`, the same launcher Chrome uses.

Options:

| Option | Effect |
|---|---|
| `-KeyStore File` | Store the key in `config.json` (only your user can read it) instead of the environment. If the key is already in your user environment, it is copied into `config.json` without prompting (and never shown). |
| `-KeyStore Skip` | Don't touch the key. |
| `-NoSelfTest` | Skip the self-test. |
| `-InstallDir <path>` | Install somewhere other than `%LOCALAPPDATA%\LowCortisol` (a relative path is resolved against the current folder). The launcher `companion\run-host.cmd` sets `LOW_CORTISOL_HOME` to this folder, so the companion keeps `config.json`, its cache and its logs there. |
| `-DryRun` | Print what would be done (`[dry-run] ...`) without changing anything. |

To replace the key later, clear it and re-run the installer:

```powershell
[Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $null, 'User')
powershell -ExecutionPolicy Bypass -File dist\companion\install-windows.ps1
```

## 6. Fully restart Chrome

Quit Chrome completely: close every window **and** check the system tray (Chrome can keep running in the background). Then start it again. Chrome only picks up the new `TYPESAFE_API_KEY` after a full restart.

## 7. Check it works

Open x.com, then click the extension icon:
- **Prod:** you see the **Hide ragebait** switch and "N hidden today". A red line "Companion offline: nothing is being filtered." means the companion isn't reachable (see Troubleshooting).
- **Dev:** the status block should say `Companion: online`, `Jev key: configured` and `Claude CLI: found`. The dev build starts in labelling mode: it shows a results panel in each post but doesn't hide anything until you turn on **Hide ragebait**.

## 8. Switching models

- Dev popup → **Transcript model**: "Opus 5.5 (default)" or "Sonnet 5.5".
- Prod always uses Opus 5.5.

## 9. Troubleshooting

- **Red `!` badge on the extension icon:** the companion is offline. Check that you ran the installer and fully restarted Chrome. Everything stays visible while it's offline.
- **Logs:** `%LOCALAPPDATA%\LowCortisol\logs\companion.log`, or `<InstallDir>\logs\companion.log` with `-InstallDir` (metadata only, never post text or the key).
- **Self-test, including a tiny image transcript** (through the same launcher Chrome uses):
  ```powershell
  & $env:LOCALAPPDATA\LowCortisol\companion\run-host.cmd --self-test --vision
  ```
  (In `cmd.exe`: `%LOCALAPPDATA%\LowCortisol\companion\run-host.cmd --self-test --vision`. With `-InstallDir`, use `<InstallDir>\companion\run-host.cmd`.) Run it in a new PowerShell window so it sees the stored key.
- **`Jev key: missing`:** the key isn't in Chrome's environment. Fully restart Chrome, or re-run the installer with `-KeyStore File`: it copies the key from your user environment into `config.json`, which the companion reads however Chrome was started.
- **`Claude CLI: not found`** or image transcripts failing: install Claude Code natively (step 1), run `claude` and `/login`, then re-run the installer so it records the `claude.exe` path.
- **Extension ID changed?** It shouldn't: each build pins its key, so reloading an unpacked extension keeps the same ID. If `chrome://extensions` shows an ID that isn't in `dist\extension-ids.json`, you loaded a folder other than `dist\dev` or `dist\prod`.

## 10. Updating

```powershell
cd C:\LowCortisol
git pull
powershell -ExecutionPolicy Bypass -File dist\companion\install-windows.ps1
```

Then click the reload icon on the extension cards in `chrome://extensions` (or restart Chrome). The installer doesn't ask for the key again if it's already stored.

## 11. Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File dist\companion\uninstall-windows.ps1
```

This removes the Chrome registration and `%LOCALAPPDATA%\LowCortisol\companion`, and keeps the cache, logs and `config.json`. Options:
- `-Purge` removes all of `%LOCALAPPDATA%\LowCortisol` (cache, logs, config).
- `-RemoveKey` clears `TYPESAFE_API_KEY` from your user environment.

Then remove the extensions in `chrome://extensions`.
