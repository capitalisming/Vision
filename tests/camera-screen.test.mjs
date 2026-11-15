// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeReason, cameraErrorText, errorPercent } from '../src/camera-screen.js';

test('every reason from distance.js has plain words, unknown ones are shown as they are', () => {
  for (const r of ['no_face', 'two_faces', 'head_turned', 'stale', 'not_calibrated']) {
    assert.match(describeReason(r), /^[A-Z].*[.…]$/, r);
    assert.ok(!describeReason(r).includes('_'), r);
  }
  assert.equal(describeReason('something_new'), 'something_new');
});

test('camera errors become instructions', () => {
  assert.match(cameraErrorText(Object.assign(new Error('x'), { name: 'NotAllowedError' })), /blocking the camera/);
  assert.match(cameraErrorText(new Error('Permission denied')), /blocking the camera/);
  assert.match(cameraErrorText(Object.assign(new Error('x'), { name: 'NotFoundError' })), /No camera/);
  assert.match(cameraErrorText(Object.assign(new Error('x'), { name: 'NotReadableError' })), /Another program/);
  assert.equal(cameraErrorText(new Error('Cannot reach the Pi camera at http://pi:8000: no answer.')),
    'Cannot reach the Pi camera at http://pi:8000: no answer.');
  assert.match(cameraErrorText(new Error('')), /could not be started/);
});

test('error percent is relative to the tape distance', () => {
  assert.equal(errorPercent({ cameraMm: 550, tapeMm: 500 }), 10);
  assert.equal(errorPercent({ cameraMm: 450, tapeMm: 500 }), -10);
});

test('head answers in step 3: off says nothing, practice steps and hints have plain words', async () => {
  const { headStatusText } = await import('../src/camera-screen.js');
  assert.equal(headStatusText({ enabled: false, trained: true }), '');
  assert.match(headStatusText({ enabled: true, trained: false }), /Practise once/);
  assert.match(headStatusText({ enabled: true, trained: true }), /arrow keys and buttons still work/);
  assert.match(headStatusText({ enabled: true, trained: true, camera: false }), /need the camera/);
  for (const state of ['up', 'center', 'left']) {
    assert.match(headStatusText({ enabled: true, trained: false, training: { state, hint: '' } }), /^[A-Z].*\.$/);
  }
  for (const hint of ['no_face', 'only_up_down', 'only_sideways']) {
    assert.ok(!headStatusText({ enabled: true, trained: false, training: { state: 'up', hint } }).includes('_'));
  }
});
