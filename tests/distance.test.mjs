/**
 * Unit tests for the pure geometry helpers of the camera module.
 * No browser and no MediaPipe is loaded: distance.js imports the vendor bundle lazily,
 * inside startDistance(), so Node can import the module directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EYE_OUTER_A,
  EYE_OUTER_B,
  median,
  eyeSpanPxFromLandmarks,
  yawFromLandmarks,
  yawFromMatrix,
} from '../src/distance.js';

const face = (overrides = {}) => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[EYE_OUTER_A] = { x: 0.45, y: 0.5 };
  lm[EYE_OUTER_B] = { x: 0.55, y: 0.5 };
  lm[234] = { x: 0.2, y: 0.5 };
  lm[454] = { x: 0.8, y: 0.5 };
  lm[1] = { x: 0.5, y: 0.55 };
  for (const [index, value] of Object.entries(overrides)) lm[Number(index)] = value;
  return lm;
};

test('median ignores non-finite values and averages the middle pair', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, NaN, Infinity, 1]), 3);
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

test('eye span uses the two outer corners, in video pixels', () => {
  const lm = face();
  const span = eyeSpanPxFromLandmarks(lm, 1000, 500);
  assert.ok(span);
  assert.equal(span.span, 100); // 0.10 of 1000 px
  assert.deepEqual(span.left, { x: 450, y: 250 });
  assert.deepEqual(span.right, { x: 550, y: 250 });
});

test('eye span rejects incomplete landmarks', () => {
  assert.equal(eyeSpanPxFromLandmarks([], 1000, 500), null);
  assert.equal(eyeSpanPxFromLandmarks(null, 1000, 500), null);
});

test('a frontal face has zero yaw, in row-major and column-major matrices', () => {
  const identity = { rows: 4, columns: 4, data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  assert.equal(yawFromMatrix(identity), 0);
  assert.equal(yawFromMatrix(null), null);

  const deg = 20;
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);

  const rowMajor = new Float32Array(16);
  rowMajor[0] = c;
  rowMajor[2] = s;
  rowMajor[10] = c;
  assert.ok(Math.abs(yawFromMatrix({ data: rowMajor }) - deg) < 1e-6);

  const columnMajor = new Float32Array(16);
  columnMajor[0] = c;
  columnMajor[2] = -s;
  columnMajor[10] = c;
  assert.ok(Math.abs(yawFromMatrix({ data: columnMajor }) - deg) < 1e-6);
});

test('the landmark yaw fallback grows when the nose leaves the eye midline', () => {
  assert.ok(Math.abs(yawFromLandmarks(face())) < 1e-6);
  const turned = yawFromLandmarks(face({ 1: { x: 0.62, y: 0.55 } }));
  assert.ok(turned > 15, `expected more than 15 degrees, got ${turned}`);
  assert.equal(yawFromLandmarks([]), null);
});