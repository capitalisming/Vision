import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, headTurnDeg, headYawDeg, evaluateFrame } from '../src/distance.js';

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

const rotY = (deg, scale = 1) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r) * scale;
  const s = Math.sin(r) * scale;
  // row-major 4x4
  return { rows: 4, columns: 4, data: [c, 0, s, 0, 0, scale, 0, 0, -s, 0, c, 0, 0, 0, -50, 1] };
};

test('headTurnDeg recovers yaw, independent of scale', () => {
  assert.ok(Math.abs(headTurnDeg(rotY(0)) - 0) < 1e-6);
  assert.ok(Math.abs(headTurnDeg(rotY(20, 3.7)) - 20) < 1e-6);
});

const face = (lx, rx) => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[263] = { x: lx, y: 0.5, z: 0 };
  lm[33] = { x: rx, y: 0.5, z: 0 };
  return lm;
};

test('evaluateFrame reasons and span in video pixels', () => {
  const W = 1280;
  const H = 720;
  assert.equal(evaluateFrame({ faceLandmarks: [] }, W, H).reason, 'no_face');
  assert.equal(evaluateFrame({ faceLandmarks: [face(0.6, 0.4), face(0.2, 0.1)] }, W, H).reason, 'two_faces');
  const turned = { faceLandmarks: [face(0.6, 0.4)], facialTransformationMatrixes: [rotY(16)] };
  assert.equal(evaluateFrame(turned, W, H).reason, 'head_turned');
  const ok = { faceLandmarks: [face(0.6, 0.4)], facialTransformationMatrixes: [rotY(10)] };
  const f = evaluateFrame(ok, W, H);
  assert.equal(f.reason, null);
  assert.ok(Math.abs(f.spanPx - 256) < 1e-9);
});

// Tilt up or down (about the x axis), row-major.
const rotX = (deg) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { rows: 4, columns: 4, data: [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, -50, 1] };
};

test('headYawDeg sees only the sideways turn, in either matrix layout', () => {
  assert.ok(Math.abs(headYawDeg(rotY(20, 3.7)) - 20) < 1e-6);
  const t = rotY(20).data;
  const transposed = { data: [t[0], t[4], t[8], t[12], t[1], t[5], t[9], t[13], t[2], t[6], t[10], t[14], t[3], t[7], t[11], t[15]] };
  assert.ok(Math.abs(headYawDeg(transposed) - 20) < 1e-6);
  assert.ok(headYawDeg(rotX(25)) < 1e-6);
});

test('looking down at the screen under a laptop camera is not "head turned"; turning sideways is', () => {
  const W = 1280;
  const H = 720;
  const frame = (m) => evaluateFrame({ faceLandmarks: [face(0.6, 0.4)], facialTransformationMatrixes: [m] }, W, H).reason;
  assert.equal(frame(rotX(20)), null, 'tilted 20° (camera above the screen)');
  assert.equal(frame(rotX(-20)), null);
  assert.equal(frame(rotX(36)), 'head_turned', 'past 35° the face points are not reliable');
  assert.equal(frame(rotY(16)), 'head_turned');
  assert.equal(frame(rotY(14)), null);
});
