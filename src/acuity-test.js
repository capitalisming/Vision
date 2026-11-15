// AI-assisted (Claude Code), reviewed by a team member.
// Acuity test procedure (module contract "Процедура теста") and scoring.
// runProcedure() is the DOM-free engine; runAcuityTest() wires it to the page.

import { sizeFor, drawLandoltC, screenFloorLogmar, ORIENTATIONS } from './optotype.js';

export const APP_VERSION = '0.1.0';

// Levels are kept as integer tenths of logMAR to avoid floating-point drift (13 = 1.3).
export const START_TENTHS = 13;
export const TRIALS_PER_LEVEL = 5;
export const PASS_CORRECT = 3;
export const DESCENT_ERROR_STEP_UP = 2;      // +0.2 after the first descent error
export const MAX_CONSECUTIVE_INVALID = 5;
export const MAX_DISTANCE_CHANGE = 0.10;     // fraction of the distance at stimulus onset
export const MAX_DISTANCE_AGE_MS = 1000;     // older readings count as "no reading"
export const INVALID_PAUSE_MS = 1000;        // pause after a trial that could not be shown
export const INTER_TRIAL_MS = 250;
export const MONITOR_INTERVAL_MS = 100;
// Answers by head turn: before the next sign, wait (not counted as a trial) until the head is back in the start
// position and the distance can be read again; after this long the next trial runs and is checked as usual.
export const HEAD_READY_POLL_MS = 100;
export const HEAD_READY_TIMEOUT_MS = 5000;
export const HEAD_READY_HINT_MS = 1500; // a quiet hint only when it takes longer than this
const HEAD_FLASH_MS = 200;

const ARROW_TO_ORIENTATION = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

/** Contract formula: logMAR = L_start + 0.1 - 0.02 * N_correct (rounded to 0.001). */
export function computeLogmar(lStart, nCorrect) {
  return Math.round((lStart + 0.1 - 0.02 * nCorrect) * 1000) / 1000;
}

function cryptoRandom() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

/** Uniform random orientation, but never the same one three times in a row. */
export function makeOrientationPicker(random = cryptoRandom) {
  const last = [];
  return () => {
    let o;
    do {
      o = ORIENTATIONS[Math.floor(random() * ORIENTATIONS.length)];
    } while (last.length === 2 && last[0] === o && last[1] === o);
    last.push(o);
    if (last.length > 2) last.shift();
    return o;
  };
}

function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Normalise one getDistance() reading into {ok, mm, reason}. */
export function readDistance(getDistance) {
  let r;
  try {
    r = getDistance();
  } catch (err) {
    return { ok: false, mm: null, reason: `distance module error: ${err?.message ?? err}` };
  }
  if (!r || r.ok !== true || !Number.isFinite(r.mm) || r.mm <= 0) {
    return { ok: false, mm: null, reason: (r && r.reason) || 'no distance reading (face not detected?)' };
  }
  if (Number.isFinite(r.ageMs) && r.ageMs > MAX_DISTANCE_AGE_MS) {
    return { ok: false, mm: null, reason: `distance reading is stale (${Math.round(r.ageMs)} ms old)` };
  }
  return { ok: true, mm: r.mm, reason: '' };
}

/**
 * The test procedure without any DOM.
 * @param {object} deps
 * @param {() => {mm:number|null, ageMs:number, ok:boolean, reason:string}} deps.getDistance
 * @param {number} deps.pxPerMm
 * @param {(spec:{phase:string, logmar:number, orientation:string, sizeCssPx:number}) =>
 *          Promise<{response:string, rtMs:number} | {abort:true}>} deps.present
 * @param {(msg:string) => void} [deps.notify]   human-readable reason for an invalid trial
 * @param {(ms:number) => Promise<void>} [deps.wait]
 * @param {() => number} [deps.random]
 * @param {() => string} [deps.displayCheck]  non-empty reason when sign sizes can no longer be trusted
 * @param {{resetNeutral: () => void, gestureStarted: () => boolean, isNeutral: () => boolean}} [deps.head]
 *   answers by head turn. The distance is checked when the sign is shown and until the head starts to move;
 *   from then on to the end of that trial it is not (turning the head is what changes the eye span). Before the
 *   next sign the procedure waits for the head to come back and the distance to be valid again.
 * @returns {Promise<{outcome:string, logmar:number|null, lStart:number|null, nCorrect:number,
 *           nTrials:number, floorHit:boolean, nearFloor:boolean, reason:string, trials:object[]}>}
 */
