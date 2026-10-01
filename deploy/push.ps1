<#
push.ps1 -- build the relay on this Windows machine and install it on the Pi.

  .\deploy\push.ps1                  # production: follows start.gg/abbey every week
  .\deploy\push.ps1 -Test            # testing: the unpublished SF Melee Discord Test
  .\deploy\push.ps1 -DryRun          # build the bundle, install nothing
  .\deploy\push.ps1 -PiHost <name> -User <user>   # another Pi, e.g. the matchcaller one

Two modes, one config field (tournament):
  production  "abbey". The relay finds the tournament the start.gg/abbey
              short URL is on, among your admin tournaments; if the TO has
              not moved it yet, the "Melee @ Abbey Tavern #N" nearest to now
              (src/resolve.ts). Nothing to push per week: power the Pi on (or
              restart the relay) on the night.
  -Test       "tournament/sf-melee-discord-test", fetched by its full slug
              (it is unpublished, so no list query returns it).
Either way the event is the Melee singles event whose name contains
-EventName and the stream is the one named -StreamName. Switching modes is a
push; the relay's first log line says which tournament it found and how.

Steps: npm run build -> write config.json (token from .env, the rest from the
parameters; startggEndpoint is always the production URL) -> tar the bundle (dist/, deploy/, package.json,
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
  [string]$EventName = 'Melee Singles',
  [string]$StreamName = 'SFMelee',
  [int]$StreamStation = 1,
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
# The relay's shared secret (design R16): the same value is secret= on every
# Wii's SD card and SlippiRelaySecret in Dolphin. 8-16 letters, digits, - or _.
if ($dotenv['RELAY_SECRET'] -notmatch '^[A-Za-z0-9_-]{8,16}$') {
  throw 'RELAY_SECRET in .env must be 8-16 letters, digits, - or _ (it goes on every SD card as secret=)'
}
$Tournament = if ($Test) { 'tournament/sf-melee-discord-test' } else { 'abbey' }

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
  secret        = $dotenv['RELAY_SECRET']
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
Write-Host ("config: {0} ({7}), event ~ '{1}', stream '{2}', stream station {3}, tcp {4}, http {5}, token {6}..." -f `
  $Tournament, $EventName, $StreamName, $StreamStation, $TcpPort, $HttpPort, $dotenv['STARTGG_TOKEN'].Substring(0, 4),
  $(if ($Test) { 'TEST' } else { 'production' }))
if ($DryRun) { Write-Host 'dry run: not pushing'; exit 0 }

# --- push and install ---
$target = "$User@$PiHost"
Write-Host "copying to $target ..."
& scp -q $tgz "${target}:/tmp/tournament-reporter.tgz"
if ($LASTEXITCODE -ne 0) { throw "scp to $target failed" }
Write-Host 'installing (sudo on the Pi) ...'
$remote = 'rm -rf /tmp/tr && mkdir -p /tmp/tr && tar -xzf /tmp/tournament-reporter.tgz -C /tmp/tr ' +
  '&& sudo bash /tmp/tr/deploy/install.sh /tmp/tr && rm -rf /tmp/tr /tmp/tournament-reporter.tgz'
& ssh -t $target $remote
if ($LASTEXITCODE -ne 0) { throw 'install on the Pi failed (see output above)' }
# The bundle carries the token; don't leave it lying in %TEMP%.
Remove-Item -Recurse -Force $stage
Remove-Item -Force $tgz
Write-Host "done. status page: http://${PiHost}:$HttpPort   smoke test: npx tsx scripts/smoke.ts $PiHost"
