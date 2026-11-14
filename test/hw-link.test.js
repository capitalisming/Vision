// AI-assisted (Claude Code), reviewed by a team member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canUseSensor, median, computeOffset, applyOffset, parseMessage, createSensorLink,
  sensorCheckCsv, summarizeSensorCheck, RECONNECT_MS, OFFSET_KEY,
} from '../src/hw-link.js';

// ---- pure functions -------------------------------------------------------------------------------------

test('contract check value: raw 480 at 500 mm -> offset +20; then raw 980 -> 1000 mm', () => {
  const offset = computeOffset(500, 480);
  assert.equal(offset, 20);
  assert.equal(applyOffset(980, offset), 1000);
});

test('median of a window', () => {
  assert.equal(median([]), null);
  assert.equal(median([510, 490, 500]), 500);
  assert.equal(median([500, 520, 480, 900]), 510);
});

test('parseMessage: valid, ok = 0, broken', () => {
  assert.deepEqual(parseMessage('{"v":1,"mm":512,"ok":1,"lux":310.5}'), { type: 'reading', mm: 512, ok: true, lux: 310.5 });
  assert.deepEqual(parseMessage('{"v":1,"mm":null,"ok":0,"lux":null}'), { type: 'reading', mm: null, ok: false, lux: null });
  assert.deepEqual(parseMessage('{"v":1,"hello":"sensor-pi","camera":false}'), { type: 'hello', camera: false });
  assert.deepEqual(parseMessage('{"v":1,"clients":2}'), { type: 'clients', clients: 2 });
  for (const bad of ['', 'not json', '{"v":1,"mm', 'null', '[]', '{"v":2,"mm":500,"ok":1,"lux":null}',
    '{"v":1,"mm":null,"ok":1,"lux":null}', '{"v":1,"mm":"500","ok":1,"lux":null}', '{"v":1,"mm":500,"ok":true,"lux":null}',
    '{"v":1,"mm":500,"ok":1,"lux":"dark"}', '{"v":1}']) {
    assert.equal(parseMessage(bad), null, bad);
  }
});

test('canUseSensor: http and localhost yes, https no', () => {
  assert.equal(canUseSensor('http:'), true);
  assert.equal(canUseSensor('https:'), false);
});

// ---- the link with a fake WebSocket, clock and storage --------------------------------------------------

class FakeWS {
  static last = null;
  constructor(url) { this.url = url; this.closed = false; FakeWS.last = this; }
  open() { this.onopen?.(); }
  send(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  close() { this.closed = true; }
  drop() { this.onclose?.(); }
}

function setup({ protocol = 'http:' } = {}) {
  let t = 1000;
  const store = new Map();
  const timers = [];
  const link = createSensorLink({
    now: () => t,
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    WebSocketImpl: () => FakeWS,
    protocol: () => protocol,
    setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; },
    clearTimer: () => {},
  });
  const advance = (ms) => {
    t += ms;
    for (const x of timers.splice(0)) { if (x.at <= t) x.fn(); else timers.push(x); }
  };
  const feed = (mm, n = 5, step = 60) => {
    for (let i = 0; i < n; i++) {
      advance(step);
      FakeWS.last.send({ v: 1, mm, ok: mm === null ? 0 : 1, lux: 200 });
    }
  };
  return { link, store, advance, feed, timers };
}

test('reasons: not_connected, not_calibrated, stale, out_of_range', async () => {
  const { link, advance, feed } = setup();
  assert.equal(link.getSensorDistance().reason, 'not_connected');
  const p = link.connectSensor('ws://pi:8765');
  FakeWS.last.open();
  await p;
  assert.equal(link.getSensorDistance().reason, 'stale'); // open, no reading yet
  feed(480);
  assert.equal(link.getSensorDistance().reason, 'not_calibrated');
  advance(501);
  assert.equal(link.getSensorDistance().reason, 'stale');
  // no fresh reading -> calibration must throw
  assert.throws(() => link.calibrateSensor(500), /stale/);
  feed(null);
  assert.equal(link.getSensorDistance().reason, 'out_of_range');
});

