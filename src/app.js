// AI-assisted (Claude Code), reviewed by a team member.
// Application shell: screen switching, session setup, test run, result, session list and export.

import { getPxPerMm, mountScreenCalibration, calibrationDprChanged } from './screen-calib.js';
import { screenFloorLogmar } from './optotype.js';
import { runAcuityTest } from './acuity-test.js';
import { paintIris } from './iris.js';
import { initHomeScroll } from './home-scroll.js';
import { connectPiCamera, normalizePiUrl } from './pi-camera.js';
import { loadCameraSettings, saveCameraSettings, cameraId, describeCamera } from './camera-source.js';
import { STEPS, stepStatus, firstOpenStep, nextStep, stepSummary, loadSetup, saveSetup, suggestDistance, NEAR_MM, FAR_MM } from './setup-flow.js';
import { renderTrend } from './ui-trend.js';
import { createHeadInput, loadHeadSettings, signsFor, DEFAULT_HEAD_SIGNS } from './head-gesture.js';
import { renderAction } from './ui-action.js';
import { toBaselineSessions, latestAction } from './trend-data.js';
import { whyThisTestElement } from './why-text.js';
import { listSessions, saveSession, deleteSession, exportCsv, exportJson, importJson } from './storage.js';

const state = {
  screen: 'screen-home',
  testRunning: false,
  lastSession: null,
  distance: null, // participant 2's src/distance.js module, loaded on first camera-mode session
  camera: loadCameraSettings(), // which camera measures the distance: this computer or a Raspberry Pi
  piCamera: null, // the running Raspberry Pi feed, if any
  cameraUi: null, // src/camera-screen.js, loaded when the camera step is first shown
  pendingStep: null, // step of the Test flow that a link asked for
  setupPrefilled: false,
  distanceChosen: false, // the user (or the last test) picked the distance; stop suggesting one
};

const $ = (sel, root = document) => root.querySelector(sel);

// Scroll story of the home iris; call the returned function whenever Home is shown.
const syncHomeScroll = initHomeScroll($('#screen-home'), () => state.screen === 'screen-home');

// ---------- errors ----------

function showError(message) {
  const el = $('#app-error');
  el.textContent = message;
  el.hidden = false;
}
function clearError() { $('#app-error').hidden = true; }

window.addEventListener('error', (e) => showError(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showError(`Error: ${e.reason?.message ?? e.reason}`));

// ---------- navigation ----------

const enterHandlers = {
  'screen-home': renderHome,
  'screen-log': renderLog,
  'screen-progress': enterProgress,
  'screen-setup': enterSetup,
  'screen-result': renderResult,
};

function show(id) {
  if (state.testRunning && id !== 'screen-test') return; // no navigation away from a running test
  const target = document.getElementById(id);
  if (!target) throw new Error(`Unknown screen ${id}`);
  document.querySelectorAll('main > .screen').forEach((s) => { s.hidden = s !== target; });
  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.classList.toggle('active', Boolean(b.closest('nav')) && b.dataset.nav === id);
  });
  document.title = `${target.dataset.title} · Vision self-check`;
  if (id !== 'screen-setup' && id !== 'screen-test') leaveDistanceStep(); // no camera running in the background
  state.screen = id;
  window.scrollTo(0, 0); // every screen starts at its top
  clearError();
  enterHandlers[id]?.();
  if (id === 'screen-home') syncHomeScroll();
  document.dispatchEvent(new CustomEvent('app:screen-enter', { detail: { id } }));
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    state.pendingStep = nav.dataset.step ?? null; // e.g. "Recalibrate" opens the screen step
    show(nav.dataset.nav);
  }
});

// ---------- home ----------

function fmtLogmar(s) {
  if (s.outcome === 'ok') return s.logmar.toFixed(2);
  if (s.outcome === 'floor_hit') return `better than ${(s.screen_floor_logmar ?? NaN).toFixed(1)}`;
  return '—';
}

