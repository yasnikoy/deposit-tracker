@echo off
rem Deposit Tracker: setup (asks Windows for administrator approval)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\setup.ps1" -LaunchUser "%USERDOMAIN%\%USERNAME%"
