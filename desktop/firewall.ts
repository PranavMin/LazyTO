// firewall.ts -- Windows Firewall and LazyTO (docs/laptop-setup.md, The
// firewall). The first time LazyTO listens, Windows asks; Allow with only
// Private ticked leaves the venue's router (a new network is Public) blocked,
// and Cancel makes Block rules that never ask again. Either way the beamers
// hear the beacon but can't connect, while the laptop itself looks fine.
//
// The probe reads, without admin rights, the networks the laptop is on, the
// firewall's profiles as in effect, and the inbound rules for LazyTO's exe.
// firewallNotes() turns that into the status page's notes. The fix is one
// elevated PowerShell (one UAC prompt): delete LazyTO's inbound rules, then
// allow TCP and UDP for the exe on every profile from the local subnet only.
// desktop/platform.ts runs both; this file holds the scripts and the verdict.

import type { PlatformNote } from '../src/platform.js';

/** One network the laptop is connected to (Get-NetConnectionProfile). */
export interface FwNetwork {
  Name: string;
  Category: string; // Public, Private, DomainAuthenticated
}

/** One firewall profile as in effect (Get-NetFirewallProfile -PolicyStore ActiveStore). */
export interface FwProfile {
  Name: string; // Domain, Private, Public
  Enabled: string; // True, False
  DefaultInboundAction: string; // Block, Allow, NotConfigured (= Block)
  AllowInboundRules: string; // True, False: False is "Block all incoming connections"
}

/** One rule for LazyTO's exe (Get-NetFirewallApplicationFilter | Get-NetFirewallRule). */
export interface FwRule {
  Enabled: string; // True, False
  Direction: string; // Inbound, Outbound
  Action: string; // Allow, Block
  Profile: string; // "Any", or e.g. "Private, Public"
}

export interface FirewallProbe {
  networks: FwNetwork[];
  profiles: FwProfile[];
  rules: FwRule[];
}

export const FIREWALL_ACTION = 'firewall';

/** PowerShell that prints a FirewallProbe as JSON for the exe in $env:LAZYTO_EXE. */
export const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$exe = $env:LAZYTO_EXE
$networks = @(Get-NetConnectionProfile | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; Category = [string]$_.NetworkCategory } })
$profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
  [pscustomobject]@{ Name = [string]$_.Name; Enabled = [string]$_.Enabled;
    DefaultInboundAction = [string]$_.DefaultInboundAction; AllowInboundRules = [string]$_.AllowInboundRules } })
$rules = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore | Where-Object { $_.Program -eq $exe } |
  Get-NetFirewallRule | ForEach-Object {
  [pscustomobject]@{ Enabled = [string]$_.Enabled; Direction = [string]$_.Direction;
    Action = [string]$_.Action; Profile = [string]$_.Profile } })
[pscustomobject]@{ networks = $networks; profiles = $profiles; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`;

/** A PowerShell single-quoted string literal. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The elevated fix: LazyTO's inbound rules replaced by TCP and UDP allows, any profile, local subnet. */
export function fixScript(exe: string): string {
  return `
$ErrorActionPreference = 'Stop'
$exe = ${psQuote(exe)}
Get-NetFirewallApplicationFilter -PolicyStore PersistentStore | Where-Object { $_.Program -eq $exe } |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule
foreach ($protocol in 'TCP', 'UDP') {
  New-NetFirewallRule -DisplayName 'LazyTO' -Description 'Lets the beamers reach LazyTO (added by LazyTO).' \`
    -Direction Inbound -Action Allow -Program $exe -Protocol $protocol -Profile Any -RemoteAddress LocalSubnet | Out-Null
}
`;
}

/**
 * The non-elevated PowerShell that asks for admin once and runs `script`
 * elevated. The script travels base64-encoded (-EncodedCommand), so no path
 * needs quoting through Start-Process; it exits non-zero when the TO says No.
 */
export function elevate(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return (
    `$p = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`
  );
}

const PROFILE_OF: Record<string, string> = {
  Public: 'Public',
  Private: 'Private',
  DomainAuthenticated: 'Domain',
};

/** Does a rule's Profile ("Any", "Private, Public") cover this profile? */
function covers(ruleProfile: string, profile: string): boolean {
  const names = ruleProfile.split(',').map((s) => s.trim());
  return names.includes('Any') || names.includes(profile);
}

/** The status page's notes for what the probe found; [] when every network lets the beamers in. */
export function firewallNotes(probe: FirewallProbe): PlatformNote[] {
  const blocked: string[] = [];
  const notes: PlatformNote[] = [];
  for (const net of probe.networks) {
    const profile = PROFILE_OF[net.Category] ?? net.Category;
    const p = probe.profiles.find((x) => x.Name === profile);
    if (!p || p.Enabled !== 'True') continue;
    const where = `"${net.Name}" (${profile})`;
    if (p.AllowInboundRules === 'False') {
      notes.push({
        text: `Windows Firewall blocks every incoming connection on ${where}, even for allowed apps. In Windows Security, Firewall & network protection, ${profile} network, turn off "Blocks all incoming connections".`,
      });
      continue;
    }
    const rules = probe.rules.filter(
      (r) => r.Enabled === 'True' && r.Direction === 'Inbound' && covers(r.Profile, profile),
    );
    const allowed = rules.some((r) => r.Action === 'Allow');
    const blocks = rules.some((r) => r.Action === 'Block');
    if (blocks || (!allowed && p.DefaultInboundAction !== 'Allow')) blocked.push(where);
  }
  if (blocked.length > 0) {
    notes.unshift({
      text: `Windows Firewall blocks LazyTO on ${blocked.join(' and ')}: the beamers can't reach this laptop.`,
      action: { name: FIREWALL_ACTION, label: 'Allow LazyTO through the firewall' },
    });
  }
  return notes;
}
