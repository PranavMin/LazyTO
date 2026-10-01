<#
sync-card.ps1 -- make one Wii SD card ready for the kiosk, in one command.

  powershell -ExecutionPolicy Bypass -File deploy/sync-card.ps1 -Station 1 -Stream 1
  powershell -ExecutionPolicy Bypass -File deploy/sync-card.ps1 -RelayConfig <dev relay config.json>

What it does (docs/wii-setup.md section 1):
  1. finds the card: the one removable FAT32 drive with a drive letter (or -Drive)
  2. loader: the newest successful GitHub build of the Nintendont fork's
     vanilla-module branch ("CI Slippi Nintendont Builds"), downloaded once into
     deploy/.cache, copied to apps/Kegstand Tournament Mod. Never a locally built
     loader: those fail on hardware (Nintendont docs/build-windows.md).
  3. module: melee build/GALE01/tournament.bin, refused if the melee sources have a
     dev switch on (TM_DEMO_AUTOSTART, LB_TOURNEY_DEMO_CLAIM, LB_TOURNEY_TRIGGER_READOUT)
  4. tournament.cfg: station / stream / secret. Station and stream default to what
     the card already has. The secret comes from -RelayConfig (a relay config.json,
     e.g. a dev relay) or else .env RELAY_SECRET (the venue relay); it is never printed.
  5. loader config (slippi_nincfg.bin, written by the loader's own settings menu):
     turns on Network (the relay needs it) and Auto Boot (straight into Melee; hold B
     at the loader to get its menu), and Log unless -NoLog. Nothing else in it changes.
  6. checks every copied file by hash, then ejects the card (-NoEject to keep it).

Needs: gh (logged in), and for a fresh card a Melee 1.02 image at
games/GALE01/game.iso or games/<name> GALE01/game.iso (not copied by this script).
#>
param(
    [int]$Station = -1,
    [ValidateSet(-1, 0, 1)][int]$Stream = -1,
    [string]$Drive = "",
    [string]$RelayConfig = "",
    [string]$Module = (Join-Path $PSScriptRoot "..\..\melee\build\GALE01\tournament.bin"),
    [string]$MeleeSrc = (Join-Path $PSScriptRoot "..\..\melee\src\melee"),
    [string]$Repo = "PranavMin/Nintendont",
    [string]$Branch = "vanilla-module",
    [switch]$NoEject,
    [switch]$NoLog
)
$ErrorActionPreference = "Stop"
$AppName = "Kegstand Tournament Mod"
function Fail($msg) { Write-Host "sync-card: $msg" -ForegroundColor Red; exit 1 }
function Md5($p) { (Get-FileHash $p -Algorithm MD5).Hash }

# ---- 1. the card
if ($Drive) {
    $letter = $Drive.TrimEnd(':', '\')
} else {
    $vols = @(Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.FileSystem -eq 'FAT32' -and $_.DriveLetter })
    if ($vols.Count -eq 0) { Fail "no removable FAT32 card found. Is the card in the reader (and the reader plugged in)?" }
    if ($vols.Count -gt 1) { Fail ("more than one removable FAT32 drive ({0}); pass -Drive X" -f (($vols | ForEach-Object { "$($_.DriveLetter):" }) -join ', ')) }
    $letter = [string]$vols[0].DriveLetter
}
$card = "${letter}:\"
if (-not (Test-Path $card)) { Fail "drive $letter`: is not ready" }
$melee = @(Get-ChildItem (Join-Path $card "games") -Recurse -Filter game.iso -ErrorAction SilentlyContinue | Where-Object { $_.DirectoryName -match 'GALE01' })
Write-Host "card: $card$(if ($melee) { "  (Melee image: $($melee[0].FullName.Substring(3)))" } else { "  (WARNING: no games\...GALE01\game.iso on this card)" })"

# ---- 2. the loader: newest successful CI build
$runJson = gh run list -R $Repo --workflow build.yml --branch $Branch --status success -L 1 --json databaseId,headSha,createdAt 2>&1
if ($LASTEXITCODE -ne 0) { Fail "gh run list failed: $runJson" }
$run = ($runJson | ConvertFrom-Json) | Select-Object -First 1
if (-not $run) { Fail "no successful CI build of $Repo $Branch yet" }
$sha = $run.headSha.Substring(0, 7)
$cache = Join-Path $PSScriptRoot ".cache\loader-$sha"
if (-not (Test-Path (Join-Path $cache "done"))) {
    if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
    New-Item -ItemType Directory -Force $cache | Out-Null
    gh run download $run.databaseId -R $Repo -D $cache -p "release-*" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "gh run download $($run.databaseId) failed" }
    Set-Content (Join-Path $cache "done") $run.databaseId
}
$srcApp = Get-ChildItem $cache -Directory -Recurse | Where-Object { $_.Name -eq $AppName } | Select-Object -First 1
if (-not $srcApp) { Fail "the CI artifact has no apps\$AppName folder (built before the rename?)" }
$dstApp = Join-Path $card "apps\$AppName"
New-Item -ItemType Directory -Force $dstApp | Out-Null
foreach ($f in Get-ChildItem $srcApp.FullName -File) { Copy-Item $f.FullName (Join-Path $dstApp $f.Name) -Force }

