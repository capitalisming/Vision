// AI-assisted (Claude Code), reviewed by a team member.
// All faces here are SYNTHETIC points, not camera measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  headPose, classifyOffset, createHeadGestureDetector, createHeadInput, createHeadTraining,
  loadHeadSettings, saveHeadSettings, signsFor, withSigns, HEAD_SETTINGS_KEY,
  HEAD_START, HEAD_HOLD_MS, HEAD_DOMINANCE, HEAD_ONSET,
} from '../src/head-gesture.js';
import { evaluateFrame } from '../src/distance.js';
import { installLocalStorage } from './helpers.mjs';

// A face in the raw camera picture: eye span 100 px, nose 45 px below the eye midpoint.
// dx, dy: the nose moved by this share of the eye span (raw picture; +x right, +y down).
function face(dx = 0, dy = 0, { span = 100, cx = 350, cy = 200 } = {}) {
  return {
    right: { x: cx - span / 2, y: cy }, // point 33, subject's right eye: image left in the raw picture
    left: { x: cx + span / 2, y: cy }, // point 263
    nose: { x: cx + dx * span, y: cy + 0.45 * span + dy * span },
  };
}
const pose = (dx, dy, o) => headPose(face(dx, dy, o));

/** Feed `frames` poses every `stepMs`; returns the first direction and the time it came. */
function feed(det, p, { from = 0, stepMs = 33, frames = 20 } = {}) {
  for (let i = 0; i < frames; i++) {
    const t = from + i * stepMs;
    const d = det.update(p, t);
    if (d) return { dir: d, t };
  }
  return { dir: null, t: null };
}

function detectorAtNeutral(options) {
  const det = createHeadGestureDetector(options);
  det.reset();
  det.update(pose(0, 0), 0);
  return det;
}

test('pose: nose against the eye midpoint, in eye spans, independent of distance and position', () => {
  const a = pose(0.1, -0.05);
  assert.ok(Math.abs(a.x - 0.1) < 1e-9);
  assert.ok(Math.abs(a.y - (0.45 - 0.05)) < 1e-9);
  const far = pose(0.1, -0.05, { span: 50, cx: 100, cy: 90 }); // farther away and elsewhere in the picture
  assert.ok(Math.abs(far.x - a.x) < 1e-9 && Math.abs(far.y - a.y) < 1e-9);
  assert.equal(headPose(null), null);
  assert.equal(headPose({ nose: { x: 1, y: 1 }, left: { x: 5, y: 5 }, right: { x: 5, y: 5 } }), null);
});

test('pose: a sideways head tilt (roll) is not read as a turn', () => {
  const f = face(0, 0);
  const ang = (20 * Math.PI) / 180;
  const rot = (p) => ({ x: 350 + (p.x - 350) * Math.cos(ang) - (p.y - 200) * Math.sin(ang),
    y: 200 + (p.x - 350) * Math.sin(ang) + (p.y - 200) * Math.cos(ang) });
  const r = headPose({ nose: rot(f.nose), left: rot(f.left), right: rot(f.right) });
  assert.ok(Math.abs(r.x) < 1e-9);
  assert.ok(Math.abs(r.y - 0.45) < 1e-9);
});

test('each direction: x grows = left, x shrinks = right, y shrinks = up, y grows = down', () => {
  for (const [dx, dy, want] of [[0.12, 0, 'left'], [-0.12, 0, 'right'], [0, -0.12, 'up'], [0, 0.12, 'down']]) {
    const det = detectorAtNeutral();
    assert.equal(feed(det, pose(dx, dy)).dir, want, `${dx},${dy}`);
  }
});

test('threshold: just under the start threshold gives nothing, at it gives an answer', () => {
  assert.equal(feed(detectorAtNeutral(), pose(HEAD_START - 0.005, 0)).dir, null);
  assert.equal(feed(detectorAtNeutral(), pose(-(HEAD_START - 0.005), 0)).dir, null);
  assert.equal(feed(detectorAtNeutral(), pose(HEAD_START + 0.001, 0)).dir, 'left');
  assert.equal(feed(detectorAtNeutral(), pose(0, -(HEAD_START + 0.001))).dir, 'up');
  assert.ok(HEAD_START >= 0.08 && HEAD_START <= 0.10);
});

