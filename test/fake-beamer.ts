// A fake Slippi Beamer for tests and scripts/fake-beamer.ts: the HTTP side of
// the beamer API (GET /SLIPPI/ and GET /SLIPPI/<file>, schema 1) over an
// in-memory list of replays, plus the announce datagram a real beamer
// multicasts on every game start and finish (src/beamer.ts).

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export class FakeBeamer {
  private readonly server: Server;
  readonly files: { name: string; read: () => Buffer }[] = [];
  busy = false; // answer 503 + Retry-After: 1
  requests = 0;

  constructor() {
    this.server = createServer((req, res) => {
      this.requests++;
      if (this.busy) {
        res.writeHead(503, { 'Retry-After': '1' }).end();
        return;
      }
      const url = req.url ?? '/';
      if (url === '/SLIPPI/') {
        const body = {
          schema: 1,
          station_id: 'fake',
          served_replay_count: this.files.length,
          files: this.files.map((f) => ({ size: f.read().length, url: `/SLIPPI/${f.name}` })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        return;
      }
      const m = /^\/SLIPPI\/([^/]+)$/.exec(url);
      const f = m && this.files.find((x) => x.name === decodeURIComponent(m[1]!));
      if (!f) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(f.read());
    });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
  }

  port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  add(name: string, data: Buffer): void {
    this.files.push({ name, read: () => data });
  }
}

/** The announce JSON a beamer named "Station <station>" sends. */
export function announceDatagram(
  station: number,
  event: 'game_started' | 'game_finished',
  replay: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      event,
      station_id: `fake-${station}`,
      station_name: `Station ${station}`,
      seq: 0,
      replay: { name: replay, size: 0, url: `/SLIPPI/${replay}` },
      game: null,
    }),
  );
}
