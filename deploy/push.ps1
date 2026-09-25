<#
push.ps1 -- build the relay on this Windows machine and install it on the Pi.

  .\deploy\push.ps1                               # bench: event/stream ids from .env
  .\deploy\push.ps1 -EventId 1234 -StreamId 5678  # a real tournament
  .\deploy\push.ps1 -DryRun                       # build the bundle, install nothing

Steps: npm run build -> write config.json from .env (+ overrides; startggEndpoint
is always the production URL) -> tar the bundle (dist/, deploy/, package.json,
README.md, config.json) -> scp to the Pi -> run deploy/install.sh
there over ssh. Needs Windows' built-in ssh/scp/tar and an ssh key the Pi
trusts (docs/pi-setup.md). The token is read from .env and never leaves this
machine except over ssh to the Pi.
#>
[CmdletBinding()]
param(
  [string]$PiHost = 'relay.local',
  [string]$User = 'pi',
  [int]$EventId = 0,
  [int]$StreamId = 0,
  [int]$StreamStation = 1,
  [int]$TcpPort = 7777,
  [int]$HttpPort = 8080,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# --- .env ---
$envPath = Join-Path $repo '.env'
if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }
$dotenv = @{}
foreach ($line in Get-Content $envPath) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$') { $dotenv[$Matches[1]] = $Matches[2].Trim() }
}
if (-not $dotenv['STARTGG_TOKEN']) { throw 'STARTGG_TOKEN missing from .env' }
if ($EventId -eq 0) { $EventId = [int]$dotenv['EVENT_ID'] }
if ($StreamId -eq 0) { $StreamId = [int]$dotenv['STREAM_ID'] }
if ($EventId -le 0 -or $StreamId -le 0) {
  throw 'EventId and StreamId must be positive (pass -EventId/-StreamId or set EVENT_ID/STREAM_ID in .env)'
}

# --- build ---
Push-Location $repo
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $repo 'dist\main.js'))) { throw 'build produced no dist/main.js' }

# --- bundle ---
$stage = Join-Path ([System.IO.Path]::GetTempPath()) 'tournament-reporter-bundle'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Recurse (Join-Path $repo 'dist') (Join-Path $stage 'dist')
Copy-Item -Recurse (Join-Path $repo 'deploy') (Join-Path $stage 'deploy')
Copy-Item (Join-Path $repo 'package.json') $stage   # "type": "module", needed beside dist/
Copy-Item (Join-Path $repo 'README.md') $stage      # night-of table, referenced by the unit
$config = [ordered]@{
  startggEndpoint = 'https://api.start.gg/gql/alpha'
  token         = $dotenv['STARTGG_TOKEN']
  eventId       = $EventId
  streamId      = $StreamId
  streamStation = $StreamStation
  tcpPort       = $TcpPort
  httpPort      = $HttpPort
  auditDir      = '/var/lib/tournament-reporter'
}
$json = (($config | ConvertTo-Json) -replace "`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'config.json'), $json, (New-Object System.Text.UTF8Encoding $false))
$tgz = Join-Path ([System.IO.Path]::GetTempPath()) 'tournament-reporter.tgz'
if (Test-Path $tgz) { Remove-Item -Force $tgz }
& tar -czf $tgz -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

Write-Host "bundle: $tgz"
Write-Host ("config: event {0}, stream {1}, stream station {2}, tcp {3}, http {4}, token {5}..." -f `
  $EventId, $StreamId, $StreamStation, $TcpPort, $HttpPort, $dotenv['STARTGG_TOKEN'].Substring(0, 4))
if ($DryRun) { Write-Host 'dry run: not pushing'; exit 0 }

# --- push and install ---
$target = "$User@$PiHost"
Write-Host "copying to $target ..."
& scp -q $tgz "${target}:/tmp/tournament-reporter.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp to $target failed" }
Write-Host 'installing (sudo on the Pi) ...'
$remote = 'rm -rf /tmp/tr && mkdir -p /tmp/tr && tar -xzf /tmp/tournament-reporter.tgz -C /tmp/tr ' +
  '&& sudo bash /tmp/tr/deploy/install.sh /tmp/tr && rm -rf /tmp/tr /tmp/tournament-reporter.tgz'
& ssh $target $remote
if ($LASTEXITCODE -ne 0) { throw 'install on the Pi failed (see output above)' }
# The bundle carries the token; don't leave it lying in %TEMP%.
Remove-Item -Recurse -Force $stage
Remove-Item -Force $tgz
Write-Host "done. status page: http://${PiHost}:$HttpPort   smoke test: npx tsx scripts/smoke.ts $PiHost"