// The form calls manual mode "Tape"; the stored value stays 'manual'.
const MODE_TEXT = { manual: 'tape', camera: 'camera' };

// Colour of the outcome text; anything not listed is a session without a result.
const OUTCOME_TONE = { ok: 'is-ok', floor_hit: 'is-warn', 'worse_than_1.3': 'is-warn' };
const OUTCOME_SHORT = {
  ok: 'Measured', floor_hit: 'Beyond screen', 'worse_than_1.3': 'Worse than 1.3',
  aborted_camera: 'No distance', aborted_user: 'Stopped',
};

/** Score of a session as short text: "0.52", "<0.1" (better than the screen floor) or null when there is none. */
function scoreText(s) {
  if (s.outcome === 'ok') return s.logmar.toFixed(2);
  if (s.outcome === 'floor_hit' && s.screen_floor_logmar != null) return `<${s.screen_floor_logmar.toFixed(1)}`;
  return null;
}

/** Show `value` in a facts cell, with an optional unit drawn by CSS from data-unit. */
function setFact(el, value, unit) {
  el.textContent = value;
  if (unit) el.dataset.unit = unit; else delete el.dataset.unit;
}

function renderHome() {
  const p = getPxPerMm();
  const zoomChanged = Boolean(p) && calibrationDprChanged();
  const ready = Boolean(p) && !zoomChanged;

  $('[data-stat=state]').textContent = !p ? 'Calibrate the screen once before your first test.'
    : zoomChanged ? 'Browser zoom changed. Calibrate the screen again.'
      : 'Screen calibrated. Ready when you are.';
  const primary = $('[data-role=primary]');
  primary.textContent = ready ? 'Start test' : 'Set up';
  setFact($('[data-stat=pxmm]'), p ? p.toFixed(2) : '—', p ? 'px/mm' : '');
  $('[data-stat=calib-link]').textContent = p ? 'Recalibrate' : 'Calibrate';

  let sessions;
  try {
    sessions = listSessions();
  } catch (err) {
    showError(err.message);
    return;
  }
  $('[data-stat=count]').textContent = String(sessions.length);
  const last = sessions.filter((x) => scoreText(x) != null).at(-1); // latest test that has a score
  setFact($('[data-stat=last]'), last ? scoreText(last) : '—', last ? 'logMAR' : '');
  $('[data-stat=last-sub]').textContent = last
    ? `${last.participant} · ${last.eye} · ${new Date(last.started_at).toLocaleDateString()}`
    : 'No measured test yet';
}

// ---------- log ----------

function renderLog() {
  const tbody = $('table.sessions tbody');
  tbody.textContent = '';
  let sessions;
  try {
    sessions = listSessions();
  } catch (err) {
    showError(err.message);
    return;
  }
  if (!sessions.length) {
    const td = tbody.insertRow().insertCell();
    td.colSpan = 7;
    td.className = 'empty';
    td.textContent = 'No tests yet. Start your first test and it will appear here.';
    return;
  }
  const columns = [
    ['participant', (s) => s.participant], ['eye', (s) => s.eye], ['glasses', (s) => s.glasses],
    ['outcome', (s) => OUTCOME_SHORT[s.outcome] ?? s.outcome], ['logmar', fmtLogmar],
  ];
  for (const s of [...sessions].reverse()) {
    const tr = tbody.insertRow();
    const when = new Date(s.started_at).toLocaleString();
    const started = tr.insertCell();
    started.className = 'c-started';
    started.append(when, Object.assign(document.createElement('small'), {
      textContent: `${s.condition} · ${MODE_TEXT[s.distance_mode] ?? s.distance_mode}`,
    }));
    for (const [key, value] of columns) {
      const td = tr.insertCell();
      td.className = key === 'outcome' ? `c-outcome ${OUTCOME_TONE[s.outcome] ?? 'is-stop'}` : `c-${key}`;
      td.textContent = value(s);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link danger';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', `Delete session ${s.participant} ${s.eye}, ${when}`);
    del.addEventListener('click', () => {
      if (confirm(`Delete session ${s.participant} ${s.eye}, ${when}? This cannot be undone.`)) {
        deleteSession(s.session_id);
        renderLog();
      }
    });
    const actions = tr.insertCell();
    actions.className = 'c-actions';
    actions.append(del);
  }
}

