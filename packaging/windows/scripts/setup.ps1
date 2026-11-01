# First setup on the office PC (setup.cmd), without administrator rights. Asks a few questions,
# then: writes deposit.env, creates the first admin, registers the task under the signed-in
# Windows user (no stored password), with or without a sign-in trigger, starts the app and
# checks the firewall rule; when it is missing, says to have IT run firewall.cmd once.
# Safe to run again: existing answers are offered as defaults.
. (Join-Path $PSScriptRoot 'common.ps1')

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

    # The app must not hold the database while the admin is created.
    if (-not (Stop-App)) { throw 'Çalışan uygulama durdurulamadı; bilgisayarı yeniden başlatıp setup.cmd dosyasını tekrar çalıştırın.' }

    Write-Title 'Yönetici hesabı'
    if (Ask-YesNo 'Yeni bir yönetici hesabı oluşturulsun mu? (ilk kurulumda Evet)' (-not (Test-Path (Join-Path $dataDir 'deposit.sqlite')))) {
        Import-DepositEnv
        Set-Location $ServerDir
        & $NodeExe (Join-Path $ServerDir 'tools\create-admin.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Yönetici hesabı oluşturulamadı.' }
    }

    # The app always runs through the task (start.cmd starts it, run.ps1 restarts it after errors
    # and installs updates); automatic start only decides whether it has a sign-in trigger. The
    # task runs as the signed-in user, which needs no administrator rights and no stored password,
    # so the app runs while this user is signed in. conhost --headless keeps it without a window.
    Write-Title 'Otomatik başlatma'
    $account = "$env:USERDOMAIN\$env:USERNAME"
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $autoStart = Ask-YesNo "Uygulama $account Windows'ta oturum açınca otomatik başlasın mı? (Hayır: start.cmd ile başlatılır)" (-not $existing -or @($existing.Triggers).Count -gt 0)
    if ($existing) {
        # A task from an older setup was registered with administrator approval; a normal user
        # may not replace it, so removing it then asks for that approval once more.
        try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop }
        catch {
            Write-Host 'Önceki kurulumun görevi yönetici izniyle kaydedilmiş; kaldırmak için Windows bir kez yönetici onayı isteyecek.' -ForegroundColor Yellow
            Start-Process -FilePath 'schtasks.exe' -ArgumentList "/Delete /TN $TaskName /F" -Verb RunAs -Wait -WindowStyle Hidden
            if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw "Önceki görev kaldırılamadı. BT'den Görev Zamanlayıcı'daki '$TaskName' görevini silmesini isteyin, sonra setup.cmd dosyasını tekrar çalıştırın." }
        }
    }
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RunScript`"" -WorkingDirectory $RootDir
    $task = @{
        TaskName  = $TaskName
        Action    = $action
        Principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
        Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Force     = $true
    }
    if ($autoStart) { $task.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $account }
    Register-ScheduledTask @task | Out-Null
    if ($autoStart) { Write-Host "Görev '$TaskName' kaydedildi; uygulama $account oturum açınca başlar." }
    else { Write-Host "Görev '$TaskName' kaydedildi; uygulama kendiliğinden başlamaz, start.cmd ile başlatın." }

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

    Write-Title 'Güvenlik duvarı'
    $firewall = Test-FirewallRule ([int]$port)
    if ($firewall -eq $true) { Write-Host "Port $port ofis ağına açık." }
    elseif ($firewall -eq $false) { Write-FirewallHelp ([int]$port) }
    else { Write-Host 'Güvenlik duvarı kuralları okunamadı. Diğer bilgisayarlardan açılmıyorsa BT firewall.cmd dosyasını çalıştırsın.' -ForegroundColor Yellow }
    $public = Get-PublicConnections
    if ($public.Count -gt 0) { Write-PublicNetworkHelp $public }
    Write-Host ''
    Write-Host 'İlk girişten sonra: Ayarlar -> E-posta, Kullanıcılar, Acenteler; Ayarlar -> Yedekleme -> İkinci yedek konumu.'
    Wait-Close
} catch {
    Write-Host "Kurulum tamamlanamadı: $($_.Exception.Message)" -ForegroundColor Red
    Wait-Close
    exit 1
}
