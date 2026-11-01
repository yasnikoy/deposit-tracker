@echo off
rem Deposit Tracker: stop (asks Windows for administrator approval)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\stop.ps1"
