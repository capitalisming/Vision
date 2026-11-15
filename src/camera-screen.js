// AI-assisted (Claude Code), reviewed by a team member.
// The camera part of the Test flow: ask for the camera, choose it, see the face with the eye markers, and
// calibrate the distance automatically (or once with a tape, for a precise distance). A guided replacement for the lab-style screen in src/camera-calib.js (which stays for
// dev.html). The Experiment 3 recorder is kept under "Study tools" and writes the same rows (same storage
// key, same CSV).
import { toCsv } from './camera-calib.js';
import { isLowPowerDevice } from './distance.js';

const ROWS_KEY = 'distance_check_rows';
const DEFAULT_KNOWN_MM = 500;
const TAU = Math.PI * 2;

// Reasons src/distance.js gives for "no distance right now", in plain words.
const REASON_TEXT = {
  no_face: 'No face found. Look at the screen.',
  two_faces: 'More than one face in view.',
  head_turned: 'Turn your head toward the camera.',
  stale: 'Hold still for a moment…',
  not_calibrated: 'Face found. Measuring…',
};

// Why an automatic calibration is still waiting, in plain words (reasons from autoCalibrateCamera).
const AUTO_TEXT = {
  collecting: 'Measuring the distance between your eyes. Hold still and look at the screen…',
  hold_still: 'Hold your head still for a moment…',
  no_iris: 'Your eyes are not clear enough. Add light in front of you and look at the camera.',
  implausible: 'That measurement looked wrong. Look straight at the camera…',
};

// How the calibration was made (distance.getCalibrationMethod), in plain words.
const METHOD_TEXT = {
  tape: 'Calibrated with a tape for this camera.',
  auto_focal: 'Calibrated automatically (this camera was measured with a tape before).',
  auto: 'Calibrated automatically. The distance is an estimate and can be off by up to about 20%. '
    + 'For a precise distance, check once with a tape below.',
};

export function describeReason(reason) {
  return REASON_TEXT[reason] ?? String(reason);
}

/** The line under the camera during the test: '' while the face is seen, else what is wrong. */
export function testCameraStatus(d) {
  if (d?.reason === null || d?.reason === undefined) return '';
  return describeReason(d.reason);
}

/**
 * A camera start-up error in plain words, with what to do about it.
 * @param {Error} err  from getUserMedia, src/distance.js or src/pi-camera.js
 * @param {{lowPower?: boolean}} [o]  lowPower: a Raspberry Pi or similar board, which gets Pi-specific hints
 */
export function cameraErrorText(err, { lowPower = isLowPowerDevice() } = {}) {
  const name = err?.name ?? '';
  const pi = (text) => (lowPower ? ` ${text}` : '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission denied/i.test(err?.message ?? '')) {
    return 'The browser is blocking the camera. Click the camera icon in the address bar (or the site settings), '
      + 'allow the camera, then press Try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. Connect a camera and press Try again.'
      + pi('On a Raspberry Pi a USB camera should appear by itself (check with: ls /dev/video*). The ribbon-cable '
        + 'Camera Module is not visible to Chromium until it is set up for browsers (see pi/README.md); or choose '
        + 'Raspberry Pi in the list and run pi/camera_server.py.');
  }
  if (name === 'OverconstrainedError') return 'The chosen camera is not available any more. Choose another camera in the list.';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'Another program is using the camera, or it did not start. Close other programs that use it and press Try again.'
      + pi('On a Raspberry Pi, pi/camera_server.py also holds the camera while it runs: stop it, or choose '
        + 'Raspberry Pi in the list to use it.');
  }
  if (name === 'InsecureContextError') {
    return `${err.message} This page is ${globalThis.location?.origin ?? 'not secure'}. Open the app over https `
      + '(for example the GitHub Pages address) or on http://localhost, or choose Raspberry Pi in the list.';
  }
  if (name === 'NotSupportedError') return `${err.message} Use a current Chrome, Chromium, Edge, Firefox or Safari.`;
  if (name === 'FaceTrackerError') {
    return `${err.message}. Reload the page and try again, or use another browser.`
      + pi('On a Raspberry Pi, close other tabs to free memory and try again.');
  }
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
let activeDistance = null; // the src/distance.js module the mounted step uses

/** Remove the camera step and let go of the camera it was showing. */
export function unmountCameraStep(container) {
  generation += 1;
  activeDistance?.stopDistance?.();
  activeDistance = null;
  container.querySelector('video')?.srcObject?.getTracks().forEach((track) => track.stop());
  container.textContent = '';
}