function download(name, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

$('[data-action=export-csv]').addEventListener('click', () => {
  const files = exportCsv();
  download('sessions.csv', files['sessions.csv'], 'text/csv');
  // Second download is deferred slightly; some browsers drop two clicks in one task.
  setTimeout(() => download('trials.csv', files['trials.csv'], 'text/csv'), 300);
  $('.io-status').textContent = `Exported ${listSessions().length} sessions.`;
});
$('[data-action=export-json]').addEventListener('click', () => {
  download(`sessions-${stamp()}.json`, exportJson(), 'application/json');
});
$('[data-action=import-json]').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = importJson(await file.text());
    $('.io-status').textContent = `Imported ${r.added}, skipped ${r.skipped}.` +
      (r.errors.length ? ` Problems: ${r.errors.slice(0, 3).join(' | ')}` : '');
    renderLog();
  } catch (err) {
    $('.io-status').textContent = '';
    showError(err.message);
  }
});

// ---------- the Test flow: three steps ----------

const CODE_RE = /^[A-Za-z0-9_-]{1,16}$/;
const form = $('#setup-form'); // empty on purpose: the fields belong to it through their form attribute
const wizard = $('#wizard');
let openedStep = null;
let cameraMountToken = 0; // a newer mount, or leaving the step, cancels one that is still loading

function readForm() {
  const fd = new FormData(form);
  return {
    participant: String(fd.get('participant') ?? '').trim(),
    eye: fd.get('eye'),
    glasses: fd.get('glasses'),
    condition: String(fd.get('condition') ?? '').trim(),
    targetMm: Number(fd.get('targetMm')),
    distanceMode: fd.get('distanceMode'),
  };
}

function validateSetup(v, pxPerMm) {
  const errs = [];
  if (!pxPerMm) errs.push('The screen is not calibrated. Do it in step 2.');
  if (!CODE_RE.test(v.participant)) errs.push('Participant code: 1–16 letters, digits, _ or -.');
  if (!['OD', 'OS', 'OU'].includes(v.eye)) errs.push('Choose the eye.');
  if (!['yes', 'no'].includes(v.glasses)) errs.push('Choose glasses on or off.');
  if (!v.condition || v.condition.length > 40 || /[\r\n]/.test(v.condition)) errs.push('Condition label is required (max 40 characters).');
  if (!Number.isInteger(v.targetMm) || v.targetMm < 200 || v.targetMm > 6000) errs.push('Distance must be a whole number of mm between 200 and 6000.');
  if (!['manual', 'camera'].includes(v.distanceMode)) errs.push('Choose how the distance is measured.');
  return errs;
}

function updateFloorHint() {
  const p = getPxPerMm();
  const mm = Number($('[name=targetMm]').value);
  const hint = $('[data-role=floor-hint]');
  if (!p) { hint.textContent = 'Calibrate the screen first (step 2).'; return; }
  if (!(mm > 0)) { hint.textContent = ''; return; }
  const floor = screenFloorLogmar(mm, p);
  if (floor == null) {
    hint.textContent = 'At this distance even logMAR 1.3 cannot be drawn on this screen.';
  } else if (floor > 0) {
    // Normal vision is logMAR 0.0: if the screen cannot draw it, good eyes only ever get "Beyond screen".
    hint.textContent = `This screen can only show signs down to logMAR ${floor.toFixed(1)} at ${mm} mm, so good eyes will ` +
      'read "Beyond screen" and get no number. Sit farther (Far · 1 m) or use a screen with more pixels.';
  } else {
    hint.textContent = `This screen can show signs down to logMAR ${floor.toFixed(1)} at ${mm} mm. Finer than that is logged as "Beyond screen".`;
  }
}

