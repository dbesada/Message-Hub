# Message Hub — Cloudflare Tunnel Setup
# This gives the app a permanent public URL (e.g. https://quo.yourdomain.com)
# that works from any browser anywhere, for free.
#
# Prerequisites:
#   1. A Cloudflare account (free) at cloudflare.com
#   2. A domain managed by Cloudflare (or use the free *.trycloudflare.com URL)
#   3. Run .\install-service.ps1 first so the app is always running

$CloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
$CloudflaredExe = "C:\AI\quo-webapp\cloudflared.exe"

# ── 1. Download cloudflared if not present ────────────────────────────────────
if (-not (Test-Path $CloudflaredExe)) {
    Write-Host "Downloading cloudflared..." -ForegroundColor Cyan
    Invoke-WebRequest $CloudflaredUrl -OutFile $CloudflaredExe -UseBasicParsing
    Write-Host "Downloaded." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== OPTION A: Quick temporary URL (no account needed) ===" -ForegroundColor Cyan
Write-Host "Run this to get a temporary https URL valid for a few hours:"
Write-Host "  $CloudflaredExe tunnel --url http://localhost:3000" -ForegroundColor Yellow
Write-Host ""
Write-Host "=== OPTION B: Permanent URL with your domain ===" -ForegroundColor Cyan
Write-Host "1. Log in to Cloudflare:"
Write-Host "   $CloudflaredExe login"
Write-Host ""
Write-Host "2. Create a named tunnel:"
Write-Host "   $CloudflaredExe tunnel create message-hub"
Write-Host ""
Write-Host "3. Route your domain to it (replace with your domain):"
Write-Host "   $CloudflaredExe tunnel route dns message-hub quo.yourdomain.com"
Write-Host ""
Write-Host "4. Install cloudflared as a Windows service (auto-starts with Windows):"
Write-Host "   $CloudflaredExe service install"
Write-Host "   $CloudflaredExe tunnel run message-hub"
Write-Host ""
Write-Host "After setup, your app will be at https://quo.yourdomain.com" -ForegroundColor Green
Write-Host "It will work from any device, anywhere in the world."
Write-Host ""
Write-Host "No open ports, no router config — Cloudflare handles all of it."
