<#
wiiload.ps1 -- boot a loader on the Wii over Wi-Fi, no SD card trip.

  powershell -ExecutionPolicy Bypass -File deploy/wiiload.ps1 -Wii 192.168.1.80
  powershell -ExecutionPolicy Bypass -File deploy/wiiload.ps1 -Wii 192.168.1.80 -File P:\...\boot.dol

The Wii must be sitting on the Homebrew Channel (it shows its IP bottom-left
when it is online). Sends the newest successful GitHub build of the fork's
vanilla-module loader (same cache as sync-card.ps1) unless -File is given.
The card still provides tournament.bin, tournament.cfg and the game; this only
replaces the "launch LazyTO" step. The Wii's IP can also come
from the environment: $env:WII_IP, or the devkitPro form $env:WIILOAD = "tcp:IP".

Needs wiiload.exe (devkitPro: pacman -S wiiload) and gh (logged in).
#>
param(
    [string]$Wii = "",
    [string]$File = "",
    [string]$Repo = "PranavMin/Nintendont",
    [string]$Branch = "vanilla-module"
)
$ErrorActionPreference = "Stop"
function Fail($msg) { Write-Host "wiiload: $msg" -ForegroundColor Red; exit 1 }

$tool = Get-Command wiiload.exe -ErrorAction SilentlyContinue
if (-not $tool) { foreach ($p in "C:\devkitPro\tools\bin\wiiload.exe", "$env:DEVKITPRO\tools\bin\wiiload.exe") { if ($p -and (Test-Path $p)) { $tool = Get-Item $p; break } } }
if (-not $tool) { Fail "wiiload.exe not found; in the devkitPro MSYS2 shell: pacman -S wiiload" }
$toolPath = if ($tool.Source) { $tool.Source } else { $tool.FullName }

if (-not $Wii) {
    if ($env:WII_IP) { $Wii = $env:WII_IP }
    elseif ($env:WIILOAD -match '^tcp:(.+)$') { $Wii = $Matches[1] }
    else { Fail "pass -Wii <ip> (the Homebrew Channel shows it bottom-left), or set WII_IP" }
}

if (-not $File) {
    $runJson = gh run list -R $Repo --workflow build.yml --branch $Branch --status success -L 1 --json databaseId,headSha,createdAt 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "gh run list failed: $runJson" }
    $run = ($runJson | ConvertFrom-Json) | Select-Object -First 1
    if (-not $run) { Fail "no successful CI build of $Repo $Branch" }
    $sha = $run.headSha.Substring(0, 7)
    $cache = Join-Path $PSScriptRoot ".cache\loader-$sha"
    if (-not (Test-Path (Join-Path $cache "done"))) {
        if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
        New-Item -ItemType Directory -Force $cache | Out-Null
        gh run download $run.databaseId -R $Repo -D $cache -p "release-*" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "gh run download $($run.databaseId) failed" }
        Set-Content (Join-Path $cache "done") $run.databaseId
    }
    $File = (Get-ChildItem $cache -Recurse -Filter boot.dol | Where-Object { $_.DirectoryName -match 'LazyTO' } | Select-Object -First 1).FullName
    if (-not $File) { Fail "no LazyTO boot.dol in the CI artifact" }
    Write-Host ("loader : CI build {0} (commit {1}, {2})" -f $run.databaseId, $sha, $run.createdAt)
}
if (-not (Test-Path $File)) { Fail "file not found: $File" }

$env:WIILOAD = "tcp:$Wii"
Write-Host ("sending {0} ({1:N0} bytes) to the Wii at {2} ..." -f (Split-Path $File -Leaf), (Get-Item $File).Length, $Wii)
& $toolPath $File
if ($LASTEXITCODE -ne 0) { Fail "wiiload exited $LASTEXITCODE. Is the Wii on the Homebrew Channel, on the same network, and is that its IP?" }
Write-Host "sent: the Wii is booting it now" -ForegroundColor Green
