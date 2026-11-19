// Guards the site's Vercel data allowance: the relay compresses the feeds, and a hidden page
// makes no feed requests (except trips during a ride with alerts still to come). Run: npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import handler from '../api/mta.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function call(acceptEncoding, bytes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes);
  const headers = {};
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (body) => { globalThis.fetch = realFetch; resolve({ status: res.statusCode, headers, body }); },
    };
    handler({ url: '/api/mta?feed=gtfs', headers: { 'accept-encoding': acceptEncoding } }, res);
  });
}

const sample = Buffer.from('x'.repeat(5000) + 'subway');

test('relay sends brotli when the client accepts it', async () => {
  const r = await call('gzip, deflate, br', sample);
  assert.equal(r.headers['content-encoding'], 'br');
  assert.match(r.headers.vary, /Accept-Encoding/);
  assert.ok(r.body.length < sample.length / 10);
  assert.deepEqual(brotliDecompressSync(r.body), sample);
});

test('relay falls back to gzip, then to raw bytes', async () => {
  const g = await call('gzip', sample);
  assert.equal(g.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(g.body), sample);
  const raw = await call('', sample);
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.deepEqual(raw.body, sample);
});

test('feed refreshes go through the visibility-aware scheduler, not bare intervals', () => {
  assert.doesNotMatch(main, /setInterval\(refresh(Trips|Alerts|Outages)/);
  assert.match(main, /refreshEvery\(refreshTrips, TRIP_REFRESH_MS, \(\) => \(rideAlertsPending\(\)/);
  assert.match(main, /refreshEvery\(refreshAlerts, ALERT_REFRESH_MS\)/);
  assert.match(main, /refreshEvery\(refreshOutages, OUTAGE_REFRESH_MS\)/);
  assert.match(main, /const gap = hidden \? r\.hiddenMs\(\) : r\.ms;/);
});