test('calibration and distance through the link: 480 @ 500 -> +20, then 980 -> 1000', async () => {
  const { link, store, feed } = setup();
  const p = link.connectSensor('ws://pi:8765');
  FakeWS.last.open();
  await p;
  feed(480, 9);
  assert.equal(link.calibrateSensor(500), 20);
  assert.equal(store.get(OFFSET_KEY), '20');
  feed(980, 9); // 9 x 60 ms > 0.5 s: the 480 readings have left the window
  const d = link.getSensorDistance();
  assert.deepEqual({ mm: d.mm, ok: d.ok, reason: d.reason, rawMm: d.rawMm }, { mm: 1000, ok: true, reason: null, rawMm: 980 });
  assert.ok(d.ageMs <= 500);
  assert.deepEqual(link.getAmbient(), { lux: 200, ageMs: 0, ok: true });
});

test('median filters single spikes inside the window', async () => {
  const { link, feed } = setup();
  const p = link.connectSensor();
  FakeWS.last.open();
  await p;
  feed(500, 3);
  feed(1500, 1);
  feed(500, 3);
  assert.equal(link.calibrateSensor(500), 0); // median of 500 x6 and one 1500 spike is 500
});

test('broken messages are skipped without an error', async () => {
  const { link, feed } = setup();
  const p = link.connectSensor();
  FakeWS.last.open();
  await p;
  feed(600, 3);
  FakeWS.last.send('garbage');
  FakeWS.last.send('{"v":1,"mm":"x","ok":1,"lux":null}');
  assert.equal(link.getSensorDistance().rawMm, 600);
});

test('connection drop -> not_connected, reconnect after 2 s', async () => {
  const { link, advance, feed } = setup();
  const p = link.connectSensor('ws://pi:8765');
  const first = FakeWS.last;
  first.open();
  await p;
  feed(500, 3);
  first.drop();
  assert.equal(link.getSensorDistance().reason, 'not_connected');
  advance(RECONNECT_MS - 1);
  assert.equal(FakeWS.last, first);
  advance(1);
  assert.notEqual(FakeWS.last, first);
  assert.equal(FakeWS.last.url, 'ws://pi:8765');
  FakeWS.last.open();
  assert.equal(link.getSensorStatus().status, 'open');
});

test('https page: needs_localhost, connect refused without a socket', async () => {
  const { link } = setup({ protocol: 'https:' });
  FakeWS.last = null;
  await assert.rejects(link.connectSensor(), /needs_localhost/);
  assert.equal(FakeWS.last, null);
  assert.equal(link.getSensorDistance().reason, 'needs_localhost');
  assert.deepEqual(link.getAmbient().ok, false);
});

// ---- Experiment 5 helpers ------------------------------------------------------------------------------

test('sensor_check.csv columns and error summary', () => {
  const rows = [
    { participant: 'A', glasses: 'no', tapeMm: 500, sensorRawMm: 480, sensorMm: 510, cameraMm: '', lux: 210.5, timestamp: 't1' },
    { participant: 'A', glasses: 'no', tapeMm: 500, sensorRawMm: 470, sensorMm: 490, cameraMm: 520, lux: null, timestamp: 't2' },
    { participant: 'B', glasses: 'yes', tapeMm: 1000, sensorRawMm: 1000, sensorMm: 1100, cameraMm: '', lux: '', timestamp: 't3' },
  ];
  const csv = sensorCheckCsv(rows).trim().split('\n');
  assert.equal(csv[0], 'participant,glasses,tapeMm,sensorRawMm,sensorMm,cameraMm,lux,timestamp');
  assert.equal(csv[2], 'A,no,500,470,490,520,,t2');
  const s = summarizeSensorCheck(rows);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { tapeMm: 500, glasses: 'no', n: 2, meanErrPct: 0, meanAbsErrPct: 2, maxAbsErrPct: 2 });
  assert.equal(s[1].meanAbsErrPct, 10);
});
