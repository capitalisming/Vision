// AI-assisted (Claude Code), reviewed by a team member.
// The camera part of the Test flow: choose the camera, see the face with the eye markers, calibrate the
// distance once. A guided replacement for the lab-style screen in src/camera-calib.js (which stays for
// dev.html). The Experiment 3 recorder is kept under "Study tools" and writes the same rows (same storage
// key, same CSV).
import { toCsv } from './camera-calib.js';

const ROWS_KEY = 'distance_check_rows';
const DEFAULT_KNOWN_MM = 500;
const TAU = Math.PI * 2;

// Reasons src/distance.js gives for "no distance right now", in plain words.
const REASON_TEXT = {
  no_face: 'No face found. Look at the screen.',
  two_faces: 'More than one face in view.',
  head_turned: 'Turn your head toward the camera.',
  stale: 'Hold still for a moment…',
  not_calibrated: 'Face found. Calibrate to see the distance.',
};

export function describeReason(reason) {
  return REASON_TEXT[reason] ?? String(reason);
}

/** A camera start-up error in plain words. */
export function cameraErrorText(err) {
  if (err?.name === 'NotAllowedError' || /permission denied/i.test(err?.message ?? '')) {
    return 'The browser is blocking the camera. Allow it in the address bar, then reload.';
  }
  if (err?.name === 'NotFoundError') return 'No camera was found.';
  if (err?.name === 'NotReadableError') return 'Another program is using the camera.';
  return err?.message || 'The camera could not be started.';
}

/** Camera distance against tape distance, in percent of the tape distance. */
export function errorPercent(row) {
  return ((row.cameraMm - row.tapeMm) / row.tapeMm) * 100;
}

function loadRows() {
  try {
    return JSON.parse(localStorage.getItem(ROWS_KEY)) || [];
  } catch {
    return []; // damaged rows are dropped; the next record starts a fresh list
  }
}

