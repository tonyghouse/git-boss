#Requires -Version 5.1

[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$DeleteData
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

function Confirm-Step {
  param(
    [string]$Prompt,
    [bool]$DefaultYes
  )

  if ($script:Yes) {
    Write-Host "$Prompt yes"
    return $true
  }

  $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "$Prompt $suffix"

  if ([string]::IsNullOrWhiteSpace($answer)) {
    return $DefaultYes
  }

  return $answer -match "^[Yy]$"
}

function Confirm-DataDelete {
  if ($script:DeleteData) {
    Write-Host "Preference/data deletion enabled by -DeleteData."
    return $true
  }

  if ($script:Yes) {
    Write-Host "Keeping GitBoss preferences and app data. Use -DeleteData to remove them."
    return $false
  }

  return Confirm-Step "Delete GitBoss preferences, cache, and local browser storage?" $false
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

  if (-not (Confirm-Step "Close GitBoss before uninstalling?" $true)) {
    Write-Host "Uninstall skipped. Close GitBoss and rerun this script."
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
    Write-Host "Uninstall skipped. Close GitBoss and rerun this script."
    return $false
  }

  Get-GitBossProcess | Stop-Process -Force

  if (Wait-GitBossExit 5) {
    return $true
  }

  Write-Host "GitBoss is still running. Uninstall skipped." -ForegroundColor Red
  return $false
}

function Split-UninstallCommand {
  param([string]$Command)

  if ([string]::IsNullOrWhiteSpace($Command)) {
    return $null
  }

  $trimmed = $Command.Trim()
  if ($trimmed.StartsWith('"')) {
    $closingQuote = $trimmed.IndexOf('"', 1)
    if ($closingQuote -gt 1) {
      $filePath = $trimmed.Substring(1, $closingQuote - 1)
      $arguments = $trimmed.Substring($closingQuote + 1).Trim()
      return [pscustomobject]@{ FilePath = $filePath; Arguments = $arguments }
    }
  }

  $match = [regex]::Match($trimmed, '^(?<path>.*?\.exe)(?<args>\s+.*)?$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($match.Success) {
    return [pscustomobject]@{
      FilePath = $match.Groups["path"].Value.Trim()
      Arguments = $match.Groups["args"].Value.Trim()
    }
  }

  return $null
}

function Get-RegistryUninstallCommands {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  foreach ($root in $roots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq "GitBoss" -or $_.DisplayName -like "GitBoss *" } |
      ForEach-Object {
        if ($_.QuietUninstallString) {
          Split-UninstallCommand $_.QuietUninstallString
        } elseif ($_.UninstallString) {
          Split-UninstallCommand $_.UninstallString
        }

        if ($_.InstallLocation) {
          $uninstaller = Join-Path $_.InstallLocation "uninstall.exe"
          if (Test-Path -LiteralPath $uninstaller) {
            [pscustomobject]@{ FilePath = $uninstaller; Arguments = "" }
          }
        }
      }
  }
}

function Get-KnownUninstallCommands {
  $paths = @()

  if ($env:LOCALAPPDATA) {
    $paths += Join-Path $env:LOCALAPPDATA "Programs\GitBoss\uninstall.exe"
    $paths += Join-Path $env:LOCALAPPDATA "GitBoss\uninstall.exe"
  }
  if ($env:ProgramFiles) {
    $paths += Join-Path $env:ProgramFiles "GitBoss\uninstall.exe"
  }
  if (${env:ProgramFiles(x86)}) {
    $paths += Join-Path ${env:ProgramFiles(x86)} "GitBoss\uninstall.exe"
  }

  $paths |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object { [pscustomobject]@{ FilePath = $_; Arguments = "" } }
}

function Invoke-GitBossUninstaller {
  $commands = @(Get-RegistryUninstallCommands) + @(Get-KnownUninstallCommands)
  $command = $commands |
    Where-Object { $_ -and $_.FilePath -and (Test-Path -LiteralPath $_.FilePath) } |
    Select-Object -First 1

  if (-not $command) {
    Write-Host "No GitBoss uninstaller executable found."
    return $false
  }

  $arguments = $command.Arguments
  if ($arguments -notmatch '(^|\s)/S(\s|$)') {
    $arguments = "$arguments /S".Trim()
  }

  Write-Host "Running $($command.FilePath)"
  $process = Start-Process -FilePath $command.FilePath -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "GitBoss uninstaller exited with code $($process.ExitCode)." -ForegroundColor Yellow
  }

  return $true
}

function Get-AppInstallPaths {
  $paths = @()

  if ($env:LOCALAPPDATA) {
    $paths += Join-Path $env:LOCALAPPDATA "Programs\GitBoss"
    $paths += Join-Path $env:LOCALAPPDATA "GitBoss"
  }
  if ($env:ProgramFiles) {
    $paths += Join-Path $env:ProgramFiles "GitBoss"
  }
  if (${env:ProgramFiles(x86)}) {
    $paths += Join-Path ${env:ProgramFiles(x86)} "GitBoss"
  }

  $paths
}

function Get-ShortcutPaths {
  $paths = @()

  if ($env:APPDATA) {
    $paths += Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\GitBoss.lnk"
    $paths += Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\GitBoss"
  }
  if ($env:USERPROFILE) {
    $paths += Join-Path $env:USERPROFILE "Desktop\GitBoss.lnk"
  }
  if ($env:PUBLIC) {
    $paths += Join-Path $env:PUBLIC "Desktop\GitBoss.lnk"
  }

  $paths
}

