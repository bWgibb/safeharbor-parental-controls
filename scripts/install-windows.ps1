param(
  [switch]$Uninstall,
  [switch]$SkipHealthCheck
)

$ErrorActionPreference = "Stop"
$TaskName = "SafeHarbor"
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server\safeharbor-server.js"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupScript = Join-Path $StartupDir "SafeHarbor.cmd"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $StartupScript) {
    Remove-Item $StartupScript -Force
    Write-Host "Removed startup fallback: $StartupScript"
  }
  Write-Host "Removed scheduled task: $TaskName"
  exit 0
}

if (!(Test-Path $Server)) {
  throw "Server file not found: $Server"
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (!$NodeCommand) {
  throw "Node.js was not found on PATH. Install Node.js 20 LTS or newer first."
}

$Node = $NodeCommand.Source
$NodeMajor = & $Node -p "Number(process.versions.node.split('.')[0])"
if ($NodeMajor -lt 20) {
  $NodeVersion = & $Node -v
  throw "Node.js 20 LTS or newer is required. Found: $NodeVersion"
}

$QuotedNode = $Node.Replace("'", "''")
$QuotedServer = $Server.Replace("'", "''")
$PowerShellArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$QuotedNode' '$QuotedServer'`""

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $PowerShellArgs
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$InstalledWith = "scheduled task"
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Starts the SafeHarbor local parental controls server at login." `
    -Force | Out-Null

  Start-ScheduledTask -TaskName $TaskName
} catch {
  $InstalledWith = "startup script"
  New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null
  $CmdServer = $Server.Replace('"', '""')
  $CmdNode = $Node.Replace('"', '""')
  Set-Content -Path $StartupScript -Encoding ASCII -Value "@echo off`r`nstart ""SafeHarbor"" /min ""$CmdNode"" ""$CmdServer""`r`n"
  Start-Process -FilePath $Node -ArgumentList "`"$Server`"" -WindowStyle Minimized
  Write-Warning "Scheduled task install failed: $($_.Exception.Message)"
  Write-Warning "Installed user startup fallback instead: $StartupScript"
}

if (!$SkipHealthCheck) {
  $HealthUrl = "http://127.0.0.1:43718/health"
  $Healthy = $false
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $Response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
      if ($Response.ok -and $Response.app -eq "SafeHarbor") {
        $Healthy = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (!$Healthy) {
    throw "SafeHarbor scheduled task started but health check failed at $HealthUrl"
  }
}

Write-Host "Installed and started SafeHarbor using: $InstalledWith"
Write-Host "Server: $Server"
Write-Host "Print the extension token with:"
Write-Host "  node `"$Server`" --show-token"