/** Suggest 40 cm or 1 m for this screen (see suggestDistance) and say why, until the user picks a distance. */
function suggestForScreen() {
  const p = getPxPerMm();
  const floorAt = (mm) => (p ? screenFloorLogmar(mm, p) : null);
  const suggested = p ? suggestDistance(floorAt) : NEAR_MM;
  if (!state.distanceChosen) {
    $('[name=targetMm]').value = String(suggested);
    syncDistancePreset();
    updateFloorHint();
  }
  const near = floorAt(NEAR_MM);
  $('[data-role=distance-why]').textContent = suggested === FAR_MM
    ? (near == null
      ? '1 m is suggested: at 40 cm this screen cannot draw the test signs.'
      : `1 m is suggested: at 40 cm this screen can only show logMAR ${near.toFixed(1)}, so good near vision would read "Beyond screen". `
        + 'Near vision matters because a hyperopic shift in space makes close-up vision worse (see Why this test on Home).')
    : 'Near is suggested: a hyperopic shift in space makes close-up vision worse (see Why this test on Home).';
}

/** Keep the Near / Far / Other choice in step with the distance field. */
function syncDistancePreset() {
  const mm = $('[name=targetMm]').value;
  const value = mm === '400' || mm === '1000' ? mm : 'custom';
  wizard.querySelector(`[name=distancePreset][value="${value}"]`).checked = true;
}

/** Everything the three steps know, in the shape src/setup-flow.js expects. */
function setupData() {
  const v = readForm();
  const p = getPxPerMm();
  let cameraLabel;
  try {
    cameraLabel = describeCamera(state.camera, location.origin);
  } catch {
    cameraLabel = 'Raspberry Pi (address needed)';
  }
  return {
    ...v,
    hasScreen: Boolean(p),
    zoomChanged: Boolean(p) && calibrationDprChanged(),
    pxPerMm: p ?? 0,
    cameraLabel,
    cameraCalibrated: Boolean(state.distance && CODE_RE.test(v.participant) && state.distance.getK(v.participant)),
  };
}

/** Bring headers, summaries and buttons in line with what the fields say now. */
function refreshWizard() {
  const d = setupData();
  const status = stepStatus(d);
  for (const step of STEPS) {
    const li = wizard.querySelector(`[data-step=${step}]`);
    li.classList.toggle('is-done', status[step]);
    li.classList.toggle('is-open', step === openedStep);
    li.querySelector('.wz-head').setAttribute('aria-expanded', String(step === openedStep));
    li.querySelector('.wz-sum').textContent = stepSummary(step, d, status);
    const next = li.querySelector('[data-act=continue]');
    if (next) next.disabled = !status[step];
  }
  $('[data-role=distance-label]').textContent = d.distanceMode === 'camera'
    ? 'Distance to sit at, mm' : 'Distance to the screen, mm (measure it with a tape)';
}

function openStep(step, { scroll = false } = {}) {
  if (step === openedStep) return;
  if (openedStep === 'distance') leaveDistanceStep();
  openedStep = step;
  refreshWizard();
  if (step === 'screen') {
    mountScreenCalibration($('[data-body=screen]'), { onSaved: () => { renderHome(); suggestForScreen(); refreshWizard(); } });
  } else if (step === 'distance') {
    updateFloorHint();
    mountDistanceStep();
  }
  if (scroll) wizard.querySelector(`[data-step=${step}]`).scrollIntoView({ block: 'start' });
}

function prefillSetup() {
  const saved = loadSetup();
  if (!saved) return;
  for (const name of ['participant', 'condition', 'targetMm']) {
    if (saved[name] !== '') wizard.querySelector(`[name=${name}]`).value = saved[name];
  }
  state.distanceChosen = true; // the last test's distance; keeps the baseline conditions the same
  for (const name of ['eye', 'glasses', 'distanceMode']) {
    const radio = saved[name] && wizard.querySelector(`[name=${name}][value=${saved[name]}]`);
    if (radio) radio.checked = true;
  }
}

