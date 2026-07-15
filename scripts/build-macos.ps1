<#
.SYNOPSIS
  A11y Lens - macOS installer build (.app + .dmg).
.DESCRIPTION
  1. Verifies Node 22.5+, Rust, and Xcode Command Line Tools.
  2. Stages the sidecar (dist-sidecar/ + a11y-node-<triple>) via npm run sidecar:build.
  3. Runs tauri build, producing .app and .dmg under src-tauri/target/release/bundle/.
.NOTES
  Must run ON macOS (cannot cross-compile from Windows).
  Install PowerShell on Mac: brew install --cask powershell
  Unsigned builds: right-click > Open on first launch, or configure Apple signing.
.USAGE
  pwsh scripts/build-macos.ps1
  pwsh scripts/build-macos.ps1 -SkipSidecar
  pwsh scripts/build-macos.ps1 -Universal   # Rust universal binary; see note below
#>
param([switch]$Universal, [switch]$SkipSidecar)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if ((uname) -ne "Darwin") {
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

function Assert-Node225 {
  $ver = (node --version).TrimStart("v").Split(".")
  $major = [int]$ver[0]; $minor = [int]$ver[1]
  if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    Write-Host ("Node 22.5+ required (found v{0}.{1}). The build ships your Node as a11y-node." -f $major, $minor) -ForegroundColor Red
    exit 1
  }
}

Write-Host "== A11y Lens macOS build ==" -ForegroundColor Cyan
Assert-Tool -Name "node"         -Hint "brew install node"
Assert-Tool -Name "cargo"        -Hint "Install Rust from https://rustup.rs"
Assert-Tool -Name "xcode-select" -Hint "xcode-select --install"
Assert-Node225

Write-Host "[1/4] Installing dependencies..." -ForegroundColor Cyan
npm install

if (-not $SkipSidecar) {
  Write-Host "[2/4] Staging sidecar (Node runtime + dist-sidecar/)..." -ForegroundColor Cyan
  npm run sidecar:build
  if ($LASTEXITCODE -ne 0) {
    Write-Host "sidecar:build failed." -ForegroundColor Red
    exit 1
  }
}
else {
  Write-Host "[2/4] Skipping sidecar staging (per flag)." -ForegroundColor DarkGray
}

if ($Universal) {
  Write-Host "[3/4] Building universal .app + .dmg (aarch64 + x86_64)..." -ForegroundColor Cyan
  Write-Host @"
        Note: sidecar:build only copies THIS Mac's Node as a11y-node-<triple>.
        For a universal bundle you need a11y-node for BOTH architectures in
        src-tauri/sidecar/ — run sidecar:build on an Intel Mac and an Apple
        Silicon Mac, or copy the other arch binary manually, before building.
"@ -ForegroundColor Yellow
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npx tauri build --target universal-apple-darwin
}
else {
  Write-Host "[3/4] Building .app + .dmg for this architecture..." -ForegroundColor Cyan
  npx tauri build
}

if ($LASTEXITCODE -ne 0) {
  Write-Host "Tauri build failed." -ForegroundColor Red
  exit 1
}

Write-Host "[4/4] Done. Bundles:" -ForegroundColor Green
Get-ChildItem -Recurse "src-tauri/target/release/bundle" -Include *.dmg, *.app -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host ("  " + $_.FullName) }

Write-Host ""
Write-Host "Notes:" -ForegroundColor Yellow
Write-Host "  - End users need Playwright Chromium once (see scripts/prereq-windows.ps1 pattern on Mac)."
Write-Host "  - Prefer: npm run tauri:build  (same as this script's sidecar + tauri steps)"
