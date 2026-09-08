param(
  [switch]$Uninstall,
  [switch]$SkipHealthCheck,
  [switch]$SkipDependencyInstall,
  [switch]$InstallNode,
  [switch]$ForceEnroll,
  [string]$HubUrl,
  [string]$PairingCode,
  [string]$DeviceName = $env:COMPUTERNAME,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "SafeHarbor"),
  [int]$SyncTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$TaskName = "SafeHarbor"
$SourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$InstallDriveRoot = [IO.Path]::GetPathRoot($InstallRoot)
if ([string]::Equals($InstallRoot, $InstallDriveRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "InstallRoot cannot be the root of a drive."
}

$Root = $InstallRoot
$Server = Join-Path $Root "server\safeharbor-server.js"
$EnrollScript = Join-Path $Root "scripts\enroll-device.js"
$PackageLock = Join-Path $Root "package-lock.json"
$ExtensionDir = Join-Path $Root "extension"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupScript = Join-Path $StartupDir "SafeHarbor.cmd"
$TargetUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Stop-SafeHarbor {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

  try {
    $KnownServers = @(
      $Server,
      (Join-Path $SourceRoot "server\safeharbor-server.js")
    )
    $Processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
    foreach ($Process in $Processes) {
      $CommandLine = [string]$Process.CommandLine
      $MatchesSafeHarbor = $KnownServers | Where-Object {
        $CommandLine.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
      }
      if ($MatchesSafeHarbor) {
        Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    Write-Warning "Could not inspect existing Node.js processes: $($_.Exception.Message)"
  }
}

function Assert-SafeHarborPortAvailable {
  $GetNetTcpConnection = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
  if (!$GetNetTcpConnection) {
    return
  }

  $Listener = Get-NetTCPConnection -LocalPort 43718 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Listener) {
    throw "Port 43718 is still in use by process $($Listener.OwningProcess). Stop that process, then rerun the installer."
  }
}

function Copy-SafeHarborApplication {
  if ([string]::Equals($SourceRoot, $InstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return
  }

  $SourceServer = Join-Path $SourceRoot "server\safeharbor-server.js"
  if (!(Test-Path $SourceServer)) {
    throw "SafeHarbor source files were not found at $SourceRoot."
  }

  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  foreach ($DirectoryName in @("server", "extension", "scripts")) {
    $SourceDirectory = Join-Path $SourceRoot $DirectoryName
    $TargetDirectory = Join-Path $InstallRoot $DirectoryName
    if (Test-Path $TargetDirectory) {
      Remove-Item $TargetDirectory -Recurse -Force
    }
    Copy-Item $SourceDirectory $TargetDirectory -Recurse -Force
  }
  foreach ($FileName in @("package.json", "package-lock.json")) {
    $SourceFile = Join-Path $SourceRoot $FileName
    if (Test-Path $SourceFile) {
      Copy-Item $SourceFile (Join-Path $InstallRoot $FileName) -Force
    }
  }
}

function Wait-ForSafeHarborStatus {
  param(
    [string]$Token,
    [int]$TimeoutSeconds
  )

  $StatusUrl = "http://127.0.0.1:43718/status"
  $Headers = @{ Authorization = "Bearer $Token" }
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $LastError = ""
  do {
    try {
      $Status = Invoke-RestMethod -Uri $StatusUrl -Headers $Headers -TimeoutSec 3
      if ($Status.ok) {
        return $Status
      }
    } catch {
      $LastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $Deadline)

  throw "SafeHarbor did not return an authenticated status within $TimeoutSeconds seconds. Last error: $LastError"
}

function Wait-ForHubSync {
  param(
    [string]$Token,
    [int]$TimeoutSeconds,
    [DateTimeOffset]$NotBefore
  )

  $StatusUrl = "http://127.0.0.1:43718/status"
  $Headers = @{ Authorization = "Bearer $Token" }
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $LastSyncError = ""
  do {
    try {
      $Status = Invoke-RestMethod -Uri $StatusUrl -Headers $Headers -TimeoutSec 3
      if (!$Status.hubSyncEnabled) {
        throw "The local agent started without hub sync enabled."
      }
      if ($Status.hubLastSyncAt) {
        $LastSyncAt = [DateTimeOffset]::Parse([string]$Status.hubLastSyncAt)
        if ($LastSyncAt -ge $NotBefore) {
          return $Status
        }
      }
      if ($Status.hubLastSyncError) {
        $LastSyncError = [string]$Status.hubLastSyncError
      }
    } catch {
      $LastSyncError = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $Deadline)

  if ($LastSyncError) {
    throw "SafeHarbor did not complete its first hub sync within $TimeoutSeconds seconds. Last sync error: $LastSyncError"
  }
  throw "SafeHarbor did not complete its first hub sync within $TimeoutSeconds seconds."
}

if ($Uninstall) {
  Stop-SafeHarbor
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $StartupScript) {
    Remove-Item $StartupScript -Force
  }
  Write-Host "SafeHarbor startup was removed for $TargetUser."
  Write-Host "Application files remain in $InstallRoot."
  Write-Host "Local activity and configuration remain in the user profile."
  exit 0
}

if ($SyncTimeoutSeconds -lt 10) {
  throw "SyncTimeoutSeconds must be at least 10."
}

$HasHubUrl = ![string]::IsNullOrWhiteSpace($HubUrl)
$HasPairingCode = ![string]::IsNullOrWhiteSpace($PairingCode)
if ($HasHubUrl -xor $HasPairingCode) {
  throw "HubUrl and PairingCode must be supplied together."
}
if ($ForceEnroll -and !$HasHubUrl) {
  throw "ForceEnroll requires HubUrl and PairingCode."
}
if ($HasPairingCode -and $PairingCode -notmatch '^\d{6}$') {
  throw "PairingCode must contain exactly six digits."
}

Write-Host "Installing SafeHarbor for Windows account: $TargetUser"
Write-Host "Application folder: $InstallRoot"
Write-Warning "SafeHarbor will run only when $TargetUser signs in. Run this installer from the Windows account that the child will use."

Stop-SafeHarbor
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path $StartupScript) {
  Remove-Item $StartupScript -Force
}
Start-Sleep -Milliseconds 500
Assert-SafeHarborPortAvailable
Copy-SafeHarborApplication

if (!(Test-Path $Server)) {
  throw "Server file not found after installation: $Server"
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (!$NodeCommand -and $InstallNode) {
  $WingetCommand = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (!$WingetCommand) {
    throw "Windows Package Manager was not found. Install Node.js 20 LTS or newer manually, then rerun this installer."
  }
  $Winget = $WingetCommand.Source

  Write-Host "Installing Node.js LTS with Windows Package Manager..."
  & $Winget install `
    --id OpenJS.NodeJS.LTS `
    --exact `
    --silent `
    --accept-package-agreements `
    --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Node.js installation failed with exit code $LASTEXITCODE."
  }

  $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = @($MachinePath, $UserPath) -join ";"
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
}
if (!$NodeCommand) {
  throw "Node.js was not found on PATH. Rerun with -InstallNode or install Node.js 20 LTS or newer manually."
}

$Node = $NodeCommand.Source
$NodeMajor = & $Node -p "Number(process.versions.node.split('.')[0])"
if ($NodeMajor -lt 20) {
  $NodeVersion = & $Node -v
  throw "Node.js 20 LTS or newer is required. Found: $NodeVersion"
}

if (!$SkipDependencyInstall) {
  $NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (!$NpmCommand) {
    $NpmCommand = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (!$NpmCommand) {
    throw "npm was not found on PATH. Reinstall Node.js with npm included."
  }
  $Npm = $NpmCommand.Source

  Push-Location $Root
  try {
    if (Test-Path $PackageLock) {
      & $Npm ci
    } else {
      & $Npm install
    }
    if ($LASTEXITCODE -ne 0) {
      throw "SafeHarbor dependency installation failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

$CurrentConfigJson = ((& $Node $Server --print-config) | Out-String).Trim()
$CurrentConfig = $CurrentConfigJson | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$CurrentConfig.app) {
  throw "SafeHarbor could not read its local configuration."
}

$ShouldEnroll = $HasHubUrl
if ($HasHubUrl -and $CurrentConfig.hubSyncEnabled -and !$ForceEnroll) {
  $CurrentHubUrl = ([string]$CurrentConfig.hubUrl).TrimEnd('/')
  $RequestedHubUrl = $HubUrl.TrimEnd('/')
  if (![string]::Equals($CurrentHubUrl, $RequestedHubUrl, [StringComparison]::OrdinalIgnoreCase)) {
    throw "This device is already enrolled with $CurrentHubUrl. Use -ForceEnroll to move it to $RequestedHubUrl."
  }
  $ShouldEnroll = $false
  Write-Host "SafeHarbor is already enrolled with $CurrentHubUrl. Reusing the existing device token."
}

if ($ShouldEnroll) {
  if (!(Test-Path $EnrollScript)) {
    throw "Enrollment script not found: $EnrollScript"
  }
  $EnrollArgs = @($EnrollScript, "--hub", $HubUrl, "--code", $PairingCode)
  if (![string]::IsNullOrWhiteSpace($DeviceName)) {
    $EnrollArgs += @("--name", $DeviceName)
  }
  & $Node @EnrollArgs
  if ($LASTEXITCODE -ne 0) {
    throw "SafeHarbor device enrollment failed with exit code $LASTEXITCODE."
  }
}

$LocalToken = ((& $Node $Server --show-token) | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $LocalToken.Length -lt 32) {
  throw "SafeHarbor could not read the local extension token."
}

$Action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Server`"" -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $TargetUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$InstalledWith = "scheduled task"
$TaskRegistered = $false
$VerificationStartedAt = [DateTimeOffset]::UtcNow
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Starts the SafeHarbor local parental controls server at login." `
    -Force | Out-Null
  $TaskRegistered = $true
} catch {
  Write-Warning "Scheduled Task registration failed: $($_.Exception.Message)"
}

if ($TaskRegistered) {
  try {
    Start-ScheduledTask -TaskName $TaskName
  } catch {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    throw "SafeHarbor registered its Scheduled Task but could not start it: $($_.Exception.Message)"
  }
} else {
  $InstalledWith = "startup script"
  New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null
  $StartupBody = @"
@echo off
cd /d "$Root"
start "SafeHarbor" /min "$Node" "$Server"
"@
  Set-Content -Path $StartupScript -Encoding ASCII -Value $StartupBody
  Start-Process -FilePath $Node -ArgumentList "`"$Server`"" -WorkingDirectory $Root -WindowStyle Hidden
  Write-Warning "Installed the current-user Startup fallback instead: $StartupScript"
}

$Status = $null
if (!$SkipHealthCheck) {
  $Status = Wait-ForSafeHarborStatus -Token $LocalToken -TimeoutSeconds 30
  if ($Status.hubSyncEnabled) {
    $Status = Wait-ForHubSync -Token $LocalToken -TimeoutSeconds $SyncTimeoutSeconds -NotBefore $VerificationStartedAt
  } elseif ($HasHubUrl) {
    throw "The device enrolled, but the running agent does not have hub sync enabled."
  }
}

Write-Host "SafeHarbor is installed and running using: $InstalledWith"
Write-Host "Windows account: $TargetUser"
Write-Host "Application folder: $Root"
Write-Host "Extension folder: $ExtensionDir"
if ($Status) {
  Write-Host "Configuration: $($Status.configFile)"
  Write-Host "Logs: $($Status.logsDir)"
  Write-Host "Device ID: $($Status.deviceId)"
  if ($Status.hubSyncEnabled) {
    Write-Host "Hub sync completed: $($Status.hubLastSyncAt)"
  }
}
if ($HasHubUrl) {
  Write-Host "Hub: $HubUrl"
}
Write-Host "Chrome server URL: http://127.0.0.1:43718"
Write-Host "Chrome extension token: $LocalToken"
Write-Host "Load the extension folder in chrome://extensions, then paste the server URL and token into SafeHarbor Options."