function enterSetup() {
  if (!state.setupPrefilled) {
    prefillSetup();
    state.setupPrefilled = true;
  }
  suggestForScreen();
  syncDistancePreset();
  $('.form-errors').textContent = '';
  openedStep = null;
  const requested = state.pendingStep;
  state.pendingStep = null;
  const open = () => {
    if (state.screen === 'screen-setup') openStep(firstOpenStep(stepStatus(setupData()), requested));
  };
  // Whether the camera is calibrated is known only to src/distance.js; load it before choosing the step.
  if (wizard.querySelector('[name=distanceMode]:checked').value === 'camera') prepareCamera().then(open, open);
  else open();
}

wizard.addEventListener('click', (e) => {
  const head = e.target.closest('.wz-head');
  if (head) openStep(head.parentElement.dataset.step, { scroll: true });
  const next = e.target.closest('[data-act=continue]');
  if (next) openStep(nextStep(next.closest('[data-step]').dataset.step), { scroll: true });
});

wizard.addEventListener('input', (e) => {
  $('.form-errors').textContent = ''; // old errors describe the previous submit
  if (e.target.name === 'targetMm') {
    state.distanceChosen = true;
    updateFloorHint();
    syncDistancePreset();
  }
  refreshWizard();
});

wizard.addEventListener('change', (e) => {
  if (e.target.name === 'distanceMode' && openedStep === 'distance') mountDistanceStep();
  if (e.target.name === 'distancePreset') state.distanceChosen = true;
  if (e.target.name === 'distancePreset' && e.target.value !== 'custom') {
    $('[name=targetMm]').value = e.target.value;
    updateFloorHint();
    refreshWizard();
  }
  if (e.target.name === 'distancePreset' && e.target.value === 'custom') $('[name=targetMm]').focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = readForm();
  const pxPerMm = getPxPerMm();
  const errs = validateSetup(v, pxPerMm);
  if (v.distanceMode === 'camera' && !setupData().cameraCalibrated) errs.push('The camera is not calibrated yet. Do it in step 3.');
  const list = $('.form-errors');
  list.textContent = '';
  for (const m of errs) list.append(Object.assign(document.createElement('li'), { textContent: m }));
  if (errs.length) {
    openStep(firstOpenStep(stepStatus(setupData())));
    list.scrollIntoView({ block: 'nearest' });
    return;
  }
  saveSetup(v);
  leaveDistanceStep();
  await startTest({ ...v, pxPerMm });
});

// ---------- test ----------

async function loadDistanceModule() {
  if (state.distance) return state.distance;
  let mod;
  try {
    mod = await import('./distance.js');
  } catch (err) {
    throw new Error(`Camera mode is not available: src/distance.js could not be loaded (${err.message}). Use manual mode.`);
  }
  state.distance = mod;
  return mod;
}

