<#
.SYNOPSIS
  A11y Lens - development launcher.
  Starts the Node sidecar and the Tauri desktop app together.
.USAGE
  powershell -File scripts\launch-dev.ps1            # full desktop app
  powershell -File scripts\launch-dev.ps1 -UiOnly     # browser-only UI (no Rust toolchain needed)
.NOTES
  Written for Windows PowerShell 5.1+ (works fine on PowerShell 7 / pwsh too).
#>
param([switch]$UiOnly)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Assert-Tool {
  param([string]$Name, [string]$Hint)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing: $Name. $Hint" -ForegroundColor Red
    exit 1
  }
}

Assert-Tool -Name "node" -Hint "Install Node.js 18+ from https://nodejs.org"
Assert-Tool -Name "npm"  -Hint "Comes with Node.js"

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  npm install
}
if (-not (Test-Path "node_modules/playwright")) {
  npm i playwright axe-core express better-sqlite3
}
# Playwright's Chromium (skipped silently if already present)
npx playwright install chromium

# 1) Sidecar in a background process
Write-Host "Starting sidecar on http://localhost:8787 ..." -ForegroundColor Cyan
$sidecar = Start-Process -FilePath "node" -ArgumentList "sidecar/server.mjs" -PassThru -NoNewWindow

try {
  if ($UiOnly) {
    Write-Host "Starting UI (browser mode) ..." -ForegroundColor Cyan
    npm run dev
  }
  else {
    Assert-Tool -Name "cargo" -Hint "Install Rust from https://rustup.rs (required for the Tauri desktop shell)"
    Write-Host "Starting Tauri desktop app ..." -ForegroundColor Cyan
    npm run tauri:dev
  }
}
finally {
  if ($sidecar -and -not $sidecar.HasExited) {
    Write-Host "Stopping sidecar (pid $($sidecar.Id))" -ForegroundColor DarkGray
    Stop-Process -Id $sidecar.Id -Force -ErrorAction SilentlyContinue
  }
}