export async function runProcedure(deps) {
  const { getDistance, pxPerMm, present } = deps;
  const notify = deps.notify ?? (() => {});
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pick = makeOrientationPicker(deps.random);
  const head = deps.head ?? null;

  const trials = [];
  let consecutiveInvalid = 0;
  let lastGoodMm = null;

  function drawableAt(tenths) {
    const d = readDistance(getDistance);
    const mm = d.ok ? d.mm : lastGoodMm;
    if (mm == null) return false;
    return sizeFor(tenths / 10, mm, pxPerMm).drawable;
  }

  function recordInvalid(phase, tenths, reason, extra = {}) {
    trials.push({
      trial_index: trials.length + 1, phase, logmar: tenths / 10,
      orientation: extra.orientation ?? '', response: extra.response ?? '',
      correct: false, valid: false,
      distance_mm: round(extra.distanceMm, 1), size_css_px: round(extra.sizeCssPx, 3),
      gap_device_px: round(extra.gapDevicePx, 3), rt_ms: round(extra.rtMs, 1),
    });
    consecutiveInvalid += 1;
    notify(`Trial not counted: ${reason}. It will be repeated.`);
    return reason;
  }

  // One presentation. Returns {valid:true, correct} | {valid:false, reason} | {abort:true}.
  async function runTrial(phase, tenths) {
    const logmar = tenths / 10;
    const displayProblem = deps.displayCheck?.() ?? '';
    if (displayProblem) {
      const reason = recordInvalid(phase, tenths, displayProblem);
      await wait(INVALID_PAUSE_MS);
      return { valid: false, reason };
    }
    const d0 = readDistance(getDistance);
    if (!d0.ok) {
      const reason = recordInvalid(phase, tenths, d0.reason);
      await wait(INVALID_PAUSE_MS);
      return { valid: false, reason };
    }
    const sz = sizeFor(logmar, d0.mm, pxPerMm);
    if (!sz.drawable) {
      const reason = recordInvalid(phase, tenths,
        'sign gap would be smaller than one screen pixel at this distance (move back)',
        { distanceMm: d0.mm, sizeCssPx: sz.sizeCssPx, gapDevicePx: sz.gapDevicePx });
      await wait(INVALID_PAUSE_MS);
      return { valid: false, reason };
    }

    const orientation = pick();
    head?.resetNeutral(); // the start position of this sign, taken while the distance is confirmed
    let midTrialProblem = '';
    let headMoved = false; // once true, the distance is not read again in this trial
    const gestureStarted = () => {
      if (!headMoved && head?.gestureStarted()) headMoved = true;
      return headMoved;
    };
    const monitor = setInterval(() => {
      if (midTrialProblem || gestureStarted()) return;
      const d = readDistance(getDistance);
      if (!d.ok) midTrialProblem = d.reason;
      else if (Math.abs(d.mm - d0.mm) / d0.mm > MAX_DISTANCE_CHANGE) {
        midTrialProblem = 'distance changed by more than 10% during the trial';
      }
    }, MONITOR_INTERVAL_MS);
    let ans;
    try {
      ans = await present({ phase, logmar, orientation, sizeCssPx: sz.sizeCssPx });
    } finally {
      clearInterval(monitor);
    }
    if (ans && ans.abort) return { abort: true };

    const moved = gestureStarted(); // asked even when the trial already failed: the wait below depends on it
    let problem = midTrialProblem;
    if (!problem && !moved) {
      const d1 = readDistance(getDistance);
      if (!d1.ok) problem = d1.reason;
      else if (Math.abs(d1.mm - d0.mm) / d0.mm > MAX_DISTANCE_CHANGE) {
        problem = 'distance changed by more than 10% during the trial';
      }
    }
    const extra = {
      orientation, response: ans.response, rtMs: ans.rtMs,
      distanceMm: d0.mm, sizeCssPx: sz.sizeCssPx, gapDevicePx: sz.gapDevicePx,
    };
    let outcome;
    if (problem) {
      outcome = { valid: false, reason: recordInvalid(phase, tenths, problem, extra) };
    } else {
      const correct = ans.response === orientation;
      trials.push({
        trial_index: trials.length + 1, phase, logmar, orientation, response: ans.response,
        correct, valid: true, distance_mm: round(d0.mm, 1), size_css_px: round(sz.sizeCssPx, 3),
        gap_device_px: round(sz.gapDevicePx, 3), rt_ms: round(ans.rtMs, 1),
      });
      consecutiveInvalid = 0;
      lastGoodMm = d0.mm;
      outcome = { valid: true, correct };
    }
    if (moved) await waitHeadReady();
    return outcome;
  }

  // After a head answer: wait until the head is back and the distance valid. Not a trial, so not counted as one.
  async function waitHeadReady() {
    const polls = Math.ceil(HEAD_READY_TIMEOUT_MS / HEAD_READY_POLL_MS);
    let hinted = false;
    for (let i = 0; i < polls; i++) {
      if (head.isNeutral() && readDistance(getDistance).ok) {
        if (hinted) notify('');
        return;
      }
      if (!hinted && (i + 1) * HEAD_READY_POLL_MS >= HEAD_READY_HINT_MS) {
        hinted = true;
        notify('Look straight at the screen again.');
      }
      await wait(HEAD_READY_POLL_MS);
    }
    // Still not back: the next trial checks the distance as usual and is not counted if it is not valid.
  }

  // Repeats until one counted trial, or a stop condition.
  async function countedTrial(phase, tenths) {
    for (;;) {
      const r = await runTrial(phase, tenths);
      if (r.abort) return { stop: { outcome: 'aborted_user', reason: 'stopped by the user' } };
      if (r.valid) return { correct: r.correct };
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID) {
        return {
          stop: {
            outcome: 'aborted_camera',
            reason: `${MAX_CONSECUTIVE_INVALID} trials in a row were not counted; last reason: ${r.reason}`,
          },
        };
      }
    }
  }

  const finish = (fields) => ({
    logmar: null, lStart: null, nCorrect: 0, nTrials: 0, floorHit: false, nearFloor: false,
    reason: '', ...fields, trials,
  });

  // 1. Fast descent: one sign per level from 1.3, -0.1 while correct; +0.2 after the first error.
  let lStartT;
  for (let t = START_TENTHS; ; t--) {
    const r = await countedTrial('descent', t);
    if (r.stop) return finish(r.stop);
    if (!r.correct) { lStartT = Math.min(START_TENTHS, t + DESCENT_ERROR_STEP_UP); break; }
    // Screen floor reached without an error: treat the last level as the turning point.
    if (!drawableAt(t - 1)) { lStartT = Math.min(START_TENTHS, t + DESCENT_ERROR_STEP_UP); break; }
  }

  // 2. Main part: five signs per level, -0.1 per level.
  for (;;) {
    const runStart = trials.length;
    let t = lStartT;
    let nCorrect = 0;
    let nTrials = 0;
    let firstLevel = true;
    let restart = false;

    for (;;) {
      let levelCorrect = 0;
      for (let i = 0; i < TRIALS_PER_LEVEL; i++) {
        const r = await countedTrial('main', t);
        if (r.stop) {
          markDiscarded(runStart);
          return finish(r.stop);
        }
        if (r.correct) levelCorrect += 1;
      }
      nCorrect += levelCorrect;
      nTrials += TRIALS_PER_LEVEL;

      if (firstLevel && levelCorrect < PASS_CORRECT) {
        markDiscarded(runStart);
        if (lStartT >= START_TENTHS) {
          return finish({
            outcome: 'worse_than_1.3',
            reason: `fewer than ${PASS_CORRECT} of ${TRIALS_PER_LEVEL} correct at logMAR 1.3`,
          });
        }
        lStartT += 1;
        restart = true;
        break;
      }
      firstLevel = false;

      if (levelCorrect < PASS_CORRECT) {
        return finish({
          outcome: 'ok', logmar: computeLogmar(lStartT / 10, nCorrect), lStart: lStartT / 10,
          nCorrect, nTrials, nearFloor: nearFloorInRun(runStart),
        });
      }
      if (!drawableAt(t - 1)) {
        return finish({
          outcome: 'floor_hit', lStart: lStartT / 10, nCorrect, nTrials, floorHit: true,
          nearFloor: nearFloorInRun(runStart),
          reason: `passed logMAR ${(t / 10).toFixed(1)}; the next level cannot be drawn on this screen ` +
            'at this distance (not better measurable)',
        });
      }
      t -= 1;
    }
    if (!restart) break;
  }
  throw new Error('unreachable');

  function markDiscarded(from) {
    for (let i = from; i < trials.length; i++) {
      if (trials[i].phase === 'main') trials[i].phase = 'main_discarded';
    }
  }
  function nearFloorInRun(from) {
    return trials.slice(from).some((tr) => tr.valid && tr.phase === 'main' &&
      tr.gap_device_px != null && tr.gap_device_px < 2);
  }
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function meanSd(values) {
  if (!values.length) return { mean: null, sd: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length < 2) return { mean, sd: null };
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return { mean, sd: Math.sqrt(v) };
}

