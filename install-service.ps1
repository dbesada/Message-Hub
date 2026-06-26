# Message Hub — Windows Service Installer
# Run this once as Administrator to install the app as a background service
# that starts automatically with Windows.
#
# Usage:
#   Right-click PowerShell → Run as Administrator
#   cd C:\AI\quo-webapp
#   .\install-service.ps1
#   .\install-service.ps1 -ServiceName QuoManager   # keep legacy service name on an upgrade

param(
    [string]$ServiceName = "MessageHub"
)

$AppDir      = "C:\AI\quo-webapp"
$PythonExe   = (Get-Command python).Source
$ScriptPath  = "$AppDir\server.py"
$NssmUrl     = "https://nssm.cc/release/nssm-2.24.zip"
$NssmDir     = "$AppDir\nssm"
$NssmExe     = "$NssmDir\win64\nssm.exe"

# ── 1. Download NSSM if not present ──────────────────────────────────────────
if (-not (Test-Path $NssmExe)) {
    Write-Host "Downloading NSSM..." -ForegroundColor Cyan
    $zip = "$AppDir\nssm.zip"
    Invoke-WebRequest $NssmUrl -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $AppDir -Force
    Rename-Item "$AppDir\nssm-2.24" $NssmDir -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force
    Write-Host "NSSM downloaded." -ForegroundColor Green
}

# ── 2. Remove existing service if present ────────────────────────────────────
$existing = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing service..." -ForegroundColor Yellow
    & $NssmExe stop  $ServiceName confirm 2>$null
    & $NssmExe remove $ServiceName confirm
    Start-Sleep 1
}

# ── 3. Install service ────────────────────────────────────────────────────────
Write-Host "Installing $ServiceName service..." -ForegroundColor Cyan
& $NssmExe install $ServiceName $PythonExe $ScriptPath
& $NssmExe set     $ServiceName AppDirectory   $AppDir
& $NssmExe set     $ServiceName DisplayName    "Message Hub"
& $NssmExe set     $ServiceName Description    "Message Hub self-hosted messaging and booking triage app"
& $NssmExe set     $ServiceName Start          SERVICE_AUTO_START
& $NssmExe set     $ServiceName AppStdout      "$AppDir\service.log"
& $NssmExe set     $ServiceName AppStderr      "$AppDir\service.log"
& $NssmExe set     $ServiceName AppRotateFiles 1
& $NssmExe set     $ServiceName AppRotateBytes 5242880   # 5 MB log rotation

# Set environment variables
& $NssmExe set $ServiceName AppEnvironmentExtra "PORT=3000"

# ── 4. Start service ──────────────────────────────────────────────────────────
& $NssmExe start $ServiceName
Start-Sleep 3
$svc = Get-Service $ServiceName
Write-Host ""
Write-Host "Service status: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Running') {'Green'} else {'Red'})
Write-Host ""
Write-Host "Done! Message Hub is now running as a Windows service." -ForegroundColor Green
Write-Host "  - It will start automatically when Windows boots."
Write-Host "  - Access it at: http://localhost:3000"
Write-Host "  - Logs: $AppDir\service.log"
Write-Host ""
Write-Host "To stop:    nssm stop $ServiceName"
Write-Host "To restart: nssm restart $ServiceName"
Write-Host "To remove:  nssm remove $ServiceName confirm"
