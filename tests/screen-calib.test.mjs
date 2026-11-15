// AI-assisted (Claude Code), reviewed by a team member.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getPxPerMm, savePxPerMmFromCardWidth, calibrationDprChanged, CARD_WIDTH_MM } from '../src/screen-calib.js';
import { installLocalStorage } from './helpers.mjs';

let mem;
beforeEach(() => { mem = installLocalStorage(); globalThis.devicePixelRatio = 1; });

test('getPxPerMm() is null before calibration', () => {
  assert.equal(getPxPerMm(), null);
});

test('save computes width / 85.60 and persists under px_per_mm', () => {
  const p = savePxPerMmFromCardWidth(323.5);
  assert.equal(p, 323.5 / CARD_WIDTH_MM);
  assert.equal(getPxPerMm(), p);
  assert.equal(mem.get('px_per_mm'), String(p));
});

test('survives a "reload" (new reads from the same storage)', async () => {
  savePxPerMmFromCardWidth(400);
  const fresh = await import(`../src/screen-calib.js?reload=${Date.now()}`);
  assert.equal(fresh.getPxPerMm(), 400 / 85.6);
});

test('garbage or out-of-range values are not accepted', () => {
  mem.set('px_per_mm', 'abc');
  assert.equal(getPxPerMm(), null);
  mem.set('px_per_mm', '-3');
  assert.equal(getPxPerMm(), null);
  assert.throws(() => savePxPerMmFromCardWidth(10), RangeError);
});

test('zoom change since calibration is detected', () => {
  savePxPerMmFromCardWidth(323.5);
  assert.equal(calibrationDprChanged(), false);
  globalThis.devicePixelRatio = 1.25;
  assert.equal(calibrationDprChanged(), true);
});

test('the card outline never gets wider than the space it is drawn in', async () => {
  const { maxFittingWidth } = await import('../src/screen-calib.js');
  assert.equal(maxFittingWidth(318.7), 318.5, 'phone: the area is the limit, in 0.5 px steps');
  assert.equal(maxFittingWidth(5000), 1200, 'never more than the allowed maximum');
  assert.equal(maxFittingWidth(50), 120, 'never less than the allowed minimum');
  assert.equal(maxFittingWidth(0), 1200, 'unknown space: the allowed maximum');
});
