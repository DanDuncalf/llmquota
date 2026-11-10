@echo off
rem Start the dashboard (scraper + API + UI) for the scheduled task.
rem Keeps running until the service exits; logs go to data\service.log.
setlocal
cd /d "%~dp0.."
if not exist data mkdir data

rem Don't start a second copy if the API port is already served.
for /f %%L in ('netstat -ano ^| findstr /C:":8787" ^| findstr /C:"LISTENING"') do exit /b 0

set "NPM=%ProgramFiles%\nodejs\npm.cmd"
if not exist "%NPM%" set "NPM=npm.cmd"

echo.>> data\service.log
echo [%DATE% %TIME%] starting quota dashboard>> data\service.log
"%NPM%" run dev >> data\service.log 2>&1
exit /b %ERRORLEVEL%
