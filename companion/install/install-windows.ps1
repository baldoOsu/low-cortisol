# Low Cortisol companion installer (Windows, per-user). Spec section 5 "Windows install".
# Run from dist\companion:  powershell -ExecutionPolicy Bypass -File dist\companion\install-windows.ps1
# The TypeSafe key is never echoed, logged or written anywhere except the chosen key store.

param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'LowCortisol'),
  [ValidateSet('Env','File','Skip')][string]$KeyStore = 'Env',
  [switch]$NoSelfTest,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# Absolute path: it goes into run-host.cmd, the manifest, the registry and .NET file calls (whose
# current directory is not PowerShell's location).
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)

$HostName = 'com.lowcortisol.companion'
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$Utf8NoBom = New-Object Text.UTF8Encoding $false

function Fail([string]$Message) {
  Write-Host $Message -ForegroundColor Red
  exit 1
}

function Warn([string]$Message) {
  Write-Host "WARNING: $Message" -ForegroundColor Yellow
}

# Runs $Action, or with -DryRun only prints "[dry-run] $Description".
function Invoke-Step([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Write-Host "[dry-run] $Description" } else { & $Action }
}

function Read-Config([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $raw = [IO.File]::ReadAllText($Path)
    if ($raw.Trim()) { return ($raw | ConvertFrom-Json) }
  }
  return (New-Object PSObject)
}

# Sets one property in config.json, keeping the others. Writes UTF-8 without BOM (an existing file keeps its ACL).
function Set-ConfigValue([string]$Path, [string]$Name, $Value) {
  $cfg = Read-Config $Path
  $cfg | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  [IO.File]::WriteAllText($Path, ($cfg | ConvertTo-Json -Depth 5), $Utf8NoBom)
}

# Stores the key in config.json and restricts the file to the current user. Never prints the key.
function Save-KeyToConfig([string]$Path, [string]$Key) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  Set-ConfigValue $Path 'typesafeApiKey' $Key
  icacls $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn "icacls could not restrict $Path to $($env:USERNAME)." }
}

function Test-ConfigHasKey([string]$Path) {
  try {
    $cfg = Read-Config $Path
    $prop = $cfg.PSObject.Properties['typesafeApiKey']
    return [bool]($prop -and $prop.Value)
  } catch {
    return $false
  }
}

# ---- 1. Build output next to this script ----
$src = $PSScriptRoot
$hostSrc = Join-Path $src 'host.cjs'
$idsSrc = Join-Path $src 'extension-ids.json'
if (-not (Test-Path -LiteralPath $hostSrc) -or -not (Test-Path -LiteralPath $idsSrc)) {
  Fail "Run 'npm run build' first (dist\companion)"
}
$ids = [IO.File]::ReadAllText($idsSrc) | ConvertFrom-Json
foreach ($flavor in 'dev', 'prod') {
  $id = $ids.PSObject.Properties[$flavor]
  if (-not $id -or "$($id.Value)" -cnotmatch '^[a-p]{32}$') {
    Fail "extension-ids.json has no valid '$flavor' extension id. Run 'npm run build' first (dist\companion)"
  }
}
if ($ids.PSObject.Properties['hostName'] -and $ids.hostName -ne $HostName) {
  Warn "extension-ids.json hostName is '$($ids.hostName)', expected '$HostName'."
}

# ---- 2. Node.js ----
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) {
  Fail 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS  (then open a new PowerShell window)'
}
$node = $nodeCmd.Source
$nodeVersion = (& $node --version) -join ''
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
  Warn "Node.js $nodeVersion found at $node; Low Cortisol needs Node 20 or newer (winget install OpenJS.NodeJS.LTS)."
}
Write-Host "Node.js: $node ($nodeVersion)"

# ---- 3. Claude Code (native claude.exe) ----
$claude = $null
$claudeExe = Get-Command claude.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($claudeExe) {
  $claude = $claudeExe.Source
} else {
  $fallback = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $fallback) { $claude = $fallback }
}
if ($claude) {
  Write-Host "Claude Code: $claude"
} else {
  $shim = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($shim) {
    Warn "Only a claude shim was found ($($shim.Source)). Low Cortisol needs the native claude.exe: irm https://claude.ai/install.ps1 | iex"
  } else {
    Warn 'Claude Code was not found. Image transcripts will fail (posts are still judged on text) until you install it (irm https://claude.ai/install.ps1 | iex), run claude once and /login with your Max account.'
  }
}

$companionDir = Join-Path $InstallDir 'companion'
$hostDst = Join-Path $companionDir 'host.cjs'
$runHost = Join-Path $companionDir 'run-host.cmd'
$manifestPath = Join-Path $companionDir "$HostName.json"
$cfgPath = Join-Path $InstallDir 'config.json'

# ---- 4. Copy host.cjs ----
Invoke-Step "create $companionDir and copy host.cjs to $hostDst" {
  New-Item -ItemType Directory -Force -Path $companionDir | Out-Null
  Copy-Item -LiteralPath $hostSrc -Destination $hostDst -Force
}

