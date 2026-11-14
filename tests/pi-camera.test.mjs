// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePiUrl, blockedReason } from '../src/pi-camera.js';

const PAGE = 'http://raspberrypi.local:8000';

test('empty address means the page itself came from the Pi', () => {
  assert.equal(normalizePiUrl('', PAGE), PAGE);
  assert.equal(normalizePiUrl('   ', PAGE), PAGE);
});

test('host:port gets http and paths are dropped', () => {
  assert.equal(normalizePiUrl('192.168.1.20:8000', PAGE), 'http://192.168.1.20:8000');
  assert.equal(normalizePiUrl('http://raspberrypi.local:8000/frame', PAGE), 'http://raspberrypi.local:8000');
});

test('nonsense is rejected with an example', () => {
  assert.throws(() => normalizePiUrl('http://', PAGE), /Example: raspberrypi.local:8000/);
});

test('an https page cannot load an http camera; http and localhost pages can', () => {
  assert.match(blockedReason('http://192.168.1.20:8000', 'https://team.github.io/vision/'), /cannot load an http camera/);
  assert.equal(blockedReason('http://192.168.1.20:8000', 'http://localhost:5178/'), '');
  assert.equal(blockedReason(PAGE, `${PAGE}/`), '');
});