test('hold: the direction comes only after it was held for HEAD_HOLD_MS', () => {
  const det = detectorAtNeutral();
  const r = feed(det, pose(0.15, 0), { from: 1000, stepMs: 10, frames: 40 });
  assert.equal(r.dir, 'left');
  assert.equal(r.t - 1000, HEAD_HOLD_MS);
  // A short flick (shorter than the hold) and back gives nothing.
  const flick = detectorAtNeutral();
  assert.equal(feed(flick, pose(0.15, 0), { from: 0, stepMs: 30, frames: 6 }).dir, null); // 150 ms
  assert.equal(feed(flick, pose(0, 0), { from: 180, stepMs: 30, frames: 20 }).dir, null);
  // Switching direction in the middle starts the hold over.
  const sw = detectorAtNeutral();
  assert.equal(feed(sw, pose(0.15, 0), { from: 0, stepMs: 30, frames: 5 }).dir, null);
  const r2 = feed(sw, pose(0, 0.15), { from: 150, stepMs: 30, frames: 20 });
  assert.equal(r2.dir, 'down');
  assert.ok(r2.t - 150 >= HEAD_HOLD_MS);
});

test('only once per sign: held longer, the answer is not repeated until reset', () => {
  const det = detectorAtNeutral();
  assert.equal(feed(det, pose(0.15, 0), { frames: 20 }).dir, 'left');
  assert.equal(feed(det, pose(0.15, 0), { from: 700, frames: 20 }).dir, null);
  det.reset();
  det.update(pose(0, 0), 2000);
  assert.equal(feed(det, pose(0, -0.15), { from: 2000, frames: 20 }).dir, 'up');
});

test('dominant axis: the answer axis must move 1.5 times more than the other', () => {
  const s = HEAD_START + 0.03;
  assert.equal(classifyOffset(s, s / HEAD_DOMINANCE), 'left');
  assert.equal(classifyOffset(s, s / HEAD_DOMINANCE + 0.01), null); // diagonal: no answer
  assert.equal(classifyOffset(s, s), null);
  assert.equal(feed(detectorAtNeutral(), pose(0.12, 0.11)).dir, null);
  assert.equal(feed(detectorAtNeutral(), pose(0.06, -0.15)).dir, 'up');
});

test('no face: no answer, and losing the face starts the hold over', () => {
  const det = createHeadGestureDetector();
  det.reset();
  assert.equal(feed(det, null).dir, null);
  assert.equal(det.isNeutral(), false);
  det.update(pose(0, 0), 0); // neutral
  assert.equal(feed(det, pose(0.15, 0), { from: 0, stepMs: 30, frames: 5 }).dir, null); // 120 ms
  det.update(null, 150);
  const r = feed(det, pose(0.15, 0), { from: 180, stepMs: 30, frames: 20 });
  assert.equal(r.dir, 'left');
  assert.ok(r.t - 180 >= HEAD_HOLD_MS, 'the hold started again after the face came back');
});

test('neutral: taken from the first pose after reset; onset and return to neutral', () => {
  const det = createHeadGestureDetector();
  det.reset();
  det.update(pose(0.03, 0.02), 0); // the person sits a little turned: that is their neutral
  assert.equal(det.started, false);
  assert.equal(det.isNeutral(), true);
  det.update(pose(0.03 + HEAD_ONSET - 0.01, 0.02), 30);
  assert.equal(det.started, false);
  det.update(pose(0.03 + HEAD_ONSET + 0.01, 0.02), 60);
  assert.equal(det.started, true);
  assert.equal(det.isNeutral(), false);
  det.update(pose(0.04, 0.02), 90);
  assert.equal(det.isNeutral(), true);
  assert.equal(det.started, true, 'started stays until the next sign');
});

test('flipped signs (from the practice) turn the answers round axis by axis', () => {
  const flipX = detectorAtNeutral({ signs: { x: -1, y: 1 } });
  assert.equal(feed(flipX, pose(0.15, 0)).dir, 'right');
  const flipY = detectorAtNeutral({ signs: { x: 1, y: -1 } });
  assert.equal(feed(flipY, pose(0, -0.15)).dir, 'down');
  assert.equal(feed(detectorAtNeutral({ signs: { x: 1, y: -1 } }), pose(0.15, 0)).dir, 'left');
});

