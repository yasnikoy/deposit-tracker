@echo off
rem Deposit Tracker: opens the port in Windows Firewall (asks for administrator approval; run once by IT)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\firewall.ps1"
