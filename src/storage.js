// AI-assisted (Claude Code), reviewed by a team member.
// Session storage in localStorage (key sessions_v1) and CSV / JSON export-import.

export const STORAGE_KEY = 'sessions_v1';
export const JSON_FORMAT = 'vision-acuity-sessions';
export const JSON_VERSION = 1;

// Column order is fixed by the module contract ("Формат данных"). Do not reorder or rename.
export const SESSION_COLUMNS = Object.freeze([
  'session_id', 'started_at', 'participant', 'eye', 'glasses', 'condition', 'target_mm',
  'mean_mm', 'sd_mm', 'distance_mode', 'logmar', 'outcome', 'n_trials', 'n_correct',
  'floor_hit', 'near_floor', 'screen_floor_logmar', 'px_per_mm', 'dpr', 'cam_k',
  'app_version', 'notes',
]);
export const TRIAL_COLUMNS = Object.freeze([
  'session_id', 'trial_index', 'phase', 'logmar', 'orientation', 'response', 'correct',
  'valid', 'distance_mm', 'size_css_px', 'gap_device_px', 'rt_ms',
]);

export const OUTCOMES = Object.freeze(['ok', 'floor_hit', 'worse_than_1.3', 'aborted_camera', 'aborted_user']);

function store() {
  const s = globalThis.localStorage;
  if (!s) throw new Error('localStorage is not available');
  return s;
}

function readAll() {
  const raw = store().getItem(STORAGE_KEY);
  if (raw == null || raw === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Never overwrite data we cannot read: surface the problem instead.
    throw new Error(`${STORAGE_KEY} in localStorage is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${STORAGE_KEY} in localStorage is not an array`);
  return parsed;
}

function writeAll(sessions) {
  store().setItem(STORAGE_KEY, JSON.stringify(sessions));
}

/** Returns a list of problems; empty when the session has the contract shape. */
export function validateSession(s) {
  const errs = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['session is not an object'];
  for (const c of SESSION_COLUMNS) if (!(c in s)) errs.push(`missing field ${c}`);
  if (typeof s.session_id !== 'string' || !s.session_id) errs.push('session_id must be a non-empty string');
  if (!OUTCOMES.includes(s.outcome)) errs.push(`unknown outcome ${JSON.stringify(s.outcome)}`);
  if (s.outcome === 'ok' && !Number.isFinite(s.logmar)) errs.push('outcome ok requires a numeric logmar');
  if (s.outcome !== 'ok' && s.logmar != null) errs.push('logmar must be empty unless outcome is ok');
  if (!Array.isArray(s.trials)) errs.push('trials must be an array');
  else {
    s.trials.forEach((t, i) => {
      for (const c of TRIAL_COLUMNS) if (!(c in t)) errs.push(`trial ${i + 1}: missing field ${c}`);
      if (t.session_id !== s.session_id) errs.push(`trial ${i + 1}: session_id does not match`);
    });
  }
  return errs;
}

export function saveSession(session) {
  const errs = validateSession(session);
  if (errs.length) throw new Error(`saveSession: ${errs.join('; ')}`);
  const all = readAll();
  if (all.some((s) => s.session_id === session.session_id)) {
    throw new Error(`saveSession: session ${session.session_id} already exists`);
  }
  all.push(session);
  writeAll(all);
  return session.session_id;
}

/**
 * @param {object|function} [filter] predicate, or an object of exact-match fields
 *   (e.g. {participant:'A', condition:'rep'}).
 */
export function listSessions(filter) {
  const all = readAll();
  if (!filter) return all;
  if (typeof filter === 'function') return all.filter(filter);
  const entries = Object.entries(filter).filter(([, v]) => v !== undefined && v !== '');
  return all.filter((s) => entries.every(([k, v]) => s[k] === v));
}

export function deleteSession(id) {
  const all = readAll();
  const next = all.filter((s) => s.session_id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Two CSV files as UTF-8 strings (no BOM): { 'sessions.csv': string, 'trials.csv': string }. */
export function exportCsv(sessions = listSessions()) {
  const trials = sessions.flatMap((s) => (s.trials ?? []).map((t) => ({ ...t, session_id: s.session_id })));
  return {
    'sessions.csv': toCsv(SESSION_COLUMNS, sessions),
    'trials.csv': toCsv(TRIAL_COLUMNS, trials),
  };
}

export function exportJson() {
  return JSON.stringify({
    format: JSON_FORMAT, version: JSON_VERSION,
    exported_at: new Date().toISOString(), sessions: listSessions(),
  }, null, 2);
}

/**
 * Merge sessions from an exportJson() file. Existing sessions are never modified or removed.
 * Duplicate session_ids are skipped. Nothing is written if the file is malformed.
 * @returns {{added:number, skipped:number, errors:string[]}}
 */
export function importJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`importJson: not valid JSON (${err.message})`);
  }
  if (!doc || doc.format !== JSON_FORMAT || !Array.isArray(doc.sessions)) {
    throw new Error(`importJson: expected {"format":"${JSON_FORMAT}","sessions":[...]}`);
  }
  if (doc.version !== JSON_VERSION) {
    throw new Error(`importJson: unsupported version ${doc.version} (expected ${JSON_VERSION})`);
  }
  const all = readAll();
  const ids = new Set(all.map((s) => s.session_id));
  const errors = [];
  let added = 0;
  let skipped = 0;
  doc.sessions.forEach((s, i) => {
    const errs = validateSession(s);
    if (errs.length) {
      errors.push(`session #${i + 1}: ${errs.join('; ')}`);
      skipped += 1;
      return;
    }
    if (ids.has(s.session_id)) {
      skipped += 1;
      return;
    }
    ids.add(s.session_id);
    all.push(s);
    added += 1;
  });
  if (added) writeAll(all);
  return { added, skipped, errors };
}
