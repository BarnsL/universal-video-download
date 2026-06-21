# install.ps1 -- Install uvd-helper on Windows.
#
# What this does:
#   1. Ensures Python 3.10+ + yt-dlp + ffmpeg are installed (winget).
#   2. Drops uvd-helper.py into %LOCALAPPDATA%\uvd-helper\.
#   3. Bootstraps config.json (generates a random token).
#   4. Registers a Scheduled Task that auto-starts the helper at login,
#      hidden, with no console window.
#   5. Kicks the task off now.
#   6. Copies the token to your clipboard so you can paste it into the
#      userscript's settings panel.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File install.ps1
# or, from the repo root:
#   .\helper\install.ps1

$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:LOCALAPPDATA "uvd-helper"
$ScriptPath = Join-Path $InstallDir "uvd-helper.py"
$ConfigFile = Join-Path $InstallDir "config.json"
$LocalSrc   = Join-Path $PSScriptRoot "uvd-helper.py"
$RawUrl     = "https://raw.githubusercontent.com/BarnsL/universal-video-download/main/helper/uvd-helper.py"
$TaskName   = "uvd-helper"

Write-Host "==> Installing uvd-helper" -ForegroundColor Cyan
Write-Host "    Target: $InstallDir"

# 1. Python
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { $pythonCmd = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $pythonCmd) {
    Write-Host "    Python not found. Installing Python 3.12 via winget..."
    winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
    # winget edits PATH for new processes only; resolve the freshly-installed exe.
    $cands = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:ProgramFiles "Python312\python.exe")
    ) | Where-Object { Test-Path $_ }
    if ($cands.Count -eq 0) {
        Write-Error "Python install seemed to succeed but python.exe wasn't found. Re-open PowerShell and re-run."
        exit 1
    }
    $pythonExe = $cands[0]
} else {
    $pythonExe = $pythonCmd.Source
}
Write-Host "    Python: $pythonExe"

# 2. yt-dlp + ffmpeg
foreach ($pair in @(@("yt-dlp", "yt-dlp.yt-dlp"), @("ffmpeg", "Gyan.FFmpeg"))) {
    $bin = $pair[0]; $pkg = $pair[1]
    if (Get-Command $bin -ErrorAction SilentlyContinue) {
        Write-Host "    $bin already installed."
    } else {
        Write-Host "    Installing $bin..."
        winget install --id $pkg --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
    }
}

# 3. Drop the helper script in place. Prefer the local copy (developer
#    workflow); fall back to the GitHub raw URL.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (Test-Path $LocalSrc) {
    Copy-Item -Path $LocalSrc -Destination $ScriptPath -Force
    Write-Host "    Copied $LocalSrc -> $ScriptPath"
} else {
    Write-Host "    Downloading helper from $RawUrl"
    Invoke-WebRequest -Uri $RawUrl -OutFile $ScriptPath -UseBasicParsing
}

# 4. Initialise config so we can read the token. Helper writes config on
#    first import, so a one-shot --print-config does it without binding
#    the port.
$cfgJson = & $pythonExe $ScriptPath --print-config
$cfg     = $cfgJson | ConvertFrom-Json
$token   = $cfg.token
$port    = $cfg.port

# 5. Scheduled Task (re-create idempotently).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "    Removing existing scheduled task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# pythonw.exe is the no-console variant of python.exe; prefer it so the
# helper doesn't flash a black window at login. Fall back to python.exe.
$pyw = $pythonExe -replace "python\.exe$", "pythonw.exe"
if (-not (Test-Path $pyw)) { $pyw = $pythonExe }

$action   = New-ScheduledTaskAction  -Execute $pyw -Argument "`"$ScriptPath`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -Hidden `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited | Out-Null
Write-Host "    Scheduled task '$TaskName' registered (auto-starts at login)."

# 6. Start it now. If something else is already bound to the port, this
#    will fail silently -- we surface it in the health check below.
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

# 7. Health check.
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
    Write-Host "    Helper health: OK (v$($health.version))" -ForegroundColor Green
    if ($health.tools.'yt-dlp')  { Write-Host "      yt-dlp: $($health.tools.'yt-dlp')" }
    if ($health.tools.ffmpeg)    { Write-Host "      ffmpeg: $($health.tools.ffmpeg)" }
    Write-Host "      Download dir: $($health.downloadDir)"
} catch {
    Write-Warning "    Helper not responding yet on port $port. It may still be starting. Run again or check: Get-ScheduledTaskInfo -TaskName uvd-helper"
}

# 8. Token to clipboard.
Set-Clipboard -Value $token
Write-Host ""
Write-Host "==> DONE" -ForegroundColor Green
Write-Host "Token (copied to clipboard):"
Write-Host "  $token" -ForegroundColor Yellow
Write-Host ""
Write-Host "Next step: open any tab where the userscript runs (e.g. youtube.com),"
Write-Host "open the download dialog (Ctrl+Shift+D), click the gear icon, and"
Write-Host "paste the token. After that, Download just works -- no clipboard"
Write-Host "round-trip, no terminal."
Write-Host ""
$uninst = "Unregister-ScheduledTask -TaskName " + $TaskName + ' -Confirm:$false; Remove-Item -Recurse "' + $InstallDir + '"'
Write-Host "Uninstall:  $uninst"