async function startTest(v) {
  let getDistance;
  let cameraMod = null;
  let headInput = null;
  let headPractised = false;
  let camera = null;
  if (v.distanceMode === 'manual') {
    const mm = v.targetMm;
    getDistance = () => ({ mm, ageMs: 0, ok: true, reason: '' });
  } else {
    try {
      cameraMod = await prepareCamera();
      if (!cameraMod.getK(v.participant)) {
        throw new Error(`There is no distance calibration for ${v.participant} with ${describeCamera(state.camera, location.origin)}. ` +
          'Calibrate on the Camera screen first.');
      }
      cameraMod.setParticipant(v.participant);
      await cameraMod.startDistance($('#camera-video'));
      getDistance = () => cameraMod.getDistance(v.participant);
      // Answers by head turn: camera mode only, on unless switched off in step 3. Without the practice in step 3
      // the directions of the raw camera picture are used (noted in the session).
      const head = loadHeadSettings();
      if (head.enabled) {
        const signs = signsFor(head, cameraId(state.camera, location.origin));
        headPractised = Boolean(signs);
        headInput = createHeadInput(cameraMod.getHeadLandmarks, signs ?? DEFAULT_HEAD_SIGNS);
      }
      // The camera is shown small above the ring, with what is wrong with it right now.
      const ui = await import('./camera-screen.js');
      camera = {
        video: $('#camera-video'),
        status: () => ui.testCameraStatus(cameraMod.getDistance(v.participant), Boolean(headInput)),
      };
    } catch (err) {
      stopCamera();
      const ui = await import('./camera-screen.js');
      showError(ui.cameraErrorText(err)); // Failure D: no camera data, no test, no number.
      return;
    }
  }

  show('screen-test');
  state.testRunning = true;
  document.body.classList.add('testing');
  let session;
  try {
    session = await runAcuityTest({
      participant: v.participant, eye: v.eye, glasses: v.glasses, condition: v.condition,
      targetMm: v.targetMm, getDistance, pxPerMm: v.pxPerMm, container: $('#test-root'),
      distanceMode: v.distanceMode,
      ...(headInput ? { headInput } : {}),
      ...(camera ? { camera } : {}),
    });
  } catch (err) {
    state.testRunning = false;
    document.body.classList.remove('testing');
    stopCamera();
    show('screen-setup');
    showError(`The test could not run: ${err.message}`);
    return;
  }
  state.testRunning = false;
  document.body.classList.remove('testing');
  stopCamera();
  if (headInput && !headPractised) {
    session.notes = [session.notes, 'head-turn directions not practised with this camera (default directions)']
      .filter(Boolean).join('; ');
  }
  if (cameraMod) {
    session.cam_k = cameraMod.getK(v.participant); // the calibration this distance was measured with
    const method = cameraMod.getCalibrationMethod(v.participant);
    // The session columns are a fixed contract, so how the camera was calibrated goes into the notes.
    if (method === 'auto' || method === 'auto_focal') {
      session.notes = [session.notes, method === 'auto'
        ? 'camera distance from automatic calibration (estimate, field of view assumed)'
        : 'camera distance from automatic calibration (camera focal length measured with a tape)']
        .filter(Boolean).join('; ');
    }
  }

  try {
    saveSession(session);
  } catch (err) {
    showError(`The session could not be saved: ${err.message}`);
  }
  state.lastSession = session;
  show('screen-result');
}

// ---------- camera ----------

function stopPiCamera() {
  state.piCamera?.stop();
  state.piCamera = null;
}

/** Let go of every camera: the distance tracking (webcam or Pi stream) and the Pi feed behind it. */
function stopCamera() {
  state.distance?.stopDistance();
  stopPiCamera();
}

// How a Raspberry Pi stream gets into a <video>; handed to src/distance.js as its camera provider.
async function piProvider(videoEl) {
  stopPiCamera();
  videoEl.srcObject?.getTracks?.().forEach((track) => track.stop()); // let go of the webcam if it was in use
  state.piCamera = await connectPiCamera(videoEl, normalizePiUrl(state.camera.piUrl, location.origin));
}

/** Load src/distance.js and tell it which camera to use; returns the module. */
async function prepareCamera() {
  const mod = await loadDistanceModule();
  const id = cameraId(state.camera, location.origin); // throws for an invalid Pi address
  mod.setCameraProvider(state.camera.source === 'pi' ? piProvider : null, id, { deviceId: state.camera.deviceId ?? '' });
  return mod;
}

/**
 * Show the camera in step 3 when the distance is measured by the camera. Choosing Camera starts it, so the
 * browser asks for permission right then; the calibration waits for a participant code if there is none yet.
 */
