#Requires -Version 5.1

param(
  [switch]$Install
)

$MinNodeVersion = [version]"20.19.0"
$RecommendedNodeVersion = "22 LTS"
$MinNpmVersion = [version]"10.0.0"
$MinRustVersion = [version]"1.77.2"

$script:RequiredOk = $true
$script:MissingGit = $false
$script:MissingNode = $false
$script:MissingNpm = $false
$script:MissingRust = $false
$script:MissingCargo = $false
$script:MissingMsvcRust = $false
$script:MissingBuildTools = $false
$script:MissingWebView2 = $false

function Write-Title {
  param([string]$Text)

  Write-Host ""
  Write-Host $Text -ForegroundColor White
}

function Write-Rule {
  Write-Host "----------------"
}

function Write-Status {
  param(
    [ValidateSet("PASS", "WARN", "FAIL")]
    [string]$State,
    [string]$Label,
    [string]$Detail
  )

  $color = switch ($State) {
    "PASS" { "Green" }
    "WARN" { "Yellow" }
    "FAIL" { "Red" }
  }

  Write-Host ("  {0,-4}  {1,-22} {2}" -f $State, $Label, $Detail) -ForegroundColor $color
}

function Mark-Fail {
  $script:RequiredOk = $false
}

function Convert-ToVersion {
  param([string]$Text)

  if ($Text -match "([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?") {
    $major = $Matches[1]
    $minor = if ($Matches[2]) { $Matches[2] } else { "0" }
    $patch = if ($Matches[3]) { $Matches[3] } else { "0" }
    return [version]"$major.$minor.$patch"
  }

  return $null
}

function Test-VersionAtLeast {
  param(
    [string]$Actual,
    [version]$Minimum
  )

  $actualVersion = Convert-ToVersion $Actual
  if ($null -eq $actualVersion) {
    return $false
  }

  return $actualVersion -ge $Minimum
}

function Get-FirstCommandLine {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    return $null
  }

  try {
    return (& $Command @Arguments 2>$null | Select-Object -First 1)
  } catch {
    return $null
  }
}

function Check-Git {
  $version = Get-FirstCommandLine "git" @("--version")

  if ($version) {
    Write-Status "PASS" "Git" $version
  } else {
    Write-Status "FAIL" "Git" "not found"
    $script:MissingGit = $true
    Mark-Fail
  }
}

function Check-Node {
  $version = Get-FirstCommandLine "node" @("--version")

  if ($version) {
    if (Test-VersionAtLeast $version $MinNodeVersion) {
      Write-Status "PASS" "Node.js" ((Convert-ToVersion $version).ToString())
    } else {
      Write-Status "FAIL" "Node.js" "$version found, >= $MinNodeVersion required"
      $script:MissingNode = $true
      Mark-Fail
    }
  } else {
    Write-Status "FAIL" "Node.js" "not found, >= $MinNodeVersion required"
    $script:MissingNode = $true
    Mark-Fail
  }
}

function Check-Npm {
  $version = Get-FirstCommandLine "npm" @("--version")

  if ($version) {
    if (Test-VersionAtLeast $version $MinNpmVersion) {
      Write-Status "PASS" "npm" ((Convert-ToVersion $version).ToString())
    } else {
      Write-Status "FAIL" "npm" "$version found, >= $MinNpmVersion required"
      $script:MissingNpm = $true
      Mark-Fail
    }
  } else {
    Write-Status "FAIL" "npm" "not found, >= $MinNpmVersion required"
    $script:MissingNpm = $true
    Mark-Fail
  }
}

function Check-Rust {
  $version = Get-FirstCommandLine "rustc" @("-V")

  if ($version) {
    if (Test-VersionAtLeast $version $MinRustVersion) {
      Write-Status "PASS" "Rust" ((Convert-ToVersion $version).ToString())
    } else {
      Write-Status "FAIL" "Rust" "$version found, >= $MinRustVersion required"
      $script:MissingRust = $true
      Mark-Fail
    }

    $rustDetails = & rustc -vV 2>$null
    $hostLine = $rustDetails | Where-Object { $_ -match "^host:" } | Select-Object -First 1
    if ($hostLine -match "msvc") {
      Write-Status "PASS" "Rust toolchain" $hostLine
    } else {
      Write-Status "FAIL" "Rust toolchain" "MSVC host required"
      $script:MissingMsvcRust = $true
      Mark-Fail
    }
  } else {
    Write-Status "FAIL" "Rust" "not found, >= $MinRustVersion required"
    $script:MissingRust = $true
    Mark-Fail
  }

  $cargoVersion = Get-FirstCommandLine "cargo" @("-V")
  if ($cargoVersion) {
    Write-Status "PASS" "Cargo" $cargoVersion
  } else {
    Write-Status "FAIL" "Cargo" "not found"
    $script:MissingCargo = $true
    Mark-Fail
  }
}

