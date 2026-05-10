param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "SafeHarbor"
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "server\safeharbor-server.js"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
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
$QuotedNode = $Node.Replace("'", "''")
$QuotedServer = $Server.Replace("'", "''")
$PowerShellArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$QuotedNode' '$QuotedServer'`""

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $PowerShellArgs
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel LeastPrivilege
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Starts the SafeHarbor local parental controls server at login." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Server: $Server"
Write-Host "Print the extension token with:"
Write-Host "  node `"$Server`" --show-token"
