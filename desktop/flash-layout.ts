// flash-layout.ts -- which parts of a beamer firmware image the flasher
// writes (beamers/page.ts). The fork's release is one merged image for
// address 0: bootloader, partition table at 0x8000, the app at its partition.
// Written whole, its 0xFF padding between the table and the app would wipe
// the NVS partitions, and with them the beamer's station number and replay
// acks (docs/redesign.md, Station identity on the beamer). So the flasher
// writes only what the image actually carries -- everything below the first
// partition, then each app partition -- and never erases the chip. An image
// with real bytes for any other partition is refused, never half-written.
//
// Pure functions, no DOM and no Node: the page and the tests (test/) share it.

/** Where ESP-IDF puts the partition table (CONFIG_PARTITION_TABLE_OFFSET's default). */
export const PARTITION_TABLE_OFFSET = 0x8000;
const ENTRY_SIZE = 32;
const MAX_ENTRIES = 95; // a 3 KB table of 32-byte entries, minus the MD5 entry
const TYPE_APP = 0x00;

export interface Partition {
  label: string;
  type: number; // 0 app, 1 data
  subtype: number; // for data: 0x02 nvs, 0x01 phy, 0x03 coredump...
  offset: number;
  size: number;
}

export interface FlashSegment {
  address: number;
  data: Uint8Array;
}

export interface FlashPlan {
  segments: FlashSegment[];
  /** Partitions left as they are on the beamer (NVS and every other data partition). */
  kept: Partition[];
}

/** The partition table of a merged image; throws when there is none. */
export function readPartitionTable(image: Uint8Array): Partition[] {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const out: Partition[] = [];
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const at = PARTITION_TABLE_OFFSET + i * ENTRY_SIZE;
    if (at + ENTRY_SIZE > image.length) break;
    const magic = view.getUint16(at, true);
    if (magic === 0xffff || magic === 0xebeb) break; // end of table, or its MD5 entry
    if (magic !== 0x50aa) throw new Error(`partition table entry ${i} is damaged`);
    const labelBytes = image.subarray(at + 12, at + 28);
    const end = labelBytes.indexOf(0);
    out.push({
      type: image[at + 2]!,
      subtype: image[at + 3]!,
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
      label: String.fromCharCode(...labelBytes.subarray(0, end < 0 ? 16 : end)),
    });
  }
  if (out.length === 0) throw new Error('the image has no partition table at 0x8000');
  return out;
}

/** What to write for a merged image, and what it leaves alone; throws with a reason the page shows. */
export function flashPlan(image: Uint8Array): FlashPlan {
  if (image.length < PARTITION_TABLE_OFFSET + ENTRY_SIZE || image[0] !== 0xe9) {
    throw new Error('this is not an ESP32 firmware image');
  }
  const parts = readPartitionTable(image);
  const apps = parts.filter((p) => p.type === TYPE_APP);
  if (apps.length === 0) throw new Error('the image has no app partition');
  const first = Math.min(...parts.map((p) => p.offset));
  if (first <= PARTITION_TABLE_OFFSET) throw new Error('a partition overlaps the partition table');

  const segments: FlashSegment[] = [{ address: 0, data: image.subarray(0, first) }];
  for (const p of apps) {
    if (p.offset >= image.length) continue;
    segments.push({
      address: p.offset,
      data: image.subarray(p.offset, Math.min(p.offset + p.size, image.length)),
    });
  }
  // Anything the segments leave out must be padding: an image that carries
  // data for a partition the flasher keeps (an NVS image, a filesystem) is refused.
  const written = new Uint8Array(image.length);
  for (const s of segments) written.fill(1, s.address, s.address + s.data.length);
  for (let i = 0; i < image.length; i++) {
    if (!written[i] && image[i] !== 0xff) {
      const p = parts.find((q) => i >= q.offset && i < q.offset + q.size);
      throw new Error(
        `the image carries data at 0x${i.toString(16)}${p ? ` (partition "${p.label}")` : ''}, which LazyTO does not overwrite`,
      );
    }
  }
  return { segments, kept: parts.filter((p) => p.type !== TYPE_APP) };
}
