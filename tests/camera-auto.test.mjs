// AI-assisted (Claude Code), reviewed by a team member.
// Camera choice, automatic calibration from the eyes, and camera errors. SYNTHETIC numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.mjs';
import {
  eyeSpanFromIris, irisDiameterPx, focalPx, videoConstraints, cameraSupport, isLowPowerDevice,
  IRIS_MM, AUTO_MIN_SAMPLES, setCameraProvider, getCalibrationMethod, clearCalibration, getK,
} from '../src/distance.js';
import { cameraErrorText } from '../src/camera-screen.js';
import { cameraId, describeCamera, loadCameraSettings, saveCameraSettings } from '../src/camera-source.js';
import { normalizePiUrl, blockedReason } from '../src/pi-camera.js';

const err = (name, message = 'x') => Object.assign(new Error(message), { name });
const run = (n, span, iris) => Array.from({ length: n }, (_, i) => ({ t: i * 33, span, iris }));

test('eye span in mm comes from the iris, at any distance', () => {
  // An eye span of 8 iris diameters is 8 × 11.7 mm, whether the face is near (big) or far (small).
  for (const iris of [40, 20, 10]) {
    const r = eyeSpanFromIris(run(AUTO_MIN_SAMPLES, 8 * iris, iris));
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.eyeSpanMm - 8 * IRIS_MM) < 1e-9);
  }
});

test('automatic calibration waits for enough still frames, and refuses odd readings', () => {
  const few = eyeSpanFromIris(run(5, 300, 37.5));
  assert.equal(few.reason, 'collecting');
  assert.ok(few.progress > 0 && few.progress < 1);
  const moving = run(AUTO_MIN_SAMPLES, 300, 37.5).map((s, i) => ({ ...s, span: s.span * (i % 2 ? 1.1 : 0.9) }));
  assert.equal(eyeSpanFromIris(moving).reason, 'hold_still');
  assert.equal(eyeSpanFromIris(run(AUTO_MIN_SAMPLES, 300, null)).reason, 'no_iris');
  assert.equal(eyeSpanFromIris(run(AUTO_MIN_SAMPLES, 300, 10)).reason, 'implausible'); // 351 mm between the eyes
});

test('iris diameter is the mean of both eyes, in video pixels; none without iris points', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  for (const [a, b] of [[469, 471], [474, 476]]) { lm[a] = { x: 0.49, y: 0.5 }; lm[b] = { x: 0.51, y: 0.5 }; }
  for (const [a, b] of [[470, 472], [475, 477]]) { lm[a] = { x: 0.5, y: 0.48 }; lm[b] = { x: 0.5, y: 0.52 }; }
  // horizontal 0.02 × 1000 = 20 px, vertical 0.04 × 500 = 20 px
  assert.ok(Math.abs(irisDiameterPx(lm, 1000, 500) - 20) < 1e-9);
  assert.equal(irisDiameterPx(lm.slice(0, 468), 1000, 500), null);
});

test('focal length from the field of view; distance = focal × eye span / eye span in px', () => {
  assert.ok(Math.abs(focalPx(1000, 90) - 500) < 1e-9);
  const f = focalPx(640);
  const k = f * 93; // a person with 93 mm between the outer eye corners
  const spanAt500 = (f * 93) / 500;
  assert.ok(Math.abs(k / spanAt500 - 500) < 1e-9);
});

test('a chosen camera is asked for exactly; the Pi and other ARM boards get a smaller picture', () => {
  assert.deepEqual(videoConstraints('abc', false), { deviceId: { exact: 'abc' }, width: { ideal: 1280 }, height: { ideal: 720 } });
  assert.deepEqual(videoConstraints('', true), { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } });
  assert.equal(isLowPowerDevice('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), true);
  assert.equal(isLowPowerDevice('Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), true);
  assert.equal(isLowPowerDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), false);
  assert.equal(isLowPowerDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), false);
});

test('a page that is not https or localhost cannot use a local camera, and says so', () => {
  assert.equal(cameraSupport({ isSecureContext: false, navigator: {} }), 'insecure');
  assert.equal(cameraSupport({ isSecureContext: true, navigator: {} }), 'unsupported');
  assert.equal(cameraSupport({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } }), '');
  assert.match(cameraErrorText(err('InsecureContextError', 'The camera only works on an https:// page.')), /https/);
});

test('every camera failure has an instruction; Pi hints only on a Pi', () => {
  for (const name of ['NotAllowedError', 'SecurityError', 'NotFoundError', 'OverconstrainedError', 'NotReadableError',
    'AbortError', 'NotSupportedError', 'FaceTrackerError']) {
    assert.ok(cameraErrorText(err(name), { lowPower: false }).length > 20, name);
  }
  assert.doesNotMatch(cameraErrorText(err('NotFoundError'), { lowPower: false }), /Raspberry/);
  assert.match(cameraErrorText(err('NotFoundError'), { lowPower: true }), /Camera Module/);
  assert.match(cameraErrorText(err('NotReadableError'), { lowPower: true }), /camera_server\.py/);
});

test('each chosen camera keeps its own calibration; the default camera keeps the old key', () => {
  installLocalStorage();
  const origin = 'https://capitalisming.github.io';
  assert.equal(cameraId({ source: 'local', piUrl: '' }, origin), '');
  assert.equal(cameraId({ source: 'local', piUrl: '', deviceId: 'cam1' }, origin), 'dev:cam1');
  assert.equal(describeCamera({ source: 'local', piUrl: '', deviceId: 'cam1', deviceLabel: 'USB Camera' }, origin), 'USB Camera');
  saveCameraSettings({ source: 'local', piUrl: '', deviceId: 'cam1', deviceLabel: 'USB Camera' });
  assert.deepEqual(loadCameraSettings(), { source: 'local', piUrl: '', deviceId: 'cam1', deviceLabel: 'USB Camera' });
  saveCameraSettings({ source: 'pi', piUrl: 'pi:8000', deviceId: 'cam1' });
  assert.deepEqual(loadCameraSettings(), { source: 'pi', piUrl: 'pi:8000' });
});

test('calibration method: old calibrations were tape; clearing removes it', () => {
  installLocalStorage();
  setCameraProvider(null, 'dev:cam1');
  assert.equal(getCalibrationMethod('A'), null);
  localStorage.setItem('cam_k_A@dev:cam1', '50000');
  assert.equal(getCalibrationMethod('A'), 'tape');
  localStorage.setItem('cam_kmethod_A@dev:cam1', 'auto');
  assert.equal(getCalibrationMethod('A'), 'auto');
  clearCalibration('A');
  assert.equal(getK('A'), null);
  assert.equal(getCalibrationMethod('A'), null);
  setCameraProvider(null, '');
});

test('on an https page a Pi address without scheme means https, which is not blocked', () => {
  const page = 'https://capitalisming.github.io';
  assert.equal(normalizePiUrl('raspberrypi.local:8000', page), 'https://raspberrypi.local:8000');
  assert.equal(blockedReason(normalizePiUrl('raspberrypi.local:8000', page), `${page}/Vision/`), '');
  assert.match(blockedReason('http://raspberrypi.local:8000', `${page}/Vision/`), /--https/);
});