test('head input: polls frames, one direction per sign, no repeat for the same frame', () => {
  let frame = null;
  const input = createHeadInput(() => frame);
  frame = { ...face(0, 0), t: 0 };
  input.resetNeutral();
  assert.equal(input.gestureStarted(), false);
  assert.equal(input.isNeutral(), true);
  let got = null;
  for (let t = 33; t <= 400 && !got; t += 33) {
    frame = { ...face(0, -0.14), t };
    got = input.readDirection();
  }
  assert.equal(got, 'up');
  assert.equal(input.gestureStarted(), true);
  assert.equal(input.readDirection(), null);
  frame = null; // face lost
  assert.equal(input.isNeutral(), false);
  frame = { ...face(0.01, 0), t: 500 };
  assert.equal(input.isNeutral(), true);
});

test('distance.js gives the nose and eye corners of one face, also when the head is turned', () => {
  const W = 640;
  const H = 480;
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[1] = { x: 0.55, y: 0.5, z: 0 };
  lm[33] = { x: 0.45, y: 0.4, z: 0 };
  lm[263] = { x: 0.6, y: 0.4, z: 0 };
  const yaw40 = { data: [1, 0, 0, 0, 0, 1, 0, 0, Math.sin(0.7), 0, Math.cos(0.7), 0, 0, 0, 0, 1] };
  const f = evaluateFrame({ faceLandmarks: [lm], facialTransformationMatrixes: [yaw40] }, W, H);
  assert.equal(f.reason, 'head_turned');
  assert.deepEqual(f.head.nose, { x: 0.55 * W, y: 0.5 * H });
  assert.deepEqual(f.head.right, { x: 0.45 * W, y: 0.4 * H });
  assert.deepEqual(f.head.left, { x: 0.6 * W, y: 0.4 * H });
  assert.equal(evaluateFrame({ faceLandmarks: [] }, W, H).head, null);
  assert.equal(evaluateFrame({ faceLandmarks: [lm, lm] }, W, H).head, null);
});

// Practice: up, back to the middle, left. Each held for the hold time.
function runTraining(upDy, leftDx) {
  const tr = createHeadTraining();
  let t = 0;
  let r;
  const hold = (p, ms = 300) => { for (const end = t + ms; t <= end; t += 30) r = tr.update(p, t); };
  hold(pose(0, 0), 60);
  hold(pose(0, upDy));
  assert.equal(r.state, 'center');
  hold(pose(0, 0), 60);
  assert.equal(r.state, 'left');
  hold(pose(leftDx, 0));
  return r;
}

test('practice: expected directions keep the signs', () => {
  const r = runTraining(-0.14, 0.14);
  assert.equal(r.state, 'done');
  assert.deepEqual(r.signs, { x: 1, y: 1 });
});

test('practice: an axis that comes out the other way is flipped by itself', () => {
  assert.deepEqual(runTraining(-0.14, -0.14).signs, { x: -1, y: 1 }); // mirrored camera
  assert.deepEqual(runTraining(0.14, 0.14).signs, { x: 1, y: -1 });
  assert.deepEqual(runTraining(0.14, -0.14).signs, { x: -1, y: -1 });
});

test('practice: the wrong axis, or no face, gives a hint and does not count', () => {
  const tr = createHeadTraining();
  tr.update(pose(0, 0), 0);
  let r;
  for (let t = 30; t < 600; t += 30) r = tr.update(pose(0.15, 0), t); // sideways while "up" is asked
  assert.equal(r.state, 'up');
  assert.equal(r.hint, 'only_up_down');
  r = tr.update(null, 630);
  assert.equal(r.hint, 'no_face');
  assert.equal(r.signs, null);
});

test('settings: on by default, own key, per camera, damaged value is ignored', () => {
  const m = installLocalStorage();
  assert.deepEqual(loadHeadSettings(), { enabled: true, signs: {} });
  saveHeadSettings({ enabled: false, signs: {} });
  assert.equal(loadHeadSettings().enabled, false, 'switched off stays off');
  let s = withSigns({ enabled: true, signs: {} }, 'pi:https://pi:8000', { x: -1, y: 1 });
  s = withSigns(s, '', { x: 1, y: 7 });
  saveHeadSettings(s);
  assert.deepEqual([...m.keys()], [HEAD_SETTINGS_KEY]);
  const back = loadHeadSettings();
  assert.equal(back.enabled, true);
  assert.deepEqual(signsFor(back, 'pi:https://pi:8000'), { x: -1, y: 1 });
  assert.deepEqual(signsFor(back, ''), { x: 1, y: 1 });
  assert.equal(signsFor(back, 'dev:other'), null);
  localStorage.setItem(HEAD_SETTINGS_KEY, '{broken');
  assert.deepEqual(loadHeadSettings(), { enabled: true, signs: {} });
});
