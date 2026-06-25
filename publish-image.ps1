param(
  [Parameter(Mandatory=$true)]
  [string]$DockerHubUser,

  [string]$Version,
  [string]$DeploymentFile = (Join-Path $PSScriptRoot "truenas-deployment.json"),
  [switch]$AlsoLatest
)

$ErrorActionPreference = "Stop"

if (-not $Version) {
  $versionFile = Join-Path $PSScriptRoot "VERSION"
  if (Test-Path -LiteralPath $versionFile) {
    $Version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
  }
}

if (-not $Version) {
  if (Test-Path -LiteralPath $DeploymentFile) {
    $deployment = Get-Content -LiteralPath $DeploymentFile -Raw | ConvertFrom-Json
    $Version = [string]$deployment.version
  } else {
    $Version = "1.12.1"
  }
}

$image = "$DockerHubUser/message-hub:$Version"

Write-Host "Building $image"
docker build -t $image .

Write-Host "Pushing $image"
docker push $image

if ($AlsoLatest) {
  $latest = "$DockerHubUser/message-hub:latest"
  Write-Host "Tagging $latest"
  docker tag $image $latest
  Write-Host "Pushing $latest"
  docker push $latest
}

Write-Host ""
Write-Host "Done. Use this image in TrueNAS:"
Write-Host "  Repository: $DockerHubUser/message-hub"
Write-Host "  Tag:        $Version"
