// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progress } from '../src/home-scroll.js';

test('progress is 0 at the top and 1 at the bottom of the page', () => {
  assert.equal(progress(0, 2000, 800), 0);
  assert.equal(progress(1200, 2000, 800), 1);
  assert.equal(progress(600, 2000, 800), 0.5);
});

test('progress is clamped for overscroll', () => {
  assert.equal(progress(-40, 2000, 800), 0);
  assert.equal(progress(1500, 2000, 800), 1);
});

test('progress is 0 when the page does not scroll', () => {
  assert.equal(progress(0, 700, 800), 0);
  assert.equal(progress(0, 800, 800), 0);
});
