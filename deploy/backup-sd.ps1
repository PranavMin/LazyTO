<#
backup-sd.ps1 -- save a full image of a microSD card before it is reflashed.

  .\deploy\backup-sd.ps1 -List                 # show removable disks and their numbers
  .\deploy\backup-sd.ps1                       # back up the only removable disk
  .\deploy\backup-sd.ps1 -DiskNumber 2 -Out D:\pi-backups\old-pi.img.gz

Reads the whole card sector by sector (\\.\PhysicalDriveN, which needs an
Administrator PowerShell; the script relaunches itself elevated if needed)
and gzips it on the fly, so a mostly-empty 32 GB card becomes a few GB.
Nothing on the card is changed.

Restore later with Raspberry Pi Imager: Operating System -> Use custom ->
pick the .img.gz -> Storage -> the card (same size or larger) -> Write.
#>
[CmdletBinding()]
param(
  [int]$DiskNumber = -1,
  [string]$Out = '',
  [switch]$List
)
$ErrorActionPreference = 'Stop'

function Get-Removable {
  Get-Disk | Where-Object { $_.BusType -in 'USB', 'SD', 'MMC' } |
    Select-Object Number, FriendlyName, BusType, @{n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 1) } }, Size
}

$disks = @(Get-Removable)
if ($List) {
  if ($disks.Count -eq 0) { 'no removable disks found (is the card reader plugged in?)' }
  else { $disks | Format-Table Number, FriendlyName, BusType, SizeGB -AutoSize | Out-String }
  exit 0
}

if ($DiskNumber -lt 0) {
  if ($disks.Count -ne 1) {
    $disks | Format-Table Number, FriendlyName, BusType, SizeGB -AutoSize | Out-String | Write-Host
    throw "found $($disks.Count) removable disks; pass -DiskNumber N"
  }
  $DiskNumber = $disks[0].Number
}
$disk = Get-Disk -Number $DiskNumber
if ($disk.BusType -notin 'USB', 'SD', 'MMC') { throw "disk $DiskNumber ($($disk.FriendlyName)) is $($disk.BusType), not a removable card; refusing" }

if (-not $Out) {
  $Out = Join-Path 'P:\Projects\pi-backups' ("pi-sd-{0}.img.gz" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
}

# Raw disk reads need Administrator; relaunch elevated with the same arguments.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'raw disk access needs Administrator; relaunching elevated (approve the prompt)...'
  $args = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-DiskNumber', $DiskNumber, '-Out', $Out)
  Start-Process powershell -Verb RunAs -ArgumentList $args
  exit 0
}

$sizeGB = [math]::Round($disk.Size / 1GB, 1)
Write-Host ("source: disk {0}  {1}  {2}  {3} GB" -f $disk.Number, $disk.FriendlyName, $disk.BusType, $sizeGB)
Write-Host "target: $Out"
$answer = Read-Host 'Back up this card? (y/N)'
if ($answer -ne 'y') { Write-Host 'aborted'; exit 1 }

New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$in = New-Object System.IO.FileStream("\\.\PhysicalDrive$DiskNumber", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite, 4MB)
$outFile = New-Object System.IO.FileStream($Out, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 4MB)
$gz = New-Object System.IO.Compression.GZipStream($outFile, [IO.Compression.CompressionLevel]::Fastest)
$buf = New-Object byte[] 4MB
$total = [int64]$disk.Size
$done = [int64]0
$sw = [Diagnostics.Stopwatch]::StartNew()
$first = $null
try {
  while ($done -lt $total) {
    # Both operands int64, or PowerShell binds the Int32 overload and a >2 GB disk size fails to convert.
    $want = [int][math]::Min([int64]$buf.Length, [int64]($total - $done))
    $n = $in.Read($buf, 0, $want)
    if ($n -le 0) { break }
    if ($null -eq $first) { $first = $buf[510, 511] }
    $gz.Write($buf, 0, $n)
    $done += $n
    if (($done % 256MB) -eq 0 -or $done -eq $total) {
      $mbs = [math]::Round(($done / 1MB) / [math]::Max($sw.Elapsed.TotalSeconds, 0.001))
      Write-Progress -Activity "reading disk $DiskNumber" -Status ("{0:N0} / {1:N0} MB  ({2} MB/s)" -f ($done / 1MB), ($total / 1MB), $mbs) -PercentComplete ($done * 100 / $total)
    }
  }
} finally {
  $gz.Dispose(); $outFile.Dispose(); $in.Dispose()
}
Write-Progress -Activity "reading disk $DiskNumber" -Completed

if ($done -ne $total) { throw "short read: $done of $total bytes (card unplugged?); the image at $Out is incomplete" }
if ($first[0] -ne 0x55 -or $first[1] -ne 0xAA) { Write-Warning 'sector 0 has no MBR signature; the card may not be a bootable Pi image (backup still complete)' }
$outSize = (Get-Item $Out).Length
Write-Host ("done: {0:N0} MB read in {1:N0} s, {2:N0} MB compressed -> {3}" -f ($done / 1MB), $sw.Elapsed.TotalSeconds, ($outSize / 1MB), $Out)
Write-Host 'restore: Raspberry Pi Imager -> Use custom -> this file -> the card.'
