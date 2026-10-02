// web.ts: what every request gets -- the POST checks (same origin, this
// relay's Host), the form size cap -- whatever page is behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { hostAllowed } from '../src/web.js';
import { startHarness, TEST_PASSWORD } from './harness.js';

function basic(password: string): string {
  return `Basic ${Buffer.from(`to:${password}`).toString('base64')}`;
}

/** A raw request, so the Host header can be anything (fetch always sends the real one). */
function rawPost(url: string, headers: Record<string, string>, body = ''): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('hostAllowed: the relay by IP, localhost, *.local or its hostname; nothing else', () => {
  for (const ok of [
    '192.168.1.252:29473',
    '127.0.0.1',
    '[::1]:29473',
    'localhost:29473',
    'relay.local',
    'RELAY.LOCAL:29473',
  ]) {
    assert.ok(hostAllowed(ok), ok);
  }
  for (const bad of [
    undefined,
    '',
    'evil.example',
    'relay.local.evil.example',
    'attacker.com:29473',
  ]) {
    assert.ok(!hostAllowed(bad), String(bad));
  }
});

test('a POST from another site or through a foreign name is refused before any action', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const id = 1; // no such flag either way: a 403 must come before the 404
  const auth = basic(TEST_PASSWORD);

  const crossSite = await fetch(`${h.statusUrl}/ack?id=${id}`, {
    method: 'POST',
    headers: { authorization: auth, origin: 'http://evil.example' },
    redirect: 'manual',
  });
  assert.equal(crossSite.status, 403);

  const rebound = await rawPost(`${h.statusUrl}/ack?id=${id}`, {
    authorization: auth,
    host: 'evil.example',
  });
  assert.equal(rebound, 403, 'DNS rebinding: a foreign Host is refused');

  const sameSite = await rawPost(`${h.statusUrl}/ack?id=${id}`, {
    authorization: auth,
    host: `127.0.0.1:${new URL(h.statusUrl).port}`,
  });
  assert.equal(sameSite, 404, 'the relay itself gets through to the action');
});

test('a form over the size cap is refused', async (t) => {
  const h = await startHarness();
  t.after(h.close);
  const r = await rawPost(
    `${h.statusUrl}/setup`,
    {
      authorization: basic(TEST_PASSWORD),
      host: `127.0.0.1:${new URL(h.statusUrl).port}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    'x='.padEnd(20_000, 'y'),
  );
  assert.equal(r, 413);
});
