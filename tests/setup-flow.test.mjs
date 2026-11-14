// AI-assisted (Claude Code), reviewed by a team member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers.mjs';
import { STEPS, stepStatus, firstOpenStep, nextStep, stepSummary, loadSetup, saveSetup } from '../src/setup-flow.js';

const ready = {
  participant: 'A', eye: 'OD', glasses: 'yes', condition: 'self_check',
  hasScreen: true, zoomChanged: false, pxPerMm: 3.7795,
  targetMm: 1000, distanceMode: 'manual', cameraCalibrated: false, cameraLabel: 'this computer',
};

test('a fully set up test has every step done', () => {
  assert.deepEqual(stepStatus(ready), { you: true, screen: true, distance: true });
});

test('each step turns incomplete for its own reason', () => {
  assert.equal(stepStatus({ ...ready, participant: '' }).you, false);
  assert.equal(stepStatus({ ...ready, participant: 'two words' }).you, false);
  assert.equal(stepStatus({ ...ready, eye: '' }).you, false);
  assert.equal(stepStatus({ ...ready, glasses: '' }).you, false);
  assert.equal(stepStatus({ ...ready, condition: '  ' }).you, false);
  assert.equal(stepStatus({ ...ready, hasScreen: false }).screen, false);
  assert.equal(stepStatus({ ...ready, zoomChanged: true }).screen, false);
  assert.equal(stepStatus({ ...ready, targetMm: 150 }).distance, false);
  assert.equal(stepStatus({ ...ready, targetMm: 1000.5 }).distance, false);
});

test('camera distance needs a calibration, tape distance does not', () => {
  assert.equal(stepStatus({ ...ready, distanceMode: 'camera' }).distance, false);
  assert.equal(stepStatus({ ...ready, distanceMode: 'camera', cameraCalibrated: true }).distance, true);
});

test('the first step that is not done opens, an explicit request wins', () => {
  assert.equal(firstOpenStep({ you: false, screen: false, distance: false }), 'you');
  assert.equal(firstOpenStep({ you: true, screen: false, distance: false }), 'screen');
  assert.equal(firstOpenStep({ you: true, screen: true, distance: false }), 'distance');
  assert.equal(firstOpenStep({ you: true, screen: true, distance: true }), 'distance');
  assert.equal(firstOpenStep({ you: true, screen: false, distance: false }, 'you'), 'you');
  assert.equal(firstOpenStep({ you: false, screen: false, distance: false }, 'nonsense'), 'you');
});

test('steps follow each other and end', () => {
  assert.deepEqual(STEPS.map(nextStep), ['screen', 'distance', null]);
});

test('summaries say what was chosen', () => {
  assert.equal(stepSummary('you', ready), 'A · Right eye · Glasses on');
  assert.equal(stepSummary('you', { ...ready, eye: '' }), 'Not set');
  assert.equal(stepSummary('screen', ready), 'Calibrated · 3.78 px/mm');
  assert.equal(stepSummary('screen', { ...ready, hasScreen: false }), 'Not calibrated');
  assert.equal(stepSummary('screen', { ...ready, zoomChanged: true }), 'Zoom changed. Calibrate again');
  assert.equal(stepSummary('distance', ready), 'Tape measure · 1000 mm');
  assert.equal(stepSummary('distance', { ...ready, distanceMode: 'camera' }), 'Camera · this computer · not calibrated');
  assert.equal(stepSummary('distance', { ...ready, distanceMode: 'camera', cameraCalibrated: true }),
    'Camera · this computer · calibrated');
});

test('the last setup is remembered and damaged data is ignored', () => {
  installLocalStorage();
  assert.equal(loadSetup(), null);
  saveSetup({ participant: 'M', eye: 'OS', glasses: 'no', condition: 'rep', targetMm: 1200, distanceMode: 'camera' });
  assert.deepEqual(loadSetup(), { participant: 'M', eye: 'OS', glasses: 'no', condition: 'rep', targetMm: 1200, distanceMode: 'camera' });
  localStorage.setItem('last_setup', '{broken');
  assert.equal(loadSetup(), null);
  localStorage.setItem('last_setup', JSON.stringify({ participant: 'bad code!', eye: 'OD' }));
  assert.equal(loadSetup(), null);
  localStorage.setItem('last_setup', JSON.stringify({ participant: 'A', eye: 'XX', glasses: 'maybe', distanceMode: 'x' }));
  assert.deepEqual(loadSetup(), { participant: 'A', eye: '', glasses: '', condition: '', targetMm: 1000, distanceMode: 'manual' });
});
