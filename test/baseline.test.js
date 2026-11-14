import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBaseline, classify } from '../src/baseline.js';

const mk = (logMAR, extra = {}) => ({
  participant: 'P1',
  eye: 'R',
  glasses: true,
  targetMm: 670,
  logMAR,
  floorHit: false,
  ...extra,
});
const five = [0.1, 0.12, 0.08, 0.1, 0.1].map((v) => mk(v));

test('(a) four sessions -> null', () => {
  assert.equal(computeBaseline(five.slice(0, 4)), null);
});

test('(b) five sessions -> mean 0.10, threshold 0.10', () => {
  const b = computeBaseline(five);
  assert.equal(b.n, 5);
  assert.ok(Math.abs(b.mean - 0.1) < 1e-12);
  assert.ok(Math.abs(b.sd - Math.sqrt(0.0002)) < 1e-12); // sample sd, n - 1
  assert.equal(b.threshold, 0.1); // 1.96 * sd * sqrt(1.2) = 0.030 < 0.10
});

test('(c) new session 0.16 -> within', () => {
  assert.equal(classify(mk(0.16), computeBaseline(five), five[4]), 'within');
});

test('(d) two in a row at 0.34 -> single, then persistent', () => {
  const b = computeBaseline(five);
  const first = mk(0.34);
  assert.equal(classify(first, b, mk(0.16)), 'single');
  assert.equal(classify(mk(0.34), b, first), 'persistent');
});

test('opposite sides in a row are not persistent', () => {
  const b = computeBaseline(five);
  assert.equal(classify(mk(-0.2), b, mk(0.34)), 'single');
});

test('no baseline -> insufficient; no number or floorHit -> not_measurable', () => {
  assert.equal(classify(mk(0.2), null, null), 'insufficient');
  assert.equal(classify(mk(null), computeBaseline(five), null), 'not_measurable');
  assert.equal(classify(mk(0.2, { floorHit: true }), null, null), 'not_measurable');
});

test('baseline skips floorHit, missing numbers and other conditions', () => {
  const mixed = [
    mk(0.5, { floorHit: true }),
    mk(null),
    five[0],
    mk(0.9, { glasses: false }),
    ...five.slice(1, 4),
    mk(0.9, { eye: 'L' }),
  ];
  assert.equal(computeBaseline(mixed), null);
  assert.ok(Math.abs(computeBaseline([...mixed, five[4]]).mean - 0.1) < 1e-12);
});
