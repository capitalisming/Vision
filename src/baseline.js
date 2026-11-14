// Personal baseline and change classification. Pure functions, no DOM.
//
// NOTE: the 0.10 logMAR minimum threshold and the "two sessions in a row"
// rule are team decisions for this prototype, not a clinical standard.

export const BASELINE_N = 5;
export const MIN_THRESHOLD = 0.1; // team decision, not a clinical norm

export function isMeasurable(session) {
  return Number.isFinite(session.logMAR) && session.floorHit === false;
}

const sameConditions = (a, b) =>
  a.participant === b.participant &&
  a.eye === b.eye &&
  a.glasses === b.glasses &&
  a.targetMm === b.targetMm;

// Measurable sessions (in input order) sharing participant, eye, glasses and
// targetMm with the first measurable session.
export function eligibleSessions(sessions) {
  const measurable = sessions.filter(isMeasurable);
  if (measurable.length === 0) return [];
  return measurable.filter((s) => sameConditions(s, measurable[0]));
}

// { n, mean, sd, threshold } from the first five eligible sessions, or null.
export function computeBaseline(sessions) {
  const base = eligibleSessions(sessions).slice(0, BASELINE_N);
  if (base.length < BASELINE_N) return null;
  const n = base.length;
  const values = base.map((s) => s.logMAR);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const threshold = Math.max(MIN_THRESHOLD, 1.96 * sd * Math.sqrt(1 + 1 / n));
  return { n, mean, sd, threshold };
}

// Rounding guard so that e.g. |0.20 - 0.10| is not judged > 0.10 because of
// binary floating point.
const EPS = 1e-9;

// -1 / +1 when outside the band (below / above), 0 when within.
function side(session, baseline) {
  const d = session.logMAR - baseline.mean;
  if (Math.abs(d) <= baseline.threshold + EPS) return 0;
  return Math.sign(d);
}

// 'not_measurable' | 'insufficient' | 'within' | 'single' | 'persistent'.
// 'persistent' = this and the previous session are both outside the band on
// the same side (team rule, not a clinical norm).
export function classify(session, baseline, previousSession) {
  if (!isMeasurable(session)) return 'not_measurable';
  if (!baseline) return 'insufficient';
  const s = side(session, baseline);
  if (s === 0) return 'within';
  if (previousSession && isMeasurable(previousSession) && side(previousSession, baseline) === s) {
    return 'persistent';
  }
  return 'single';
}
