// AI-assisted (Claude Code), reviewed by a team member.
// Application shell: screen switching, session setup, test run, result, session list and export.

import { getPxPerMm, mountScreenCalibration, calibrationDprChanged } from './screen-calib.js';
import { screenFloorLogmar } from './optotype.js';
import { runAcuityTest } from './acuity-test.js';
import { paintIris } from './iris.js';
import { initHomeScroll } from './home-scroll.js';
import { connectPiCamera, normalizePiUrl } from './pi-camera.js';
import { loadCameraSettings, saveCameraSettings, cameraId, describeCamera } from './camera-source.js';
import { renderTrend } from './ui-trend.js';
import { renderAction } from './ui-action.js';
import { toBaselineSessions, latestAction } from './trend-data.js';
import { listSessions, saveSession, deleteSession, exportCsv, exportJson, importJson } from './storage.js';

const state = {
  screen: 'screen-home',
  testRunning: false,
  lastSession: null,
  distance: null, // participant 2's src/distance.js module, loaded on first camera-mode session
  camera: loadCameraSettings(), // which camera measures the distance: this computer or a Raspberry Pi
  piCamera: null, // the running Raspberry Pi feed, if any
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
  'screen-calib': () => mountScreenCalibration($('#screen-calib'), { onSaved: renderHome }),
  'screen-camera': enterCamera,
  'screen-trend': enterTrend,
  'screen-action': enterAction,
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
  if (id !== 'screen-camera' && id !== 'screen-test') stopPiCamera(); // no polling in the background
  state.screen = id;
  window.scrollTo(0, 0); // every screen starts at its top
  clearError();
  enterHandlers[id]?.();
  if (id === 'screen-home') syncHomeScroll();
  // Integration point for participant 2's screens (screen-camera, screen-trend, screen-action).
  document.dispatchEvent(new CustomEvent('app:screen-enter', { detail: { id } }));
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); show(nav.dataset.nav); }
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
  primary.textContent = ready ? 'Start test' : 'Calibrate screen';
  primary.dataset.nav = ready ? 'screen-setup' : 'screen-calib';
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
    td.colSpan = 9;
    td.className = 'empty';
    td.textContent = 'No tests yet. Calibrate the screen, then start a test.';
    return;
  }
  const columns = [
    ['started', (s) => new Date(s.started_at).toLocaleString()],
    ['participant', (s) => s.participant], ['eye', (s) => s.eye],
    ['glasses', (s) => s.glasses], ['condition', (s) => s.condition],
    ['mode', (s) => MODE_TEXT[s.distance_mode] ?? s.distance_mode],
    ['outcome', (s) => OUTCOME_SHORT[s.outcome] ?? s.outcome],
    ['logmar', fmtLogmar],
  ];
  for (const s of [...sessions].reverse()) {
    const tr = tbody.insertRow();
    for (const [key, value] of columns) {
      const td = tr.insertCell();
      td.className = key === 'outcome' ? `c-outcome ${OUTCOME_TONE[s.outcome] ?? 'is-stop'}` : `c-${key}`;
      td.textContent = value(s);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link danger';
    del.textContent = 'Delete';
    const when = new Date(s.started_at).toLocaleString();
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

// ---------- setup ----------

const form = $('#setup-form');

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
  if (!pxPerMm) errs.push('The screen is not calibrated. Calibrate it before testing.');
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(v.participant)) errs.push('Participant code: 1–16 letters, digits, _ or -.');
  if (!['OD', 'OS', 'OU'].includes(v.eye)) errs.push('Choose the eye.');
  if (!['yes', 'no'].includes(v.glasses)) errs.push('Choose glasses yes or no.');
  if (!v.condition || v.condition.length > 40 || /[\r\n]/.test(v.condition)) errs.push('Condition label is required (max 40 characters).');
  if (!Number.isInteger(v.targetMm) || v.targetMm < 200 || v.targetMm > 6000) errs.push('Target distance must be a whole number of mm between 200 and 6000.');
  if (!['manual', 'camera'].includes(v.distanceMode)) errs.push('Choose a distance source.');
  return errs;
}

function updateFloorHint() {
  const p = getPxPerMm();
  const mm = Number(form.targetMm.value);
  const hint = $('[data-role=floor-hint]');
  if (!p) { hint.textContent = 'Calibrate the screen first.'; return; }
  if (!(mm > 0)) { hint.textContent = ''; return; }
  const floor = screenFloorLogmar(mm, p);
  hint.textContent = floor == null
    ? 'At this distance even logMAR 1.3 cannot be drawn on this screen.'
    : `This screen can show signs down to logMAR ${floor.toFixed(1)} at ${mm} mm. Finer than that is logged as "Beyond screen".`;
}
form.targetMm.addEventListener('input', updateFloorHint);
// Old errors describe the previous submit; drop them once the user edits the form.
form.addEventListener('input', () => { $('.form-errors').textContent = ''; });

