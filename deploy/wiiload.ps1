<#
wiiload.ps1 -- shim. The script moved to Node so it runs on Windows, macOS and
Linux alike: scripts/wiiload.ts (npm run wiiload -- <flags>). This file turns
the old -Flag style into --flag and calls it; it will be removed in a later
release. Same flags as before, e.g. -Station 1 -Stream 1 -> --station 1 --stream 1.
#>
$ErrorActionPreference = 'Stop'
$converted = @()
foreach ($a in $args) {
  if ($a -is [string] -and $a -match '^-([A-Za-z][A-Za-z0-9]*)$') {
    $kebab = ($Matches[1] -creplace '(?<=[a-z0-9])([A-Z])', '-$1').ToLower()
    $converted += "--$kebab"
  } else { $converted += $a }
}
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repo
try {
  & npx tsx (Join-Path $repo 'scripts/wiiload.ts') @converted
  exit $LASTEXITCODE
} finally { Pop-Location }