function drawEyes(ctx, faces, ok) {
  const scale = ctx.canvas.width / 640; // sizes are written for a 640 px wide picture
  const color = ok ? '#4fb3b8' : '#e6b450';
  ctx.lineCap = 'round';
  for (const { left, right } of faces) {
    ctx.strokeStyle = 'rgb(255 255 255 / 0.75)';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
    for (const p of [left, right]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 * scale, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11 * scale, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

let generation = 0; // a newer mount, or an unmount, stops the loop of an older one

/** Remove the camera step and let go of the camera it was showing. */
export function unmountCameraStep(container) {
  generation += 1;
  container.querySelector('video')?.srcObject?.getTracks().forEach((track) => track.stop());
  container.textContent = '';
}

/**
 * @param {HTMLElement} container  where the step goes; its content is replaced
 * @param {object} o
 * @param {object|null} o.distance  the src/distance.js module, or null when it could not be prepared
 * @param {string} [o.error]  why the camera cannot start (shown instead of the picture)
 * @param {string} o.participant  the code the calibration belongs to
 * @param {{settings: {source: string, piUrl: string}, label: string}} o.source  the camera in use
 * @param {(next: {source: string, piUrl: string}) => string} o.onSourceChange  returns '' or a message
 * @param {(calibrated: boolean) => void} [o.onCalibrated]  called when the calibration state changes
 */
export function mountCameraStep(container, { distance, error = '', participant, source, onSourceChange, onCalibrated }) {
  const gen = ++generation;
  container.innerHTML = `
    <div class="cam">
      <div class="cam-view">
        <video muted playsinline></video>
        <canvas></canvas>
        <p class="cam-chip" role="status"></p>
        <p class="cam-dist"></p>
      </div>
      <p class="cam-alert" role="alert" hidden></p>

      <div class="cam-calib">
        <p class="hint cam-howto"></p>
        <div class="row">
          <button type="button" class="primary" data-act="calibrate" disabled>Calibrate</button>
          <span class="cam-calib-status" role="status"></span>
        </div>
      </div>

      <details class="more cam-source">
        <summary>Camera source: <span data-role="source-label"></span></summary>
        <div class="seg">
          <label><input type="radio" name="cameraSource" value="local"><span>This computer</span></label>
          <label><input type="radio" name="cameraSource" value="pi"><span>Raspberry Pi</span></label>
        </div>
        <label class="field pi-address">
          <span class="label">Raspberry Pi address</span>
          <input name="piUrl" autocomplete="off" inputmode="url" placeholder="raspberrypi.local:8000">
          <small>Leave empty if you opened this page from the Pi.</small>
        </label>
        <p class="hint cam-source-error" role="alert"></p>
        <p class="hint">Each camera has its own calibration.</p>
      </details>

      <details class="more cam-study">
        <summary>Study tools</summary>
        <div class="field">
          <span class="label">Calibration distance, mm</span>
          <input name="knownMm" type="number" min="100" max="2000" value="${DEFAULT_KNOWN_MM}">
        </div>
        <h2>Camera vs tape (Experiment 3)</h2>
        <div class="row">
          <label class="field"><span class="label">Tape distance, mm</span><input name="tapeMm" type="number" min="100" max="2000"></label>
          <label class="check"><input type="checkbox" name="glassesOn"> Glasses on</label>
        </div>
        <div class="row">
          <button type="button" class="small" data-act="record">Record</button>
          <button type="button" class="small" data-act="download">Download CSV</button>
          <button type="button" class="small ghost" data-act="clear">Clear rows</button>
        </div>
        <p class="hint rec-status" role="status"></p>
        <table class="rec-table">
          <thead><tr><th>Participant</th><th>Glasses</th><th>Tape mm</th><th>Camera mm</th><th>Error %</th></tr></thead>
          <tbody></tbody>
        </table>
      </details>
    </div>`;

  const q = (sel) => container.querySelector(sel);
  const input = (name) => q(`[name="${name}"]`);
  const view = q('.cam-view');
  const video = q('video');
  const canvas = q('canvas');
  const ctx = canvas.getContext('2d');
  const chip = q('.cam-chip');
  const distText = q('.cam-dist');
  const alertEl = q('.cam-alert');
  const calibrateBtn = q('[data-act=calibrate]');
  const calibStatus = q('.cam-calib-status');
  const knownMm = () => Number(input('knownMm').value);

  // ----- camera source (collapsed)
  const sourceDetails = q('.cam-source');
  q('[data-role=source-label]').textContent = source.label;
  q(`[name=cameraSource][value=${source.settings.source}]`).checked = true;
  input('piUrl').value = source.settings.piUrl;
  sourceDetails.addEventListener('change', () => {
    const next = { source: q('[name=cameraSource]:checked').value, piUrl: input('piUrl').value.trim() };
    q('.cam-source-error').textContent = onSourceChange(next);
  });

  // ----- camera
  const showAlert = (text) => {
    alertEl.textContent = text;
    alertEl.hidden = !text;
    view.classList.toggle('is-off', Boolean(text));
  };
  let started = false;
  if (error || !distance) {
    showAlert(error || 'The camera module could not be loaded.');
    sourceDetails.open = true;
  } else {
    chip.textContent = 'Starting camera…';
    distance.setParticipant(participant);
    distance.startDistance(video).then(() => { started = true; }).catch((err) => {
      showAlert(cameraErrorText(err));
      sourceDetails.open = true; // the way out may be another camera
    });
  }

  // ----- calibration
  const syncHowto = () => {
    const cm = knownMm() / 10;
    q('.cam-howto').textContent = `Calibrating for ${participant}. Sit so that your eyes are ${cm} cm from the screen. ` +
      'Measure it with a tape or ruler. Look at the camera, then press Calibrate.';
    calibrateBtn.textContent = `Calibrate at ${cm} cm`;
  };
  syncHowto();
  input('knownMm').addEventListener('input', syncHowto);

  let flash = { text: '', until: 0 };
  calibrateBtn.addEventListener('click', () => {
    try {
      distance.calibrateCamera(participant, knownMm());
      flash = { text: 'Calibrated.', until: Date.now() + 4000 };
    } catch (err) {
      flash = { text: describeReason(err.message.replace(/^cannot calibrate: /, '')), until: Date.now() + 4000 };
    }
  });

  // ----- live view: one pass per frame, text only when it changes
  const set = (el, prop, value) => { if (el[prop] !== value) el[prop] = value; };
  let wasCalibrated = null;
  function tick() {
    if (gen !== generation || !container.isConnected) return;
    requestAnimationFrame(tick);
    if (!started) return;

    const d = distance.getDistance(participant);
    const faceOk = d.reason === null || d.reason === 'not_calibrated';
    const calibrated = Boolean(distance.getK(participant));
    if (calibrated !== wasCalibrated) {
      wasCalibrated = calibrated;
      onCalibrated?.(calibrated);
    }

    set(chip, 'textContent', d.reason === null ? 'Face found' : describeReason(d.reason));
    chip.className = `cam-chip ${faceOk ? 'is-ok' : (d.reason === 'stale' ? '' : 'is-warn')}`;
    view.classList.toggle('no-face', d.reason === 'no_face');
    set(distText, 'textContent', d.ok ? `${Math.round(d.mm / 10)} cm` : '');

    if (video.videoWidth && canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawEyes(ctx, distance.getEyeCorners(), faceOk);

    let status;
    if (flash.until > Date.now()) status = flash.text;
    else if (!faceOk) status = describeReason(d.reason);
    else if (calibrated) status = 'Calibrated with this camera.';
    else status = 'Ready. Press Calibrate.';
    set(calibStatus, 'textContent', status);
    calibrateBtn.disabled = !faceOk;
    set(calibrateBtn, 'textContent', calibrated ? 'Recalibrate' : `Calibrate at ${knownMm() / 10} cm`);
  }
  requestAnimationFrame(tick);

  // ----- study tools: camera against tape
  let rows = loadRows();
  const recStatus = q('.rec-status');
  const renderRows = () => {
    const body = q('.rec-table tbody');
    body.textContent = '';
    for (const r of rows) {
      const tr = body.insertRow();
      const err = errorPercent(r);
      [r.participant, r.glasses ? 'yes' : 'no', r.tapeMm, Math.round(r.cameraMm), err.toFixed(1)].forEach((v, i) => {
        const td = tr.insertCell();
        td.textContent = String(v);
        if (i === 4 && Math.abs(err) > 10) td.className = 'bad';
      });
    }
    localStorage.setItem(ROWS_KEY, JSON.stringify(rows));
  };
  renderRows();

  q('[data-act=record]').addEventListener('click', () => {
    const tapeMm = Number(input('tapeMm').value);
    if (!(tapeMm > 0)) { recStatus.textContent = 'Enter the tape distance in mm.'; return; }
    const d = distance.getDistance(participant);
    if (!d.ok) { recStatus.textContent = `Not recorded: ${describeReason(d.reason)}`; return; }
    rows.push({
      participant, glasses: input('glassesOn').checked, tapeMm, cameraMm: d.mm,
      eyeSpanPx: d.eyeSpanPx, timestamp: new Date().toISOString(),
    });
    recStatus.textContent = `Recorded ${rows.length} rows.`;
    renderRows();
  });
  q('[data-act=download]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'distance_check.csv' });
    a.click();
    URL.revokeObjectURL(url);
  });
  q('[data-act=clear]').addEventListener('click', () => {
    if (rows.length && confirm(`Delete all ${rows.length} recorded rows?`)) {
      rows = [];
      recStatus.textContent = '';
      renderRows();
    }
  });
}