function Test-VisualCppBuildTools {
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if (-not $programFilesX86) {
    $programFilesX86 = $env:ProgramFiles
  }

  $vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"

  if (Test-Path $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Workload.VCTools -property installationPath 2>$null
    if ($installPath) {
      return $installPath
    }
  }

  if (Get-Command "cl.exe" -ErrorAction SilentlyContinue) {
    return (Get-Command "cl.exe").Source
  }

  return $null
}

function Test-WebView2 {
  $paths = @(
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  )

  foreach ($path in $paths) {
    if (Test-Path $path) {
      $props = Get-ItemProperty $path -ErrorAction SilentlyContinue
      if ($props.pv) {
        return $props.pv
      }
    }
  }

  return $null
}

function Check-WindowsNative {
  $buildTools = Test-VisualCppBuildTools
  if ($buildTools) {
    Write-Status "PASS" "MSVC Build Tools" $buildTools
  } else {
    Write-Status "FAIL" "MSVC Build Tools" "Desktop development with C++ workload not found"
    $script:MissingBuildTools = $true
    Mark-Fail
  }

  $webView2 = Test-WebView2
  if ($webView2) {
    Write-Status "PASS" "WebView2 Runtime" $webView2
  } else {
    Write-Status "FAIL" "WebView2 Runtime" "not found"
    $script:MissingWebView2 = $true
    Mark-Fail
  }
}

function Write-RequiredActions {
  if ($script:RequiredOk) {
    return
  }

  Write-Title "Required actions"

  if ($script:MissingGit) {
    Write-Host "  winget install --id Git.Git -e --source winget"
  }

  if ($script:MissingNode -or $script:MissingNpm) {
    Write-Host "  winget install --id OpenJS.NodeJS.LTS -e --source winget"
    Write-Host "  Minimum required Node.js version: >= $MinNodeVersion. Recommended: Node.js $RecommendedNodeVersion."
  }

  if ($script:MissingRust -or $script:MissingCargo -or $script:MissingMsvcRust) {
    Write-Host "  winget install --id Rustlang.Rustup -e --source winget"
    Write-Host "  rustup default stable-msvc"
  }

  if ($script:MissingBuildTools) {
    Write-Host "  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --override `"--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`""
  }

  if ($script:MissingWebView2) {
    Write-Host "  winget install --id Microsoft.EdgeWebView2Runtime -e --source winget"
  }
}

function Invoke-WingetInstall {
  param([string[]]$Arguments)

  if (-not (Get-Command "winget" -ErrorAction SilentlyContinue)) {
    Write-Host "winget was not found. Install the missing prerequisites manually with the commands above." -ForegroundColor Yellow
    return
  }

  & winget @Arguments
}

function Invoke-InstallActions {
  Write-Title "Installing available prerequisites"

  if ($script:MissingGit) {
    Invoke-WingetInstall @("install", "--id", "Git.Git", "-e", "--source", "winget")
  }

  if ($script:MissingNode -or $script:MissingNpm) {
    Invoke-WingetInstall @("install", "--id", "OpenJS.NodeJS.LTS", "-e", "--source", "winget")
  }

  if ($script:MissingRust -or $script:MissingCargo -or $script:MissingMsvcRust) {
    Invoke-WingetInstall @("install", "--id", "Rustlang.Rustup", "-e", "--source", "winget")
    Write-Host "After Rust installs, run: rustup default stable-msvc"
  }

  if ($script:MissingBuildTools) {
    Invoke-WingetInstall @(
      "install",
      "--id",
      "Microsoft.VisualStudio.2022.BuildTools",
      "-e",
      "--source",
      "winget",
      "--override",
      "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    )
  }

  if ($script:MissingWebView2) {
    Invoke-WingetInstall @("install", "--id", "Microsoft.EdgeWebView2Runtime", "-e", "--source", "winget")
  }
}

Write-Host "GitBoss Setup Check" -ForegroundColor White
Write-Rule

Write-Title "System"
Write-Status "PASS" "OS" "$([System.Environment]::OSVersion.VersionString) $env:PROCESSOR_ARCHITECTURE"

Write-Title "Build and runtime requirements"
Check-Git
Check-Node
Check-Npm
Check-Rust
Check-WindowsNative

Write-RequiredActions

if ($Install) {
  Invoke-InstallActions
}

if ($script:RequiredOk) {
  Write-Host ""
  Write-Host "All required prerequisites are available." -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "Some required prerequisites are missing." -ForegroundColor Red
exit 1
