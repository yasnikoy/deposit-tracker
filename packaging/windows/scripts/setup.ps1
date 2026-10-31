# First setup on the office PC (setup.cmd). Asks a few questions, then: writes deposit.env,
# creates the first admin, opens the port in Windows Firewall (domain and private networks
# only), registers the startup task under the given Windows account and starts the app.
# Safe to run again: existing answers are offered as defaults.
param([string]$LaunchUser = '')

. (Join-Path $PSScriptRoot 'common.ps1')
Invoke-Elevated $PSCommandPath "-LaunchUser `"$LaunchUser`""

function Ask([string]$Question, [string]$Default) {
    $answer = Read-Host "$Question [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Ask-YesNo([string]$Question, [bool]$Default) {
    $hint = if ($Default) { 'E/h' } else { 'e/H' }
    while ($true) {
        $answer = (Read-Host "$Question ($hint)").Trim().ToLower()
        if ($answer -eq '') { return $Default }
        if ($answer -in @('e', 'evet', 'y')) { return $true }
        if ($answer -in @('h', 'hayir', 'hayır', 'n')) { return $false }
    }
}

try {
    Write-Title 'Deposit Tracker kurulumu'
    Write-Host "Program klasörü : $AppDir"
    Write-Host "Kurulum klasörü : $RootDir"
    if ((Split-Path -Leaf $AppDir) -ne 'app') {
        Write-Host "Uyarı: zip'in içeriği genellikle C:\DepositTracker\app klasörüne açılır." -ForegroundColor Yellow
    }
    if (-not (Ask-YesNo 'Veri, anahtar ve ayar dosyası bu kurulum klasörüne yazılsın mı?' $true)) {
        Write-Host 'Zip içeriğini istediğiniz yerdeki bir "app" klasörüne açıp setup.cmd dosyasını yeniden çalıştırın.'
        Wait-Close; exit 1
    }

    $current = Read-DepositEnv
    Write-Title 'Ayarlar'
    while ($true) {
        $port = Ask 'Port' ($(if ($current.PORT) { $current.PORT } else { '3000' }))
        if ($port -notmatch '^\d+$' -or [int]$port -lt 1024 -or [int]$port -gt 65535) { Write-Host 'Port 1024 ile 65535 arasında bir sayı olmalı.' -ForegroundColor Yellow; continue }
        $busy = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
        $ours = Get-AppNodeProcesses | Where-Object { $busy -and $busy.OwningProcess -contains $_.ProcessId }
        if ($busy -and -not $ours) { Write-Host "Port $port başka bir program tarafından kullanılıyor; başka bir port seçin." -ForegroundColor Yellow; continue }
        break
    }
    Write-Host 'E-posta gönderimi: deneme modunda hiçbir e-posta gönderilmez, sadece kaydedilir.'
    $live = Ask-YesNo 'E-postalar gerçekten gönderilsin mi? (deneme kurulumunda Hayır)' ($current.EMAIL_MODE -eq 'live')
    $dataDir = Join-Path $RootDir 'data'
    $settings = @(
        "# Deposit Tracker ayarları (setup.cmd yazar). Değiştirdikten sonra stop.cmd ve start.cmd.",
        "PORT=$port",
        "DATA_DIR=$dataDir",
        "KEY_FILE=$(Join-Path $RootDir 'deposit.key')",
        "EMAIL_MODE=$(if ($live) { 'live' } else { 'dry-run' })"
    )
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    [IO.File]::WriteAllLines($EnvFile, $settings, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Ayarlar kaydedildi: $EnvFile"

    # The task must not hold the database while the admin is created.
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Get-AppNodeProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }

    Write-Title 'Yönetici hesabı'
    if (Ask-YesNo 'Yeni bir yönetici hesabı oluşturulsun mu? (ilk kurulumda Evet)' (-not (Test-Path (Join-Path $dataDir 'deposit.sqlite')))) {
        Import-DepositEnv
        Set-Location $ServerDir
        & $NodeExe (Join-Path $ServerDir 'tools\create-admin.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Yönetici hesabı oluşturulamadı.' }
    }

    Write-Title 'Güvenlik duvarı'
    $ruleName = 'Deposit Tracker'
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort ([int]$port) -Profile Domain, Private | Out-Null
    Write-Host "Port $port ofis ağına açıldı (etki alanı ve özel ağ; genel ağlar kapalı)."

    Write-Title 'Otomatik başlatma'
    Write-Host 'Uygulama Windows açılınca, kimse oturum açmadan başlar. Bunun için bir Windows hesabı ve şifresi gerekir;'
    Write-Host 'şifre yalnızca Windows Görev Zamanlayıcı''ya verilir, uygulama saklamaz.'
    $account = Ask 'Windows hesabı' ($(if ($LaunchUser) { $LaunchUser } else { "$env:USERDOMAIN\$env:USERNAME" }))
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'run.ps1')`"" -WorkingDirectory $RootDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    while ($true) {
        $secure = Read-Host "$account şifresi" -AsSecureString
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        try {
            Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $taskSettings -User $account -Password $plain -RunLevel Limited -Force | Out-Null
            break
        } catch {
            Write-Host "Görev kaydedilemedi: $($_.Exception.Message)" -ForegroundColor Yellow
            if (-not (Ask-YesNo 'Tekrar denensin mi?' $true)) { throw 'Otomatik başlatma ayarlanamadı.' }
        } finally {
            $plain = $null
        }
    }
    Write-Host "Görev '$TaskName' kaydedildi."

    Write-Title 'Başlatılıyor'
    Start-ScheduledTask -TaskName $TaskName
    $version = Wait-Health ([int]$port)
    if (-not $version) {
        Write-Host "Uygulama 90 saniyede yanıt vermedi. Ayrıntı: $(Join-Path $dataDir 'logs\console.log')" -ForegroundColor Red
        Wait-Close; exit 1
    }
    Write-Host "Deposit Tracker $version çalışıyor." -ForegroundColor Green
    Write-Host ''
    Write-Host 'Bu bilgisayarda : ' -NoNewline; Write-Host "http://localhost:$port" -ForegroundColor Green
    foreach ($ip in Get-LanAddresses) { Write-Host 'Ofis ağında    : ' -NoNewline; Write-Host "http://$($ip):$port" -ForegroundColor Green }
    Write-Host ''
    Write-Host 'İlk girişten sonra: Ayarlar -> E-posta, Kullanıcılar, Acenteler; Ayarlar -> Yedekler -> ikinci konum.'
    Wait-Close
} catch {
    Write-Host "Kurulum tamamlanamadı: $($_.Exception.Message)" -ForegroundColor Red
    Wait-Close
    exit 1
}
