// page.ts -- the Beamers window's page (index.html; main side in
// ../beamers.ts). Flashing: Web Serial and esptool-js, writing only the parts
// of the image flash-layout.ts picks, never erasing the chip, so the beamer
// keeps its station number and replay acks. Provisioning: the main process
// asks for the drive and writes config.txt; this page only collects the
// Wi-Fi name and password.

import { flashPlan } from '../flash-layout.js';

type Firmware =
  { ok: true; bytes: Uint8Array; sha256: string; version: string } | { ok: false; reason: string };

declare global {
  interface Window {
    lazyto: {
      firmware(): Promise<Firmware>;
      secretSet(): Promise<boolean>;
      provision(ssid: string, password: string): Promise<{ ok: boolean; msg: string }>;
    };
  }
}

const BEAMER_CHIP = 'ESP32-S3';
const BAUD = 921_600;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const log = el<HTMLPreElement>('log');
function say(line: string): void {
  log.textContent += line;
}
function result(id: string, ok: boolean, msg: string): void {
  const p = el<HTMLParagraphElement>(id);
  p.className = ok ? 'ok' : 'warn';
  p.textContent = msg;
}

// esptool-js's own ES module build, beside this page in the app; its types are the package's.
type Esptool = typeof import('esptool-js');
const esptool = import(
  new URL('../../../node_modules/esptool-js/bundle.js', import.meta.url).href
) as Promise<Esptool>;

async function flash(fw: Extract<Firmware, { ok: true }>): Promise<void> {
  const button = el<HTMLButtonElement>('flash');
  const progress = el<HTMLProgressElement>('progress');
  button.disabled = true;
  el('flash-result').textContent = '';
  let port: SerialPort;
  try {
    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
  } catch {
    result(
      'flash-result',
      false,
      'No beamer in flashing mode. Unplug it, hold its button while plugging it back in, then click Flash.',
    );
    button.disabled = false;
    return;
  }
  const { ESPLoader, Transport } = await esptool;
  const transport = new Transport(port, false);
  try {
    const plan = flashPlan(fw.bytes);
    const loader = new ESPLoader({
      transport,
      baudrate: BAUD,
      terminal: {
        clean: () => (log.textContent = ''),
        writeLine: (s) => say(`${s}\n`),
        write: say,
      },
    });
    const chip = await loader.main();
    if (!chip.startsWith(BEAMER_CHIP))
      throw new Error(`this is an ${chip}, not a beamer (${BEAMER_CHIP})`);
    const total = plan.segments.reduce((n, s) => n + s.data.length, 0);
    const before = plan.segments.map((_, i) =>
      plan.segments.slice(0, i).reduce((n, s) => n + s.data.length, 0),
    );
    progress.hidden = false;
    await loader.writeFlash({
      fileArray: plan.segments.map((s) => ({ address: s.address, data: s.data })),
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, size) => {
        progress.value = (before[i]! + (written / size) * plan.segments[i]!.data.length) / total;
      },
    });
    progress.value = 1;
    await loader.after('hard_reset');
    result(
      'flash-result',
      true,
      `Done: LazyTO firmware ${fw.version || fw.sha256.slice(0, 12)} is on the beamer. It kept ${plan.kept.map((p) => p.label).join(', ')}. Unplug it.`,
    );
  } catch (e) {
    result(
      'flash-result',
      false,
      `Flashing failed: ${e instanceof Error ? e.message : String(e)}. Unplug the beamer and try again.`,
    );
  } finally {
    await transport.disconnect().catch(() => undefined);
    button.disabled = false;
  }
}

async function main(): Promise<void> {
  const fw = await window.lazyto.firmware();
  const fwLine = el<HTMLParagraphElement>('fw');
  if (fw.ok) {
    fwLine.textContent = `Firmware ${fw.version || '(unversioned)'} · SHA-256 ${fw.sha256.slice(0, 16)}…`;
    const button = el<HTMLButtonElement>('flash');
    button.disabled = false;
    button.addEventListener('click', () => void flash(fw));
  } else {
    fwLine.className = 'warn';
    fwLine.textContent = fw.reason;
  }

  const form = el<HTMLFormElement>('provision');
  if (!(await window.lazyto.secretSet())) {
    result(
      'provision-result',
      false,
      'Set LazyTO up first (its settings page): the beamers need its secret.',
    );
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const write = el<HTMLButtonElement>('write');
    write.disabled = true;
    void window.lazyto
      .provision(el<HTMLInputElement>('ssid').value, el<HTMLInputElement>('password').value)
      .then((r) => result('provision-result', r.ok, r.msg))
      .finally(() => (write.disabled = false));
  });
}

void main();
