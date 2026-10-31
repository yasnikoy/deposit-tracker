# Started by the DepositTracker scheduled task (at Windows startup, and again by the task's
# restart setting if the app stops). Runs the server in the foreground; the task ends when it
# exits, and a non-zero exit makes Task Scheduler restart it after a minute.
. (Join-Path $PSScriptRoot 'common.ps1')

Import-DepositEnv
$logs = Join-Path $env:DATA_DIR 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# The app writes its own rotating logs; this file only catches what happens before or during a
# crash. The previous run's copy is kept, so a crash is still visible after the restart.
$console = Join-Path $logs 'console.log'
if (Test-Path $console) { Move-Item -Force $console (Join-Path $logs 'console-previous.log') }

Set-Location $ServerDir
$ErrorActionPreference = 'Continue'
& cmd.exe /d /c "`"$NodeExe`" server.js > `"$console`" 2>&1"
exit $LASTEXITCODE