# ---- 3. the module, refused if a dev switch is on
if (-not (Test-Path $Module)) { Fail "module not found: $Module (build it: python tools/build_module.py in the melee repo)" }
$hdr = [IO.File]::ReadAllBytes($Module)[0..3]
if ([Text.Encoding]::ASCII.GetString($hdr) -ne "TMOD") { Fail "$Module is not a TMOD module" }
$switches = @(
    @{ File = "mn\mntourney.c"; Name = "TM_DEMO_AUTOSTART" },
    @{ File = "lb\lbtourney.c"; Name = "LB_TOURNEY_DEMO_CLAIM" },
    @{ File = "lb\lbtourney.c"; Name = "LB_TOURNEY_TRIGGER_READOUT" }
)
foreach ($sw in $switches) {
    $m = Select-String -Path (Join-Path $MeleeSrc $sw.File) -Pattern ("^#define {0} (\d+)" -f $sw.Name) | Select-Object -First 1
    if (-not $m) { Fail "could not find #define $($sw.Name) in $($sw.File)" }
    if ($m.Matches[0].Groups[1].Value -ne "0") { Fail "$($sw.Name) is $($m.Matches[0].Groups[1].Value) in $($sw.File): set it to 0 and rebuild the module before shipping a card" }
}
$srcMod = (Resolve-Path $Module).Path
$moduleNewer = (Get-ChildItem (Join-Path $MeleeSrc "lb\*.c"), (Join-Path $MeleeSrc "mn\mntourney.c") | Where-Object { $_.LastWriteTime -gt (Get-Item $srcMod).LastWriteTime })
if ($moduleNewer) { Write-Host ("WARNING: module source is newer than tournament.bin ({0}); rebuild if that edit should ship" -f (($moduleNewer | ForEach-Object Name) -join ', ')) -ForegroundColor Yellow }
Copy-Item $srcMod (Join-Path $card "tournament.bin") -Force

# ---- 4. tournament.cfg
$cfgPath = Join-Path $card "tournament.cfg"
$old = @{}
if (Test-Path $cfgPath) {
    foreach ($line in Get-Content $cfgPath) { if ($line -match '^\s*(\w+)=(.*)$') { $old[$Matches[1]] = $Matches[2].Trim() } }
}
if ($Station -lt 0) { if ($old.ContainsKey('station')) { $Station = [int]$old['station'] } else { Fail "this card has no tournament.cfg yet: pass -Station N (and -Stream 1 for the stream setup)" } }
if ($Stream -lt 0) { $Stream = if ($old.ContainsKey('stream')) { [int]$old['stream'] } else { 0 } }
if ($RelayConfig) {
    $secret = (Get-Content $RelayConfig -Raw | ConvertFrom-Json).secret
    $secretFrom = "relay config $(Split-Path $RelayConfig -Leaf)"
} else {
    $envFile = Join-Path $PSScriptRoot "..\.env"
    $line = Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^RELAY_SECRET=' } | Select-Object -First 1
    $secret = if ($line) { $line.Substring('RELAY_SECRET='.Length).Trim().Trim('"') } else { $null }
    $secretFrom = ".env RELAY_SECRET (venue relay)"
}
if ($secret -notmatch '^[A-Za-z0-9_-]{8,16}$') { Fail "no valid secret from $secretFrom (8-16 of A-Z a-z 0-9 - _)" }
[IO.File]::WriteAllText($cfgPath, "station=$Station`nstream=$Stream`nsecret=$secret`n", [Text.Encoding]::ASCII)

