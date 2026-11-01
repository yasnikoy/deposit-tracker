# First setup on the office PC (setup.cmd). Asks a few questions, then: writes deposit.env,
# creates the first admin, opens the port in Windows Firewall (domain and private networks
# only), registers the task under the given Windows account (with its password, or without one
# through S4U when it has none), with or without a Windows-startup trigger, and starts the app.
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
    Write-Host "Kurulum klasörü : $RootDir"
    Write-Host "Program         : $AppDir"
    Write-Host "Veriler         : $(Join-Path $RootDir 'data')"
    # A synced folder copies the database while it is being written and can corrupt it.
    $synced = @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ -and $RootDir.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }
    if ($synced) {
        Write-Host 'Uyarı: bu klasör OneDrive ile eşitleniyor. Eşitleme, kullanılan veritabanını bozabilir.' -ForegroundColor Yellow
        Write-Host 'Masaüstü veya Belgeler OneDrive''a bağlıysa DepositTracker klasörünü OneDrive dışındaki bir klasöre taşıyın' -ForegroundColor Yellow
        Write-Host '(örneğin kullanıcı klasörünüzün içine) ve setup.cmd dosyasını oradan çalıştırın.' -ForegroundColor Yellow
        if (-not (Ask-YesNo 'Yine de bu klasöre kurulsun mu?' $false)) { Wait-Close; exit 1 }
    } elseif (-not (Ask-YesNo 'Veri, anahtar ve ayar dosyası bu klasöre yazılsın mı?' $true)) {
        Write-Host 'DepositTracker klasörünü istediğiniz yere taşıyıp setup.cmd dosyasını oradan çalıştırın.'
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

    # The app always runs through the task (start.cmd starts it, it restarts after errors and
    # installs updates); automatic start only decides whether it has a Windows-startup trigger.
    Write-Title 'Otomatik başlatma'
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $autoStart = Ask-YesNo 'Uygulama Windows açılınca, kimse oturum açmadan otomatik başlasın mı? (Hayır: start.cmd ile başlatılır)' (-not $existing -or @($existing.Triggers).Count -gt 0)
    Write-Host 'Uygulama bir Windows hesabıyla çalışır. Şifre yalnızca Windows Görev Zamanlayıcı''ya verilir, uygulama saklamaz.'
    Write-Host 'Hesabın şifresi yoksa boş bırakın: görev şifresiz kaydedilir; o zaman ağdaki paylaşılan klasörlere'
    Write-Host '(örneğin ağdaki bir ikinci yedek konumuna) erişemez, harici diske veya bu bilgisayardaki bir klasöre erişir.'
    $account = Ask 'Windows hesabı' ($(if ($LaunchUser) { $LaunchUser } else { "$env:USERDOMAIN\$env:USERNAME" }))
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'run.ps1')`"" -WorkingDirectory $RootDir
    $triggers = if ($autoStart) { @(New-ScheduledTaskTrigger -AtStartup) } else { @() }
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    while ($true) {
        $secure = Read-Host "$account şifresi (şifre yoksa boş bırakın)" -AsSecureString
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        try {
            $task = @{ TaskName = $TaskName; Action = $action; Settings = $taskSettings; Force = $true }
            if ($triggers.Count -gt 0) { $task.Trigger = $triggers }
            if ($plain) {
                Register-ScheduledTask @task -User $account -Password $plain -RunLevel Limited | Out-Null
            } else {
                # No stored password (S4U): Windows refuses blank passwords for tasks, this needs none.
                Register-ScheduledTask @task -Principal (New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Limited) | Out-Null
            }
            break
        } catch {
            Write-Host "Görev kaydedilemedi: $($_.Exception.Message)" -ForegroundColor Yellow
            if (-not (Ask-YesNo 'Tekrar denensin mi?' $true)) { throw 'Otomatik başlatma ayarlanamadı.' }
        } finally {
            $plain = $null
        }
    }
    if ($autoStart) { Write-Host "Görev '$TaskName' kaydedildi; uygulama Windows açılınca başlar." }
    else { Write-Host "Görev '$TaskName' kaydedildi; uygulama Windows açılınca başlamaz, start.cmd ile başlatın." }

    Write-Title 'Başlatılıyor'
    Start-ScheduledTask -TaskName $TaskName
    $version = Wait-Health ([int]$port)
    if (-not $version) {
        Write-Host 'Uygulama 90 saniyede yanıt vermedi.' -ForegroundColor Red
        Write-StartFailure $dataDir
        Wait-Close; exit 1
    }
    Write-Host "Deposit Tracker $version çalışıyor." -ForegroundColor Green
    Write-Host ''
    Write-Host 'Bu bilgisayarda : ' -NoNewline; Write-Host "http://localhost:$port" -ForegroundColor Green
    foreach ($ip in Get-LanAddresses) { Write-Host 'Ofis ağında    : ' -NoNewline; Write-Host "http://$($ip):$port" -ForegroundColor Green }
    Write-Host ''
    Write-Host 'İlk girişten sonra: Ayarlar -> E-posta, Kullanıcılar, Acenteler; Ayarlar -> Yedekleme -> İkinci yedek konumu.'
    Wait-Close
} catch {
    Write-Host "Kurulum tamamlanamadı: $($_.Exception.Message)" -ForegroundColor Red
    Wait-Close
    exit 1
}