function enterSetup() {
  $('.form-errors').textContent = '';
  updateFloorHint();
  let camera;
  try {
    camera = describeCamera(state.camera, location.origin);
  } catch {
    camera = 'a Raspberry Pi with an invalid address';
  }
  $('[data-role=camera-summary]').textContent = `Camera: ${camera}.`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = readForm();
  const pxPerMm = getPxPerMm();
  const errs = validateSetup(v, pxPerMm);
  const list = $('.form-errors');
  list.textContent = '';
  for (const m of errs) list.append(Object.assign(document.createElement('li'), { textContent: m }));
  if (errs.length) { list.scrollIntoView({ block: 'nearest' }); return; }
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
    } catch (err) {
      stopPiCamera();
      showError(err.message); // Failure D: no camera data, no test, no number.
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
    });
  } catch (err) {
    state.testRunning = false;
    document.body.classList.remove('testing');
    stopPiCamera();
    show('screen-setup');
    showError(`The test could not run: ${err.message}`);
    return;
  }
  state.testRunning = false;
  document.body.classList.remove('testing');
  stopPiCamera();
  if (cameraMod) session.cam_k = cameraMod.getK(v.participant); // the calibration this distance was measured with

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
  mod.setCameraProvider(state.camera.source === 'pi' ? piProvider : null, id);
  return mod;
}

async function enterCamera() {
  const container = $('#screen-camera');
  stopPiCamera();
  container.textContent = '';
  try {
    await prepareCamera();
    (await import('./camera-calib.js')).mountCameraCalib(container);
  } catch (err) {
    container.textContent = '';
    container.append(Object.assign(document.createElement('h1'), { textContent: 'Camera' }));
    showError(err.message);
  }
  mountCameraPicker(container);
}

// Choice of camera, shown at the top of the Camera screen: calibration and tests then use the same camera.
function mountCameraPicker(container) {
  const wrap = document.createElement('div');
  wrap.className = 'camera-pick';
  wrap.innerHTML = `
    <div class="seg">
      <label><input type="radio" name="cameraSource" value="local"><span>This computer</span></label>
      <label><input type="radio" name="cameraSource" value="pi"><span>Raspberry Pi</span></label>
    </div>
    <label class="field pi-address">
      <span class="label">Raspberry Pi address</span>
      <input name="piUrl" autocomplete="off" inputmode="url" placeholder="raspberrypi.local:8000">
      <small>Leave empty when this page is opened from the Pi.</small>
    </label>
    <p class="hint">Each camera has its own distance calibration.</p>`;
  wrap.querySelector(`[name=cameraSource][value=${state.camera.source}]`).checked = true;
  wrap.querySelector('[name=piUrl]').value = state.camera.piUrl;
  wrap.addEventListener('change', () => {
    const next = {
      source: wrap.querySelector('[name=cameraSource]:checked').value,
      piUrl: wrap.querySelector('[name=piUrl]').value.trim(),
    };
    try {
      if (next.source === 'pi') normalizePiUrl(next.piUrl, location.origin);
    } catch (err) {
      showError(err.message);
      return;
    }
    clearError();
    saveCameraSettings(next);
    state.camera = next;
    enterCamera();
  });
  const title = container.querySelector('h1, h2');
  if (title) title.after(wrap); else container.prepend(wrap);
}

// ---------- trend and action ----------

function readSessions() {
  try {
    return listSessions();
  } catch (err) {
    showError(err.message);
    return [];
  }
}

function emptyScreen(container, title, text) {
  container.textContent = '';
  container.append(
    Object.assign(document.createElement('h1'), { textContent: title }),
    Object.assign(document.createElement('p'), { className: 'hint', textContent: text }),
  );
}

function enterTrend() {
  const container = $('#screen-trend');
  const sessions = toBaselineSessions(readSessions());
  if (!sessions.length) {
    emptyScreen(container, 'Trend', 'No tests to show yet. Practice tests are left out of the trend.');
    return;
  }
  renderTrend(container, sessions);
}

function enterAction() {
  const container = $('#screen-action');
  const info = latestAction(readSessions());
  if (!info) {
    emptyScreen(container, 'Action', 'Take a test first. Advice compares your newest test with your own baseline.');
    return;
  }
  container.innerHTML = '<h2>Action</h2><div class="action-body"></div>';
  renderAction(container.querySelector('.action-body'), { state: info.state, needed: info.needed });
  // The "Why this test" text is still a placeholder from src/ui-action.js; do not show it to users yet.
  container.querySelector('.action-why')?.remove();
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
  if (s.notes) wrap.append(el('p', 'note plain', `Reason: ${s.notes}`));
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
// Decorative iris on the home screen, drawn after the first paint so it never delays the page.
setTimeout(() => { const canvas = $('.eye-canvas'); if (canvas) paintIris(canvas); }, 0);
