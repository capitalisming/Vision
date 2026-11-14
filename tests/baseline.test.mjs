/**
 * Contract tests for the personal norm (brief section 2.3).
 * Run with:  node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_N,
  MIN_THRESHOLD,
  assessSeries,
  classify,
  computeBaseline,
  normalizeSession,
} from '../src/baseline.js';

const sess = (logMAR, extra = {}) => ({
  participant: 'P01',
  eye: 'OD',
  glasses: true,
  targetMm: 400,
  logMAR,
  floorHit: false,
  timestamp: '2026-11-01T09:00:00.000Z',
  ...extra,
});

const near = (actual, expected, eps = 1e-12) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

test('(a) four sessions are not enough: computeBaseline returns null', () => {
  const rows = [0.1, 0.12, 0.08, 0.1].map((v) => sess(v));
  assert.equal(computeBaseline(rows), null);
  assert.equal(BASELINE_N, 5);
});

test('(b) five sessions give mean 0.10 and threshold 0.10', () => {
  const rows = [0.1, 0.12, 0.08, 0.1, 0.1].map((v) => sess(v));
  const base = computeBaseline(rows);
  assert.ok(base);
  assert.equal(base.n, 5);
  near(base.mean, 0.1);
  near(base.sd, Math.sqrt(0.0008 / 4));
  // 1.96 * sd * sqrt(1 + 1/5) is only ~0.030, so the 0.10 floor wins.
  near(base.threshold, MIN_THRESHOLD);
  assert.equal(base.threshold, 0.1);
});

test('(c) a new session at 0.16 is still within the norm', () => {
  const rows = [0.1, 0.12, 0.08, 0.1, 0.1].map((v) => sess(v));
  const base = computeBaseline(rows);
  assert.equal(classify(sess(0.16), base, sess(0.1)), 'within');
});

test('(d) two sessions of 0.34 in a row: single, then persistent', () => {
  const rows = [0.1, 0.12, 0.08, 0.1, 0.1].map((v) => sess(v));
  const base = computeBaseline(rows);

  const first = sess(0.34);
  assert.equal(classify(first, base, sess(0.1)), 'single');

  const second = sess(0.34);
  assert.equal(classify(second, base, first), 'persistent');
});

test('insufficient when the norm is not ready', () => {
  assert.equal(classify(sess(0.2), null, null), 'insufficient');
});

test('not_measurable when there is no number or the test hit the floor', () => {
  const base = computeBaseline([0.1, 0.12, 0.08, 0.1, 0.1].map((v) => sess(v)));
  assert.equal(classify(sess(null), base, null), 'not_measurable');
  assert.equal(classify(sess(undefined), base, null), 'not_measurable');
  assert.equal(classify(sess(0.2, { floorHit: true }), base, null), 'not_measurable');
});

test('a persistent change needs both sessions beyond the band in the same direction', () => {
  const base = computeBaseline([0.1, 0.12, 0.08, 0.1, 0.1].map((v) => sess(v)));
  assert.equal(classify(sess(0.34), base, sess(-0.1)), 'single', 'opposite directions do not count');
  assert.equal(classify(sess(0.34), base, sess(0.34)), 'persistent');
  assert.equal(classify(sess(-0.2), base, sess(-0.2)), 'persistent', 'better than the norm counts too');
  assert.equal(classify(sess(0.34), base, sess(null)), 'single', 'previous session without a number');
});

test('the norm never mixes eyes, corrections or target distances', () => {
  const rows = [
    ...[0.3, 0.31, 0.32, 0.3, 0.3].map((v) => sess(v, { eye: 'OS' })),
    ...[0.1, 0.12, 0.08, 0.1, 0.1].map((v) => sess(v)),
  ];
  const base = computeBaseline(rows, { participant: 'P01', eye: 'OD', glasses: true, targetMm: 400 });
  near(base.mean, 0.1);
  assert.equal(base.n, 5);

  const fourOnly = rows.filter((r) => r.eye === 'OS').slice(0, 4);
  assert.equal(computeBaseline(fourOnly), null);
});

test('the threshold grows when the person own spread is large', () => {
  const rows = [0.0, 0.3, 0.05, 0.35, 0.1].map((v) => sess(v));
  const base = computeBaseline(rows);
  assert.ok(base.threshold > 0.2);
});

test('floor-hit and numberless sessions are skipped, not counted as norm sessions', () => {
  const rows = [
    sess(0.1),
    sess(0.12, { floorHit: true }),
    sess(0.08),
    sess(null),
    sess(0.1),
    sess(0.1),
    sess(0.1),
  ];
  const base = computeBaseline(rows);
  assert.equal(base.n, 5);
  near(base.mean, 0.096);
});

test('normalizeSession accepts the field names used by the other modules', () => {
  const s = normalizeSession({ participantId: 'P02', eye: 'OS', correction: 'none', targetDistanceCm: 40, logMar: 0.2 });
  assert.equal(s.participant, 'P02');
  assert.equal(s.eye, 'OS');
  assert.equal(s.glasses, false);
  assert.equal(s.targetMm, 400);
  assert.equal(s.logMAR, 0.2);
});

test('assessSeries reports the last session and how many are still missing', () => {
  const rows = [0.1, 0.12, 0.08].map((v) => sess(v));
  const a = assessSeries(rows);
  assert.equal(a.baseline, null);
  assert.equal(a.usable, 3);
  assert.equal(a.sessionsNeeded, 2);
  assert.equal(a.detail.state, 'insufficient');

  const full = [0.1, 0.12, 0.08, 0.1, 0.1, 0.34, 0.34].map((v) => sess(v));
  const b = assessSeries(full);
  assert.equal(b.sessionsNeeded, 0);
  assert.equal(b.detail.state, 'persistent');
});