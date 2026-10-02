// Shared bits for the operator scripts (sync-card, push, wiiload): coloured
// one-line failures and a child-process runner. Plain Node, no
// dependencies, so they run wherever the relay's own toolchain does
// (Windows, macOS, Linux). The PowerShell files in deploy/ are shims onto these.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

const tty = process.stdout.isTTY === true;
export const red = (s: string): string => (tty ? `\x1b[31m${s}\x1b[0m` : s);
export const yellow = (s: string): string => (tty ? `\x1b[33m${s}\x1b[0m` : s);
export const green = (s: string): string => (tty ? `\x1b[32m${s}\x1b[0m` : s);

/** Thrown for every operator-facing failure; the script prints it as "<tool>: <message>" and exits 1. */
export class ToolError extends Error {}

export function fail(msg: string): never {
  throw new ToolError(msg);
}

/** Run a script's main, turning a ToolError into one red line and exit code 1. */
export async function runMain(tool: string, main: () => Promise<void> | void): Promise<void> {
  try {
    await main();
  } catch (e) {
    if (e instanceof ToolError) {
      console.error(red(`${tool}: ${e.message}`));
      process.exit(1);
    }
    throw e;
  }
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** A command runner: scripts take one so tests can fake gh, ssh, scp, tar. */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; inherit?: boolean; env?: NodeJS.ProcessEnv },
) => RunResult;

export const runCommand: Runner = (cmd, args, opts = {}) => {
  const so: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  };
  // npm/npx are .cmd shims on Windows, which Node will only start through a
  // shell; one command string keeps the shell from re-splitting arguments.
  // Everything else (gh, tar, ssh, scp, powershell, diskutil, lsblk) is an
  // executable and runs directly, so arguments pass through untouched.
  const viaShell = process.platform === 'win32' && /^(npm|npx)$/.test(cmd);
  const r = viaShell
    ? spawnSync([cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), {
        ...so,
        shell: true,
      })
    : spawnSync(cmd, args, so);
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    fail(code === 'ENOENT' ? `${cmd} not found on PATH` : `${cmd}: ${r.error.message}`);
  }
  return { status: r.status ?? -1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};
