# Started by the DepositTracker scheduled task (at the user's Windows sign-in, or by start.cmd).
# Installs a staged update first, then runs the server and waits for it; when the server stops
# with an error it is started again after a minute. ARCHITECTURE -> Updates:
#   - an update staged by the app (update\pending.json + its verified zip) is unpacked, its
#     `DepositTracker\app` swapped in for `app` (the previous folder kept as `app-previous`) and
#     the launchers next to it (setup.cmd, start.cmd, ...) refreshed;
#   - if the new version does not answer /api/health in time, it is stopped, `app-previous`
#     comes back, and a database migrated by it is restored from the automatic pre-migration
#     backup (the changed file is kept aside, never deleted);
#   - exit code 75 from the server means "update staged": install it and start again at once.
. (Join-Path $PSScriptRoot 'common.ps1')

# The task has no window: an error before the server starts would otherwise leave no trace.
trap {
    Add-Content -Path (Join-Path $RootDir 'run-error.log') -Value "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) [$([Security.Principal.WindowsIdentity]::GetCurrent().Name)] $($_ | Out-String)" -Encoding UTF8
    exit 1
}

Import-DepositEnv
$env:APP_ROOT = $RootDir
$port = [int]$env:PORT
$logs = Join-Path $env:DATA_DIR 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$updateLog = Join-Path $logs 'updates.log'
$UpdateDir = Join-Path $RootDir 'update'
$Pending = Join-Path $UpdateDir 'pending.json'
$Previous = Join-Path $RootDir 'app-previous'
$RestartForUpdate = 75

# Never stay inside `app`: Windows cannot rename a folder a process is working in. (Set-Location
# alone does not move the process's own working folder.)
Set-Location $RootDir
[Environment]::CurrentDirectory = $RootDir

function Write-UpdateLog([string]$Text) {
    Add-Content -Path $updateLog -Value "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $Text" -Encoding UTF8
}

function Get-InstalledVersion([string]$Dir) {
    return (Get-Content -Path (Join-Path $Dir 'VERSION') -Raw).Trim()
}

# Renames with a few retries: an antivirus scan can hold a file for a moment.
function Rename-WithRetry([string]$Path, [string]$NewName) {
    for ($i = 1; $i -le 10; $i++) {
        try { Rename-Item -Path $Path -NewName $NewName; return } catch { if ($i -eq 10) { throw }; Start-Sleep -Seconds 3 }
    }
}

function Install-PendingUpdate {
    if (-not (Test-Path $Pending)) { return $null }
    $info = Get-Content -Path $Pending -Raw | ConvertFrom-Json
    $zip = Join-Path $UpdateDir $info.file
    $new = Join-Path $RootDir 'app-new'
    $unpacked = Join-Path $RootDir 'update-unpacked'
    try {
        $current = Get-InstalledVersion $AppDir
        if ((Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower() -ne $info.sha256) { throw 'paket bozuk (SHA-256 tutmuyor)' }
        if ([version]$info.version -le [version]$current) { throw "$($info.version) kurulu sürümden ($current) yeni değil" }
        foreach ($dir in $new, $unpacked) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
        New-Item -ItemType Directory -Path $unpacked | Out-Null
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (Test-Path $tar) { & $tar -xf $zip -C $unpacked; if ($LASTEXITCODE -ne 0) { throw 'paket açılamadı' } }
        else { Expand-Archive -Path $zip -DestinationPath $unpacked }
        $package = Join-Path $unpacked 'DepositTracker'
        if (-not (Test-Path (Join-Path $package 'app\VERSION'))) { throw 'paketin yapısı beklenen gibi değil' }
        if ((Get-InstalledVersion (Join-Path $package 'app')) -ne $info.version) { throw 'paketteki sürüm beklenen sürüm değil' }
        Move-Item -Path (Join-Path $package 'app') -Destination $new
        if (Test-Path $Previous) { Remove-Item -Recurse -Force $Previous }
        Rename-WithRetry $AppDir 'app-previous'
        Rename-WithRetry $new 'app'
        # The launchers only call into app\scripts; refresh them with the package's copies.
        Get-ChildItem -Path $package -File | Copy-Item -Destination $RootDir -Force
        Write-UpdateLog "kuruldu: $current -> $($info.version)"
        return @{ From = $current; To = $info.version; At = (Get-Date).ToUniversalTime() }
    } catch {
        Write-UpdateLog "kurulmadı: $($info.version): $($_.Exception.Message)"
        if (Test-Path $new) { Remove-Item -Recurse -Force $new -ErrorAction SilentlyContinue }
        return $null
    } finally {
        Remove-Item -Force -Path $Pending, $zip -ErrorAction SilentlyContinue
        if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked -ErrorAction SilentlyContinue }
    }
}

function Restore-Previous($installed) {
    $failed = Join-Path $RootDir "app-failed-$($installed.To)"
    if (Test-Path $failed) { Remove-Item -Recurse -Force $failed }
    Rename-WithRetry $AppDir (Split-Path -Leaf $failed)
    Rename-WithRetry $Previous 'app'
    # The new version may have migrated the database before failing: restore the copy taken
    # just before that migration. The migrated file is kept next to the backups.
    $backups = Join-Path $env:DATA_DIR 'backups'
    $preMigration = Get-ChildItem -Path $backups -Filter 'pre-migration-*.sqlite' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -ge $installed.At } | Sort-Object LastWriteTimeUtc | Select-Object -First 1
    if ($preMigration) {
        $db = Join-Path $env:DATA_DIR 'deposit.sqlite'
        $stamp = (Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')
        Copy-Item -Path $db -Destination (Join-Path $backups "failed-update-$($installed.To)-$stamp.sqlite")
        Copy-Item -Path $preMigration.FullName -Destination $db -Force
        Remove-Item -Force -Path "$db-wal", "$db-shm" -ErrorAction SilentlyContinue
        Write-UpdateLog "veritabanı güncelleme öncesi yedekten geri yüklendi: $($preMigration.Name)"
    }
    Write-UpdateLog "geri dönüldü: $($installed.To) açılmadı, $($installed.From) yeniden çalışıyor (ayrıntı: logs\console*.log)"
}

function Start-Server {
    # The app writes its own rotating logs; these files catch what happens before or during a
    # crash. The previous run's copies are kept, so a crash is still visible after the restart.
    foreach ($name in 'console.log', 'console-error.log') {
        $file = Join-Path $logs $name
        if (Test-Path $file) { Move-Item -Force $file (Join-Path $logs ($name -replace '\.log$', '-previous.log')) }
    }
    $process = Start-Process -FilePath $NodeExe -ArgumentList 'server.js' -WorkingDirectory $ServerDir -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $logs 'console.log') -RedirectStandardError (Join-Path $logs 'console-error.log')
    # Windows PowerShell only reports ExitCode (75 = update staged) if the handle was taken
    # while the process ran.
    $null = $process.Handle
    return $process
}

$installed = Install-PendingUpdate
while ($true) {
    $server = Start-Server
    if ($installed) {
        $version = Wait-Health $port 180
        if ($version -ne $installed.To) {
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
            $server.WaitForExit()
            Restore-Previous $installed
            $installed = $null
            continue
        }
        Write-UpdateLog "çalışıyor: $version"
        $installed = $null
    }
    $server.WaitForExit()
    if ($server.ExitCode -eq $RestartForUpdate) {
        $installed = Install-PendingUpdate
        continue
    }
    # Any other end is unexpected: start again after a minute (stop.cmd ends this loop too).
    Start-Sleep -Seconds 60
}
