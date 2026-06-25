param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [switch]$CreateTag
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$versionPath = Join-Path $repoRoot 'VERSION'
$packagePath = Join-Path $repoRoot 'package.json'
$deploymentPath = Join-Path $repoRoot 'truenas-deployment.json'

function Read-JsonFile {
  param([string]$Path)
  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must look like 1.12.2"
}

$package = Read-JsonFile -Path $packagePath
$deployment = Read-JsonFile -Path $deploymentPath

$package.version = $Version
$deployment.version = $Version

if ($deployment.image -match '^(?<repo>.+?):[^:]+$') {
  $deployment.image = "$($Matches.repo):$Version"
}

Set-Content -LiteralPath $versionPath -Value "$Version`n" -NoNewline:$false
$package | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $packagePath
$deployment | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $deploymentPath

Write-Host "Updated release metadata to $Version" -ForegroundColor Green
Write-Host "  VERSION"
Write-Host "  package.json"
Write-Host "  truenas-deployment.json"

if ($CreateTag) {
  git -C $repoRoot tag "v$Version"
  Write-Host "Created git tag v$Version" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  git -C $repoRoot status"
Write-Host "  git -C $repoRoot add VERSION package.json truenas-deployment.json"
Write-Host "  git -C $repoRoot commit -m `"Release $Version`""
Write-Host "  git -C $repoRoot push origin main --tags"
