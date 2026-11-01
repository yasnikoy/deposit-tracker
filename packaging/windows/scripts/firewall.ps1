# firewall.cmd: the one step that needs an administrator (IT runs it once). Allows the app's
# node.exe on its port from the office network (domain and private profiles; never public
# networks). Run again after changing the port or moving the DepositTracker folder.
. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-Elevated $PSCommandPath

try {
    Import-DepositEnv  # stops with a clear message when deposit.env is missing (setup.cmd first)
    $port = [int]$env:PORT
    Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    # "Cancel" on Windows' own "allow access?" prompt leaves block rules for node.exe, and a block
    # rule wins over any allow rule: remove those of this installation's node.exe.
    $blocks = @(Get-NetFirewallApplicationFilter -Program $NodeExe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' })
    if ($blocks.Count -gt 0) {
        $blocks | Remove-NetFirewallRule
        Write-Host "node.exe için $($blocks.Count) engelleme kuralı kaldırıldı."
    }
    New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port `
        -Program $NodeExe -Profile Domain, Private | Out-Null
    Write-Host "Port $port ofis ağına açıldı (etki alanı ve özel ağ; genel ağlar kapalı)." -ForegroundColor Green
    Write-Host "Program: $NodeExe"
    # The rule skips public networks on purpose; an office connection marked public is moved
    # to private here, with the administrator's consent.
    foreach ($c in Get-PublicConnections) {
        $answer = (Read-Host "'$($c.InterfaceAlias)' bağlantısı 'Ortak ağ' (Public) olarak tanımlı; kural burada geçerli olmaz. Bu ofis ağı mı, 'Özel ağ' yapılsın mı? (E/h)").Trim().ToLower()
        if ($answer -in @('', 'e', 'evet', 'y')) {
            Set-NetConnectionProfile -InterfaceIndex $c.InterfaceIndex -NetworkCategory Private
            Write-Host "'$($c.InterfaceAlias)' artık özel ağ." -ForegroundColor Green
        } else {
            Write-Host 'Değiştirilmedi: bu bağlantıdan diğer bilgisayarlar uygulamaya ulaşamaz.' -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "Güvenlik duvarı ayarlanamadı: $($_.Exception.Message)" -ForegroundColor Red
}
Wait-Close
