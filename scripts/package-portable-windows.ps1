# Windows release artifact: one extracted directory with Node and uv/uvx already bundled.
# Run on Windows after npm ci && npm run build; no user machine prerequisites.
[CmdletBinding()]
param([string]$OutputDirectory = "", [string]$LocalCoreSource = "")
# Pinned BotConnector Local Core source: one portable installation reusing its
# original runtime/model/download/ownership implementation, not a reimplementation.
$LocalCoreRev = '1aa37824ea5d6bcd35f499c892a68cecfa695660'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo 'artifacts' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stage = Join-Path $env:TEMP ("switchboard-portable-" + [guid]::NewGuid().ToString('N'))
$root = Join-Path $stage "Switchboard-$version"
$artifact = Join-Path $OutputDirectory "Switchboard-$version-Windows-x64.zip"
if (Test-Path $artifact) { throw "Artifact exists: refusing overwrite ($artifact)" }
try {
  New-Item -ItemType Directory -Path (Join-Path $root 'runtime'), (Join-Path $root 'app') -Force | Out-Null
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $uv = (Get-Command uv.exe -ErrorAction Stop).Source
  $uvx = (Get-Command uvx.exe -ErrorAction Stop).Source
  if (-not ([Environment]::Is64BitOperatingSystem)) { throw 'Windows x64 is required' }
  if ((& $node -p process.platform).Trim() -ne 'win32' -or (& $node -p process.arch).Trim() -ne 'x64') { throw 'The builder must use Windows x64 Node' }
  if ((& $uv --version) -notmatch '^uv [0-9]+\.') { throw 'uv binary version verification failed' }
  Copy-Item $node (Join-Path $root 'runtime\node.exe')
  Copy-Item $uv (Join-Path $root 'runtime\uv.exe')
  Copy-Item $uvx (Join-Path $root 'runtime\uvx.exe')
  # The full runtime must include the applicable upstream license texts.
  $nodeLicense = Join-Path (Split-Path $node) 'LICENSE'
  $nodeVer = (& $node --version).Trim()
  if (Test-Path $nodeLicense) {
    Copy-Item $nodeLicense (Join-Path $root 'runtime\NODE-LICENSE.txt')
  } else {
    # Official source license from the exact Node release, not an arbitrary third-party site.
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVer/LICENSE" -OutFile (Join-Path $root 'runtime\NODE-LICENSE.txt')
  }
  $uvVer = ((& $uv --version).Trim() -split ' ')[1]
  $uvLicense = Get-ChildItem (Split-Path $uv) -File | Where-Object { $_.Name -match '^LICENSE' } | Select-Object -First 1
  if ($uvLicense) {
    Copy-Item $uvLicense.FullName (Join-Path $root 'runtime\UV-LICENSE-MIT.txt')
  } else {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/astral-sh/uv/$uvVer/LICENSE-MIT" -OutFile (Join-Path $root 'runtime\UV-LICENSE-MIT.txt')
  }
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/astral-sh/uv/$uvVer/LICENSE-APACHE" -OutFile (Join-Path $root 'runtime\UV-LICENSE-APACHE.txt')
  foreach ($item in @('NODE-LICENSE.txt','UV-LICENSE-MIT.txt','UV-LICENSE-APACHE.txt')) {
    if ((Get-Item (Join-Path $root "runtime\$item")).Length -lt 1000) { throw "Incomplete upstream license: $item" }
  }
  foreach ($name in @('dist','web')) {
    $source = Join-Path $repo $name
    if (-not (Test-Path $source)) { throw "Missing built $source" }
    Copy-Item -Recurse $source (Join-Path $root 'app')
  }
  foreach ($file in @('package.json','package-lock.json','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md')) {
    Copy-Item (Join-Path $repo $file) (Join-Path $root 'app')
  }
  # Bundle the ORIGINAL BotConnector Local CLI/manager in the same ZIP.
  # A full source SHA is mandatory; never distribute a moving branch head.
  $coreSourceDir = $LocalCoreSource
  if (-not $coreSourceDir) {
    $coreSourceDir = Join-Path $stage 'botconnector-local-core-source'
    & git clone --quiet --no-checkout https://github.com/farijarifriyanto-debug/BotConnector.git $coreSourceDir
    if ($LASTEXITCODE -ne 0) { throw 'Cannot clone original BotConnector Local Core' }
    & git -C $coreSourceDir fetch --quiet --depth 1 origin $LocalCoreRev
    if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch pinned BotConnector Local Core commit' }
    & git -C $coreSourceDir checkout --quiet --detach $LocalCoreRev
    if ($LASTEXITCODE -ne 0) { throw 'Cannot check out pinned BotConnector Local Core commit' }
  }
  $coreSourceDir = (Resolve-Path $coreSourceDir).Path
  $verifiedCoreRev = (& git -C $coreSourceDir rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $verifiedCoreRev -ne $LocalCoreRev) {
    throw "Refuse to embed a mismatched BotConnector Local Core source: $verifiedCoreRev"
  }
  $coreRoot = Join-Path $root 'local-core'
  New-Item -ItemType Directory -Path $coreRoot -Force | Out-Null
  foreach ($dirName in @('bin','runtime','webui','registry','tui','agent','desktop','assets','scripts')) {
    Copy-Item -Path (Join-Path $coreSourceDir $dirName) -Destination $coreRoot -Recurse -ErrorAction Stop
  }
  $coreWeb = Join-Path $coreSourceDir 'dist\web'
  if (Test-Path $coreWeb) {
    New-Item -ItemType Directory -Path (Join-Path $coreRoot 'dist') -Force | Out-Null
    Copy-Item -Path $coreWeb -Destination (Join-Path $coreRoot 'dist') -Recurse
  }
  foreach ($fileName in @('package.json','package-lock.json','LICENSE','README.md','state.cjs','sessions.cjs','projects.cjs','doctor.cjs')) {
    Copy-Item -Path (Join-Path $coreSourceDir $fileName) -Destination $coreRoot -ErrorAction Stop
  }
  "BotConnector Local Core revision: $LocalCoreRev" | Set-Content (Join-Path $coreRoot 'SOURCE-REVISION.txt') -Encoding Ascii
  & $node (Join-Path $coreRoot 'scripts\build-web.mjs')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $coreRoot 'dist\web\index.html'))) {
    throw 'Original BotConnector Local model manager UI did not build'
  }
  Push-Location $coreRoot
  try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installing original BotConnector Local runtime dependencies failed' }
    & $node (Join-Path $coreRoot 'bin\botconnector.mjs') --help *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Bundled BotConnector Local CLI cannot launch' }
  } finally { Pop-Location }

  Push-Location (Join-Path $root 'app')
  try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installing production dependencies failed' }
  } finally { Pop-Location }
  @'
