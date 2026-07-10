<#
.SYNOPSIS
  A11y Lens - macOS installer build (.app + .dmg) using PowerShell.
.DESCRIPTION
  1. Verifies Node 18+, Rust, and Xcode Command Line Tools.
  2. Compiles the Node sidecar into a standalone binary named per
     Tauri's externalBin convention for the current architecture
     (a11y-sidecar-aarch64-apple-darwin or -x86_64-apple-darwin).
  3. Runs "tauri build", producing the .app and .dmg under
     src-tauri/target/release/bundle/macos/ and /dmg/.
.NOTES
  macOS does not ship Windows PowerShell, so this script runs under
  PowerShell for macOS/Linux, installed with:  brew install --cask powershell
  Then run it with the "pwsh" command shown below.
  Unsigned builds will trigger Gatekeeper; for distribution, set
  APPLE_SIGNING_IDENTITY / APPLE_ID env vars per Tauri's signing docs,
  or right-click > Open for local use.
.USAGE
  pwsh scripts/build-macos.ps1
  pwsh scripts/build-macos.ps1 -Universal   # build for both Apple Silicon and Intel
#>
param([switch]$Universal, [switch]$SkipSidecar)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
. (Join-Path $PSScriptRoot "pkg-prereqs.ps1")

$osName = uname
if ($osName -ne "Darwin") {
  Write-Host "Run this on macOS (use build-windows.ps1 on Windows)." -ForegroundColor Red
  exit 1
}

function Assert-Tool {
  param([string]$Name, [string]$Hint)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing: $Name. $Hint" -ForegroundColor Red
    exit 1
  }
}

Write-Host "== A11y Lens macOS build ==" -ForegroundColor Cyan
Assert-Tool -Name "node"         -Hint "Install Node.js 18+ (brew install node)"
Assert-Tool -Name "cargo"        -Hint "Install Rust from https://rustup.rs"
Assert-Tool -Name "xcode-select" -Hint "Install Xcode Command Line Tools: xcode-select --install"

Write-Host "[1/4] Installing dependencies..." -ForegroundColor Cyan
npm install
npm i playwright axe-core express better-sqlite3

$arch = (uname -m)
if ($arch -eq "arm64") {
  $rustTarget = "aarch64-apple-darwin"
}
else {
  $rustTarget = "x86_64-apple-darwin"
}
$pkgTarget = Get-PkgMacTarget -Arch $arch

if (-not $SkipSidecar) {
  Write-Host ("[2/4] Compiling sidecar for {0}..." -f $rustTarget) -ForegroundColor Cyan
  Write-Host ("  pkg target: {0}" -f $pkgTarget) -ForegroundColor DarkGray
  npx pkg sidecar/server.mjs `
    --targets $pkgTarget `
    --output ("src-tauri/sidecar/a11y-sidecar-" + $rustTarget)
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Sidecar compile failed." -ForegroundColor Red
    exit 1
  }
  chmod +x ("src-tauri/sidecar/a11y-sidecar-" + $rustTarget)

  if ($Universal) {
    if ($rustTarget -eq "aarch64-apple-darwin") {
      $otherTarget = "x86_64-apple-darwin"
      $otherPkg = Get-PkgMacTarget -Arch "x86_64"
    }
    else {
      $otherTarget = "aarch64-apple-darwin"
      $otherPkg = Get-PkgMacTarget -Arch "arm64"
    }
    Write-Host ("        ...and {0} for a universal bundle" -f $otherTarget) -ForegroundColor Cyan
    npx pkg sidecar/server.mjs --targets $otherPkg --output ("src-tauri/sidecar/a11y-sidecar-" + $otherTarget)
    chmod +x ("src-tauri/sidecar/a11y-sidecar-" + $otherTarget)
  }
}
else {
  Write-Host "[2/4] Skipping sidecar compile (per flag)." -ForegroundColor DarkGray
}

Write-Host "[3/4] Building frontend + Tauri bundles..." -ForegroundColor Cyan
if ($Universal) {
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npx tauri build --target universal-apple-darwin
}
else {
  npx tauri build
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "Tauri build failed." -ForegroundColor Red
  exit 1
}

Write-Host "[4/4] Done. Bundles:" -ForegroundColor Green
Get-ChildItem -Recurse "src-tauri/target" -Include *.dmg, *.app -ErrorAction SilentlyContinue |
  Select-Object -First 6 |
  ForEach-Object { Write-Host ("  " + $_.FullName) }

Write-Host ""
Write-Host "Notes:" -ForegroundColor Yellow
Write-Host "  - End users need Playwright's Chromium once: npx playwright install chromium"
Write-Host "  - Unsigned .app: right-click > Open on first launch, or configure signing per Tauri docs."
