<#
  build-image.ps1 — one command builds everything the server needs.

  Every build gets a UNIQUE tag (dualsql:<version>-<yyyyMMdd-HHmm>), so
  `docker compose up -d` on the server ALWAYS recreates the container with the
  new code. No reused tags, no stale containers, no DUALSQL_VERSION juggling.

  Output: a self-contained  dist\dualsql-<tag>\  folder containing
    - dualsql-<tag>.tar        the image
    - docker-compose.yml       with the exact tag already baked in
    - DEPLOY.txt               the two commands to run on the server

  Usage (from anywhere, Docker Desktop running):
    powershell -ExecutionPolicy Bypass -File D:\KS\SQL\deploy\build-image.ps1
#>

[CmdletBinding()]
param(
    [switch]$NoCache    # force a fully fresh build if you suspect layer-cache issues
)

$ErrorActionPreference = "Stop"

# Run from the project root regardless of where the script is invoked.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$stamp   = Get-Date -Format 'yyyyMMdd-HHmm'
$tagVer  = "$version-$stamp"          # e.g. 1.0.0-20260702-1215
$tag     = "dualsql:$tagVer"

# Sanity check: make sure the UI being shipped is the file you just edited.
$indexAge = (Get-Date) - (Get-Item 'public\index.html').LastWriteTime
Write-Host ("Shipping public\index.html (last modified {0:N0} min ago)" -f $indexAge.TotalMinutes)

Write-Host "Building $tag ..."
$buildArgs = @('build', '-t', $tag, '--build-arg', "BUILD_STAMP=$tagVer")
if ($NoCache) { $buildArgs += '--no-cache' }
$buildArgs += '.'
docker @buildArgs
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

# Assemble the deploy bundle.
$dist = Join-Path $root "dist\dualsql-$tagVer"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$tarFile = Join-Path $dist "dualsql-$tagVer.tar"
Write-Host "Saving image to $tarFile ..."
docker save -o $tarFile $tag
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }

# Compose file with the exact tag baked in — nothing to set on the server.
$composeTemplate = Get-Content (Join-Path $PSScriptRoot 'docker-compose.image.yml') -Raw
$composeOut = $composeTemplate -replace 'image:\s*dualsql:\S+', "image: $tag"
Set-Content -Path (Join-Path $dist 'docker-compose.yml') -Value $composeOut -Encoding UTF8

Set-Content -Path (Join-Path $dist 'DEPLOY.txt') -Encoding UTF8 -Value @"
Deploy $tag  (built $stamp)

1. Copy this whole folder to the server (keep your existing .env in it, or add one).
2. In this folder on the server:

     docker load -i dualsql-$tagVer.tar
     docker compose up -d

3. Verify the new build is live:

     open http://<server>:3000/build.txt   ->  must say: $tagVer

If build.txt shows an older stamp, the container didn't recreate — run:
     docker compose down; docker compose up -d
"@

$size = "{0:N0} MB" -f ((Get-Item $tarFile).Length / 1MB)
Write-Host ""
Write-Host "Done. Bundle ready: $dist  (image $size)"
Write-Host "Copy the folder to the server, then run the two commands in DEPLOY.txt."
Write-Host "Verify with http://<server>:3000/build.txt -> $tagVer"
