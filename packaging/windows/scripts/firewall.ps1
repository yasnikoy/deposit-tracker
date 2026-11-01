# firewall.cmd: the one step that needs an administrator (IT runs it once). Allows the app's
# node.exe on its port from the office network (domain and private profiles; never public
# networks). Run again after changing the port or moving the DepositTracker folder.
. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-Elevated $PSCommandPath

try {
    Import-DepositEnv  # stops with a clear message when deposit.env is missing (setup.cmd first)
    $port = [int]$env:PORT
    Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port `
        -Program $NodeExe -Profile Domain, Private | Out-Null
    Write-Host "Port $port ofis ağına açıldı (etki alanı ve özel ağ; genel ağlar kapalı)." -ForegroundColor Green
    Write-Host "Program: $NodeExe"
} catch {
    Write-Host "Güvenlik duvarı ayarlanamadı: $($_.Exception.Message)" -ForegroundColor Red
}
Wait-Close
