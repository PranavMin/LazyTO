// A set archive that only records which hooks the TCP server called, for
// tests that are not about the archive (archive.test.ts tests the real one).

import type { ArchiveHooks } from '../src/tcp.js';

export class RecordingArchive implements ArchiveHooks {
  readonly calls: { hook: string; args: unknown[] }[] = [];
  setStarted(...args: unknown[]): void {
    this.calls.push({ hook: 'setStarted', args });
  }
  scored(...args: unknown[]): void {
    this.calls.push({ hook: 'scored', args });
  }
  setEnded(...args: unknown[]): void {
    this.calls.push({ hook: 'setEnded', args });
  }
  setAbandoned(...args: unknown[]): void {
    this.calls.push({ hook: 'setAbandoned', args });
  }
}
