<#
.SYNOPSIS
  A11y Lens - Windows prerequisite check (and optional browser install).
.DESCRIPTION
  For QA testers / end users who installed the MSI or setup .exe:
    - Verifies Windows version, WebView2, free local port 8787
    - Optionally downloads Playwright's Chromium (~150 MB, one-time)

  For developers building from source, add -Dev to also check Node 22.5+ and Rust.
.USAGE
  powershell -ExecutionPolicy Bypass -File scripts\prereq-windows.ps1
  powershell -ExecutionPolicy Bypass -File scripts\prereq-windows.ps1 -InstallBrowser
  powershell -ExecutionPolicy Bypass -File scripts\prereq-windows.ps1 -Dev
.NOTES
  Run as a normal user (admin not required). Needs outbound HTTPS for -InstallBrowser.
#>
param(
  [switch]$Dev,
  [switch]$InstallBrowser
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Write-Pass([string]$Text) { Write-Host ("  [OK]   {0}" -f $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ("  [WARN] {0}" -f $Text) -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host ("  [FAIL] {0}" -f $Text) -ForegroundColor Red }

$failures = 0
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host ""
Write-Host "== A11y Lens - Windows prerequisites ==" -ForegroundColor Cyan
Write-Host ""

# --- OS -------------------------------------------------------------------
Write-Step "1/5  Windows version"
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
if ($build -ge 19041) {
  Write-Pass ("{0} (build {1})" -f $os.Caption, $build)
}
else {
  Write-Fail "Windows 10 2004+ or Windows 11 required (build 19041+)."
  $failures++
}

# --- WebView2 -------------------------------------------------------------
Write-Step "2/5  Microsoft WebView2"
$wv2 = @(
  "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application",
  "${env:ProgramFiles}\Microsoft\EdgeWebView\Application"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($wv2) {
  Write-Pass "Runtime found ($wv2)"
}
else {
  Write-Warn "WebView2 not detected. The installer normally adds it. If the app window is blank, install from:"
  Write-Host "         https://developer.microsoft.com/microsoft-edge/webview2/" -ForegroundColor DarkGray
}

# --- Port 8787 ------------------------------------------------------------
Write-Step "3/5  Local automation port (8787)"
$portUsers = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
if (-not $portUsers) {
  Write-Pass "Port 8787 is free."
}
else {
  $ownerPid = $portUsers[0].OwningProcess
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { "pid $ownerPid" }
  Write-Warn "Port 8787 is in use by $name. Close other A11y Lens windows, then retry."
  Write-Host "         taskkill /F /IM `"A11y Lens.exe`" /T" -ForegroundColor DarkGray
  Write-Host "         taskkill /F /IM a11y-node-x86_64-pc-windows-msvc.exe /T" -ForegroundColor DarkGray
}

# --- Dev toolchain (optional) ---------------------------------------------
Write-Step $(if ($Dev) { "4/5  Developer toolchain" } else { "4/5  Developer toolchain (skipped, pass -Dev to check)" })

if ($Dev) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js not found. Install Node 22.5+ from https://nodejs.org"
    $failures++
  }
  else {
    $ver = (node --version).TrimStart("v").Split(".")
    $major = [int]$ver[0]; $minor = [int]$ver[1]
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 5)) {
      Write-Pass ("Node v{0}.{1}" -f $major, $minor)
    }
    else {
      Write-Fail ("Node 22.5+ required for builds (found v{0}.{1})." -f $major, $minor)
      $failures++
    }
  }

  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Fail "Rust / cargo not found. Install from https://rustup.rs (MSVC toolchain)."
    $failures++
  }
  else {
    Write-Pass "Rust cargo found."
    if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
      Write-Warn "MSVC compiler (cl.exe) not on PATH. Install Visual Studio Build Tools with 'Desktop development with C++'."
    }
    else {
      Write-Pass "MSVC compiler (cl.exe) on PATH."
    }
  }

  if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Warn "Run from repo root: npm install"
  }
  else {
    Write-Pass "node_modules present."
  }
}

# --- Playwright Chromium --------------------------------------------------
Write-Step "5/5  Browser engine (Playwright Chromium)"

function Find-InstallRoot {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "A11y Lens"),
    (Join-Path $env:LOCALAPPDATA "Programs\com.a11ylens.app"),
    (Join-Path $env:LOCALAPPDATA "Programs\A11y Lens"),
    $repoRoot
  ) | Select-Object -Unique

  foreach ($dir in $candidates) {
    if (-not (Test-Path $dir)) { continue }
    $node = Get-ChildItem -Path $dir -Recurse -Filter "a11y-node-x86_64-pc-windows-msvc.exe" -ErrorAction SilentlyContinue -Depth 4 |
      Select-Object -First 1
    if ($node) {
      return @{ Root = $node.Directory.FullName; Node = $node.FullName }
    }
  }
  return $null
}

function Test-ChromiumInstalled {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "ms-playwright"),
    (Join-Path $env:USERPROFILE ".cache\ms-playwright")
  )
  foreach ($r in $roots) {
    $chrome = Get-ChildItem -Path $r -Recurse -Filter "chrome.exe" -ErrorAction SilentlyContinue -Depth 5 |
      Where-Object { $_.FullName -match "chromium" } |
      Select-Object -First 1
    if ($chrome) { return $chrome.FullName }
  }
  return $null
}

$chrome = Test-ChromiumInstalled
if ($chrome) {
  Write-Pass "Chromium found ($chrome)"
}
elseif ($Dev -and (Test-Path (Join-Path $repoRoot "node_modules\playwright"))) {
  Write-Warn "Chromium not installed yet. Run: npx playwright install chromium"
  if ($InstallBrowser) {
    Write-Host "  Installing Chromium for development..." -ForegroundColor Cyan
    Push-Location $repoRoot
    npx playwright install chromium
    Pop-Location
    if ($LASTEXITCODE -eq 0) { Write-Pass "Chromium installed." } else { $failures++ }
  }
}
else {
  $install = Find-InstallRoot
  if ($install) {
    Write-Warn "Chromium not installed yet (required before Open browser / Quick Scan)."
    if ($InstallBrowser) {
      $resourceDir = $install.Root
      $cli = Join-Path $resourceDir "node_modules\playwright\cli.js"
      if (-not (Test-Path $cli)) {
        # Tauri may nest resources one level down
        $cli = Get-ChildItem -Path $resourceDir -Recurse -Filter "cli.js" -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -match "playwright\\cli\.js$" } |
          Select-Object -First 1 -ExpandProperty FullName
      }
      if (-not $cli -or -not (Test-Path $cli)) {
        Write-Fail "Could not find Playwright CLI in the installed app. Reinstall A11y Lens or run with -Dev from the repo."
        $failures++
      }
      else {
        Write-Host "  Downloading Chromium (~150 MB, needs internet)..." -ForegroundColor Cyan
        if ($env:HTTPS_PROXY) { Write-Host "  Using HTTPS_PROXY=$env:HTTPS_PROXY" -ForegroundColor DarkGray }
        & $install.Node $cli install chromium
        if ($LASTEXITCODE -eq 0) { Write-Pass "Chromium installed." } else { $failures++ }
      }
    }
    else {
      Write-Host "  To install now, re-run with -InstallBrowser:" -ForegroundColor DarkGray
      Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\prereq-windows.ps1 -InstallBrowser" -ForegroundColor White
    }
  }
  else {
    Write-Warn "A11y Lens install folder not found (MSI not installed yet?)."
    if ($Dev) {
      Write-Host "  Developers: npx playwright install chromium" -ForegroundColor DarkGray
    }
    else {
      Write-Host "  Install A11y Lens first, then run this script again." -ForegroundColor DarkGray
    }
  }
}

# --- Summary --------------------------------------------------------------
Write-Host ""
if ($failures -gt 0) {
  Write-Host "Some checks failed ($failures). Fix the items above, then retry." -ForegroundColor Red
  exit 1
}

Write-Host "Ready to use A11y Lens." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor DarkGray
Write-Host "  1. Launch A11y Lens from the Start menu"
Write-Host "  2. Scan Center -> enter URL -> Open browser -> log in manually"
Write-Host "  3. Run Quick Accessibility Scan"
Write-Host ""
Write-Host "If the automation engine did not start, close all copies and relaunch."
Write-Host ""