# ---- 5. run-host.cmd (CRLF, OEM code page so cmd.exe reads non-ASCII paths correctly) ----
# LOW_CORTISOL_HOME pins the host to $InstallDir (config.json, cache, logs) whatever -InstallDir was.
# '%' is doubled so cmd.exe does not expand it inside a batch file.
$cmdHome = $InstallDir.Replace('%', '%%')
$cmdNode = $node.Replace('%', '%%')
$runHostText = "@echo off`r`nset `"LOW_CORTISOL_HOME=$cmdHome`"`r`n`"$cmdNode`" `"%~dp0host.cjs`" %*`r`n"
Invoke-Step "write $runHost (sets LOW_CORTISOL_HOME=$InstallDir, runs `"$node`" `"%~dp0host.cjs`")" {
  $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  [IO.File]::WriteAllText($runHost, $runHostText, $oem)
}

# ---- 6. Native Messaging host manifest ----
$origins = @("chrome-extension://$($ids.dev)/", "chrome-extension://$($ids.prod)/")
$manifest = [ordered]@{
  name = $HostName
  description = 'Low Cortisol companion'
  path = $runHost
  type = 'stdio'
  allowed_origins = $origins
}
$manifestJson = $manifest | ConvertTo-Json -Depth 3
Invoke-Step "write $manifestPath (allowed_origins: $($origins -join ', '))" {
  [IO.File]::WriteAllText($manifestPath, $manifestJson, $Utf8NoBom)
}

# ---- 7. Register the host for Chrome (current user) ----
Invoke-Step "set registry $RegKey (Default) = $manifestPath" {
  New-Item -Path $RegKey -Force | Out-Null
  Set-Item -Path $RegKey -Value $manifestPath
}

# ---- 8. TypeSafe API key ----
$userEnvHasKey = [bool][Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
if ($KeyStore -eq 'Skip') {
  Write-Host 'Key setup skipped (-KeyStore Skip).'
} elseif ($KeyStore -eq 'File' -and (Test-ConfigHasKey $cfgPath)) {
  Write-Host 'TYPESAFE_API_KEY is already stored in config.json; not prompting.'
} elseif ($KeyStore -eq 'File' -and $userEnvHasKey) {
  # The host reads config.json even when Chrome was started without the user environment key.
  Invoke-Step "copy TYPESAFE_API_KEY from your user environment into $cfgPath (restricted to $($env:USERNAME))" {
    Save-KeyToConfig $cfgPath ([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User'))
    Write-Host 'TYPESAFE_API_KEY copied from your user environment (config.json)'
  }
} elseif ($userEnvHasKey) {
  Write-Host 'TYPESAFE_API_KEY is already set in your user environment; not prompting.'
} elseif ($DryRun) {
  $where = if ($KeyStore -eq 'Env') { 'the user environment' } else { "$cfgPath (restricted to $($env:USERNAME))" }
  Write-Host "[dry-run] prompt for TYPESAFE_API_KEY (input hidden) and store it in $where"
} else {
  $secure = Read-Host -AsSecureString 'TYPESAFE_API_KEY (input hidden)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if (-not $plain) {
    Warn 'No key entered. Text classification reports NO_API_KEY until you re-run this script.'
  } elseif ($KeyStore -eq 'Env') {
    [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $plain, 'User')
    Write-Host 'TYPESAFE_API_KEY stored (user environment)'
  } else {
    Save-KeyToConfig $cfgPath $plain
    Write-Host 'TYPESAFE_API_KEY stored (config.json)'
  }
  $plain = $null
  $secure = $null
}

# ---- 9. claudePath in config.json ----
if ($claude) {
  Invoke-Step "set claudePath = $claude in $cfgPath" {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Set-ConfigValue $cfgPath 'claudePath' $claude
  }
}

# ---- 10. Self-test ----
if (-not $NoSelfTest) {
  # Through run-host.cmd, as Chrome launches it, so the test sees the same LOW_CORTISOL_HOME.
  Invoke-Step "run `"$runHost`" --self-test (LOW_CORTISOL_HOME=$InstallDir, as set by run-host.cmd)" {
    $prevKey = $env:TYPESAFE_API_KEY
    try {
      # A key just stored in the user environment is not in this process yet; Chrome gets it after a restart.
      if (-not $env:TYPESAFE_API_KEY) {
        $env:TYPESAFE_API_KEY = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
      }
      & $runHost --self-test
      if ($LASTEXITCODE -ne 0) { Warn 'The self-test reported a problem (see above). Posts stay visible until it is fixed.' }
    } finally {
      $env:TYPESAFE_API_KEY = $prevKey
    }
  }
}

# ---- 11. Chrome restart ----
Write-Host ''
Write-Host 'Fully quit Chrome (check the system tray) and start it again so it picks up the new environment.'
