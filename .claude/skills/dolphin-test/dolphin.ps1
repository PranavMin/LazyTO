# Drives a development Slippi Dolphin (PranavMin/Ishiiruka, branch LazyTO) without taking
# the user's focus. Paths come from .env: DOLPHIN_DIR (folder holding "Slippi Dolphin.exe")
# and MELEE_ISO (a stock Melee 1.02 image). Only touches Dolphin processes started from
# DOLPHIN_DIR, never another install the user runs.
#
#   dolphin.ps1 start [-Wait 30]   boot the ISO, optionally wait for the set list
#   dolphin.ps1 shot               take a screenshot, print its path
#   dolphin.ps1 stop               stop emulation and close Dolphin gracefully
#   dolphin.ps1 status             running or not, and the kiosk-related ini settings
param(
    [Parameter(Mandatory = $true)][ValidateSet('start', 'shot', 'stop', 'status')][string]$Action,
    [int]$Wait = 0
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$vars = @{}
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $vars[$matches[1]] = $matches[2].Trim().Trim('"') }
    }
}
$dir = $vars['DOLPHIN_DIR']
if (-not $dir -or -not (Test-Path (Join-Path $dir 'Slippi Dolphin.exe'))) {
    throw "DOLPHIN_DIR in .env must name the folder holding 'Slippi Dolphin.exe'"
}
$exe = Join-Path $dir 'Slippi Dolphin.exe'
$ini = Join-Path $dir 'User\Config\Dolphin.ini'
$shots = Join-Path $dir 'User\ScreenShots\GALE01'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LazyToWin {
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static List<IntPtr> Windows(uint pid) {
        var r = new List<IntPtr>();
        EnumWindows((h, p) => { uint q; GetWindowThreadProcessId(h, out q); if (q == pid) r.Add(h); return true; }, IntPtr.Zero);
        return r;
    }
}
'@

$WM_COMMAND = 0x111
$IDM_STOP = 251
$IDM_SCREENSHOT = 265
$IDYES = 6

function Get-OurDolphin {
    Get-Process -Name 'Slippi Dolphin' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -ieq $exe) } | Select-Object -First 1
}

# The wx main frame: class wxWindowNR, title without the render window's FPS suffix.
function Get-Frame($proc) {
    foreach ($h in [LazyToWin]::Windows([uint32]$proc.Id)) {
        if ([LazyToWin]::ClassOf($h) -eq 'wxWindowNR' -and [LazyToWin]::TitleOf($h) -notmatch 'FPS') { return $h }
    }
    throw 'Dolphin main frame not found'
}

function Send-Command($proc, $id) {
    [void][LazyToWin]::PostMessage((Get-Frame $proc), $WM_COMMAND, [IntPtr]$id, [IntPtr]::Zero)
}

switch ($Action) {
    'start' {
        if (Get-OurDolphin) { throw 'Dolphin from DOLPHIN_DIR is already running; stop it first' }
        $iso = $vars['MELEE_ISO']
        if (-not $iso -or -not (Test-Path $iso)) { throw 'MELEE_ISO in .env must name a stock Melee 1.02 image' }
        $p = Start-Process -FilePath $exe -ArgumentList @('-b', '-e', "`"$iso`"") -WorkingDirectory $dir -PassThru
        Write-Output "started pid $($p.Id)"
        if ($Wait -gt 0) { Start-Sleep -Seconds $Wait; Write-Output "waited $Wait s" }
    }
    'shot' {
        $p = Get-OurDolphin
        if (-not $p) { throw 'Dolphin is not running' }
        $before = @(Get-ChildItem $shots -Filter *.png -ErrorAction SilentlyContinue | ForEach-Object FullName)
        Send-Command $p $IDM_SCREENSHOT
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 250
            $new = Get-ChildItem $shots -Filter *.png -ErrorAction SilentlyContinue |
                Where-Object { $before -notcontains $_.FullName } | Sort-Object LastWriteTime | Select-Object -Last 1
            if ($new) { Write-Output $new.FullName; return }
        }
        throw 'no screenshot appeared within 10 s'
    }
    'stop' {
        $p = Get-OurDolphin
        if (-not $p) { Write-Output 'not running'; return }
        Send-Command $p $IDM_STOP
        Start-Sleep -Milliseconds 800
        # Answer a stop confirmation if ConfirmStop is still on.
        foreach ($h in [LazyToWin]::Windows([uint32]$p.Id)) {
            if ([LazyToWin]::ClassOf($h) -eq '#32770') { [void][LazyToWin]::PostMessage($h, $WM_COMMAND, [IntPtr]$IDYES, [IntPtr]::Zero) }
        }
        Start-Sleep -Milliseconds 800
        [void]$p.CloseMainWindow()
        if ($p.WaitForExit(15000)) { Write-Output 'stopped' } else { throw 'Dolphin did not exit within 15 s; ask the user to close it' }
    }
    'status' {
        $p = Get-OurDolphin
        if ($p) { Write-Output "running pid $($p.Id)" } else { Write-Output 'not running' }
        if (Test-Path $ini) {
            foreach ($line in Get-Content $ini) {
                if ($line -match '^\s*(SlippiTournamentModule|EnableCheats|HLE_BS2|ConfirmStop)\s*=') { Write-Output $line.Trim() }
                if ($line -match '^\s*SlippiRelaySecret\s*=\s*(.*)$') {
                    if ($matches[1].Trim()) { Write-Output 'SlippiRelaySecret = (set)' } else { Write-Output 'SlippiRelaySecret = (empty)' }
                }
            }
        }
    }
}
