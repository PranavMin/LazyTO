<#
push.ps1 -- build the relay on this Windows machine and install it on the Pi.

  .\deploy\push.ps1                  # production: the tournament named by TOURNAMENT in .env
  .\deploy\push.ps1 -Test            # testing: TEST_TOURNAMENT in .env instead
  .\deploy\push.ps1 -DryRun          # build the bundle, install nothing
  .\deploy\push.ps1 -PiHost <name> -User <user>   # a Pi with another name or user

Everything about your event comes from .env (see .env.example):
  TOURNAMENT          your start.gg short URL (e.g. "mybar"). The relay finds
                      the tournament it is on among your admin tournaments, so
                      a weekly that moves its short URL needs no push per week.
  WEEKLY_NAME_PREFIX  optional. With e.g. "My Bar Weekly #", a short URL
                      not moved yet falls back to the tournament named that
                      prefix plus a number, nearest to now (src/resolve.ts).
  EVENT_NAME          picks the Melee singles event whose name contains it.
  STREAM_NAME         the stream, by its exact name in the stream settings.
  STREAM_STATION      optional, default 1: the station number of the stream Wii.
  TEST_TOURNAMENT     for -Test: a full slug, "tournament/<slug>" (an
                      unpublished tournament is never listed, so it needs one).
Switching modes is a push; the relay's first log line says which tournament it
found and how.

Steps: npm run build -> write config.json (all from .env; startggEndpoint is
always the production URL) -> tar the bundle (dist/, deploy/, package.json,
README.md, config.json) -> scp to the Pi -> run deploy/install.sh
there over ssh. Needs Windows' built-in ssh/scp/tar and an ssh key the Pi
trusts (docs/pi-setup.md). The token and RELAY_SECRET are read from .env and
never leave this machine except over ssh to the Pi.
#>
[CmdletBinding()]
param(
  [string]$PiHost = 'relay.local',
  [string]$User = 'pi',
  [switch]$Test,
  [int]$TcpPort = 29470,
  [int]$HttpPort = 29473,
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
# The relay's shared secret (decisions.md R16): the same value is secret= on every
# Wii's SD card and SlippiRelaySecret in Dolphin. 8-16 letters, digits, - or _.
if ($dotenv['RELAY_SECRET'] -notmatch '^[A-Za-z0-9_-]{8,16}$') {
  throw 'RELAY_SECRET in .env must be 8-16 letters, digits, - or _ (it goes on every SD card as secret=)'
}
function Need([string]$key) {
  if (-not $dotenv[$key]) { throw "$key missing from .env (see .env.example)" }
  $dotenv[$key]
}
$EventName = Need 'EVENT_NAME'
$StreamName = Need 'STREAM_NAME'
$StreamStation = if ($dotenv['STREAM_STATION']) { [int]$dotenv['STREAM_STATION'] } else { 1 }
if ($Test) {
  $Tournament = Need 'TEST_TOURNAMENT'
  if ($Tournament -notmatch '^tournament/') { throw 'TEST_TOURNAMENT must be a full slug, tournament/<slug>' }
  $WeeklyPrefix = ''
} else {
  $Tournament = Need 'TOURNAMENT'
  $WeeklyPrefix = if ($Tournament -match '^tournament/') { '' } else { [string]$dotenv['WEEKLY_NAME_PREFIX'] }
}

# --- build ---
Push-Location $repo
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $repo 'dist\main.js'))) { throw 'build produced no dist/main.js' }

# --- bundle ---
$stage = Join-Path ([System.IO.Path]::GetTempPath()) 'lazyto-bundle'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -Recurse (Join-Path $repo 'dist') (Join-Path $stage 'dist')
Copy-Item -Recurse (Join-Path $repo 'deploy') (Join-Path $stage 'deploy')
Copy-Item (Join-Path $repo 'package.json') $stage   # "type": "module", needed beside dist/
Copy-Item (Join-Path $repo 'README.md') $stage
$config = [ordered]@{
  startggEndpoint = 'https://api.start.gg/gql/alpha'
  token         = $dotenv['STARTGG_TOKEN']
  tournament    = $Tournament
  eventName     = $EventName
  streamName    = $StreamName
  weeklyNamePrefix = $WeeklyPrefix
  secret        = $dotenv['RELAY_SECRET']
  streamStation = $StreamStation
  tcpPort       = $TcpPort
  httpPort      = $HttpPort
  auditDir      = '/var/lib/lazyto'
}
$json = (($config | ConvertTo-Json) -replace "`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'config.json'), $json, (New-Object System.Text.UTF8Encoding $false))
$tgz = Join-Path ([System.IO.Path]::GetTempPath()) 'lazyto.tgz'
if (Test-Path $tgz) { Remove-Item -Force $tgz }
& tar -czf $tgz -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

Write-Host "bundle: $tgz"
Write-Host ("config: {0} ({7}), event ~ '{1}', stream '{2}', stream station {3}, tcp {4}, http {5}, token {6}..." -f `
  $Tournament, $EventName, $StreamName, $StreamStation, $TcpPort, $HttpPort, $dotenv['STARTGG_TOKEN'].Substring(0, 4),
  $(if ($Test) { 'TEST' } else { 'production' }))
if ($DryRun) { Write-Host 'dry run: not pushing'; exit 0 }

# --- push and install ---
$target = "$User@$PiHost"
Write-Host "copying to $target ..."
& scp -q $tgz "${target}:/tmp/lazyto.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp to $target failed" }
Write-Host 'installing (sudo on the Pi) ...'
$remote = 'rm -rf /tmp/tr && mkdir -p /tmp/tr && tar -xzf /tmp/lazyto.tgz -C /tmp/tr ' +
  '&& sudo bash /tmp/tr/deploy/install.sh /tmp/tr && rm -rf /tmp/tr /tmp/lazyto.tgz'
& ssh -t $target $remote
if ($LASTEXITCODE -ne 0) { throw 'install on the Pi failed (see output above)' }
# The bundle carries the token; don't leave it lying in %TEMP%.
Remove-Item -Recurse -Force $stage
Remove-Item -Force $tgz
Write-Host "done. status page: http://${PiHost}:$HttpPort   smoke test: npx tsx scripts/smoke.ts $PiHost"
