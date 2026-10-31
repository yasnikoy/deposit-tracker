@echo off
rem Deposit Tracker: stop (asks Windows for administrator approval)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