function Test-DangerousPath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $true
  }

  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  } catch {
    return $true
  }

  return $fullPath -match '^[A-Za-z]:$'
}

function Remove-PathSafe {
  param(
    [string]$Path,
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  if (Test-DangerousPath $Path) {
    Write-Host "Refusing to remove unsafe ${Label} path: $Path" -ForegroundColor Red
    return
  }

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "Not found: $Path"
    return
  }

  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    Write-Host "Removed ${Label}: $Path"
  } catch {
    Write-Host "Could not remove ${Path}: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "If this is under Program Files, rerun PowerShell as Administrator."
  }
}

function Remove-AppFallbackPaths {
  Write-Host "Checking common app install locations."
  Get-AppInstallPaths | ForEach-Object { Remove-PathSafe $_ "app" }
  Get-ShortcutPaths | ForEach-Object { Remove-PathSafe $_ "shortcut" }
}

function Test-GitBossCliShim {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  try {
    $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
  } catch {
    return $false
  }

  return $content.Contains("GitBoss") -and (
    $content.Contains("SOURCE_DIR=") -or
    $content.Contains("desktop:dev") -or
    $content.Contains("GitBoss expected a folder")
  )
}

function Remove-UserPathEntry {
  param([string]$PathToRemove)

  if ([string]::IsNullOrWhiteSpace($PathToRemove)) {
    return
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ([string]::IsNullOrWhiteSpace($userPath)) {
    return
  }

  $target = [Environment]::ExpandEnvironmentVariables($PathToRemove).TrimEnd('\')
  $entries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $remaining = @(
    $entries | Where-Object {
      [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ne $target
    }
  )

  if ($remaining.Count -ne $entries.Count) {
    [Environment]::SetEnvironmentVariable("Path", ($remaining -join ";"), "User")
    Write-Host "Removed $PathToRemove from user PATH. Open a new terminal to use the updated PATH."
  }
}

function Remove-CliShim {
  Write-Host ""
  Write-Host "Removing terminal command" -ForegroundColor White

  if (-not $env:LOCALAPPDATA) {
    Write-Host "LOCALAPPDATA is not set; no GitBoss command shim path can be checked."
    return
  }

  $binDir = Join-Path $env:LOCALAPPDATA "GitBoss\bin"
  $cmdPath = Join-Path $binDir "gitboss.cmd"

  if (-not (Test-Path -LiteralPath $cmdPath)) {
    Write-Host "Not found: $cmdPath"
  } elseif (Test-GitBossCliShim $cmdPath) {
    Remove-PathSafe $cmdPath "terminal command"
  } else {
    Write-Host "$cmdPath exists but does not look like the GitBoss installer shim." -ForegroundColor Yellow
    if ($script:Yes) {
      Write-Host "Left in place: $cmdPath"
    } elseif (Confirm-Step "Remove it anyway?" $false) {
      Remove-PathSafe $cmdPath "terminal command"
    } else {
      Write-Host "Left in place: $cmdPath"
    }
  }

  if ((Test-Path -LiteralPath $binDir) -and -not (Get-ChildItem -LiteralPath $binDir -Force -ErrorAction SilentlyContinue)) {
    Remove-PathSafe $binDir "terminal command directory"
  }

  Remove-UserPathEntry $binDir
}

function Get-DataPaths {
  $paths = @()

  if ($env:APPDATA) {
    $paths += Join-Path $env:APPDATA "io.gitboss.desktop"
  }
  if ($env:LOCALAPPDATA) {
    $paths += Join-Path $env:LOCALAPPDATA "io.gitboss.desktop"
  }

  $paths
}

function Write-DataSummary {
  Write-Host ""
  Write-Host "Preferences and app data" -ForegroundColor White
  Write-Host "GitBoss stores app-owned UI preferences, local browser storage, and cache separately from the app."
  Write-Host "Deleting this data may reset theme and WebView state. Git repositories, working trees, and Git history are not touched."
  Write-Host ""
  Write-Host "Paths checked:"
  Get-DataPaths | ForEach-Object { Write-Host "  $_" }
}

Write-Host "GitBoss Uninstaller" -ForegroundColor White
Write-Host "-------------------"
Write-Host ""
Write-Host "This removes the installed GitBoss app and the gitboss terminal command created by install.ps1."
Write-Host "Later, this script asks whether to delete GitBoss preferences and app data. Press Enter to keep them."

if (Confirm-Step "Remove the GitBoss application and terminal command now?" $true) {
  if (-not (Request-CloseRunningApp)) {
    exit 0
  }

  Write-Host ""
  Write-Host "Removing Windows app" -ForegroundColor White
  [void](Invoke-GitBossUninstaller)
  Remove-AppFallbackPaths
  Remove-CliShim
} else {
  Write-Host "Application and terminal command removal skipped."
}

Write-DataSummary
if (Confirm-DataDelete) {
  if (-not (Request-CloseRunningApp)) {
    exit 0
  }

  Get-DataPaths | ForEach-Object { Remove-PathSafe $_ "preferences/data" }
  Write-Host "GitBoss preferences and app data removed." -ForegroundColor Green
} else {
  Write-Host "GitBoss preferences and app data preserved."
}

Write-Host ""
Write-Host "GitBoss uninstall finished." -ForegroundColor Green