async function mountDistanceStep() {
  leaveDistanceStep();
  const token = cameraMountToken;
  const embed = $('[data-role=camera-embed]');
  if (wizard.querySelector('[name=distanceMode]:checked').value !== 'camera') {
    refreshWizard();
    return;
  }
  const code = readForm().participant;
  const participant = CODE_RE.test(code) ? code : '';
  let distance = null;
  let error = '';
  try {
    distance = await prepareCamera();
  } catch (err) {
    error = err.message;
  }
  const ui = await import('./camera-screen.js');
  if (token !== cameraMountToken) return; // the user moved on while the camera module was loading
  state.cameraUi = ui;
  let label;
  try {
    label = describeCamera(state.camera, location.origin);
  } catch {
    label = 'Raspberry Pi (address needed)';
  }
  let camId = '';
  try {
    camId = cameraId(state.camera, location.origin);
  } catch {
    // invalid Pi address: the head training waits for a camera that works
  }
  ui.mountCameraStep(embed, {
    distance, error, participant, cameraId: camId,
    source: { settings: state.camera, label },
    onSourceChange: applyCameraSettings,
    onCalibrated: refreshWizard,
    onCameraOff: stopPiCamera,
  });
  refreshWizard();
}

/** Stop showing the camera in step 3 and let go of it. */
function leaveDistanceStep() {
  cameraMountToken += 1;
  state.cameraUi?.unmountCameraStep($('[data-role=camera-embed]'));
  stopCamera();
}

/** The user picked another camera. Returns '' or a message to show next to the choice. */
function applyCameraSettings(next) {
  try {
    if (next.source === 'pi') normalizePiUrl(next.piUrl, location.origin);
  } catch (err) {
    return err.message;
  }
  saveCameraSettings(next);
  state.camera = next;
  mountDistanceStep();
  return '';
}

// ---------- progress ----------

function readSessions() {
  try {
    return listSessions();
  } catch (err) {
    showError(err.message);
    return [];
  }
}

const h = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

function enterProgress() {
  const root = $('#screen-progress .progress-body');
  root.textContent = '';
  const sessions = readSessions();
  const info = latestAction(sessions);
  if (!info) {
    const start = h('button', 'primary', 'Take a test');
    start.type = 'button';
    start.dataset.nav = 'screen-setup';
    const row = h('div', 'row');
    row.append(start);
    root.append(h('p', 'hint', 'Nothing to show yet. Your progress appears here after your first test. Practice tests are not counted.'), row);
    return;
  }
  const { latest } = info;
  const action = h('div', 'action-body');
  const trend = h('div', 'trend-body');
  root.append(h('p', 'hint', `Latest test · ${latest.participant} · ${latest.eye} · ${new Date(latest.timestamp).toLocaleDateString()}`),
    action, trend);
  renderAction(action, { state: info.state, needed: info.needed });
  renderTrend(trend, toBaselineSessions(sessions));
  trend.querySelector(':scope > h2')?.remove();
  const legend = trend.querySelector('.trend-legend');
  if (legend) legend.textContent = 'The shaded band is your usual range. Red dots are outside it. A triangle is a test without a result.';
  root.append(whyThisTestElement());
}

// ---------- result ----------

const OUTCOME_TEXT = {
  ok: 'Measured',
  floor_hit: 'Not measurable: better than this screen can show',
  'worse_than_1.3': 'Not measurable: worse than logMAR 1.3',
  aborted_camera: 'No result: distance could not be verified',
  aborted_user: 'No result: test stopped',
};

/** Snellen-style equivalent of a logMAR value, e.g. 0.30 -> "20/40". */
function snellen(logmar) { return `20/${Math.round(20 * 10 ** logmar)}`; }

