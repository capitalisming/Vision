// Camera calibration screen (#screen-camera) and the Experiment 3 recorder.
import { mountDistanceDebug, calibrateCamera, getDistance, getK, setParticipant } from './distance.js';

const ROWS_KEY = 'distance_check_rows';
const CSV_FIELDS = ['participant', 'glasses', 'tapeMm', 'cameraMm', 'eyeSpanPx', 'timestamp'];

function loadRows() {
  try {
    return JSON.parse(localStorage.getItem(ROWS_KEY)) || [];
  } catch {
    return [];
  }
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_FIELDS.join(','), ...rows.map((r) => CSV_FIELDS.map((f) => cell(r[f])).join(','))].join('\n') + '\n';
}

export function mountCameraCalib(container = document.getElementById('screen-camera')) {
  container.innerHTML = `
    <h2>Camera calibration</h2>
    <p class="calib-instr" style="font-size:1.2em">Sit so that your eyes are 500 mm from the screen
      (measure with a ruler), look straight at the camera, press Save.</p>
    <div class="calib-form" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:12px">
      <label>Participant <input name="participant" value="P1" size="8"></label>
      <label>Known distance, mm <input name="knownMm" type="number" min="100" max="2000" value="500" style="width:6em"></label>
      <button name="save">Save</button>
      <span class="calib-status"></span>
    </div>
    <div class="calib-video"></div>
    <p class="calib-live" style="font:700 32px system-ui"></p>

    <h3>Experiment 3: camera vs tape</h3>
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:end">
      <label><input name="glasses" type="checkbox"> Glasses on</label>
      <label>Tape, mm <input name="tapeMm" type="number" min="100" max="2000" style="width:6em"></label>
      <button name="record">Record</button>
      <button name="download">Download distance_check.csv</button>
      <button name="clear">Clear rows</button>
      <span class="rec-status"></span>
    </div>
    <table class="rec-table" style="margin-top:8px;border-collapse:collapse">
      <thead><tr><th>participant</th><th>glasses</th><th>tape mm</th><th>camera mm</th><th>error %</th><th>eyeSpanPx</th><th>time</th></tr></thead>
      <tbody></tbody>
    </table>`;

  const q = (sel) => container.querySelector(sel);
  const input = (name) => q(`[name="${name}"]`);
  const status = q('.calib-status');
  const recStatus = q('.rec-status');
  const live = q('.calib-live');
  let rows = loadRows();

  const participant = () => input('participant').value.trim();
  const showK = () => {
    setParticipant(participant());
    const k = getK(participant());
    status.textContent = k ? `calibrated (k = ${k.toFixed(0)})` : 'not calibrated';
  };
  input('participant').addEventListener('input', showK);
  showK();

  const { started } = mountDistanceDebug(q('.calib-video'));
  started.catch((e) => {
    status.textContent = `Camera error: ${e.message}`;
  });

  input('save').addEventListener('click', () => {
    try {
      calibrateCamera(participant(), Number(input('knownMm').value));
      showK();
    } catch (e) {
      status.textContent = e.message;
    }
  });

  const tick = () => {
    if (!container.isConnected) return;
    const d = getDistance(participant());
    live.textContent = d.ok ? `Current distance: ${Math.round(d.mm)} mm` : `Current distance: — (${d.reason})`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const renderRows = () => {
    q('.rec-table tbody').innerHTML = rows
      .map((r) => {
        const err = ((r.cameraMm - r.tapeMm) / r.tapeMm) * 100;
        const bad = Math.abs(err) > 10 ? ' style="color:#c00;font-weight:700"' : '';
        const name = String(r.participant).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        return `<tr><td>${name}</td><td>${r.glasses ? 'yes' : 'no'}</td><td>${r.tapeMm}</td>
          <td>${r.cameraMm.toFixed(0)}</td><td${bad}>${err.toFixed(1)}</td>
          <td>${r.eyeSpanPx.toFixed(1)}</td><td>${r.timestamp}</td></tr>`;
      })
      .join('');
    localStorage.setItem(ROWS_KEY, JSON.stringify(rows));
  };
  renderRows();

  input('record').addEventListener('click', () => {
    const tapeMm = Number(input('tapeMm').value);
    if (!(tapeMm > 0)) {
      recStatus.textContent = 'Enter the tape distance in mm';
      return;
    }
    const d = getDistance(participant());
    if (!d.ok) {
      recStatus.textContent = `Not recorded: ${d.reason}`;
      return;
    }
    rows.push({
      participant: participant(),
      glasses: input('glasses').checked,
      tapeMm,
      cameraMm: d.mm,
      eyeSpanPx: d.eyeSpanPx,
      timestamp: new Date().toISOString(),
    });
    recStatus.textContent = `Recorded ${rows.length} rows`;
    renderRows();
  });

  input('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'distance_check.csv' });
    a.click();
    URL.revokeObjectURL(url);
  });

  input('clear').addEventListener('click', () => {
    if (rows.length && confirm(`Delete all ${rows.length} recorded rows?`)) {
      rows = [];
      renderRows();
    }
  });
}
