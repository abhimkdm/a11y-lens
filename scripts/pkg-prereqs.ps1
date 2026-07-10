# Shared helpers for @yao-pkg/pkg sidecar builds.
# Dot-source from build scripts:  . (Join-Path $PSScriptRoot "pkg-prereqs.ps1")

function Add-GitUsrBinToPath {
  if (Get-Command patch -ErrorAction SilentlyContinue) { return }

  $candidates = @(
    (Join-Path ${env:ProgramFiles} "Git\usr\bin"),
    (Join-Path ${env:ProgramFiles(x86)} "Git\usr\bin"),
    (Join-Path ${env:LocalAppData} "Programs\Git\usr\bin")
  )

  foreach ($dir in $candidates) {
    if (Test-Path (Join-Path $dir "patch.exe")) {
      $env:Path = "$dir;$env:Path"
      Write-Host ("  Added patch to PATH: {0}" -f $dir) -ForegroundColor DarkGray
      return
    }
  }

  Write-Host @"
Missing: patch (required if pkg must compile Node from source).
Install Git for Windows and ensure its usr\bin folder is on PATH:
  https://git-scm.com/download/win
"@ -ForegroundColor Red
  exit 1
}

function Get-PkgWinTarget {
  $nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
  if ($nodeMajor -ge 22) { return "node22-win-x64" }
  if ($nodeMajor -ge 20) { return "node20-win-x64" }
  return "node18-win-x64"
}

function Get-PkgMacTarget {
  param([string]$Arch)
  $nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
  $nodeFamily = if ($nodeMajor -ge 22) { "node22" } elseif ($nodeMajor -ge 20) { "node20" } else { "node18" }
  if ($Arch -eq "arm64") { return "${nodeFamily}-macos-arm64" }
  return "${nodeFamily}-macos-x64"
}
