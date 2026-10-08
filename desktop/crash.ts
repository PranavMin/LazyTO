// crash.ts -- how long the desktop app waits before it starts again after a
// crash (desktop/main.ts relaunches itself). The same backoff the Pi's
// systemd unit had (deploy/lazyto-relay.service: RestartSec=10,
// RestartSteps=5, RestartMaxDelaySec=120): 10 s, stretching geometrically
// to 2 min over 5 crashes. The count lives in a file in userData, because
// the process that counts is the one that crashed. A crash more than
// CRASH_RESET_MS after the last one starts again at 10 s.

export const FIRST_DELAY_MS = 10_000;
export const MAX_DELAY_MS = 120_000;
export const STEPS = 5;
export const CRASH_RESET_MS = 10 * 60_000;

export interface CrashRecord {
  /** Crashes in a row, this one included. */
  count: number;
  at: number;
}

/** systemd's interpolation: FIRST_DELAY_MS * (MAX/FIRST)^(step/STEPS), capped at MAX_DELAY_MS. */
export function restartDelayMs(step: number): number {
  const s = Math.min(Math.max(step, 0), STEPS);
  return Math.round(FIRST_DELAY_MS * (MAX_DELAY_MS / FIRST_DELAY_MS) ** (s / STEPS));
}

/** The record to save for a crash now, after `prev` (null: none saved or unreadable), and the wait. */
export function nextRestart(
  prev: CrashRecord | null,
  now: number,
): { record: CrashRecord; delayMs: number } {
  const inRow = prev !== null && now - prev.at < CRASH_RESET_MS ? prev.count : 0;
  return { record: { count: inRow + 1, at: now }, delayMs: restartDelayMs(inRow) };
}

/** A saved record, or null for anything that isn't one. */
export function parseCrashRecord(text: string): CrashRecord | null {
  try {
    const j = JSON.parse(text) as Partial<CrashRecord>;
    return Number.isInteger(j.count) && typeof j.at === 'number'
      ? { count: j.count!, at: j.at }
      : null;
  } catch {
    return null;
  }
}