/** Assemble a contract Session object from options and a procedure result. */
export function buildSession(options, result, startedAt, dpr = globalThis.devicePixelRatio || 1) {
  const sessionId = uuid();
  const trials = result.trials.map((t) => ({ session_id: sessionId, ...t }));
  const dists = trials.filter((t) => t.valid && t.distance_mm != null).map((t) => t.distance_mm);
  const { mean, sd } = meanSd(dists);
  return {
    session_id: sessionId,
    started_at: startedAt,
    participant: options.participant,
    eye: options.eye,
    glasses: options.glasses,
    condition: options.condition,
    target_mm: options.targetMm,
    mean_mm: round(mean, 1),
    sd_mm: round(sd, 1),
    distance_mode: options.distanceMode,
    logmar: result.outcome === 'ok' ? result.logmar : null,
    outcome: result.outcome,
    n_trials: result.nTrials,
    n_correct: result.nCorrect,
    floor_hit: result.floorHit,
    near_floor: result.nearFloor,
    screen_floor_logmar: screenFloorLogmar(options.targetMm, options.pxPerMm),
    px_per_mm: options.pxPerMm,
    dpr,
    cam_k: null,
    app_version: APP_VERSION,
    notes: result.reason || '',
    trials,
  };
}

function validateOptions(o) {
  const errs = [];
  if (!o || typeof o !== 'object') throw new TypeError('runAcuityTest: options object required');
  if (!(o.pxPerMm > 0)) errs.push('screen is not calibrated (pxPerMm missing)');
  if (typeof o.getDistance !== 'function') errs.push('getDistance must be a function');
  if (!o.participant) errs.push('participant is required');
  if (!['OD', 'OS', 'OU'].includes(o.eye)) errs.push('eye must be OD, OS or OU');
  if (!['yes', 'no'].includes(o.glasses)) errs.push('glasses must be yes or no');
  if (!(o.targetMm > 0)) errs.push('targetMm must be > 0');
  if (!['manual', 'camera'].includes(o.distanceMode)) errs.push('distanceMode must be manual or camera');
  if (!o.container) errs.push('container element is required');
  if (errs.length) throw new Error(`runAcuityTest: ${errs.join('; ')}`);
}

