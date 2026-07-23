#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

function Confirm-Step {
  param(
    [string]$Prompt,
    [bool]$DefaultYes
  )

  $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "$Prompt $suffix"

  if ([string]::IsNullOrWhiteSpace($answer)) {
    return $DefaultYes
  }

  return $answer -match "^[Yy]$"
}

function Get-GitBossProcess {
  Get-Process -Name "GitBoss", "gitboss" -ErrorAction SilentlyContinue
}

function Wait-GitBossExit {
  param([int]$Seconds)

  $deadline = (Get-Date).AddSeconds($Seconds)

  while ((Get-Date) -lt $deadline) {
    if (-not (Get-GitBossProcess)) {
      return $true
    }

    Start-Sleep -Seconds 1
  }

  return -not (Get-GitBossProcess)
}

function Request-CloseRunningApp {
  $processes = Get-GitBossProcess
  if (-not $processes) {
    return $true
  }

  Write-Host "GitBoss is currently running." -ForegroundColor Yellow

  if (-not (Confirm-Step "Close GitBoss before installing the generated app?" $true)) {
    Write-Host "App installation skipped. Rerun .\install.cmd after closing GitBoss."
    return $false
  }

  $processes | ForEach-Object {
    try {
      $_.CloseMainWindow() | Out-Null
    } catch {
      # Process may have exited between detection and close request.
    }
  }

  if (Wait-GitBossExit 15) {
    return $true
  }

  Write-Host "GitBoss did not close within 15 seconds." -ForegroundColor Yellow

  if (-not (Confirm-Step "Force close GitBoss now?" $false)) {
    Write-Host "App installation skipped. Close GitBoss and rerun .\install.cmd."
    return $false
  }

  Get-GitBossProcess | Stop-Process -Force

  if (Wait-GitBossExit 5) {
    return $true
  }

  Write-Host "GitBoss is still running. App installation skipped." -ForegroundColor Red
  return $false
}

function Invoke-Doctor {
  param([switch]$Install)

  $doctorScript = Join-Path $RootDir "scripts\doctor.ps1"
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $doctorScript)

  if ($Install) {
    $arguments += "-Install"
  }

  & powershell @arguments
  $script:DoctorExitCode = $LASTEXITCODE
}

function Install-CliShim {
  $binDir = Join-Path $env:LOCALAPPDATA "GitBoss\bin"
  $cmdPath = Join-Path $binDir "gitboss.cmd"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null

  $content = @"
@echo off
setlocal EnableDelayedExpansion

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=."
for %%I in ("%TARGET%") do set "FULLTARGET=%%~fI"

if not exist "%FULLTARGET%\" (
  echo GitBoss expected a folder: %FULLTARGET% 1>&2
  exit /b 1
)

set "EXE=%LOCALAPPDATA%\Programs\GitBoss\GitBoss.exe"
if exist "%EXE%" (
  start "" "%EXE%" "%FULLTARGET%"
  exit /b 0
)

set "EXE=%LOCALAPPDATA%\GitBoss\GitBoss.exe"
if exist "%EXE%" (
  start "" "%EXE%" "%FULLTARGET%"
  exit /b 0
)

echo GitBoss is not installed. Refusing to start a development fallback; reinstall the release app. 1>&2
exit /b 1
"@

  Set-Content -Path $cmdPath -Value $content -Encoding ASCII
  Write-Host "Installed gitboss command to $cmdPath"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathEntries = @()
  if ($userPath) {
    $pathEntries = $userPath -split ";"
  }

  if ($pathEntries -notcontains $binDir) {
    if (Confirm-Step "Add $binDir to your user PATH?" $true) {
      $nextPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
      [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
      Write-Host "PATH updated. Open a new terminal before running gitboss."
    } else {
      Write-Host "$binDir is not in PATH. Add it later to run gitboss from any terminal." -ForegroundColor Yellow
    }
  }
}

Write-Host "GitBoss Source Installer" -ForegroundColor White
Write-Host "------------------------"
Write-Host ""

Invoke-Doctor
if ($script:DoctorExitCode -ne 0) {
  if (Confirm-Step "Run available prerequisite installers now?" $false) {
    Invoke-Doctor -Install
  }

  Write-Host ""
  Write-Host "Rechecking prerequisites..."
  Invoke-Doctor
  if ($script:DoctorExitCode -ne 0) {
    Write-Host ""
    Write-Host "Install cannot continue until the required prerequisites pass." -ForegroundColor Red
    exit 1
  }
}

if (-not (Confirm-Step "Build GitBoss now?" $true)) {
  Write-Host "Build skipped."
  exit 0
}

Write-Host ""
Write-Host "Installing npm dependencies" -ForegroundColor White
& npm ci
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Building GitBoss (nsis)" -ForegroundColor White
& npm run build -- --bundles nsis
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
Write-Host "Generated artifacts are under src-tauri\target\release\bundle"

if (Confirm-Step "Install the generated app now?" $true) {
  if (Request-CloseRunningApp) {
    $nsisDir = Join-Path $RootDir "src-tauri\target\release\bundle\nsis"
    $setup = Get-ChildItem -Path $nsisDir -Recurse -Filter "*setup*.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime |
      Select-Object -Last 1

    if ($setup) {
      Write-Host "Running $($setup.FullName)"
      Start-Process -FilePath $setup.FullName -Wait
    } else {
      Write-Host "Could not find generated NSIS setup executable." -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "App installation skipped."
}

if (Confirm-Step "Install the gitboss terminal command now?" $true) {
  Install-CliShim
} else {
  Write-Host "Terminal command installation skipped."
}
