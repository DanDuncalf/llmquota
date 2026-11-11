@echo off
rem llmquota — query the local quota dashboard from any directory.
rem Add this directory to PATH, then:  llmquota kimi --text
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\agent\cli.ts" %*
