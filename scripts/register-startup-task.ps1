#requires -Version 5.1
# Register (or refresh) the logon scheduled task that runs the dashboard hidden.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$vbs = Join-Path $root 'scripts\start-service.vbs'
$taskName = 'LLM Quota Dashboard'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
  -Execute "$env:WINDIR\System32\wscript.exe" `
  -Argument ('"' + $vbs + '"') `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$principal = New-ScheduledTaskPrincipal `
  -UserId $user `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Quota dashboard: scraper daemon, Express API on :8787, Vite UI on :5173' `
  -Force | Out-Null

Write-Host "Registered scheduled task '$taskName' for $user."
