<#
.SYNOPSIS
  A11y Lens - macOS development launcher.
  Starts the Node sidecar and the Tauri desktop app together.
.DESCRIPTION
  macOS-only wrapper around the dev workflow. Tauri dev does not spawn the
  sidecar itself — this script starts it, launches the app, then stops it on exit.
.USAGE
  pwsh scripts/launch-macos-dev.ps1
  pwsh scripts/launch-macos-dev.ps1 -UiOnly
.NOTES
  Requires PowerShell 7+: brew install --cask powershell
  Alternative without Tauri: npm run dev  (Vite + sidecar via concurrently)
#>
param([switch]$UiOnly)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if ((uname) -ne "Darwin") {
  Write-Host "This script is for macOS only. Use scripts/launch-dev.ps1 on Windows." -ForegroundColor Red
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
    Write-Host ("Node 22.5+ required for the sidecar (node:sqlite). Found v{0}.{1}. brew install node" -f $major, $minor) -ForegroundColor Red
    exit 1
  }
}

Write-Host "== A11y Lens macOS dev ==" -ForegroundColor Cyan
Assert-Tool -Name "pwsh"         -Hint "brew install --cask powershell"
Assert-Tool -Name "node"         -Hint "brew install node"
Assert-Tool -Name "npm"          -Hint "Comes with Node.js"
Assert-Node225

if (-not $UiOnly) {
  Assert-Tool -Name "cargo"        -Hint "curl https://sh.rustup.rs | sh"
  Assert-Tool -Name "xcode-select" -Hint "xcode-select --install"
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  npm install
}

Write-Host "Ensuring Playwright Chromium is installed..." -ForegroundColor Cyan
npx playwright install chromium

# Free port 8787 if a previous dev sidecar is still running
$pids = @(lsof -ti :8787 2>$null)
foreach ($pid in $pids) {
  if ($pid) {
    Write-Host "Stopping stale process on :8787 (pid $pid)" -ForegroundColor DarkGray
    kill -9 $pid 2>$null
  }
}

Write-Host "Starting sidecar on http://localhost:8787 ..." -ForegroundColor Cyan
$sidecarArgs = @("--no-warnings=ExperimentalWarning", "sidecar/server.mjs")
$sidecar = Start-Process -FilePath "node" -ArgumentList $sidecarArgs -PassThru -NoNewWindow

try {
  if ($UiOnly) {
    Write-Host "Starting UI only (Vite on http://localhost:1420) ..." -ForegroundColor Cyan
    npm run dev:ui
  }
  else {
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
