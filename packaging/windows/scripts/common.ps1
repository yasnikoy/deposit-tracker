# Shared by the Deposit Tracker scripts. Layout (ARCHITECTURE -> Operations and deployment);
# <root> is the DepositTracker folder from the zip, wherever it was unpacked (Desktop, Documents):
#   <root>\*.cmd        launchers (setup, start, stop, backup, create-admin) and BENIOKU.txt
#   <root>\app          program files (replaced by updates)
#   <root>\data         database, uploaded files, logs, backups (never touched by updates)
#   <root>\deposit.key  mail-password key (outside data, never in backups)
#   <root>\deposit.env  settings written by setup.cmd (port, email mode)
# The folders are never stored: they follow <root>, so the folder can be moved (then setup.cmd
# again, for the task).
# Nothing here needs administrator rights except firewall.cmd, which IT runs once
# (ARCHITECTURE -> Operations and deployment).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$TaskName = 'DepositTracker'
$AppDir = Split-Path -Parent $PSScriptRoot
$RootDir = Split-Path -Parent $AppDir
$EnvFile = Join-Path $RootDir 'deposit.env'
$NodeExe = Join-Path $AppDir 'node\node.exe'
$ServerDir = Join-Path $AppDir 'server'
$RunScript = Join-Path $PSScriptRoot 'run.ps1'
$FirewallRuleName = 'Deposit Tracker'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-runs the calling script as administrator (Windows asks for approval) and ends this copy.
# Only firewall.cmd uses it.
function Invoke-Elevated([string]$ScriptPath, [string]$Arguments = '') {
    if (Test-Admin) { return }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $Arguments"
    exit 0
}

function Read-DepositEnv {
    $values = [ordered]@{}
    if (Test-Path $EnvFile) {
        foreach ($line in Get-Content -Path $EnvFile -Encoding UTF8) {
            if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2] }
        }
    }
    return $values
}

# Loads deposit.env into this process, plus what every run needs.
function Import-DepositEnv {
    if (-not (Test-Path $EnvFile)) { throw "Ayar dosyası yok: $EnvFile. Önce setup.cmd çalıştırın." }
    foreach ($entry in (Read-DepositEnv).GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    $env:DATA_DIR = Join-Path $RootDir 'data'
    $env:KEY_FILE = Join-Path $RootDir 'deposit.key'
    $env:NODE_ENV = 'production'
    $env:HOSTNAME = '0.0.0.0'
    $env:NEXT_TELEMETRY_DISABLED = '1'
}

# Office-network IPv4 addresses, best first (office PCs share one name, so people use the address).
function Get-LanAddresses {
    $all = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress
    $rank = { param($a) if ($a -like '192.168.*') { 0 } elseif ($a -like '10.*') { 1 } elseif ($a -match '^172\.(1[6-9]|2\d|3[01])\.') { 2 } else { 3 } }
    return @($all | Sort-Object { & $rank $_ })
}

# Waits until the app answers on /api/health; returns its version or $null.
function Wait-Health([int]$Port, [int]$Seconds = 90) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
            if ($r.ok) { return $r.version }
        } catch { Start-Sleep -Seconds 2 }
    }
    return $null
}

# Node processes started from this app folder (the server, or a tool).
function Get-AppNodeProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $NodeExe }
}

# The run.ps1 loops of this installation (they restart the server after an error).
function Get-AppRunnerProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($RunScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
}

# Stops the task, its run.ps1 loop and the server; $true when nothing is left running.
function Stop-App {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    foreach ($p in @(Get-AppRunnerProcesses) + @(Get-AppNodeProcesses)) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    return -not (Get-AppNodeProcesses)
}

# Whether Windows Firewall lets the office network reach the app: $true, $false, or $null when
# the rules cannot be read. The rule names node.exe so Windows never asks about it on first use.
function Test-FirewallRule([int]$Port) {
    try {
        $rules = @(Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction Stop | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
        foreach ($rule in $rules) {
            $ports = @(($rule | Get-NetFirewallPortFilter).LocalPort)
            $program = ($rule | Get-NetFirewallApplicationFilter).Program
            if ($ports -contains [string]$Port -and $program -ieq $NodeExe) { return $true }
        }
        return $false
    } catch {
        # "No rule with that name" is an answer; anything else (e.g. no access) is not.
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return $false }
        return $null
    }
}

# Connected networks Windows treats as public. The firewall rule never covers public networks,
# so on one of them other PCs cannot connect and Windows asks again about node.exe at each start.
function Get-PublicConnections {
    @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
}

function Write-PublicNetworkHelp($Connections) {
    foreach ($c in $Connections) {
        Write-Host "Uyarı: '$($c.InterfaceAlias)' bağlantısı Windows'ta 'Ortak ağ' (Public) olarak tanımlı." -ForegroundColor Yellow
    }
    Write-Host 'Güvenlik duvarı kuralı ortak ağlarda geçerli değildir: diğer bilgisayarlar bağlanamaz ve Windows her' -ForegroundColor Yellow
    Write-Host 'başlatmada ağ erişimi sorar (o pencerede İptal deyin). Ofis ağıysa BT bağlantıyı "Özel ağ" yapsın:' -ForegroundColor Yellow
    Write-Host 'firewall.cmd bunu da sorar; veya Ayarlar -> Ağ ve İnternet -> Ethernet -> Ağ profili türü -> Özel.' -ForegroundColor Yellow
}

# Shown when the firewall rule is missing: the one step that needs an administrator.
function Write-FirewallHelp([int]$Port) {
    Write-Host "Diğer bilgisayarların uygulamaya ulaşması için Windows Güvenlik Duvarı'nda port $Port açılmalı." -ForegroundColor Yellow
    Write-Host 'Bu, yönetici izni gereken tek adımdır ve bir kez yapılır:' -ForegroundColor Yellow
    Write-Host "  BT (yönetici hesabı olan biri) DepositTracker klasöründeki firewall.cmd dosyasını çalıştırır." -ForegroundColor Yellow
    Write-Host '  Port veya klasör değişirse bir kez daha çalıştırılır.' -ForegroundColor Yellow
    Write-Host "Bu bilgisayarda uygulama yine çalışır: http://localhost:$Port" -ForegroundColor Yellow
}

# Shown when the app does not answer after a start: the task's last result and the end of the
# console logs, so the cause is on screen instead of in a folder.
function Write-StartFailure([string]$DataDir) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($info) { Write-Host ('Görevin son çalışması: {0}, sonuç kodu 0x{1:X8}' -f $info.LastRunTime, $info.LastTaskResult) }
    foreach ($file in (Join-Path $RootDir 'run-error.log'), (Join-Path $DataDir 'logs\console-error.log'), (Join-Path $DataDir 'logs\console.log')) {
        if (-not (Test-Path $file)) {
            if ($file -like '*\logs\*') { Write-Host "$file yok (sunucu hiç başlamadı)." }
            continue
        }
        $tail = @(Get-Content -Path $file -Tail 20 -Encoding UTF8)
        if ($tail.Count -eq 0) { continue }
        Write-Host "--- $file (son satırlar)"
        $tail | ForEach-Object { Write-Host $_ }
    }
}

function Write-Title([string]$Text) {
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Wait-Close {
    Write-Host ''
    Read-Host 'Kapatmak için Enter tuşuna basın' | Out-Null
}
