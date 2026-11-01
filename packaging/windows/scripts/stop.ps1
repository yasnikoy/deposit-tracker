# stop.cmd: stops the app (the task, its run.ps1 loop and the server). It stays stopped until
# start.cmd or, with automatic start, the next Windows sign-in.
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    if (-not (Stop-App)) { throw 'Uygulama durdurulamadı; bilgisayarı yeniden başlatın.' }
    Write-Host 'Deposit Tracker durduruldu.' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
Wait-Close
