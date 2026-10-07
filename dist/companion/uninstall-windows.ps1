# Low Cortisol companion uninstaller (Windows, per-user). Spec section 5.
# Removes the Chrome Native Messaging registration and the companion folder.
#   -Purge      also removes the whole install dir (cache, logs, config.json)
#   -RemoveKey  also clears the TYPESAFE_API_KEY user environment variable
# The extensions themselves are removed in chrome://extensions.

param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'LowCortisol'),
  [switch]$Purge,
  [switch]$RemoveKey
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# Absolute path, as the installer uses (a relative -InstallDir resolves against the current location).
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)

$RegKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.lowcortisol.companion'

if (Test-Path -LiteralPath $RegKey) {
  Remove-Item -LiteralPath $RegKey -Recurse -Force
  Write-Host "Removed registry key $RegKey"
} else {
  Write-Host 'Native Messaging host was not registered.'
}

$target = if ($Purge) { $InstallDir } else { Join-Path $InstallDir 'companion' }
if (Test-Path -LiteralPath $target) {
  try {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "Removed $target"
  } catch {
    Write-Host "Could not remove $target. Fully quit Chrome (check the system tray) and run this again." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "$target does not exist."
}
if (-not $Purge -and (Test-Path -LiteralPath $InstallDir)) {
  Write-Host "Kept $InstallDir (cache, logs, config.json). Use -Purge to remove it."
}

if ($RemoveKey) {
  [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $null, 'User')
  Write-Host 'Cleared TYPESAFE_API_KEY from your user environment.'
}
