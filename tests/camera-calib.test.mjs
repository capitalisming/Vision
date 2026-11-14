/**
 * Unit tests for the distance_check.csv export (brief section 2.2, item 4).
 * camera-calib.js touches the DOM only inside its mount functions, so the pure CSV builder
 * can be imported in Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsToCsv } from '../src/camera-calib.js';

test('distance_check.csv has the contracted columns in order', () => {
  const csv = rowsToCsv([
    {
      participant: 'P01',
      glasses: 'yes',
      tapeMm: 300,
      cameraMm: 305,
      eyeSpanPx: 162.34,
      timestamp: '2026-11-14T12:00:00.000Z',
    },
  ]);
  assert.equal(
    csv,
    'participant,glasses,tapeMm,cameraMm,eyeSpanPx,timestamp\n' +
      'P01,yes,300,305,162.3,2026-11-14T12:00:00.000Z\n',
  );
});

test('empty rows still produce the header', () => {
  assert.equal(rowsToCsv([]), 'participant,glasses,tapeMm,cameraMm,eyeSpanPx,timestamp\n');
});

test('values with commas are quoted', () => {
  const csv = rowsToCsv([
    { participant: 'P,01', glasses: 'no', tapeMm: 400, cameraMm: 399, eyeSpanPx: null, timestamp: 'x' },
  ]);
  const line = csv.split('\n')[1];
  assert.ok(line.startsWith('"P,01",no,400,399,'));
  assert.ok(line.endsWith(',x'));
});