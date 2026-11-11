@echo off
rem Stop the dashboard process tree started by run-service.cmd.
rem Task Scheduler only kills wscript.exe when the task is stopped, so the
rem cmd/npm/node children need to be terminated explicitly.
setlocal
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'LLM Quota Dashboard' -ErrorAction SilentlyContinue; $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-service\.cmd' }; foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F | Out-Null }"
echo Stopped LLM Quota Dashboard.
