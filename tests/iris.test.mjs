// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ringNoise, irisPixel, renderIris } from '../src/iris.js';

test('ringNoise stays in [0, 1] and has no seam at the end of the angular period', () => {
  for (let i = 0; i < 500; i++) {
    const v = ringNoise(i * 0.37, i * 0.11, 90, 5);
    assert.ok(v >= 0 && v <= 1, String(v));
  }
  assert.equal(ringNoise(0, 2.3, 90, 5), ringNoise(90, 2.3, 90, 5));
});

test('iris is transparent outside the disc, opaque and grey inside', () => {
  const out = [0, 0, 0, 0];
  assert.equal(irisPixel(1, 0.3, 1, out)[3], 0);
  irisPixel(0.6, 0.3, 1, out);
  assert.equal(out[3], 255);
  assert.ok(out[0] === out[1] && out[1] === out[2], 'colour comes from the CSS tint, not the texture');
});

test('rendering is deterministic per seed and differs between seeds', () => {
  const a = renderIris(24, 1);
  assert.deepEqual(a, renderIris(24, 1));
  assert.notDeepEqual(a, renderIris(24, 2));
  assert.equal(a.length, 24 * 24 * 4);
  assert.equal(a[3], 0, 'corner pixel is outside the disc');
});
