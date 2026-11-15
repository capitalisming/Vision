// Personal baseline and change classification. Pure functions, no DOM.
//
// NOTE: the 0.10 logMAR minimum threshold and the "two sessions in a row"
// rule are team decisions for this prototype, not a clinical standard.

export const BASELINE_N = 5;
export const MIN_THRESHOLD = 0.1; // team decision, not a clinical norm

// Two-sided 97.5 % quantile of Student's t for df = 1 … 10. The band is a prediction interval for one new
// session, mean ± t · sd · √(1 + 1/n), estimated from only n sessions, so t (not the normal 1.96) applies.
const T_975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
function t975(df) {
  const t = T_975[df];
  if (!Number.isFinite(t)) throw new RangeError(`no t quantile for ${df} degrees of freedom`);
  return t;
}

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
  const threshold = Math.max(MIN_THRESHOLD, t975(n - 1) * sd * Math.sqrt(1 + 1 / n));
  return { n, mean, sd, threshold };
}

// Rounding guard so that e.g. |0.20 - 0.10| is not judged > 0.10 because of
// binary floating point.
const EPS = 1e-9;

// -1 when below the band (better acuity), +1 when above it (worse acuity), 0 when within.
function side(session, baseline) {
  const d = session.logMAR - baseline.mean;
  if (Math.abs(d) <= baseline.threshold + EPS) return 0;
  return Math.sign(d);
}

// 'not_measurable' | 'insufficient' | 'within' | 'improved' | 'single' | 'persistent'.
// Only worse acuity is a change to act on. Better acuity than the band ('improved') is expected from
// practice with the test and never raises the alarm.
// 'persistent' = this and the previous session are both worse than the band (team rule, not a clinical norm).
export function classify(session, baseline, previousSession) {
  if (!isMeasurable(session)) return 'not_measurable';
  if (!baseline) return 'insufficient';
  const s = side(session, baseline);
  if (s === 0) return 'within';
  if (s < 0) return 'improved';
  if (previousSession && isMeasurable(previousSession) && side(previousSession, baseline) > 0) {
    return 'persistent';
  }
  return 'single';
}