function renderResult() {
  const s = state.lastSession;
  const body = $('#result-body');
  body.textContent = '';
  const el = (tag, className, textContent = '') => Object.assign(document.createElement(tag), { className, textContent });
  if (!s) {
    body.append(el('div', 'narrow', ''));
    body.firstChild.append(el('h1', '', 'Result'), el('p', 'hint', 'No test has been run in this visit.'));
    return;
  }

  const wrap = el('div', 'narrow result');
  body.append(wrap);
  wrap.append(el('p', 'hint', `${s.participant} · ${s.eye} · ${new Date(s.started_at).toLocaleString()}`));
  const score = scoreText(s);
  wrap.append(el('p', `result-head ${OUTCOME_TONE[s.outcome] ?? 'is-stop'}${score == null ? ' big' : ''}`,
    OUTCOME_TEXT[s.outcome] ?? s.outcome));
  if (score != null) {
    wrap.append(el('p', 'result-value', score),
      el('p', 'result-unit', s.outcome === 'ok' ? `logMAR · about ${snellen(s.logmar)} on the Snellen chart` : 'logMAR'));
  }
  if (s.outcome === 'ok' && s.near_floor) {
    wrap.append(el('p', 'note',
      'Near the screen limit: the smallest signs were under 2 device pixels wide in the gap. Treat with caution.'));
  }
  if (s.notes) wrap.append(el('p', 'note plain', `${s.outcome === 'ok' ? 'Note' : 'Reason'}: ${s.notes}`));
  if (score != null || s.outcome === 'worse_than_1.3') wrap.append(renderScale(s));

  const tech = el('details', 'tech');
  tech.append(el('summary', '', 'Technical details'));
  const dl = el('dl', 'kv');
  const rows = [
    ['Glasses', s.glasses], ['Condition', s.condition],
    ['Distance source', MODE_TEXT[s.distance_mode] ?? s.distance_mode], ['Target distance', `${s.target_mm} mm`],
    ['Mean distance', s.mean_mm == null ? '—' : `${s.mean_mm} mm` + (s.sd_mm == null ? '' : ` (SD ${s.sd_mm})`)],
    ['Correct / counted (main part)', `${s.n_correct} / ${s.n_trials}`],
    ['Screen floor at target', s.screen_floor_logmar == null ? '—' : `logMAR ${s.screen_floor_logmar.toFixed(1)}`],
    ['Trials recorded', String(s.trials.length)],
  ];
  for (const [k, val] of rows) dl.append(el('dt', '', k), el('dd', '', val));
  tech.append(dl);
  wrap.append(tech);
}

// Tick strip from logMAR 1.3 (left, worse) to -0.3 (right, better) in 0.1 steps.
const SCALE_WORST_TENTHS = 13;
const SCALE_BEST_TENTHS = -3;

function renderScale(s) {
  const wrap = document.createElement('div');
  wrap.className = 'scale';
  wrap.setAttribute('aria-hidden', 'true'); // the same numbers are in the text above and in the details
  const value = s.outcome === 'ok' ? s.logmar
    : s.outcome === 'floor_hit' ? s.screen_floor_logmar
      : s.outcome === 'worse_than_1.3' ? SCALE_WORST_TENTHS / 10 : null;
  const here = value == null ? null : Math.max(SCALE_BEST_TENTHS, Math.min(SCALE_WORST_TENTHS, Math.round(value * 10)));
  const floor = s.screen_floor_logmar == null ? null : Math.round(s.screen_floor_logmar * 10);
  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  for (let t = SCALE_WORST_TENTHS; t >= SCALE_BEST_TENTHS; t--) {
    const tick = document.createElement('span');
    if (t % 5 === 0 || t === SCALE_WORST_TENTHS || t === SCALE_BEST_TENTHS) tick.classList.add('major');
    if (floor != null && t < floor) tick.classList.add('beyond');
    if (t === here) tick.classList.add('here');
    ticks.append(tick);
  }
  const axis = document.createElement('div');
  axis.className = 'scale-axis';
  for (const t of ['1.3 worse', 'better −0.3']) axis.append(Object.assign(document.createElement('span'), { textContent: t }));
  wrap.append(ticks, axis);
  return wrap;
}

// ---------- init ----------

show('screen-home');
$('[data-role=why-home]').append(whyThisTestElement());
// Decorative iris on the home screen, drawn after the first paint so it never delays the page.
setTimeout(() => { const canvas = $('.eye-canvas'); if (canvas) paintIris(canvas); }, 0);
