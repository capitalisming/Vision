// AI-assisted (Claude Code), reviewed by a team member.
// All observers here are SYNTHETIC scripted responders, not measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLogmar, runProcedure, buildSession, makeOrientationPicker, MAX_CONSECUTIVE_INVALID,
} from '../src/acuity-test.js';
import { SESSION_COLUMNS, validateSession } from '../src/storage.js';
import { scriptedObserver, manualDistance, noWait } from './helpers.mjs';

globalThis.devicePixelRatio = 1;
const PX = 3.78; // ~96 dpi; logMAR 0.2 @1000 mm is drawable (gap ~1.74 device px)

const run = (present, getDistance = manualDistance(1000), pxPerMm = PX) =>
  runProcedure({ getDistance, pxPerMm, present, wait: noWait });

test('contract formula: start 0.5, 16 correct -> 0.28', () => {
  assert.equal(computeLogmar(0.5, 16), 0.28);
});

test('contract example end to end: descent to 0.5 start; 5,5,4,2 -> logMAR 0.28', async () => {
  const present = scriptedObserver((phase, lm) => {
    if (phase === 'descent') return lm >= 0.4 ? 1 : 0;      // first error at 0.3 -> start 0.5
    return { 0.5: 5, 0.4: 5, 0.3: 4, 0.2: 2 }[lm] ?? 0;
  });
  const r = await run(present);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.lStart, 0.5);
  assert.equal(r.nCorrect, 16);
  assert.equal(r.nTrials, 20);
  assert.equal(r.logmar, 0.28);
  assert.equal(r.floorHit, false);
  const descent = r.trials.filter((t) => t.phase === 'descent');
  assert.deepEqual(descent.map((t) => t.logmar), [1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
  assert.equal(r.trials.filter((t) => t.phase === 'main').length, 20);
});

test('descent error at 1.3 caps the start at 1.3', async () => {
  const present = scriptedObserver((phase, lm) => (phase === 'descent' ? 0 : { 1.3: 5, 1.2: 1 }[lm] ?? 0));
  const r = await run(present);
  assert.equal(r.lStart, 1.3);
  assert.equal(r.logmar, computeLogmar(1.3, 6));
});

test('restart: first main level < 3/5 moves up 0.1 and starts over; old run not counted', async () => {
  const present = scriptedObserver((phase, lm, i) => {
    if (phase === 'descent') return lm >= 0.4;                 // start 0.5
    if (lm === 0.5) return i < 5 ? i < 2 : (i - 5) < 3;       // run 1: 2/5; run 2: 3/5
    if (lm === 0.6) return true;                               // run 2 first level 5/5
    if (lm === 0.4) return (i < 1);                            // 1/5
    return false;
  });
  const r = await run(present);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.lStart, 0.6);
  assert.equal(r.nCorrect, 5 + 3 + 1);
  assert.equal(r.logmar, computeLogmar(0.6, 9)); // 0.52
  assert.equal(r.logmar, 0.52);
  assert.equal(r.trials.filter((t) => t.phase === 'main_discarded').length, 5);
});

test('worse_than_1.3: failing the first main level at 1.3 gives no number', async () => {
  const r = await run(scriptedObserver(() => 0));
  assert.equal(r.outcome, 'worse_than_1.3');
  assert.equal(r.logmar, null);
  const s = buildSession(baseOpts(), r, new Date().toISOString());
  assert.equal(s.logmar, null);
});

test('screen floor: passing the last drawable level gives floor_hit and no number', async () => {
  const r = await run(scriptedObserver((phase) => (phase === 'descent' ? 1 : 5)), manualDistance(400), 2.0);
  assert.equal(r.outcome, 'floor_hit');
  assert.equal(r.floorHit, true);
  assert.equal(r.logmar, null);
  assert.ok(r.trials.every((t) => t.gap_device_px >= 1), 'no undrawable sign was shown');
  assert.match(r.reason, /not better measurable/);
});

test('camera: 5 consecutive invalid trials stop the test with a reason and no number', async () => {
  let calls = 0;
  const getDistance = () => { calls++; return { mm: null, ageMs: 0, ok: false, reason: 'face lost' }; };
  const present = async () => assert.fail('nothing must be shown without a distance');
  const r = await run(present, getDistance);
  assert.equal(r.outcome, 'aborted_camera');
  assert.equal(r.logmar, null);
  assert.equal(r.trials.length, MAX_CONSECUTIVE_INVALID);
  assert.ok(r.trials.every((t) => t.valid === false));
  assert.match(r.reason, /face lost/);
  assert.ok(calls >= MAX_CONSECUTIVE_INVALID);
});

// The next getDistance() call after an answer is the engine's "at answer" reading.
function jumpOnceAfterAnswer(jumpMm, when = () => true) {
  let pending = false;
  const getDistance = () => {
    if (pending) { pending = false; return { mm: jumpMm, ageMs: 0, ok: true, reason: '' }; }
    return { mm: 1000, ageMs: 0, ok: true, reason: '' };
  };
  let used = false;
  const wrap = (inner) => async (spec) => {
    const ans = await inner(spec);
    if (!used && when(spec)) { used = true; pending = true; }
    return ans;
  };
  return { getDistance, wrap };
}

