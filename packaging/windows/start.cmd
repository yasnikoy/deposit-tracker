@echo off
rem Deposit Tracker: start (asks Windows for administrator approval)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