@echo off
setlocal
set "SWITCHBOARD_HOME=%~dp0"
set "PATH=%SWITCHBOARD_HOME%runtime;%PATH%"
cd /d "%USERPROFILE%"
"%SWITCHBOARD_HOME%runtime\node.exe" "%SWITCHBOARD_HOME%app\dist\cli.js" web %*
if errorlevel 1 pause
'@ | Set-Content -Path (Join-Path $root 'Start-Switchboard.cmd') -Encoding Ascii
  # Manage AI models using the ORIGINAL BotConnector UI, not another
  # Switchboard model manager. Same user data, downloads and ownership locks.
  @'
@echo off
setlocal
set "SWITCHBOARD_HOME=%~dp0"
set "PATH=%SWITCHBOARD_HOME%runtime;%PATH%"
cd /d "%USERPROFILE%"
"%SWITCHBOARD_HOME%runtime\node.exe" "%SWITCHBOARD_HOME%local-core\bin\botconnector.mjs" ui --ui-port 32100
if errorlevel 1 pause
'@ | Set-Content -Path (Join-Path $root 'Manage-Local-AI.cmd') -Encoding Ascii
  @'
@echo off
setlocal
set "SWITCHBOARD_HOME=%~dp0"
set "PATH=%SWITCHBOARD_HOME%runtime;%PATH%"
"%SWITCHBOARD_HOME%runtime\node.exe" "%SWITCHBOARD_HOME%local-core\bin\botconnector.mjs" runtime status --json
if errorlevel 1 pause
'@ | Set-Content -Path (Join-Path $root 'Check-Local-AI.cmd') -Encoding Ascii
  @'
Switchboard portable — Windows x64

1. Extract the entire ZIP into a permanent folder, not inside a temporary ZIP preview.
2. Double-click Start-Switchboard.cmd. Switchboard opens locally at http://127.0.0.1:7777.
3. Optional Local AI (included in this ONE portable ZIP): double-click Manage-Local-AI.cmd.
   This starts the ORIGINAL BotConnector Local manager at 127.0.0.1. Choose a
   compatible runtime and download/start GGUF models there, on user request only.
   Switchboard Settings > Models > AI Lokal > Periksa ulang > Plug / Hubungkan.
   Check-Local-AI.cmd shows current runtime health. No model is downloaded silently.
4. Open Settings > Plugins & MCP to install Semgrep or link a private OpenSandbox.

Node.js, uv/uvx, and PINNED BotConnector Local Core are bundled; no second
BotConnector installation or Node.js installation is required. The original Core
maintains model downloads, shared user data, ownership rules and runtime binaries.
Models / llama.cpp binaries are NOT preinstalled (size, licensing and GPU choices
vary). Use the original manager to choose and install them.

Node.js and uv/uvx are already included in this portable package; no separate npm or uv installation is required. Python MCP packages are downloaded from their official pinned PyPI versions only when you install the plugin (internet required on first use).
Keep existing ~/.switchboard settings on upgrades; nothing is automatically deleted.
OpenSandbox must use your own private authenticated endpoint. Do not open its API directly to the public internet.
'@ | Set-Content -Path (Join-Path $root 'README-START.txt') -Encoding UTF8
  Compress-Archive -Path $root -DestinationPath $artifact -CompressionLevel Optimal
  $hash = (Get-FileHash -Path $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $(Split-Path $artifact -Leaf)" | Set-Content ($artifact+'.sha256') -Encoding Ascii
  Write-Output "PORTABLE_WINDOWS_READY $artifact"
  Write-Output "SHA256 $hash"
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