# ---- 5. loader config bits: Network, Auto Boot, Log (NIN_CFG.Config, big-endian u32 at offset 8;
#         bits from Nintendont common/include/CommonConfig.h)
$ninCfg = Join-Path $card "slippi_nincfg.bin"
$cfgNote = "no slippi_nincfg.bin yet (the loader writes it on first save; set Network and Auto Boot in its settings)"
if (Test-Path $ninCfg) {
    $b = [IO.File]::ReadAllBytes($ninCfg)
    $magic = ([uint32]$b[0] -shl 24) -bor ([uint32]$b[1] -shl 16) -bor ([uint32]$b[2] -shl 8) -bor [uint32]$b[3]
    if ($b.Length -ge 12 -and $magic -eq 0x01070CF6) {
        $want = (1 -shl 13) -bor (1 -shl 10)            # NIN_CFG_NETWORK, NIN_CFG_AUTO_BOOT
        if (-not $NoLog) { $want = $want -bor (1 -shl 8) }  # NIN_CFG_LOG
        $cfgWord = ([uint32]$b[8] -shl 24) -bor ([uint32]$b[9] -shl 16) -bor ([uint32]$b[10] -shl 8) -bor [uint32]$b[11]
        $newWord = $cfgWord -bor $want
        if ($newWord -ne $cfgWord) {
            $b[8] = [byte](($newWord -shr 24) -band 0xFF); $b[9] = [byte](($newWord -shr 16) -band 0xFF)
            $b[10] = [byte](($newWord -shr 8) -band 0xFF); $b[11] = [byte]($newWord -band 0xFF)
            [IO.File]::WriteAllBytes($ninCfg, $b)
        }
        $cfgNote = ("loader config {0:X8} -> {1:X8}: network on, auto boot on, log {2}" -f $cfgWord, $newWord, $(if ($NoLog) { "left as is" } else { "on" }))
    } else { $cfgNote = "slippi_nincfg.bin not recognised (magic {0:X8}); left alone" -f $magic }
}

# ---- 6. verify, report, eject
$checks = @()
foreach ($f in Get-ChildItem $srcApp.FullName -File) { $checks += [pscustomobject]@{ File = "apps\$AppName\$($f.Name)"; Ok = (Md5 $f.FullName) -eq (Md5 (Join-Path $dstApp $f.Name)) } }
$checks += [pscustomobject]@{ File = "tournament.bin"; Ok = (Md5 $srcMod) -eq (Md5 (Join-Path $card "tournament.bin")) }
$cfgBack = Get-Content $cfgPath -Raw
$checks += [pscustomobject]@{ File = "tournament.cfg"; Ok = ($cfgBack -match "(?m)^station=$Station$") -and ($cfgBack -match "(?m)^stream=$Stream$") -and $cfgBack.Contains("secret=$secret") }
$checks | Format-Table -AutoSize | Out-String | Write-Host
if ($checks | Where-Object { -not $_.Ok }) { Fail "a file on the card does not match its source; nothing ejected" }
Write-Host ("loader : CI build {0} (commit {1}, {2})" -f $run.databaseId, $sha, $run.createdAt)
Write-Host ("module : {0} bytes, md5 {1}" -f (Get-Item $srcMod).Length, (Md5 $srcMod))
Write-Host ("config : station={0} stream={1} secret from {2}" -f $Station, $Stream, $secretFrom)
Write-Host ("loader : {0}" -f $cfgNote)

if (-not $NoEject) {
    $shell = New-Object -ComObject Shell.Application
    $item = $shell.Namespace(17).ParseName("${letter}:")
    if ($item) { $item.InvokeVerb("Eject"); Start-Sleep -Seconds 2 }
    if (Test-Path $card) { Write-Host "card is still mounted; eject it from Windows before pulling it" -ForegroundColor Yellow }
    else { Write-Host "ejected: the card is safe to remove" -ForegroundColor Green }
}
