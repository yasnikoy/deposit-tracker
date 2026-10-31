# start.cmd: starts the app through its scheduled task and waits until it answers.
. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-Elevated $PSCommandPath

try {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw 'Otomatik başlatma görevi yok. Önce setup.cmd çalıştırın.' }
    $port = [int](Read-DepositEnv).PORT
    if (Get-AppNodeProcesses) {
        Write-Host 'Uygulama zaten çalışıyor.'
    } else {
        Start-ScheduledTask -TaskName $TaskName
        Write-Host 'Başlatılıyor…'
    }
    $version = Wait-Health $port
    if (-not $version) { throw "Uygulama yanıt vermedi. Ayrıntı: $(Join-Path (Read-DepositEnv).DATA_DIR 'logs\console.log')" }
    Write-Host "Deposit Tracker $version çalışıyor: http://localhost:$port" -ForegroundColor Green
    foreach ($ip in Get-LanAddresses) { Write-Host "Ofis ağında: http://$($ip):$port" -ForegroundColor Green }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
Wait-Close
