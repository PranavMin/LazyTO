<#
push.ps1 -- build the relay on this Windows machine and install it on the Pi.

  .\deploy\push.ps1                     # install or update; tournament per the default below
  .\deploy\push.ps1 -Tournament abbey   # production: the weekly short URL
  .\deploy\push.ps1 -DryRun             # build the bundle, install nothing

The relay finds tonight's event itself: it looks up the tournament by its
start.gg short URL (start.gg/<Tournament>) among your admin tournaments, or
fetches it directly when given a full slug (tournament/<slug>; needed for an
unpublished tournament, which no list returns), then the Melee singles event whose
name contains -EventName and the stream named -StreamName, once, at startup
(src/resolve.ts). A weekly series whose short URL moves to each new
tournament needs no push per week; power the Pi on (or restart the relay) on
the night. Push only to update the relay or change these names.

Steps: npm run build -> write config.json (token from .env, the rest from the
parameters; startggEndpoint is always the production URL) -> tar the bundle (dist/, deploy/, package.json,
README.md, config.json) -> scp to the Pi -> run deploy/install.sh
there over ssh. Needs Windows' built-in ssh/scp/tar and an ssh key the Pi
trusts (docs/pi-setup.md). The token is read from .env and never leaves this
machine except over ssh to the Pi.
#>
[CmdletBinding()]
param(
  [string]$PiHost = 'relay.local',
  [string]$User = 'pi',
  # Production: 'abbey'. Kept on the (unpublished) test tournament until go-live.
  [string]$Tournament = 'tournament/sf-melee-discord-test',
  [string]$EventName = 'Melee Singles',
  [string]$StreamName = 'SFMelee',
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
  tournament    = $Tournament
  eventName     = $EventName
  streamName    = $StreamName
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
Write-Host ("config: {0}, event ~ '{1}', stream '{2}', stream station {3}, tcp {4}, http {5}, token {6}..." -f `
  $Tournament, $EventName, $StreamName, $StreamStation, $TcpPort, $HttpPort, $dotenv['STARTGG_TOKEN'].Substring(0, 4))
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