const plan028 = (phase, lm) => (phase === 'descent' ? lm >= 0.4 : ({ 0.5: 5, 0.4: 5, 0.3: 4, 0.2: 2 }[lm] ?? 0));

test('distance change > 10% during a trial: trial repeated, not counted', async () => {
  const j = jumpOnceAfterAnswer(1150, (spec) => spec.phase === 'main');
  // Level 0.5 answers are all correct, so the extra (repeated) presentation does not shift the script.
  const plan = (phase, lm) => (phase === 'main' && lm === 0.5 ? 99 : plan028(phase, lm));
  const r = await run(j.wrap(scriptedObserver(plan)), j.getDistance);
  const invalid = r.trials.filter((t) => !t.valid);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].phase, 'main');
  assert.equal(r.trials.filter((t) => t.valid && t.phase === 'main').length, 20, 'invalid trial was repeated');
  assert.equal(r.nCorrect, 16, 'invalid trial is excluded from N_correct');
  assert.equal(r.logmar, 0.28);
});

test('distance change of exactly 10% is accepted, 10.1% is not', async () => {
  for (const [after, expectInvalid] of [[1100, 0], [1101, 1], [900, 0], [899, 1]]) {
    const j = jumpOnceAfterAnswer(after);
    const r = await run(j.wrap(scriptedObserver(plan028)), j.getDistance);
    assert.equal(r.trials.filter((t) => !t.valid).length, expectInvalid, `after=${after}`);
  }
});

test('stale distance reading counts as no reading', async () => {
  const r = await run(async () => assert.fail('must not show'), () => ({ mm: 1000, ageMs: 5000, ok: true, reason: '' }));
  assert.equal(r.outcome, 'aborted_camera');
  assert.match(r.reason, /stale/);
});

test('display scale change mid-test: trials not counted, no number', async () => {
  let n = 0;
  const displayCheck = () => (++n > 3 ? 'display scale changed' : '');
  const r = await runProcedure({ getDistance: manualDistance(1000), pxPerMm: PX, wait: noWait, displayCheck,
    present: scriptedObserver(() => 1) });
  assert.equal(r.logmar, null);
  assert.notEqual(r.outcome, 'ok');
  assert.equal(r.trials.filter((t) => !t.valid).length, MAX_CONSECUTIVE_INVALID);
  assert.match(r.reason, /display scale changed/);
});

test('Esc aborts: aborted_user, no number', async () => {
  const r = await run(async () => ({ abort: true }));
  assert.equal(r.outcome, 'aborted_user');
  assert.equal(r.logmar, null);
});

test('reaction time, shown and entered direction are recorded per trial', async () => {
  const r = await run(scriptedObserver((phase, lm) => (phase === 'descent' ? lm >= 0.4 : ({ 0.5: 5, 0.4: 5, 0.3: 4, 0.2: 2 }[lm] ?? 0))));
  for (const t of r.trials) {
    assert.equal(t.rt_ms, 500);
    assert.ok(['up', 'down', 'left', 'right'].includes(t.orientation));
    assert.ok(['up', 'down', 'left', 'right'].includes(t.response));
    assert.equal(t.correct, t.orientation === t.response);
    assert.equal(t.distance_mm, 1000);
  }
});

test('orientation picker: all four used, never three identical in a row', () => {
  const pick = makeOrientationPicker();
  const seq = Array.from({ length: 5000 }, pick);
  for (let i = 2; i < seq.length; i++) assert.ok(!(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]));
  const counts = Object.fromEntries(['up', 'down', 'left', 'right'].map((o) => [o, seq.filter((x) => x === o).length]));
  for (const n of Object.values(counts)) assert.ok(n > 1000, `roughly uniform: ${JSON.stringify(counts)}`);
});

function baseOpts() {
  return { participant: 'A', eye: 'OD', glasses: 'no', condition: 'rep', targetMm: 1000, pxPerMm: PX, distanceMode: 'manual' };
}

test('buildSession produces exactly the contract fields plus trials and passes validation', async () => {
  const r = await run(scriptedObserver((phase, lm) => (phase === 'descent' ? lm >= 0.4 : ({ 0.5: 5, 0.4: 5, 0.3: 4, 0.2: 2 }[lm] ?? 0))));
  const s = buildSession(baseOpts(), r, '2026-11-14T15:00:00.000Z');
  assert.deepEqual(Object.keys(s), [...SESSION_COLUMNS, 'trials']);
  assert.deepEqual(validateSession(s), []);
  assert.equal(s.logmar, 0.28);
  assert.equal(s.distance_mode, 'manual');
  assert.equal(s.mean_mm, 1000);
  assert.equal(s.sd_mm, 0);
  assert.ok(s.trials.every((t) => t.session_id === s.session_id));
});
