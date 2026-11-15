// AI-assisted (Claude Code), reviewed by a team member.
// Regression tests for two review findings on src/baseline.js:
// 1) better acuity (lower logMAR) must never raise the "persistent change" alarm;
// 2) the band for a 5-session baseline uses Student's t with n - 1 = 4 degrees of freedom, not 1.96.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBaseline, classify } from '../src/baseline.js';

const mk = (logMAR) => ({ participant: 'A', eye: 'OD', glasses: 'yes', targetMm: 1000, logMAR, floorHit: false });
const steady = [0.30, 0.31, 0.29, 0.30, 0.30].map(mk); // mean 0.30, small spread -> threshold 0.10

test('two better results in a row are an improvement, not a persistent change', () => {
  const b = computeBaseline(steady);
  const first = mk(0.14);
  assert.equal(classify(first, b, steady[4]), 'improved');
  assert.equal(classify(mk(0.12), b, first), 'improved');
});

test('two worse results in a row are still a persistent change', () => {
  const b = computeBaseline(steady);
  const first = mk(0.46);
  assert.equal(classify(first, b, steady[4]), 'single');
  assert.equal(classify(mk(0.48), b, first), 'persistent');
});

test('a better result does not count as the first of two worse ones', () => {
  const b = computeBaseline(steady);
  assert.equal(classify(mk(0.46), b, mk(0.12)), 'single');
});

test('the band uses t(0.975, df = 4) = 2.776 for five sessions', () => {
  // SYNTHETIC values: mean 0.30, sample sd 0.045277 (n - 1)
  const b = computeBaseline([0.30, 0.35, 0.25, 0.34, 0.26].map(mk));
  const sd = Math.sqrt(0.0082 / 4);
  assert.ok(Math.abs(b.sd - sd) < 1e-12);
  const expected = 2.776 * sd * Math.sqrt(1 + 1 / 5); // 0.1377; with 1.96 it would be 0.0972 and clamp to 0.10
  assert.ok(Math.abs(b.threshold - expected) < 1e-9, `threshold ${b.threshold}, expected ${expected}`);
});
