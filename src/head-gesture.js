// AI-assisted (Claude Code), reviewed by a team member.
// Answers by turning the head: a DOM-free detector on three face points.
//
// Geometry: the nose tip (point 1) against the midpoint of the outer eye corners (points 33 and 263), in the raw
// (not mirrored) camera picture, divided by the eye span. Dividing by the span makes it independent of the
// distance; measuring along the eye line makes a sideways head tilt (roll) read as no turn. The rotation matrix
// of the face tracker is not used: its signs were never checked on a real face.
//
// Signs, raw picture, camera facing the person:
//   x grows    -> the person turned the head to their own left  -> 'left'
//   x shrinks  -> 'right'
//   y shrinks  -> chin up                                        -> 'up'
//   y grows    -> 'down'
// These are checked on the real face by the training in step 3 (createHeadTraining); a sign that comes out the
// other way is flipped per axis (signs.x / signs.y = -1).

export const NOSE = 1;
export const EYE_RIGHT_OUTER = 33; // subject's right eye
export const EYE_LEFT_OUTER = 263; // subject's left eye

export const HEAD_START = 0.09; // share of the eye span, about 13–15° of head turn: an answer
export const HEAD_DOMINANCE = 1.5; // the answer axis must move at least this many times more than the other
export const HEAD_HOLD_MS = 200; // the position must be held this long
export const HEAD_ONSET = 0.05; // about 8°: from here on the head is moving and the distance is not read
export const HEAD_NEUTRAL_RADIUS = 0.04; // back within this of the start position = neutral again

const DEFAULT_SIGNS = Object.freeze({ x: 1, y: 1 });

/**
 * Head pose from the three points in video pixels: { x, y, span }, x and y in eye spans, or null.
 * @param {{nose:{x:number,y:number}, left:{x:number,y:number}, right:{x:number,y:number}} | null} p
 *   left / right: the subject's left (263) and right (33) outer eye corner
 */
export function headPose(p) {
  if (!p || !p.nose || !p.left || !p.right) return null;
  const ux = p.left.x - p.right.x;
  const uy = p.left.y - p.right.y;
  const span = Math.hypot(ux, uy);
  if (!(span > 0)) return null;
  // Unit vector along the eye line (image +x when the head is upright) and the one at +90°, image +y (down).
  const ex = ux / span;
  const ey = uy / span;
  const dx = p.nose.x - (p.left.x + p.right.x) / 2;
  const dy = p.nose.y - (p.left.y + p.right.y) / 2;
  return { x: (dx * ex + dy * ey) / span, y: (-dx * ey + dy * ex) / span, span };
}

/** Direction of an offset from the neutral position (signs already applied), or null. */
export function classifyOffset(dx, dy, { start = HEAD_START, dominance = HEAD_DOMINANCE } = {}) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= start && ax >= dominance * ay) return dx > 0 ? 'left' : 'right';
  if (ay >= start && ay >= dominance * ax) return dy < 0 ? 'up' : 'down';
  return null;
}

function cleanSigns(signs) {
  return { x: signs?.x === -1 ? -1 : 1, y: signs?.y === -1 ? -1 : 1 };
}

/**
 * The detector. Call reset() when a sign is shown: the next pose becomes the neutral position. Then feed it one
 * pose per camera frame with update(pose, t); it returns a direction once, when one has been held for holdMs.
 */
export function createHeadGestureDetector({
  signs = DEFAULT_SIGNS, start = HEAD_START, dominance = HEAD_DOMINANCE, holdMs = HEAD_HOLD_MS,
  onset = HEAD_ONSET, neutralRadius = HEAD_NEUTRAL_RADIUS,
} = {}) {
  const s = cleanSigns(signs);
  let neutral = null;
  let offset = null; // { dx, dy } of the latest pose, null without a face
  let started = false;
  let fired = false;
  let candidate = null;
  let since = 0;
  return {
    reset() {
      neutral = null;
      offset = null;
      started = false;
      fired = false;
      candidate = null;
    },
    /** @returns {'up'|'down'|'left'|'right'|null} a direction once per reset, when held long enough */
    update(pose, t) {
      if (!pose) { // no face (or two): the hold starts over
        offset = null;
        candidate = null;
        return null;
      }
      if (!neutral) {
        neutral = { x: pose.x, y: pose.y };
        offset = { dx: 0, dy: 0 };
        return null;
      }
      const dx = (pose.x - neutral.x) * s.x;
      const dy = (pose.y - neutral.y) * s.y;
      offset = { dx, dy };
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= onset) started = true;
      const dir = classifyOffset(dx, dy, { start, dominance });
      if (dir !== candidate) {
        candidate = dir;
        since = t;
      }
      if (dir && !fired && t - since >= holdMs) {
        fired = true;
        return dir;
      }
      return null;
    },
    /** true once the head moved away from the neutral position since reset() */
    get started() { return started; },
    /** true while a face is seen within neutralRadius of the neutral position */
    isNeutral() {
      return offset !== null && Math.max(Math.abs(offset.dx), Math.abs(offset.dy)) < neutralRadius;
    },
    get offset() { return offset; },
    get hasNeutral() { return neutral !== null; },
  };
}

