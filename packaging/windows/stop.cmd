@echo off
rem Deposit Tracker: stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\stop.ps1"
