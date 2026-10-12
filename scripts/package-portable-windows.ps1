# Windows release artifact: one extracted directory with Node and uv/uvx already bundled.
# Run on Windows after npm ci && npm run build; no user machine prerequisites.
[CmdletBinding()]
param([string]$OutputDirectory = "")
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
  if ((& $node -p 'process.platform+"-"+process.arch').Trim() -ne 'win32-x64') { throw 'The builder must use Windows x64 Node' }
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
  @'
Switchboard portable — Windows x64

1. Extract the entire ZIP into a permanent folder, not inside a temporary ZIP preview.
2. Double-click Start-Switchboard.cmd. Switchboard opens locally at http://127.0.0.1:7777.
3. Open Settings > Plugins & MCP to install Semgrep or link a private OpenSandbox.

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
