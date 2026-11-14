// AI-assisted (Claude Code), reviewed by a team member.
// Link to the optional sensor module: a Raspberry Pi 4 with an HC-SR04 that sends
// {"v":1,"mm":512,"ok":1,"lux":310.5} every 60 ms over WebSocket (pi/sensor_server.py).
// This is the only module that talks to the network, and only to the Pi on the local network.
//
// getSensorDistance() has the same shape as getDistance() in distance.js:
//   { mm, ageMs, ok, reason }  with reason one of
//   needs_localhost, not_connected, stale, not_calibrated, out_of_range (null when ok).
// sensorMm = median(raw mm over the last 0.5 s) + offsetMm; offsetMm = knownMm - raw median at calibration.

export const DEFAULT_URL = 'ws://raspberrypi.local:8765';
export const WINDOW_MS = 500;
export const STALE_MS = 500;
export const RECONNECT_MS = 2000;
export const OFFSET_KEY = 'sensor_offset_mm';

// ---- pure helpers (unit-tested) -------------------------------------------------------------------------

// false when the page is served over https: the browser blocks ws:// from https pages.
export function canUseSensor(protocol = globalThis.location?.protocol) {
  return protocol !== 'https:';
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeOffset(knownMm, rawMedianMm) {
  return knownMm - rawMedianMm;
}

export function applyOffset(rawMm, offsetMm) {
  return rawMm + offsetMm;
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Parses one server message. Returns
//   { type: 'reading', mm, ok, lux }  |  { type: 'hello', camera }  |  { type: 'clients', clients }  |  null
// null for anything broken or unknown; callers skip it without an error.
export function parseMessage(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.v !== 1) return null;
  if ('mm' in m || 'ok' in m) {
    if (m.ok !== 0 && m.ok !== 1) return null;
    const lux = m.lux === null || m.lux === undefined ? null : isNum(m.lux) ? m.lux : undefined;
    if (lux === undefined) return null;
    if (m.ok === 1) {
      if (!isNum(m.mm) || m.mm <= 0) return null;
      return { type: 'reading', mm: m.mm, ok: true, lux };
    }
    return { type: 'reading', mm: null, ok: false, lux };
  }
  if ('hello' in m) return { type: 'hello', camera: m.camera === true };
  if ('clients' in m && Number.isInteger(m.clients)) return { type: 'clients', clients: m.clients };
  return null;
}

// ---- Experiment 5: sensor_check.csv ---------------------------------------------------------------------

export const SENSOR_CHECK_COLUMNS = Object.freeze([
  'participant', 'glasses', 'tapeMm', 'sensorRawMm', 'sensorMm', 'cameraMm', 'lux', 'timestamp',
]);

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function sensorCheckCsv(rows) {
  const lines = [SENSOR_CHECK_COLUMNS.join(',')];
  for (const r of rows) lines.push(SENSOR_CHECK_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}

// Error per tape distance (and glasses yes/no): error % = (sensorMm - tapeMm) / tapeMm * 100.
// -> [{ tapeMm, glasses, n, meanErrPct, meanAbsErrPct, maxAbsErrPct }] sorted by tapeMm, then glasses.
export function summarizeSensorCheck(rows) {
  const groups = new Map();
  for (const r of rows) {
    const tape = Number(r.tapeMm);
    const s = Number(r.sensorMm);
    if (!(tape > 0) || !Number.isFinite(s)) continue;
    const key = `${tape}|${r.glasses}`;
    if (!groups.has(key)) groups.set(key, { tapeMm: tape, glasses: r.glasses, errs: [] });
    groups.get(key).errs.push(((s - tape) / tape) * 100);
  }
  return [...groups.values()]
    .map(({ tapeMm, glasses, errs }) => ({
      tapeMm,
      glasses,
      n: errs.length,
      meanErrPct: errs.reduce((a, b) => a + b, 0) / errs.length,
      meanAbsErrPct: errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length,
      maxAbsErrPct: Math.max(...errs.map(Math.abs)),
    }))
    .sort((a, b) => a.tapeMm - b.tapeMm || String(a.glasses).localeCompare(String(b.glasses)));
}

// ---- the link (state) ----------------------------------------------------------------------------------

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Dependencies are injectable for tests; the browser uses the defaults.
export function createSensorLink({
  now = () => performance.now(),
  storage = defaultStorage(),
  WebSocketImpl = () => globalThis.WebSocket,
  protocol = () => globalThis.location?.protocol,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const st = {
    url: null,
    socket: null,
    status: 'idle', // idle | connecting | open | closed
    wanted: false,
    retry: null,
    samples: [], // { t, mm, ok } readings of the last WINDOW_MS
    lastAt: null, // time of the newest reading
    lastLux: null,
    camera: null,
    clients: null,
    offsetMm: undefined, // undefined = not read from storage yet
  };
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  const can = () => canUseSensor(protocol());

  function prune(t) {
    while (st.samples.length && t - st.samples[0].t > WINDOW_MS) st.samples.shift();
  }

  function onText(text) {
    const m = parseMessage(text);
    if (!m) return;
    if (m.type === 'reading') {
      const t = now();
      st.samples.push({ t, mm: m.mm, ok: m.ok });
      st.lastAt = t;
      st.lastLux = m.lux;
      prune(t);
    } else if (m.type === 'hello') {
      st.camera = m.camera;
    } else if (m.type === 'clients') {
      st.clients = m.clients;
    }
    notify();
  }

  function scheduleRetry() {
    if (!st.wanted || st.retry !== null) return;
    st.retry = setTimer(() => {
      st.retry = null;
      if (st.wanted) open();
    }, RECONNECT_MS);
  }

  function open() {
    const WS = WebSocketImpl();
    st.status = 'connecting';
    notify();
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WS(st.url);
      } catch (e) {
        st.status = 'closed';
        scheduleRetry();
        notify();
        reject(e);
        return;
      }
      st.socket = ws;
      ws.onopen = () => {
        if (st.socket !== ws) return;
        st.status = 'open';
        notify();
        settled = true;
        resolve();
      };
      ws.onmessage = (e) => {
        if (st.socket === ws) onText(typeof e.data === 'string' ? e.data : '');
      };
      ws.onerror = () => {}; // onclose follows
      ws.onclose = () => {
        if (st.socket !== ws) return;
        st.socket = null;
        st.status = 'closed';
        st.samples = [];
        notify();
        scheduleRetry();
        if (!settled) {
          settled = true;
          reject(new Error('not_connected'));
        }
      };
    });
  }

  function connectSensor(url = DEFAULT_URL) {
    if (!can()) return Promise.reject(new Error('needs_localhost'));
    disconnectSensor();
    st.url = url;
    st.wanted = true;
    return open();
  }

  function disconnectSensor() {
    st.wanted = false;
    if (st.retry !== null) {
      clearTimer(st.retry);
      st.retry = null;
    }
    const ws = st.socket;
    st.socket = null;
    st.samples = [];
    st.lastAt = null;
    st.status = 'idle';
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    notify();
  }

  function getSensorOffset() {
    if (st.offsetMm === undefined) {
      let v = null;
      try {
        const raw = storage?.getItem(OFFSET_KEY);
        v = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      } catch {
        v = null;
      }
      st.offsetMm = Number.isFinite(v) ? v : null;
    }
    return st.offsetMm;
  }

  // Median of raw mm over the last 0.5 s, or a reason why there is none.
  function rawState() {
    const t = now();
    if (!can()) return { reason: 'needs_localhost', ageMs: null };
    if (st.status !== 'open') return { reason: 'not_connected', ageMs: null };
    const ageMs = st.lastAt === null ? null : t - st.lastAt;
    if (ageMs === null || ageMs > STALE_MS) return { reason: 'stale', ageMs };
    prune(t);
    const newest = st.samples[st.samples.length - 1];
    const okMm = st.samples.filter((s) => s.ok).map((s) => s.mm);
    if (!newest?.ok || !okMm.length) return { reason: 'out_of_range', ageMs };
    return { reason: null, ageMs, rawMm: median(okMm) };
  }

  // { mm, ageMs, ok, reason } - same shape as getDistance(); plus rawMm (median before the offset).
  function getSensorDistance() {
    const r = rawState();
    let reason = r.reason;
    const offset = getSensorOffset();
    // not_calibrated is reported once the sensor itself is readable, as in distance.js
    if (reason === null && offset === null) reason = 'not_calibrated';
    const ok = reason === null;
    return {
      mm: ok ? applyOffset(r.rawMm, offset) : null,
      ageMs: r.ageMs,
      ok,
      reason,
      rawMm: r.rawMm ?? null,
    };
  }

  // offsetMm = knownMm - median raw mm; stored in localStorage (sensor_offset_mm). Returns offsetMm.
  // Throws when there is no usable reading to calibrate from.
  function calibrateSensor(knownMm) {
    if (!(knownMm > 0)) throw new Error('knownMm must be a positive number');
    const r = rawState();
    if (r.reason) throw new Error(`cannot calibrate: ${r.reason}`);
    const offset = computeOffset(knownMm, r.rawMm);
    st.offsetMm = offset;
    try {
      storage?.setItem(OFFSET_KEY, String(offset));
    } catch {
      /* storage unavailable: offset kept for this page only */
    }
    notify();
    return offset;
  }

  function clearSensorCalibration() {
    st.offsetMm = null;
    try {
      storage?.removeItem(OFFSET_KEY);
    } catch {
      /* ignore */
    }
    notify();
  }

  // { lux, ageMs, ok } - light estimate from the newest reading; lux is null without a camera.
  function getAmbient() {
    const t = now();
    const ageMs = st.lastAt === null ? null : t - st.lastAt;
    const fresh = can() && st.status === 'open' && ageMs !== null && ageMs <= STALE_MS;
    const lux = fresh ? st.lastLux : null;
    return { lux, ageMs, ok: lux !== null };
  }

  function getSensorStatus() {
    return { status: st.status, url: st.url, camera: st.camera, clients: st.clients, canUse: can() };
  }

  function onSensorChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    canUseSensor: () => can(),
    connectSensor,
    disconnectSensor,
    calibrateSensor,
    clearSensorCalibration,
    getSensorDistance,
    getSensorOffset,
    getAmbient,
    getSensorStatus,
    onSensorChange,
  };
}

// ---- module-level link used by the app (contract functions) --------------------------------------------

const link = createSensorLink();
export const connectSensor = link.connectSensor;
export const disconnectSensor = link.disconnectSensor;
export const calibrateSensor = link.calibrateSensor;
export const clearSensorCalibration = link.clearSensorCalibration;
export const getSensorDistance = link.getSensorDistance;
export const getSensorOffset = link.getSensorOffset;
export const getAmbient = link.getAmbient;
export const getSensorStatus = link.getSensorStatus;
export const onSensorChange = link.onSensorChange;
