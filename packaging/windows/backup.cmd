@echo off
rem Deposit Tracker: backup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\tool.ps1" -Tool backup
