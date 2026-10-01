// The Homebrew Channel's wiiload protocol, natively, so no wiiload.exe /
// devkitPro install is needed: TCP 4299, "HAXX", version 0.5, u16 args
// length, u32 compressed and uncompressed sizes, the zlib-compressed file in
// 4 KB writes, then the argument block (file name, NUL-terminated).
import { createConnection } from 'node:net';
import { deflateSync } from 'node:zlib';

export const WIILOAD_PORT = 4299;
export const WIILOAD_VERSION: [number, number] = [0, 5];

/** The byte stream for one file, exactly as the Wii expects it (pure; the test decodes it). */
export function wiiloadFrame(fileName: string, data: Uint8Array): Uint8Array {
  const compressed = deflateSync(data, { level: 6 });
  const args = Buffer.from(`${fileName}\0`, 'latin1');
  const header = Buffer.alloc(4 + 2 + 2 + 4 + 4);
  header.write('HAXX', 0, 'latin1');
  header[4] = WIILOAD_VERSION[0];
  header[5] = WIILOAD_VERSION[1];
  header.writeUInt16BE(args.length, 6);
  header.writeUInt32BE(compressed.length, 8);
  header.writeUInt32BE(data.length, 12);
  return Buffer.concat([header, compressed, args]);
}

/** Decode a frame (for tests and diagnostics): throws on a bad magic/version. */
export function parseWiiloadFrame(frame: Uint8Array): {
  fileName: string;
  compressedLength: number;
  length: number;
  payload: Uint8Array;
} {
  const b = Buffer.from(frame);
  if (b.toString('latin1', 0, 4) !== 'HAXX') throw new Error('not a wiiload frame');
  if (b[4] !== WIILOAD_VERSION[0] || b[5] !== WIILOAD_VERSION[1])
    throw new Error(`wiiload version ${b[4]}.${b[5]}`);
  const argsLen = b.readUInt16BE(6);
  const compressedLength = b.readUInt32BE(8);
  const length = b.readUInt32BE(12);
  const payload = b.subarray(16, 16 + compressedLength);
  const args = b
    .subarray(16 + compressedLength, 16 + compressedLength + argsLen)
    .toString('latin1');
  return { fileName: args.split('\0')[0], compressedLength, length, payload };
}

/** Send a file to the Wii; resolves when the whole frame is written and the socket closed. */
export function sendWiiload(
  host: string,
  fileName: string,
  data: Uint8Array,
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<void> {
  const frame = wiiloadFrame(fileName, data);
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port: opts.port ?? WIILOAD_PORT });
    sock.setTimeout(opts.timeoutMs ?? 15000, () => {
      sock.destroy();
      reject(new Error(`no answer from ${host}:${opts.port ?? WIILOAD_PORT} (timeout)`));
    });
    sock.once('error', (e) => reject(e));
    sock.once('connect', () => {
      // 4 KB writes like the reference tool; Node coalesces anyway.
      let off = 0;
      const step = (): void => {
        while (off < frame.length) {
          const end = Math.min(off + 4096, frame.length);
          const ok = sock.write(frame.subarray(off, end));
          off = end;
          if (!ok) {
            sock.once('drain', step);
            return;
          }
        }
        sock.end();
      };
      step();
    });
    sock.once('close', (hadError) => (hadError ? undefined : resolve()));
  });
}
