// AI-assisted (Claude Code), reviewed by a team member.
// The "Test" screen is one guided flow of three steps: who is testing, the screen calibration, the distance.
// This module holds the rules (which step is done, which one to open, what to say about each) and nothing
// that touches the page, so it can be tested on its own.

export const STEPS = ['you', 'screen', 'distance'];

const CODE = /^[A-Za-z0-9_-]{1,16}$/;
const EYES = ['OD', 'OS', 'OU'];
const EYE_TEXT = { OD: 'Right eye', OS: 'Left eye', OU: 'Both eyes' };
const KEY = 'last_setup';

/**
 * Which steps are complete.
 * @param {object} d
 * @param {string} d.participant @param {string} d.eye @param {string} d.glasses @param {string} d.condition
 * @param {boolean} d.hasScreen  the screen has a saved calibration
 * @param {boolean} d.zoomChanged  browser zoom differs from the calibration
 * @param {number} d.targetMm @param {string} d.distanceMode  'manual' or 'camera'
 * @param {boolean} d.cameraCalibrated  the chosen camera has a calibration for this participant
 */
export function stepStatus(d) {
  const condition = String(d.condition ?? '').trim();
  return {
    you: CODE.test(d.participant) && EYES.includes(d.eye) && ['yes', 'no'].includes(d.glasses)
      && condition.length > 0 && condition.length <= 40,
    screen: Boolean(d.hasScreen) && !d.zoomChanged,
    distance: Number.isInteger(d.targetMm) && d.targetMm >= 200 && d.targetMm <= 6000
      && (d.distanceMode === 'manual' || Boolean(d.cameraCalibrated)),
  };
}

export const NEAR_MM = 400;
export const FAR_MM = 1000;
const GOOD_NEAR_LOGMAR = -0.1; // good young eyes often reach this; the screen must draw it to give them a number

/**
 * Default test distance. Near vision is where a hyperopic shift shows, so 40 cm when this screen can draw
 * logMAR -0.1 at 40 cm; otherwise 1 m, where good eyes still get a number instead of "Beyond screen".
 * @param {(mm: number) => number|null} floorAt  smallest logMAR the screen can draw at a distance (null: none)
 */
export function suggestDistance(floorAt) {
  const near = floorAt(NEAR_MM);
  return near != null && near <= GOOD_NEAR_LOGMAR + 1e-9 ? NEAR_MM : FAR_MM;
}

/** The step to show: the one that was asked for, else the first that is not done, else the last. */
export function firstOpenStep(status, requested = null) {
  if (STEPS.includes(requested)) return requested;
  return STEPS.find((s) => !status[s]) ?? STEPS[STEPS.length - 1];
}

/** The step after `step`, or null after the last one. */
export function nextStep(step) {
  return STEPS[STEPS.indexOf(step) + 1] ?? null;
}

/** One line about a step, shown when it is folded. */
export function stepSummary(step, d, status = stepStatus(d)) {
  if (step === 'you') {
    if (!status.you) return 'Not set';
    return `${d.participant} · ${EYE_TEXT[d.eye]} · Glasses ${d.glasses === 'yes' ? 'on' : 'off'}`;
  }
  if (step === 'screen') {
    if (!d.hasScreen) return 'Not calibrated';
    if (d.zoomChanged) return 'Zoom changed. Calibrate again';
    return `Calibrated · ${d.pxPerMm.toFixed(2)} px/mm`;
  }
  if (d.distanceMode === 'camera') {
    return `Camera · ${d.cameraLabel} · ${d.cameraCalibrated ? 'calibrated' : 'not calibrated'}`;
  }
  return Number.isInteger(d.targetMm) && d.targetMm > 0 ? `Tape measure · ${d.targetMm} mm` : 'Tape measure';
}

/** The choices of the last test, so the next one starts ready. Null when nothing valid is saved. */
export function loadSetup(storage = globalThis.localStorage) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
  } catch {
    // A damaged value is treated like no value: the user simply fills the steps again.
  }
  if (!saved || !CODE.test(saved.participant ?? '')) return null;
  return {
    participant: saved.participant,
    eye: EYES.includes(saved.eye) ? saved.eye : '',
    glasses: ['yes', 'no'].includes(saved.glasses) ? saved.glasses : '',
    condition: typeof saved.condition === 'string' && saved.condition ? saved.condition : '',
    targetMm: Number.isInteger(saved.targetMm) ? saved.targetMm : 400,
    distanceMode: saved.distanceMode === 'camera' ? 'camera' : 'manual',
  };
}

export function saveSetup(v, storage = globalThis.localStorage) {
  storage.setItem(KEY, JSON.stringify({
    participant: v.participant, eye: v.eye, glasses: v.glasses, condition: v.condition,
    targetMm: v.targetMm, distanceMode: v.distanceMode,
  }));
}
