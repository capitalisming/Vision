// AI-assisted (Claude Code), reviewed by a team member.
// Application shell: screen switching, session setup, test run, result, session list and export.

import { getPxPerMm, mountScreenCalibration, calibrationDprChanged } from './screen-calib.js';
import { screenFloorLogmar } from './optotype.js';
import { runAcuityTest } from './acuity-test.js';
import { listSessions, saveSession, deleteSession, exportCsv, exportJson, importJson } from './storage.js';

const state = {
  screen: 'screen-home',
  testRunning: false,
  lastSession: null,
  distance: null, // participant 2's src/distance.js module, loaded on first camera-mode session
};

const $ = (sel, root = document) => root.querySelector(sel);

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
  'screen-calib': () => mountScreenCalibration($('#screen-calib'), { onSaved: renderHome }),
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
  state.screen = id;
  clearError();
  enterHandlers[id]?.();
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

function renderHome() {
  const p = getPxPerMm();
  const calibState = $('[data-state=calib]');
  calibState.textContent = p ? (calibrationDprChanged() ? '⚠' : '✓') : '○';
  calibState.title = p ? `${p.toFixed(3)} CSS px/mm` : 'not calibrated';

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
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = 9;
    td.className = 'empty';
    td.textContent = 'No sessions yet.';
    return;
  }
  for (const s of [...sessions].reverse()) {
    const tr = tbody.insertRow();
    const cells = [new Date(s.started_at).toLocaleString(), s.participant, s.eye, s.glasses,
      s.condition, s.distance_mode, s.outcome, fmtLogmar(s)];
    for (const c of cells) tr.insertCell().textContent = c;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (confirm(`Delete session ${s.participant} ${s.eye} ${s.started_at}? This cannot be undone.`)) {
        deleteSession(s.session_id);
        renderHome();
      }
    });
    tr.insertCell().append(del);
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
    renderHome();
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
  if (!p) { hint.textContent = 'Screen not calibrated.'; return; }
  if (!(mm > 0)) { hint.textContent = ''; return; }
  const floor = screenFloorLogmar(mm, p);
  hint.textContent = floor == null
    ? 'At this distance even logMAR 1.3 cannot be drawn on this screen.'
    : `Smallest level this screen can draw at ${mm} mm: logMAR ${floor.toFixed(1)}.`;
}
form.targetMm.addEventListener('input', updateFloorHint);

function enterSetup() {
  $('.form-errors').textContent = '';
  updateFloorHint();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = readForm();
  const pxPerMm = getPxPerMm();
  const errs = validateSetup(v, pxPerMm);
  const list = $('.form-errors');
  list.textContent = '';
  for (const m of errs) list.append(Object.assign(document.createElement('li'), { textContent: m }));
  if (errs.length) return;
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
  if (typeof mod.getDistance !== 'function') {
    throw new Error('Camera mode is not available: src/distance.js does not export getDistance(). Use manual mode.');
  }
  state.distance = mod;
  return mod;
}

async function startTest(v) {
  let getDistance;
  if (v.distanceMode === 'manual') {
    const mm = v.targetMm;
    getDistance = () => ({ mm, ageMs: 0, ok: true, reason: '' });
  } else {
    try {
      const mod = await loadDistanceModule();
      if (typeof mod.startDistance === 'function') await mod.startDistance($('#camera-video'));
      getDistance = mod.getDistance;
    } catch (err) {
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
    show('screen-setup');
    showError(`The test could not run: ${err.message}`);
    return;
  }
  state.testRunning = false;
  document.body.classList.remove('testing');

  try {
    saveSession(session);
  } catch (err) {
    showError(`The session could not be saved: ${err.message}`);
  }
  state.lastSession = session;
  show('screen-result');
}

// ---------- result ----------

const OUTCOME_TEXT = {
  ok: 'Measured',
  floor_hit: 'Not measurable: better than this screen can show',
  'worse_than_1.3': 'Not measurable: worse than logMAR 1.3',
  aborted_camera: 'No result: distance could not be verified',
  aborted_user: 'No result: test stopped',
};

function renderResult() {
  const s = state.lastSession;
  const body = $('#result-body');
  body.textContent = '';
  if (!s) { body.textContent = 'No test has been run in this visit.'; return; }

  const head = document.createElement('p');
  head.className = `result-head outcome-${s.outcome.replace(/\W/g, '_')}`;
  head.textContent = OUTCOME_TEXT[s.outcome] ?? s.outcome;
  body.append(head);

  if (s.outcome === 'ok') {
    const big = document.createElement('p');
    big.className = 'result-value';
    big.textContent = `logMAR ${s.logmar.toFixed(2)}`;
    body.append(big);
    if (s.near_floor) {
      body.append(Object.assign(document.createElement('p'), {
        className: 'warn',
        textContent: 'Near the screen limit: the smallest signs were under 2 device pixels wide in the gap. Treat with caution.',
      }));
    }
  }
  if (s.notes) body.append(Object.assign(document.createElement('p'), { textContent: `Reason: ${s.notes}` }));

  const dl = document.createElement('dl');
  const rows = [
    ['Participant / eye', `${s.participant} / ${s.eye}`], ['Glasses', s.glasses], ['Condition', s.condition],
    ['Distance source', s.distance_mode], ['Target distance', `${s.target_mm} mm`],
    ['Mean distance', s.mean_mm == null ? '—' : `${s.mean_mm} mm` + (s.sd_mm == null ? '' : ` (SD ${s.sd_mm})`)],
    ['Correct / counted (main part)', `${s.n_correct} / ${s.n_trials}`],
    ['Screen floor at target', s.screen_floor_logmar == null ? '—' : `logMAR ${s.screen_floor_logmar.toFixed(1)}`],
    ['Trials recorded', String(s.trials.length)],
  ];
  for (const [k, val] of rows) {
    dl.append(Object.assign(document.createElement('dt'), { textContent: k }));
    dl.append(Object.assign(document.createElement('dd'), { textContent: val }));
  }
  body.append(dl);
}

// ---------- init ----------

show('screen-home');
