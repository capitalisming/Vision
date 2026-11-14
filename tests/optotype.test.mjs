// AI-assisted (Claude Code), reviewed by a team member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeFor, screenFloorLogmar, MIN_GAP_DEVICE_PX, NEAR_FLOOR_DEVICE_PX } from '../src/optotype.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ± ${tol}`);

test('contract check value: logMAR 0.0 at 400 mm', () => {
  globalThis.devicePixelRatio = 1;
  const s = sizeFor(0.0, 400, 4);
  close(s.gapMm, 0.1164, 0.00005, 'gapMm');
  close(s.sizeMm, 0.582, 0.0005, 'sizeMm');
});

test('contract check value: logMAR 1.0 at 1000 mm', () => {
  globalThis.devicePixelRatio = 1;
  const s = sizeFor(1.0, 1000, 4);
  close(s.gapMm, 2.909, 0.0005, 'gapMm');
  close(s.sizeMm, 14.54, 0.005, 'sizeMm');
  close(s.sizeCssPx, 14.5444 * 4, 0.01, 'sizeCssPx = sizeMm * pxPerMm');
});

test('named thresholds', () => {
  assert.equal(MIN_GAP_DEVICE_PX, 1);
  assert.equal(NEAR_FLOOR_DEVICE_PX, 2);
});

test('gapDevicePx uses devicePixelRatio; drawable / nearFloor boundaries', () => {
  // Pick pxPerMm so that gapMm * pxPerMm == exactly 1 CSS px at logMAR 0, 400 mm.
  const gap = sizeFor(0, 400, 1).gapMm;
  globalThis.devicePixelRatio = 1;
  let s = sizeFor(0, 400, 1 / gap);
  close(s.gapDevicePx, 1, 1e-9, 'gapDevicePx at dpr 1');
  assert.equal(s.drawable, true, 'gap == 1 device px is drawable');
  assert.equal(s.nearFloor, true, 'gap 1 < 2 is near floor');

  s = sizeFor(0, 400, 0.999 / gap);
  assert.equal(s.drawable, false, 'gap < 1 device px is not drawable');

  globalThis.devicePixelRatio = 2;
  s = sizeFor(0, 400, 1 / gap);
  close(s.gapDevicePx, 2, 1e-9, 'gapDevicePx at dpr 2');
  assert.equal(s.nearFloor, false, 'gap == 2 device px is not near floor');
  assert.equal(s.sizeCssPx, sizeFor(0, 400, 1 / gap).sizeCssPx, 'CSS size does not depend on dpr');
  globalThis.devicePixelRatio = 1;
});

test('rejects invalid input', () => {
  assert.throws(() => sizeFor(0, 0, 4), RangeError);
  assert.throws(() => sizeFor(0, 400, 0), RangeError);
  assert.throws(() => sizeFor(NaN, 400, 4), TypeError);
});

test('screenFloorLogmar returns the smallest drawable 0.1 level', () => {
  globalThis.devicePixelRatio = 1;
  const px = 1 / 0.113; // 0.113 mm pixel, as in the plan's example
  const f1000 = screenFloorLogmar(1000, px);
  assert.equal(sizeFor(f1000, 1000, px).drawable, true);
  assert.equal(sizeFor(f1000 - 0.1, 1000, px).drawable, false);
  const f400 = screenFloorLogmar(400, px);
  assert.ok(f400 > f1000, 'closer distance gives a higher (worse) floor');
  console.log(`  screen floor @0.113 mm px, dpr 1: 1000 mm -> ${f1000}, 400 mm -> ${f400}`);
});
