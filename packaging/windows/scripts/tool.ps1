# backup.cmd and create-admin.cmd: runs one of the bundled tools with the app's settings.
param([Parameter(Mandatory = $true)][ValidateSet('backup', 'create-admin')][string]$Tool)
. (Join-Path $PSScriptRoot 'common.ps1')

try {
    Import-DepositEnv
    Set-Location $ServerDir
    $ErrorActionPreference = 'Continue'
    & $NodeExe (Join-Path $ServerDir "tools\$Tool.mjs")
    if ($LASTEXITCODE -ne 0) { Write-Host "Bitti, hata kodu $LASTEXITCODE." -ForegroundColor Yellow }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
}
Wait-Close
