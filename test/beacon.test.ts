// beacon.test.ts -- relay discovery beacon (src/beacon.ts, decisions.md R15):
// the broadcast address math, and a real datagram received and decoded the
// way a station will, taking the relay's address from the datagram source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { RelayBeacon, directedBroadcasts } from '../src/beacon.js';
import {
  MAGIC_0,
  MAGIC_1,
  PROTO_VERSION,
  RELAY_BEACON_SIZE,
  decodeRelayBeacon,
} from '../generated/wire.js';

function iface(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
  } as NetworkInterfaceInfo;
}

test('directed broadcast per IPv4 interface; loopback and IPv6 skipped; duplicates merged', () => {
  const got = directedBroadcasts({
    lo: [iface('127.0.0.1', '255.0.0.0', true)],
    wlan0: [
      iface('192.168.1.37', '255.255.255.0'),
      {
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        mac: '',
        internal: false,
        cidr: null,
        scopeid: 0,
      } as NetworkInterfaceInfo,
    ],
    eth0: [iface('10.42.0.1', '255.255.0.0')],
    eth0b: [iface('10.42.7.9', '255.255.0.0')],
  });
  assert.deepEqual(got, ['10.42.255.255', '192.168.1.255']);
});

test('no interfaces, no targets', () => {
  assert.deepEqual(directedBroadcasts({}), []);
});

test('a station receives the beacon and learns the relay from the source address and tcp_port', async () => {
  const station = createSocket('udp4');
  await new Promise<void>((resolve) => station.bind(0, '127.0.0.1', () => resolve()));
  const port = (station.address() as AddressInfo).port;
  const received = new Promise<{ msg: Buffer; from: string }>((resolve) =>
    station.once('message', (msg, rinfo) => resolve({ msg, from: rinfo.address })),
  );

  const beacon = new RelayBeacon({
    tcpPort: 29470,
    eventId: 1613010,
    targets: () => ['127.0.0.1'],
    port,
    intervalMs: 50,
  });
  await beacon.start();
  try {
    const { msg, from } = await received;
    assert.equal(msg.length, RELAY_BEACON_SIZE);
    const b = decodeRelayBeacon(msg);
    assert.deepEqual([...b.magic], [MAGIC_0, MAGIC_1]);
    assert.equal(b.version, PROTO_VERSION);
    assert.equal(b.tcp_port, 29470);
    assert.equal(b.event_id, 1613010);
    assert.equal(from, '127.0.0.1', 'the relay address is the datagram source');
    await new Promise((r) => setTimeout(r, 30));
    const s = beacon.status();
    assert.deepEqual(s.targets, ['127.0.0.1']);
    assert.ok(s.sent >= 1);
    assert.equal(s.lastError, null);
  } finally {
    await beacon.stop();
    station.close();
  }
});

test('an empty interface list is reported, not thrown', async () => {
  const beacon = new RelayBeacon({ tcpPort: 29470, eventId: 1, targets: () => [], intervalMs: 50 });
  await beacon.start();
  try {
    assert.match(beacon.status().lastError ?? '', /no IPv4 network interface/);
    assert.equal(beacon.status().sent, 0);
  } finally {
    await beacon.stop();
  }
});
