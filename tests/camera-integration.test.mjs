// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.mjs';
import { toBaselineSessions, latestAction } from '../src/trend-data.js';
import { loadCameraSettings, saveCameraSettings, cameraId, describeCamera } from '../src/camera-source.js';
import { getK, setCameraProvider } from '../src/distance.js';

const ORIGIN = 'http://raspberrypi.local:8000';

// SYNTHETIC sessions in the stored (contract) format, only the fields the adapter reads.
const session = (day, logmar, extra = {}) => ({
  participant: 'A', eye: 'OD', glasses: 'yes', condition: 'self_check', target_mm: 1000,
  started_at: `2026-11-${String(day).padStart(2, '0')}T08:00:00.000Z`,
  outcome: 'ok', logmar, floor_hit: false, ...extra,
});

test('adapter maps the stored format and drops practice tests', () => {
  const out = toBaselineSessions([session(2, 0.3), session(1, 0.2, { condition: 'practice' })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    participant: 'A', eye: 'OD', glasses: 'yes', targetMm: 1000, timestamp: '2026-11-02T08:00:00.000Z',
    logMAR: 0.3, floorHit: false, reason: '',
  });
});

test('adapter orders by time and turns failures into not-measurable sessions', () => {
  const out = toBaselineSessions([
    session(3, null, { outcome: 'floor_hit', floor_hit: true }),
    session(1, 0.3),
    session(2, null, { outcome: 'aborted_camera' }),
  ]);
  assert.deepEqual(out.map((s) => s.timestamp.slice(8, 10)), ['01', '02', '03']);
  assert.deepEqual(out.map((s) => s.logMAR), [0.3, null, null]);
  assert.deepEqual(out.map((s) => s.floorHit), [false, false, true]);
  assert.deepEqual(out.map((s) => s.reason), ['', 'no distance', 'floor hit']);
});

test('latestAction needs five tests for a baseline, then compares the newest one', () => {
  assert.equal(latestAction([]), null);
  const four = [1, 2, 3, 4].map((d) => session(d, 0.3));
  assert.deepEqual({ ...latestAction(four), latest: undefined }, { state: 'insufficient', needed: 1, latest: undefined });
  const steady = [...four, session(5, 0.3), session(6, 0.32)];
  assert.equal(latestAction(steady).state, 'within');
  const drifted = [...four, session(5, 0.3), session(6, 0.7)];
  assert.equal(latestAction(drifted).state, 'single');
});

test('latestAction compares only tests of the same participant, eye and glasses', () => {
  const others = [1, 2, 3, 4, 5].map((d) => session(d, 0.3, { participant: 'B' }));
  const mine = session(6, 0.9);
  const a = latestAction([...others, mine]);
  assert.equal(a.state, 'insufficient');
  assert.equal(a.needed, 4);
});

test('camera settings default to this computer and survive a round trip', () => {
  installLocalStorage();
  assert.deepEqual(loadCameraSettings(), { source: 'local', piUrl: '' });
  saveCameraSettings({ source: 'pi', piUrl: 'raspberrypi.local:8000' });
  assert.deepEqual(loadCameraSettings(), { source: 'pi', piUrl: 'raspberrypi.local:8000' });
  localStorage.setItem('camera_settings', '{not json');
  assert.deepEqual(loadCameraSettings(), { source: 'local', piUrl: '' });
  localStorage.setItem('camera_settings', JSON.stringify({ source: 'usb', piUrl: '' }));
  assert.deepEqual(loadCameraSettings(), { source: 'local', piUrl: '' });
});

test('camera id and description', () => {
  assert.equal(cameraId({ source: 'local', piUrl: '' }, ORIGIN), '');
  assert.equal(cameraId({ source: 'pi', piUrl: '' }, ORIGIN), 'pi:http://raspberrypi.local:8000');
  assert.equal(cameraId({ source: 'pi', piUrl: '192.168.1.20:8000' }, ORIGIN), 'pi:http://192.168.1.20:8000');
  assert.equal(describeCamera({ source: 'local', piUrl: '' }, ORIGIN), 'this computer');
  assert.equal(describeCamera({ source: 'pi', piUrl: '192.168.1.20:8000' }, ORIGIN), 'Raspberry Pi (192.168.1.20:8000)');
});

test('a distance calibration belongs to one camera', () => {
  installLocalStorage();
  localStorage.setItem('cam_k_A', '1000');
  localStorage.setItem('cam_k_A@pi:http://pi:8000', '2000');
  setCameraProvider(null, '');
  assert.equal(getK('A'), 1000);
  setCameraProvider(async () => {}, 'pi:http://pi:8000');
  assert.equal(getK('A'), 2000);
  setCameraProvider(async () => {}, 'pi:http://other:8000');
  assert.equal(getK('A'), null, 'a camera that was never calibrated has no k');
  setCameraProvider(null, '');
});
