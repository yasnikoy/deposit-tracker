# stop.cmd: stops the app (the task, and its server process). It stays stopped until start.cmd
# or the next Windows start.
. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-Elevated $PSCommandPath

try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $running = @(Get-AppNodeProcesses)
    foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    if (Get-AppNodeProcesses) { throw 'Uygulama durdurulamadı; bilgisayarı yeniden başlatın.' }
    Write-Host 'Deposit Tracker durduruldu.' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
Wait-Close
