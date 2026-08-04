# Runs the edge worker natively on Windows instead of in Docker.
#
# Why this exists: Docker Desktop's WSL2 NAT is *symmetric* — the same local
# UDP port maps to a different external port per destination, which STUN-based
# ICE cannot traverse at all. Windows itself has a cone NAT, so running here
# gets further, but still cannot connect on STUN alone: aioice reuses the same
# local socket for its "host" and STUN-derived candidates, so the host
# candidate (a private, unroutable address) is always tried and always fails,
# and the srflx candidate never gets an independent connectivity check. Either
# way, direct connection cannot work on this network — set CF_TURN_KEY_ID /
# CF_TURN_KEY_TOKEN in .env (see there for what that is) so the worker relays
# through Cloudflare's TURN server instead.
#
#   docker compose stop edge-worker
#   .\services\edge\run-native.ps1
#
# Everything else (nextjs, auth-postgres) stays in Docker.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $PSScriptRoot

$envFile = Join-Path $repoRoot '.env'
if (-not (Test-Path $envFile)) { throw "Cannot find $envFile" }

$cfg = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $cfg[$matches[1]] = $matches[2].Trim() }
}

foreach ($key in @('CF_APP_ID', 'CF_APP_SECRET', 'INFERENCE_API_KEY')) {
    if (-not $cfg[$key]) { throw "$key is not set in $envFile" }
}

# Set as process environment. config.py calls load_dotenv(), which does NOT
# override variables already present, so these win over services/edge/.env.
$env:CF_APP_ID         = $cfg['CF_APP_ID']
$env:CF_APP_SECRET     = $cfg['CF_APP_SECRET']
$env:INFERENCE_API_KEY = $cfg['INFERENCE_API_KEY']
# Optional — empty means STUN-only, which cannot connect on this network (see
# header comment above). Set these in .env once a TURN key exists.
$env:CF_TURN_KEY_ID    = $cfg['CF_TURN_KEY_ID']
$env:CF_TURN_KEY_TOKEN = $cfg['CF_TURN_KEY_TOKEN']

# Next.js is published to the host by Docker, so localhost reaches it.
$env:NEXTJS_INTERNAL_URL = if ($cfg['NEXTJS_NATIVE_URL']) { $cfg['NEXTJS_NATIVE_URL'] } else { 'http://localhost:3000' }
$env:CF_TRACK_NAMES      = '{"CAM-01":"cam-01","CAM-02":"cam-02"}'
$env:TARGET_FPS          = if ($cfg['TARGET_FPS']) { $cfg['TARGET_FPS'] } else { '15' }
$env:HTTP_PORT           = if ($cfg['HTTP_PORT']) { $cfg['HTTP_PORT'] } else { '8081' }

# Host paths, not the container's /app/video mount.
$videoDir = (Join-Path $repoRoot 'app\video') -replace '\\', '/'
$cam1 = if ($cfg['CAM_01_NATIVE_SOURCE']) { $cfg['CAM_01_NATIVE_SOURCE'] } else { "$videoDir/pov1.mp4" }
$cam2 = if ($cfg['CAM_02_NATIVE_SOURCE']) { $cfg['CAM_02_NATIVE_SOURCE'] } else { "$videoDir/pov2.mov" }
$env:CAMERA_SOURCES = "{`"CAM-01`":`"$cam1`",`"CAM-02`":`"$cam2`"}"

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    throw "Virtualenv missing. Create it first:`n" +
          "  python -m venv services\edge\.venv`n" +
          "  services\edge\.venv\Scripts\python.exe -m pip install -r services\edge\requirements.txt"
}

Write-Host "Edge worker (native)"
Write-Host "  cameras : $env:CAMERA_SOURCES"
Write-Host "  next.js : $env:NEXTJS_INTERNAL_URL"
Write-Host "  ICE     : $(if ($env:CF_TURN_KEY_ID) { 'TURN configured' } else { 'STUN only (will not connect on this network)' })"
Write-Host ""

& $python main.py