/**
 * @param {HTMLElement} container  where the step goes; its content is replaced
 * @param {object} o
 * @param {object|null} o.distance  the src/distance.js module, or null when it could not be prepared
 * @param {string} [o.error]  why the camera cannot start (shown instead of the picture)
 * @param {string} o.participant  the code the calibration belongs to ('' until step 1 is filled in)
 * @param {{settings: {source: string, piUrl: string, deviceId?: string, deviceLabel?: string}, label: string}} o.source
 *   the camera in use
 * @param {(next: {source: string, piUrl: string, deviceId?: string, deviceLabel?: string}) => string} o.onSourceChange
 *   called with another camera (or the same one, to try again); returns '' or a message
 * @param {(calibrated: boolean) => void} [o.onCalibrated]  called when the calibration state changes
 * @param {() => void} [o.onCameraOff]  called when the user turns the camera off
 */
export function mountCameraStep(container, {
  distance, error = '', participant, source, onSourceChange, onCalibrated, onCameraOff,
}) {
  const gen = ++generation;
  activeDistance = distance;
  container.innerHTML = `
    <div class="cam">
      <div class="cam-pick">
        <label class="field">
          <span class="label">Camera</span>
          <select name="cameraChoice"></select>
        </label>
        <button type="button" class="small" data-act="power">Turn camera off</button>
      </div>
      <label class="field pi-address" hidden>
        <span class="label">Raspberry Pi address</span>
        <input name="piUrl" autocomplete="off" inputmode="url" placeholder="raspberrypi.local:8000">
        <small>Leave empty if you opened this page from the Pi. On an https page the Pi server must run with --https (see pi/README.md).</small>
      </label>
      <p class="hint cam-source-error" role="alert"></p>

      <div class="cam-view">
        <video muted playsinline></video>
        <canvas></canvas>
        <p class="cam-chip" role="status"></p>
        <p class="cam-dist"></p>
      </div>
      <div class="cam-alert" role="alert" hidden>
        <p></p>
        <button type="button" class="small" data-act="retry">Try again</button>
      </div>

      <div class="cam-calib">
        <p class="cam-calib-status" role="status"></p>
        <div class="cam-progress" hidden><span></span></div>
        <div class="row"><button type="button" class="small" data-act="recalibrate" hidden>Calibrate again</button></div>
        <details class="more cam-tape">
          <summary>Check with a tape (more precise)</summary>
          <p class="hint cam-howto"></p>
          <label class="field">
            <span class="label">Calibration distance, mm</span>
            <input name="knownMm" type="number" min="100" max="2000" value="${DEFAULT_KNOWN_MM}">
          </label>
          <div class="row">
            <button type="button" class="small" data-act="calibrate" disabled>Calibrate</button>
          </div>
        </details>
      </div>

      <details class="more cam-study">
        <summary>Study tools</summary>
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
  const live = () => gen === generation && container.isConnected;
  const view = q('.cam-view');
  const video = q('video');
  const canvas = q('canvas');
  const ctx = canvas.getContext('2d');
  const chip = q('.cam-chip');
  const distText = q('.cam-dist');
  const alertBox = q('.cam-alert');
  const powerBtn = q('[data-act=power]');
  const calibrateBtn = q('[data-act=calibrate]');
  const recalibrateBtn = q('[data-act=recalibrate]');
  const calibStatus = q('.cam-calib-status');
  const progress = q('.cam-progress');
  const knownMm = () => Number(input('knownMm').value);

  // ----- which camera: this computer's cameras by name, or a Raspberry Pi on the network
  const select = input('cameraChoice');
  const piField = q('.pi-address');
  const settings = source.settings;
  input('piUrl').value = settings.piUrl;
  function fillChoices(cameras) {
    const current = settings.source === 'pi' ? 'pi'
      : `local:${settings.deviceId || distance?.activeDeviceId?.() || ''}`;
    const options = cameras.map((c) => [`local:${c.deviceId}`, c.label]);
    if (settings.source === 'local' && !options.some(([v]) => v === current)) {
      options.unshift([current, settings.deviceLabel || (cameras.length ? 'Default camera' : 'This computer’s camera')]);
    }
    options.push(['pi', 'Raspberry Pi over the network']);
    select.textContent = '';
    for (const [value, label] of options) select.append(new Option(label, value, false, value === current));
    piField.hidden = select.value !== 'pi';
  }
  fillChoices([]);
  async function refreshChoices() {
    let cameras = [];
    try {
      cameras = (await distance?.listCameras?.()) ?? [];
    } catch {
      // No list (old browser): the current choice and the Pi stay selectable.
    }
    if (live()) fillChoices(cameras);
  }
  const choose = () => {
    const value = select.value;
    piField.hidden = value !== 'pi';
    const next = value === 'pi'
      ? { source: 'pi', piUrl: input('piUrl').value.trim() }
      : { source: 'local', piUrl: input('piUrl').value.trim(), deviceId: value.slice('local:'.length),
        deviceLabel: select.selectedOptions[0]?.textContent ?? '' };
    q('.cam-source-error').textContent = onSourceChange(next);
  };
  select.addEventListener('change', choose);
  input('piUrl').addEventListener('change', choose);
  const onDeviceChange = () => { if (live()) refreshChoices(); else navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange); };
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

  // ----- camera: started here, so the browser asks for permission as soon as Camera is chosen
  let started = false;
  const showAlert = (text) => {
    alertBox.querySelector('p').textContent = text;
    alertBox.hidden = !text;
    view.classList.toggle('is-off', Boolean(text));
  };
  q('[data-act=retry]').addEventListener('click', () => {
    q('.cam-source-error').textContent = onSourceChange({ ...settings });
  });
  function start() {
    showAlert('');
    started = false;
    view.classList.remove('is-paused');
    powerBtn.hidden = false;
    powerBtn.textContent = 'Turn camera off';
    chip.className = 'cam-chip';
    chip.textContent = settings.source === 'pi' ? 'Connecting to the Raspberry Pi…' : 'Allow the camera if the browser asks…';
    distance.setParticipant(participant);
    distance.startDistance(video).then(() => {
      if (!live()) return;
      started = true;
      refreshChoices(); // camera names are known only after permission was given
    }).catch((err) => {
      if (!live()) return;
      powerBtn.hidden = true; // "Try again" is the way back
      showAlert(cameraErrorText(err));
      refreshChoices(); // the way out may be another camera
    });
  }
  function stop() {
    started = false;
    distance.stopDistance();
    onCameraOff?.();
    view.classList.add('is-paused');
    chip.textContent = 'Camera is off.';
    distText.textContent = '';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    powerBtn.textContent = 'Turn camera on';
  }
  if (error || !distance) {
    showAlert(error || 'The camera module could not be loaded.');
    powerBtn.hidden = true;
  } else {
    start();
  }
  powerBtn.addEventListener('click', () => {
    if (view.classList.contains('is-paused') || !alertBox.hidden) start(); else stop();
  });

  // ----- calibration: automatic from the eyes; a tape calibration is optional and more precise
  const syncHowto = () => {
    const cm = knownMm() / 10;
    q('.cam-howto').textContent = `Sit so that your eyes are ${cm} cm from the screen, measured with a tape or ruler. `
      + 'Look at the camera, then press the button. This also measures the camera itself, so later automatic '
      + 'calibrations with it are more precise.';
    calibrateBtn.textContent = `Calibrate at ${cm} cm`;
  };
  syncHowto();
  input('knownMm').addEventListener('input', syncHowto);

  let flash = { text: '', until: 0 };
  calibrateBtn.addEventListener('click', () => {
    try {
      distance.calibrateCamera(participant, knownMm());
      flash = { text: `Calibrated with a tape at ${knownMm() / 10} cm.`, until: Date.now() + 4000 };
    } catch (err) {
      flash = { text: describeReason(err.message.replace(/^cannot calibrate: /, '')), until: Date.now() + 4000 };
    }
  });
  recalibrateBtn.addEventListener('click', () => {
    distance.clearCalibration(participant);
    flash = { text: '', until: 0 };
  });

  // ----- live view: one pass per frame, text only when it changes
  const set = (el, prop, value) => { if (el[prop] !== value) el[prop] = value; };
  let wasCalibrated = null;
  let auto = null; // last answer of autoCalibrateCamera while not calibrated
  function tick() {
    if (!live()) return;
    requestAnimationFrame(tick);
    if (!started) {
      progress.hidden = true;
      if (!distance || !alertBox.hidden || view.classList.contains('is-paused')) {
        set(calibStatus, 'textContent', '');
      }
      return;
    }

    const d = distance.getDistance(participant || null);
    const faceOk = d.reason === null || d.reason === 'not_calibrated';
    let calibrated = Boolean(participant && distance.getK(participant));
    if (participant && !calibrated && faceOk) {
      auto = distance.autoCalibrateCamera(participant);
      if (auto.ok) {
        calibrated = true;
        flash = { text: `Calibrated automatically: ${Math.round(auto.eyeSpanMm)} mm between the outer eye corners.`, until: Date.now() + 4000 };
      }
    }
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
    let pct = null;
    if (flash.until > Date.now()) status = flash.text;
    else if (!participant) status = 'Enter the participant code in step 1: the calibration belongs to it.';
    else if (calibrated) status = METHOD_TEXT[distance.getCalibrationMethod(participant)] ?? METHOD_TEXT.tape;
    else if (!faceOk) status = describeReason(d.reason);
    else {
      status = AUTO_TEXT[auto?.reason] ?? AUTO_TEXT.collecting;
      pct = auto?.reason === 'collecting' ? Math.round(auto.progress * 100) : null;
    }
    set(calibStatus, 'textContent', status);
    progress.hidden = pct == null;
    if (pct != null) progress.firstElementChild.style.width = `${pct}%`;
    recalibrateBtn.hidden = !calibrated;
    calibrateBtn.disabled = !faceOk || !participant;
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
    if (!distance || !participant) { recStatus.textContent = 'Not recorded: the camera or the participant code is missing.'; return; }
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
