// AI-assisted (Claude Code), reviewed by a team member.
// Sessions here are SYNTHETIC (scripted observer), used only to exercise storage and export.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveSession, listSessions, deleteSession, exportCsv, exportJson, importJson,
  SESSION_COLUMNS, TRIAL_COLUMNS, STORAGE_KEY,
} from '../src/storage.js';
import { runProcedure, buildSession } from '../src/acuity-test.js';
import { installLocalStorage, scriptedObserver, manualDistance, noWait } from './helpers.mjs';

globalThis.devicePixelRatio = 1;
let mem;
beforeEach(() => { mem = installLocalStorage(); });

async function makeSession(i, overrides = {}) {
  const present = scriptedObserver((phase, lm) => (phase === 'descent' ? lm >= 0.4 : ({ 0.5: 5, 0.4: 5, 0.3: 4, 0.2: 2 }[lm] ?? 0)));
  const r = await runProcedure({ getDistance: manualDistance(1000), pxPerMm: 3.78, present, wait: noWait });
  return buildSession({
    participant: ['A', 'B', 'M'][i % 3], eye: 'OD', glasses: i % 2 ? 'yes' : 'no', condition: 'rep',
    targetMm: 1000, pxPerMm: 3.78, distanceMode: 'manual', ...overrides,
  }, r, new Date(Date.UTC(2026, 10, 14, 15, i)).toISOString());
}

/** Minimal RFC 4180 parser for the round-trip check. */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  return rows;
}

test('save, list with filter, delete', async () => {
  const a = await makeSession(0);
  const b = await makeSession(1);
  saveSession(a); saveSession(b);
  assert.equal(listSessions().length, 2);
  assert.equal(listSessions({ participant: 'B' }).length, 1);
  assert.equal(listSessions((s) => s.glasses === 'no').length, 1);
  assert.throws(() => saveSession(a), /already exists/);
  assert.equal(deleteSession(a.session_id), true);
  assert.equal(deleteSession(a.session_id), false);
  assert.deepEqual(listSessions().map((s) => s.session_id), [b.session_id]);
});

test('rejects sessions that break the contract (number without ok, unknown outcome)', async () => {
  const s = await makeSession(0);
  assert.throws(() => saveSession({ ...s, outcome: 'floor_hit' }), /logmar must be empty/);
  assert.throws(() => saveSession({ ...s, outcome: 'camera_stop', logmar: null }), /unknown outcome/);
  const { notes, ...missing } = s;
  assert.throws(() => saveSession(missing), /missing field notes/);
});

test('ten sessions -> 10 rows in sessions.csv, every trial in trials.csv with its session_id', async () => {
  const ids = [];
  let trialTotal = 0;
  for (let i = 0; i < 10; i++) {
    const s = await makeSession(i);
    saveSession(s); ids.push(s.session_id); trialTotal += s.trials.length;
  }
  const files = exportCsv();
  const sess = parseCsv(files['sessions.csv']);
  const trials = parseCsv(files['trials.csv']);
  assert.deepEqual(sess[0], [...SESSION_COLUMNS]);
  assert.deepEqual(trials[0], [...TRIAL_COLUMNS]);
  assert.equal(sess.length - 1, 10);
  assert.equal(trials.length - 1, trialTotal);
  const sid = new Set(ids);
  assert.ok(trials.slice(1).every((r) => sid.has(r[0])));
  for (const id of ids) {
    const n = listSessions().find((s) => s.session_id === id).trials.length;
    assert.equal(trials.filter((r) => r[0] === id).length, n);
  }
  // Decimal point, booleans, empty for null.
  const row = Object.fromEntries(SESSION_COLUMNS.map((c, i) => [c, sess[1][i]]));
  assert.equal(row.logmar, '0.28');
  assert.equal(row.floor_hit, 'false');
  assert.equal(row.cam_k, '');
  assert.ok(!files['sessions.csv'].startsWith('﻿'), 'no BOM');
  console.log(`  10 sessions -> ${trials.length - 1} trial rows`);
});

test('CSV escaping of commas, quotes and newlines', async () => {
  const s = await makeSession(0, { condition: 'dose, "-1D"\nnear' });
  saveSession(s);
  const rows = parseCsv(exportCsv()['sessions.csv']);
  assert.equal(rows[1][SESSION_COLUMNS.indexOf('condition')], 'dose, "-1D"\nnear');
  assert.equal(rows[1].length, SESSION_COLUMNS.length);
});

test('JSON export/import round trip merges, skips duplicates, keeps existing data', async () => {
  const a = await makeSession(0); const b = await makeSession(1);
  saveSession(a); saveSession(b);
  const json = exportJson();
  mem.clear();
  const c = await makeSession(2);
  saveSession(c);
  let r = importJson(json);
  assert.deepEqual(r, { added: 2, skipped: 0, errors: [] });
  assert.equal(listSessions().length, 3);
  r = importJson(json);
  assert.deepEqual(r, { added: 0, skipped: 2, errors: [] });
  assert.deepEqual(listSessions().find((s) => s.session_id === a.session_id), a);
});

test('malformed import writes nothing', async () => {
  saveSession(await makeSession(0));
  const before = mem.get(STORAGE_KEY);
  assert.throws(() => importJson('{not json'), /not valid JSON/);
  assert.throws(() => importJson('{"sessions":[]}'), /expected/);
  assert.throws(() => importJson('{"format":"vision-acuity-sessions","version":9,"sessions":[]}'), /unsupported version/);
  const r = importJson(JSON.stringify({ format: 'vision-acuity-sessions', version: 1, sessions: [{ session_id: 'x' }] }));
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 1);
  assert.ok(r.errors[0].includes('missing field'));
  assert.equal(mem.get(STORAGE_KEY), before);
});

test('corrupt storage is reported, never overwritten', () => {
  mem.set(STORAGE_KEY, '{oops');
  assert.throws(() => listSessions(), /not valid JSON/);
  assert.equal(mem.get(STORAGE_KEY), '{oops');
});

test('delete all removes every session and reports how many there were', async () => {
  const { deleteAllSessions } = await import('../src/storage.js');
  assert.equal(deleteAllSessions(), 0);
  saveSession(await makeSession(0));
  saveSession(await makeSession(1));
  assert.equal(deleteAllSessions(), 2);
  assert.deepEqual(listSessions(), []);
});
