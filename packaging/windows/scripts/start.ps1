# start.cmd: starts the app through its scheduled task and waits until it answers.
. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-Elevated $PSCommandPath

try {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw 'Otomatik başlatma görevi yok. Önce setup.cmd çalıştırın.' }
    Import-DepositEnv  # stops with a clear message when deposit.env is missing (wrong folder)
    $port = [int]$env:PORT
    if (Get-AppNodeProcesses) {
        Write-Host 'Uygulama zaten çalışıyor.'
    } else {
        Start-ScheduledTask -TaskName $TaskName
        Write-Host 'Başlatılıyor…'
    }
    $version = Wait-Health $port
    if (-not $version) {
        Write-Host 'Uygulama yanıt vermedi.' -ForegroundColor Red
        Write-StartFailure $env:DATA_DIR
    } else {
        Write-Host "Deposit Tracker $version çalışıyor: http://localhost:$port" -ForegroundColor Green
        foreach ($ip in Get-LanAddresses) { Write-Host "Ofis ağında: http://$($ip):$port" -ForegroundColor Green }
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
Wait-Close
