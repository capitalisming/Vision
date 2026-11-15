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

test('head answers in step 3: always says the arrows work, practice steps and hints have plain words', async () => {
  const { headStatusText } = await import('../src/camera-screen.js');
  assert.match(headStatusText({ enabled: false, trained: true }), /^Off.*arrow/);
  assert.match(headStatusText({ enabled: true, trained: false }), /practice.*answer with the arrows/);
  assert.match(headStatusText({ enabled: true, trained: true }), /camera does not work, answer with the arrows/);
  assert.match(headStatusText({ enabled: true, trained: true, camera: false }), /need the camera.*arrows/);
  for (const state of ['up', 'center', 'left']) {
    assert.match(headStatusText({ enabled: true, trained: false, training: { state, hint: '' } }), /^[A-Z].*\.$/);
  }
  for (const hint of ['no_face', 'only_up_down', 'only_sideways']) {
    assert.ok(!headStatusText({ enabled: true, trained: false, training: { state: 'up', hint } }).includes('_'));
  }
});

test('camera line during the test: quiet while the face is seen, else the problem and the arrows', async () => {
  const { testCameraStatus } = await import('../src/camera-screen.js');
  assert.equal(testCameraStatus({ reason: null }, true), '');
  assert.equal(testCameraStatus({ reason: 'head_turned' }, true), '', 'a head answer is not a problem');
  assert.match(testCameraStatus({ reason: 'head_turned' }, false), /Turn your head/);
  assert.equal(testCameraStatus({ reason: 'no_face' }, true), 'No face found. Look at the screen. Answer with the arrows.');
  assert.equal(testCameraStatus({ reason: 'no_face' }, false), 'No face found. Look at the screen.');
});