/**
 * Run the test in `container` and resolve with a Session (contract schema + `trials`).
 * Options per contract: { participant, eye, glasses, condition, targetMm, getDistance, pxPerMm, container }
 * plus distanceMode: 'manual' | 'camera' (written to Session.distance_mode), and optionally
 * headInput: { readDirection(): 'up'|'down'|'left'|'right'|null, resetNeutral(), gestureStarted(): boolean,
 * isNeutral(): boolean } (src/head-gesture.js createHeadInput) to also answer by turning the head. Arrows and
 * buttons work as before; how many answers came by head turn is written to the session notes.
 * camera: { video: HTMLVideoElement, status?: () => string } shows the running camera small above the ring, with
 * status() (what is wrong with the camera right now, '' when nothing) under it. The video is put back where it
 * was when the test ends.
 */
export async function runAcuityTest(options) {
  validateOptions(options);
  const headInput = options.headInput ?? null;
  const camera = options.camera?.video ? options.camera : null;
  const startedAt = new Date().toISOString();
  // pxPerMm is only valid for the zoom level and monitor it was measured on.
  const dprAtStart = window.devicePixelRatio || 1;
  const displayCheck = () => ((window.devicePixelRatio || 1) !== dprAtStart
    ? 'display scale changed since the test started (browser zoom or monitor change); recalibrate the screen'
    : '');
  const root = options.container;
  root.innerHTML = `
    <div class="test-stage">
      ${camera ? '<div class="test-cam"><div class="test-cam-view"></div><p class="test-cam-status"></p></div>' : ''}
      <div class="test-msg" role="alert" aria-live="assertive"></div>
      <canvas class="optotype" aria-label="Landolt C"></canvas>
      <div class="test-pad" role="group" aria-label="Where is the gap in the ring?">
        <button type="button" data-answer="up" aria-label="Gap at the top">↑</button>
        <button type="button" data-answer="left" aria-label="Gap on the left">←</button>
        <button type="button" data-answer="down" aria-label="Gap at the bottom">↓</button>
        <button type="button" data-answer="right" aria-label="Gap on the right">→</button>
      </div>
      <p class="test-help">${headInput
    ? 'Turn your head toward the gap in the ring (up, down, left or right), hold for a moment, then look '
      + 'straight again. If you cannot, or the camera does not work, use the arrows. Guess if unsure.'
    : 'Tap the arrow, or press the arrow key, that points to the gap in the ring. Guess if unsure.'}</p>
      <button type="button" class="test-stop" data-answer="stop">Stop the test (Esc)</button>
    </div>`;
  const canvas = root.querySelector('canvas.optotype');
  const msg = root.querySelector('.test-msg');

  // The camera above the ring: the same <video> the distance is read from, moved here for the test.
  let cameraHome = null;
  let cameraTimer = 0;
  if (camera) {
    const { video } = camera;
    cameraHome = { parent: video.parentNode, next: video.nextSibling, hidden: video.hidden };
    root.querySelector('.test-cam-view').append(video); // a move, not a removal: the stream keeps playing
    video.hidden = false;
    const statusEl = root.querySelector('.test-cam-status');
    const showStatus = () => {
      let text = '';
      try { text = camera.status?.() ?? ''; } catch { text = ''; }
      if (statusEl.textContent !== text) statusEl.textContent = text;
      root.querySelector('.test-cam').classList.toggle('is-warn', Boolean(text));
    };
    showStatus();
    cameraTimer = setInterval(showStatus, 250);
  }
  const blank = () => {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // One input path for keys, clicks and taps. An answer counts only while a sign is shown; a stop request
  // is kept until the next sign, so Esc or Stop pressed in the pause between signs is never lost.
  let pending = null; // { resolve, shownAt } while a sign is on screen
  let stopRequested = false;
  let answers = 0;
  let headAnswers = 0;
  const answer = (response, via = 'key') => {
    if (response === 'stop') {
      stopRequested = true;
      if (pending) { pending.resolve({ abort: true }); pending = null; }
      return;
    }
    if (!pending) return;
    answers += 1;
    if (via === 'head') headAnswers += 1;
    pending.resolve({ response, rtMs: performance.now() - pending.shownAt });
    pending = null;
  };

  // Head answers: polled once per frame while a sign is shown; the arrow it chose lights up briefly.
  let headRaf = 0;
  let flashTimer = 0;
  const confirmArrow = (direction) => {
    const btn = root.querySelector(`.test-pad [data-answer=${direction}]`);
    if (!btn) return;
    clearTimeout(flashTimer);
    root.querySelectorAll('.test-pad .is-confirm').forEach((b) => b.classList.remove('is-confirm'));
    btn.classList.add('is-confirm');
    flashTimer = setTimeout(() => btn.classList.remove('is-confirm'), HEAD_FLASH_MS);
  };
  const pollHead = () => {
    headRaf = 0;
    if (!pending) return;
    const direction = headInput.readDirection();
    if (direction) {
      confirmArrow(direction);
      answer(direction, 'head');
      return;
    }
    headRaf = requestAnimationFrame(pollHead);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); answer('stop'); return; }
    const response = ARROW_TO_ORIENTATION[e.key];
    if (!response) return;
    e.preventDefault(); // the page must never scroll mid-test
    if (!e.repeat) answer(response);
  };
  const onClick = (e) => {
    const btn = e.target.closest('[data-answer]');
    if (btn) answer(btn.dataset.answer);
  };

  async function present(spec) {
    if (stopRequested) return { abort: true };
    drawLandoltC(canvas, spec.sizeCssPx, spec.orientation);
    await nextFrame(); // stimulus is on screen before the clock starts
    const result = stopRequested ? { abort: true }
      : await new Promise((resolve) => {
        pending = { resolve, shownAt: performance.now() };
        if (headInput) pollHead();
      });
    if (headRaf) { cancelAnimationFrame(headRaf); headRaf = 0; }
    blank();
    if (!result.abort) {
      msg.textContent = '';
      await wait(INTER_TRIAL_MS);
    }
    return result;
  }

  window.addEventListener('keydown', onKey, true);
  root.addEventListener('click', onClick);
  try {
    const result = await runProcedure({
      getDistance: options.getDistance,
      pxPerMm: options.pxPerMm,
      present,
      notify: (text) => { msg.textContent = text; },
      wait,
      displayCheck,
      head: headInput,
    });
    const session = buildSession(options, result, startedAt, dprAtStart);
    if (headInput) {
      // The session columns are a fixed contract, so the answer method goes into the notes.
      session.notes = [session.notes, `head-turn answers on (${headAnswers} of ${answers} answers given by head turn)`]
        .filter(Boolean).join('; ');
    }
    return session;
  } finally {
    if (headRaf) cancelAnimationFrame(headRaf);
    clearTimeout(flashTimer);
    clearInterval(cameraTimer);
    if (cameraHome) {
      const { video } = camera;
      if (cameraHome.parent) cameraHome.parent.insertBefore(video, cameraHome.next?.parentNode === cameraHome.parent ? cameraHome.next : null);
      video.hidden = cameraHome.hidden;
    }
    window.removeEventListener('keydown', onKey, true);
    root.removeEventListener('click', onClick);
  }
}