/**
 * What the acuity test needs (runAcuityTest option `headInput`), on top of a source of face points.
 * @param {() => ({nose, left, right, t:number} | null)} getLandmarks  points of the latest camera frame
 *   (src/distance.js getHeadLandmarks); t is the frame time in ms
 * @param {{x:number, y:number}} signs  from the training
 */
export function createHeadInput(getLandmarks, signs = DEFAULT_SIGNS, detectorOptions = {}) {
  const det = createHeadGestureDetector({ ...detectorOptions, signs });
  let lastT = null;
  let pendingDir = null;
  const poll = () => {
    const p = getLandmarks();
    if (!p) { // no face: the hold starts over
      det.update(null, 0);
      lastT = null;
      return;
    }
    if (p.t === lastT) return; // the same frame: nothing new
    lastT = p.t;
    const dir = det.update(headPose(p), p.t);
    if (dir) pendingDir = dir;
  };
  return {
    /** The sign is on screen: its neutral position is the next frame. */
    resetNeutral() {
      det.reset();
      lastT = null;
      pendingDir = null;
      poll();
    },
    /** A direction once, when the head has been held there; else null. */
    readDirection() {
      poll();
      const d = pendingDir;
      pendingDir = null;
      return d;
    },
    /** The head started to move since the sign was shown: the distance can no longer be read for this trial. */
    gestureStarted() {
      poll();
      return det.started;
    },
    /** The head is back at the position it had when the last sign was shown. */
    isNeutral() {
      poll();
      return det.isNeutral();
    },
  };
}

/**
 * The training in step 3: "turn your head up", back to the middle, then "turn your head to the left". It finds
 * which way each axis goes on this camera. Feed it poses with update(pose, t).
 * state: 'up' | 'center' | 'left' | 'done'; hint: what is wrong, or ''; signs: when done.
 */
export function createHeadTraining({
  start = HEAD_START, dominance = HEAD_DOMINANCE, holdMs = HEAD_HOLD_MS, neutralRadius = HEAD_NEUTRAL_RADIUS,
} = {}) {
  let state = 'up';
  let neutral = null;
  let since = null;
  let heldAxis = null;
  let hint = '';
  const signs = { x: 1, y: 1 };
  const report = () => ({ state, hint, signs: state === 'done' ? { ...signs } : null });
  return {
    get state() { return state; },
    update(pose, t) {
      if (state === 'done') return report();
      if (!pose) { since = null; heldAxis = null; hint = 'no_face'; return report(); }
      if (!neutral) { neutral = { x: pose.x, y: pose.y }; hint = ''; return report(); }
      const dx = pose.x - neutral.x;
      const dy = pose.y - neutral.y;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (state === 'center') {
        hint = '';
        if (Math.max(ax, ay) < neutralRadius) { state = 'left'; since = null; heldAxis = null; }
        return report();
      }
      const want = state === 'up' ? 'y' : 'x';
      let axis = null;
      if (ax >= start && ax >= dominance * ay) axis = 'x';
      else if (ay >= start && ay >= dominance * ax) axis = 'y';
      if (axis && axis !== want) {
        hint = want === 'y' ? 'only_up_down' : 'only_sideways';
        since = null;
        heldAxis = null;
        return report();
      }
      hint = '';
      if (!axis) { since = null; heldAxis = null; return report(); }
      if (heldAxis !== axis) { heldAxis = axis; since = t; }
      if (t - since < holdMs) return report();
      if (state === 'up') {
        signs.y = dy < 0 ? 1 : -1; // up should make y shrink
        state = 'center';
      } else {
        signs.x = dx > 0 ? 1 : -1; // the person's left should make x grow
        state = 'done';
      }
      since = null;
      heldAxis = null;
      return report();
    },
  };
}

// ----- settings: their own localStorage key (the fields of last_setup stay as they are)

export const HEAD_SETTINGS_KEY = 'head_answers';

/** { enabled: boolean, signs: { [cameraId]: {x, y} } } */
export function loadHeadSettings(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(HEAD_SETTINGS_KEY) ?? 'null');
    if (v && typeof v === 'object') {
      const signs = {};
      for (const [id, s] of Object.entries(v.signs ?? {})) signs[id] = cleanSigns(s);
      return { enabled: v.enabled === true, signs };
    }
  } catch {
    // damaged settings: start over
  }
  return { enabled: false, signs: {} };
}

export function saveHeadSettings(settings, storage = globalThis.localStorage) {
  storage.setItem(HEAD_SETTINGS_KEY, JSON.stringify({ enabled: settings.enabled === true, signs: settings.signs ?? {} }));
}

/** The trained signs for this camera, or null when it was not trained with it. */
export function signsFor(settings, cameraId) {
  return settings.signs[cameraId || 'default'] ?? null;
}

export function withSigns(settings, cameraId, signs) {
  return { ...settings, signs: { ...settings.signs, [cameraId || 'default']: cleanSigns(signs) } };
}
