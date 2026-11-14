/**
 * Camera calibration screen (#screen-camera).
 *
 * Two jobs:
 *   1. Save the personal k at a tape-measured distance, then show the live distance so the
 *      person can check it against the ruler at another distance.
 *   2. Record camera-vs-tape rows for Experiment 3 and export distance_check.csv.
 *
 * The screen only draws inside the container given to mountCameraScreen(); it never touches
 * other screens. All camera work happens in distance.js.
 */
import { api, getDistance, getLastFrame } from './distance.js';

const ROWS_KEY = 'nvm_distance_check_rows';
const CSV_HEADER = ['participant', 'glasses', 'tapeMm', 'cameraMm', 'eyeSpanPx', 'timestamp'];

const REASON_TEXT = {
  not_calibrated: 'Not calibrated — sit at a known distance and press Save',
  no_face: 'No face in the frame',
  two_faces: 'Two faces in the frame — only one person may be visible',
  head_turned: 'Head turned more than 15° — look straight at the camera',
  stale: 'No fresh measurement',
};

const esc = (v) =>
  /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

function readRows() {
  try {
    const rows = JSON.parse(localStorage.getItem(ROWS_KEY) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeRows(rows) {
  try {
    localStorage.setItem(ROWS_KEY, JSON.stringify(rows));
  } catch {
    /* the table still works until the page is closed */
  }
}

export function rowsToCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.participant,
        r.glasses,
        r.tapeMm,
        r.cameraMm,
        typeof r.eyeSpanPx === 'number' ? r.eyeSpanPx.toFixed(1) : '',
        r.timestamp,
      ]
        .map(esc)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function downloadCsv(rows, filename = 'distance_check.csv') {
  const blob = new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TEMPLATE = `
<div class="nvm-screen">
  <h1>Camera distance</h1>
  <p class="nvm-hint">
    Sit so that your eyes are 500 mm from the screen (measure with a ruler), look straight at
    the camera, press Save. The calibration is personal and stays on this device.
  </p>

  <div class="nvm-row">
    <label class="nvm-field">Participant
      <select data-role="participant"></select>
    </label>
    <label class="nvm-field">Known distance, mm
      <input data-role="known-mm" type="number" value="500" min="150" max="2000" step="1" inputmode="numeric">
    </label>
    <button data-role="start" type="button" class="nvm-btn">Start camera</button>
    <button data-role="save" type="button" class="nvm-btn nvm-btn-primary">Save</button>
  </div>

  <div class="nvm-camera">
    <div class="nvm-video-wrap">
      <video data-role="video" playsinline muted autoplay></video>
      <div class="nvm-video-host" data-role="video-host"></div>
    </div>
    <div class="nvm-live" data-role="live" data-tone="idle">
      <div class="nvm-live-mm" data-role="live-mm">—</div>
      <div class="nvm-live-reason" data-role="live-reason">Camera is off</div>
    </div>
  </div>

  <label class="nvm-check">
    <input data-role="debug" type="checkbox">
    Debug view: eye corners and the current distance on the video
  </label>

  <p class="nvm-note" data-role="status" role="status" aria-live="polite"></p>

  <section class="nvm-block">
    <h2>Experiment 3 · camera vs tape</h2>
    <p class="nvm-hint">
      Hold the phone at a tape-measured distance, wait for a stable number, then Record.
      300, 400, 500, 670 and 1000 mm for each participant, with and without glasses.
    </p>
    <div class="nvm-row">
      <label class="nvm-field">Glasses
        <select data-role="glasses">
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      </label>
      <label class="nvm-field">Tape distance, mm
        <input data-role="tape-mm" type="number" min="150" max="2000" step="1" inputmode="numeric" placeholder="e.g. 300">
      </label>
      <button data-role="record" type="button" class="nvm-btn">Record</button>
      <button data-role="export" type="button" class="nvm-btn">Export distance_check.csv</button>
      <button data-role="clear" type="button" class="nvm-btn nvm-btn-quiet">Clear rows</button>
    </div>
    <div data-role="table" class="nvm-table-wrap"></div>
  </section>
</div>`;

/**
 * @param {HTMLElement} container the #screen-camera container owned by the app shell.
 * @param {{participants?: string[]}} [options]
 */
export function mountCameraScreen(container, options = {}) {
  if (!container) throw new TypeError('mountCameraScreen(container): container required');
  const participants = options.participants?.length ? [...options.participants] : ['P01', 'P02', 'P03'];

  container.innerHTML = TEMPLATE;
  const $ = (role) => container.querySelector(`[data-role="${role}"]`);
  const video = $('video');
  const host = $('video-host');
  const live = $('live');
  const liveMm = $('live-mm');
  const liveReason = $('live-reason');
  const statusEl = $('status');
  const participant = $('participant');
  const knownMm = $('known-mm');
  const tapeMm = $('tape-mm');
  const glasses = $('glasses');
  const tableEl = $('table');

  participant.innerHTML = participants.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  participant.value = participants[0];
  api.setParticipant(participant.value);

  let rows = readRows();
  let liveTimer = 0;
  let destroyed = false;

  const status = (text, tone = 'info') => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };

  const renderTable = () => {
    if (rows.length === 0) {
      tableEl.innerHTML = '<p class="nvm-empty">No rows recorded yet.</p>';
      return;
    }
    const body = rows
      .map((r) => {
        const err = r.tapeMm ? ((r.cameraMm - r.tapeMm) / r.tapeMm) * 100 : null;
        const errText = err == null ? '—' : `${err >= 0 ? '+' : ''}${err.toFixed(1)} %`;
        const bad = err != null && Math.abs(err) > 10;
        return `<tr${bad ? ' class="nvm-bad"' : ''}>
          <td>${esc(r.participant)}</td>
          <td>${esc(r.glasses)}</td>
          <td>${esc(r.tapeMm)}</td>
          <td>${esc(r.cameraMm)}</td>
          <td>${esc(errText)}</td>
          <td>${r.eyeSpanPx == null ? '—' : Number(r.eyeSpanPx).toFixed(1)}</td>
          <td>${esc(new Date(r.timestamp).toLocaleString())}</td>
        </tr>`;
      })
      .join('');
    tableEl.innerHTML = `<table class="nvm-table">
      <thead><tr><th>Participant</th><th>Glasses</th><th>Tape, mm</th><th>Camera, mm</th><th>Error</th><th>Eye span, px</th><th>Time</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  };

  const updateCalibrationNote = () => {
    const calib = api.getCalibration();
    if (!calib) {
      status('No calibration for this participant yet — press Save at a known distance.', 'warn');
      return;
    }
    status(
      `${calib.participant}: k = ${calib.k.toFixed(0)} px·mm from ${calib.knownMm} mm ` +
        `(eye span ${calib.eyeSpanPx.toFixed(1)} px, ${new Date(calib.at).toLocaleString()}).`,
      'ok',
    );
  };

  const updateLive = () => {
    if (destroyed) return;
    if (!api.isRunning()) {
      live.dataset.tone = 'idle';
      liveMm.textContent = '—';
      liveReason.textContent = 'Camera is off';
      return;
    }
    const d = getDistance();
    if (d.ok) {
      live.dataset.tone = 'ok';
      liveMm.textContent = `${d.mm} mm`;
      const frame = getLastFrame();
      liveReason.textContent =
        `eye span ${d.eyeSpanPx.toFixed(1)} px · yaw ${frame?.yawDeg == null ? '?' : Math.round(frame.yawDeg)}°` +
        ` · ${frame?.faces ?? 0} face(s)`;
    } else {
      live.dataset.tone = 'warn';
      liveMm.textContent = '—';
      liveReason.textContent = REASON_TEXT[d.reason] ?? d.reason ?? 'No data';
    }
  };

  const explainCameraError = (err) => {
    if (err?.name === 'NotAllowedError') return 'Camera access was blocked — allow the camera in the browser and press Start camera again';
    if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No camera found on this device';
    if (err?.name === 'NotReadableError') return 'The camera is already in use by another app';
    return err?.message || 'Camera could not be started';
  };

  const startCamera = async () => {
    status('Starting camera…');
    try {
      await api.startDistance(video, { participant: participant.value });
      if (!liveTimer) liveTimer = setInterval(updateLive, 200);
      updateCalibrationNote();
      updateLive();
    } catch (err) {
      const hint = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)
        ? ''
        : ' Browsers allow the camera only on HTTPS or localhost.';
      status(`${explainCameraError(err)}.${hint}`, 'error');
    }
  };

  const saveCalibration = () => {
    try {
      const calib = api.calibrateCamera(Number(knownMm.value), participant.value);
      status(
        `Saved for ${calib.participant}: k = ${calib.k.toFixed(0)} px·mm. ` +
          'Now check it at another tape-measured distance.',
        'ok',
      );
    } catch (err) {
      status(err.message, 'error');
    }
  };

  const record = () => {
    const tape = Number(tapeMm.value);
    if (!Number.isFinite(tape) || tape < 150 || tape > 2000) {
      status('Enter the tape distance in millimetres (150–2000).', 'warn');
      return;
    }
    const d = getDistance();
    if (!d.ok) {
      status(`Cannot record: ${REASON_TEXT[d.reason] ?? d.reason ?? 'no measurement'}.`, 'warn');
      return;
    }
    rows.push({
      participant: participant.value,
      glasses: glasses.value,
      tapeMm: tape,
      cameraMm: d.mm,
      eyeSpanPx: Number(d.eyeSpanPx.toFixed(1)),
      timestamp: new Date().toISOString(),
    });
    writeRows(rows);
    renderTable();
    const err = ((d.mm - tape) / tape) * 100;
    status(
      `Recorded ${d.mm} mm vs ${tape} mm (${err >= 0 ? '+' : ''}${err.toFixed(1)} %).`,
      Math.abs(err) > 10 ? 'warn' : 'ok',
    );
  };

  $('start').addEventListener('click', startCamera);
  $('save').addEventListener('click', saveCalibration);
  $('record').addEventListener('click', record);
  $('export').addEventListener('click', () => {
    if (rows.length === 0) {
      status('Nothing to export yet.', 'warn');
      return;
    }
    downloadCsv(rows);
    status(`Exported ${rows.length} row(s) to distance_check.csv.`, 'ok');
  });
  $('clear').addEventListener('click', () => {
    if (rows.length === 0) return;
    if (!confirm(`Delete all ${rows.length} recorded row(s)?`)) return;
    rows = [];
    writeRows(rows);
    renderTable();
    status('Rows cleared.', 'info');
  });
  $('debug').addEventListener('change', (e) => {
    api.setDebugHost(e.target.checked ? host : null);
  });
  participant.addEventListener('change', () => {
    api.setParticipant(participant.value);
    updateCalibrationNote();
    updateLive();
  });

  renderTable();
  updateCalibrationNote();

  return {
    destroy() {
      destroyed = true;
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = 0;
      api.setDebugHost(null);
      api.stopDistance();
    },
    getRows: () => rows.map((r) => ({ ...r })),
    exportCsv: () => downloadCsv(rows),
    startCamera,
    updateCalibrationNote,
  };
}