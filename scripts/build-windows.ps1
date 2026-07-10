<#
.SYNOPSIS
  A11y Lens - Windows installer build (MSI + NSIS .exe).
.DESCRIPTION
  1. Verifies Node 18+, Rust (MSVC toolchain), and the Tauri CLI.
  2. Installs JS deps and compiles the Node sidecar into a standalone
     .exe with @yao-pkg/pkg, named per Tauri's externalBin convention
     (a11y-sidecar-x86_64-pc-windows-msvc.exe).
  3. Runs "tauri build", producing installers under
     src-tauri\target\release\bundle\msi\ and \nsis\.
.NOTES
  Written for Windows PowerShell 5.1+ (works fine on PowerShell 7 / pwsh too).
  Run from a Developer PowerShell prompt, or any shell with MSVC Build
  Tools installed (Visual Studio Build Tools + "Desktop development with C++").
  WebView2 runtime is bundled/bootstrapped by the installer automatically.
.USAGE
  powershell -File scripts\build-windows.ps1
  powershell -File scripts\build-windows.ps1 -SkipSidecar   # if sidecar exe already built
#>
param([switch]$SkipSidecar)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "pkg-prereqs.ps1")

function Assert-Tool {
  param([string]$Name, [string]$Hint)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing: $Name. $Hint" -ForegroundColor Red
    exit 1
  }
}

Write-Host "== A11y Lens Windows build ==" -ForegroundColor Cyan
Assert-Tool -Name "node"  -Hint "Install Node.js 18+ from https://nodejs.org"
Assert-Tool -Name "cargo" -Hint "Install Rust (MSVC) from https://rustup.rs"

$nodeVersionString = (node --version).TrimStart("v")
$nodeMajor = [int]($nodeVersionString.Split(".")[0])
if ($nodeMajor -lt 18) {
  Write-Host ("Node 18+ required (found v{0})" -f $nodeVersionString) -ForegroundColor Red
  exit 1
}

Write-Host "[1/4] Installing dependencies..." -ForegroundColor Cyan
npm install
npm i playwright axe-core express better-sqlite3

if (-not $SkipSidecar) {
  Write-Host "[2/4] Compiling sidecar to a standalone exe..." -ForegroundColor Cyan
  Add-GitUsrBinToPath
  $pkgTarget = Get-PkgWinTarget
  Write-Host ("  pkg target: {0}" -f $pkgTarget) -ForegroundColor DarkGray
  # @yao-pkg/pkg 6.20.x uses pkg-fetch 3.5.x whose prebuilt binaries are published.
  npx pkg sidecar/server.mjs `
    --targets $pkgTarget `
    --output "src-tauri/sidecar/a11y-sidecar-x86_64-pc-windows-msvc.exe"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Sidecar compile failed." -ForegroundColor Red
    exit 1
  }
}
else {
  Write-Host "[2/4] Skipping sidecar compile (per flag)." -ForegroundColor DarkGray
}

Write-Host "[3/4] Building frontend + Tauri bundles (this takes a while on first run)..." -ForegroundColor Cyan
npx tauri build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Tauri build failed." -ForegroundColor Red
  exit 1
}

Write-Host "[4/4] Done. Installers:" -ForegroundColor Green
Get-ChildItem -Recurse "src-tauri/target/release/bundle" -Include *.msi, *.exe |
  ForEach-Object { Write-Host ("  " + $_.FullName) }

Write-Host ""
Write-Host "Note: end users still need Playwright's Chromium once:" -ForegroundColor Yellow
Write-Host "  npx playwright install chromium   (or ship it via your deployment tooling)"
