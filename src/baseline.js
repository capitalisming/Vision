/**
 * Personal norm and change classification.
 *
 * Pure functions: no DOM, no storage, no network. Safe to import from tests and from
 * both the browser and any other module.
 *
 * CONTRACT
 *   computeBaseline(sessions) -> { n, mean, sd, threshold } | null
 *   classify(session, baseline, previousSession) -> state
 *
 * TEAM DECISION, NOT A CLINICAL NORM:
 *   - the minimum threshold is 0.10 logMAR;
 *   - two sessions in a row beyond the threshold, in the same direction, count as a
 *     persistent change;
 *   - fewer than five usable sessions means "insufficient".
 * These numbers and the two-session rule are the team's prototype logic. They are not a
 * validated clinical limit and not a NASA protocol.
 *
 * Session fields used here (extra fields are ignored):
 *   participant, eye, glasses, targetMm, logMAR, floorHit, timestamp
 * `glasses` may also be a correction label ("own glasses" / "none"); see normalizeSession.
 */

/** Number of usable sessions that freezes the personal norm. */
export const BASELINE_N = 5;
/** Never let the change threshold fall below this, however small the spread is. */
export const MIN_THRESHOLD = 0.10;

/** Two-sided 95% normal quantile used for the prediction limit. */
const Z95 = 1.96;

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Convert the many names used across the prototype modules into one shape.
 * Never mutates its input.
 */
export function normalizeSession(input = {}) {
  const correction = input.correction ?? input.glassesCondition ?? input.correctionLabel;
  const targetCm = num(input.targetDistanceCm ?? input.distanceCm ?? input.targetCm);
  return {
    participant: input.participant ?? input.participantId ?? input.participant_id ?? null,
    eye: input.eye ?? input.eyeId ?? input.eye_id ?? null,
    glasses: normalizeGlasses(input.glasses ?? correction),
    targetMm:
      num(input.targetMm ?? input.targetDistanceMm ?? input.distanceMm) ??
      (targetCm == null ? null : targetCm * 10),
    logMAR: num(input.logMAR ?? input.logMar ?? input.logmar),
    floorHit: input.floorHit === true || input.floorHit === 'true',
    timestamp: input.timestamp ?? input.at ?? input.endedAt ?? input.startedAt ?? input.date ?? null,
    reason: input.reason ?? null,
  };
}

/** true = wearing the usual correction, false = uncorrected, null = unknown. */
export function normalizeGlasses(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'true', '1', 'glasses', 'own glasses', 'corrected', 'contacts'].includes(s)) return true;
  if (['no', 'false', '0', 'none', 'no glasses', 'uncorrected'].includes(s)) return false;
  return null;
}

/** A session can enter the norm only if it produced a number and did not hit the floor. */
export function isMeasurable(session) {
  const s = normalizeSession(session);
  return s.logMAR != null && !s.floorHit;
}

/** Two sessions belong to the same series if these four fields match exactly. */
export function sameGroup(a, b) {
  const x = normalizeSession(a);
  const y = normalizeSession(b);
  return (
    x.participant === y.participant &&
    x.eye === y.eye &&
    x.glasses === y.glasses &&
    x.targetMm === y.targetMm
  );
}

export function groupKey(session) {
  const s = normalizeSession(session);
  return [s.participant, s.eye, s.glasses, s.targetMm].map((v) => String(v)).join('|');
}

function sampleSd(xs, mean) {
  if (xs.length < 2) return 0;
  const ss = xs.reduce((acc, x) => acc + (x - mean) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

const timeOf = (s) => {
  const t = Date.parse(s.timestamp);
  return Number.isFinite(t) ? t : null;
};

/** Oldest first; sessions without a parseable time keep their input order. */
function chronological(rows) {
  return rows
    .map((s, i) => ({ s, i, t: timeOf(s) }))
    .sort((a, b) => (a.t == null || b.t == null ? a.i - b.i : a.t - b.t))
    .map((x) => x.s);
}

/**
 * Personal norm from the first five usable sessions of one series.
 *
 * @param {Array<object>} sessions time-ordered sessions (oldest first).
 * @param {object} [group] the series to use. Defaults to the series of the last session,
 *   so callers can pass a mixed export and still get the norm of the person they look at.
 * @returns {{n: number, mean: number, sd: number, threshold: number} | null} null when the
 *   series has fewer than five usable sessions.
 */
export function computeBaseline(sessions, group = null) {
  const all = (sessions ?? []).map(normalizeSession);
  if (all.length === 0) return null;
  const target = group ? normalizeSession(group) : all[all.length - 1];
  const rows = chronological(all.filter((s) => sameGroup(s, target)));
  const used = rows.filter(isMeasurable).slice(0, BASELINE_N);
  if (used.length < BASELINE_N) return null;

  const xs = used.map((s) => s.logMAR);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = sampleSd(xs, mean);
  const threshold = Math.max(MIN_THRESHOLD, Z95 * sd * Math.sqrt(1 + 1 / xs.length));
  return { n: xs.length, mean, sd, threshold };
}

/**
 * Classify one session against the frozen personal norm.
 *
 *   'not_measurable' — no logMAR number, or the test hit the floor;
 *   'insufficient'   — the norm is not ready (baseline === null);
 *   'within'         — |logMAR − mean| <= threshold;
 *   'persistent'     — this and the previous session are both beyond the threshold in
 *                      the same direction;
 *   'single'         — one session beyond the threshold.
 *
 * The previous session must come from the same series (same participant, eye, glasses,
 * targetMm). Pass the previous usable session of that series, or null.
 */
export function classify(session, baseline, previousSession = null) {
  const s = normalizeSession(session);
  if (s.logMAR == null || s.floorHit) return 'not_measurable';
  if (!baseline) return 'insufficient';

  const delta = s.logMAR - baseline.mean;
  if (Math.abs(delta) <= baseline.threshold) return 'within';

  const prev = previousSession ? normalizeSession(previousSession) : null;
  if (prev && prev.logMAR != null && !prev.floorHit) {
    const prevDelta = prev.logMAR - baseline.mean;
    const sameSide = Math.sign(prevDelta) === Math.sign(delta);
    if (sameSide && Math.abs(prevDelta) > baseline.threshold) return 'persistent';
  }
  return 'single';
}

/**
 * Same as classify() plus the numbers a screen needs. `state` is exactly what classify()
 * returns, so the two can never disagree.
 */
export function classifyDetailed(session, baseline, previousSession = null) {
  const s = normalizeSession(session);
  const state = classify(s, baseline, previousSession);
  const delta = baseline && s.logMAR != null ? s.logMAR - baseline.mean : null;
  return {
    state,
    session: s,
    baseline,
    delta,
    direction: delta == null || delta === 0 ? null : delta > 0 ? 'worse' : 'better',
    threshold: baseline ? baseline.threshold : null,
  };
}

/**
 * Whole-series assessment used by the chart and the action screen.
 * Returns the norm of the series, its last session and the detailed classification of
 * that last session, plus how many sessions are still missing for the norm.
 */
export function assessSeries(sessions, group = null) {
  const all = chronological((sessions ?? []).map(normalizeSession));
  const target = group ? normalizeSession(group) : all[all.length - 1] ?? null;
  const rows = target ? all.filter((s) => sameGroup(s, target)) : [];
  const baseline = computeBaseline(rows, target);
  const last = rows[rows.length - 1] ?? null;
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;
  const usable = rows.filter(isMeasurable).length;
  return {
    group: target,
    baseline,
    last,
    previous,
    detail: last ? classifyDetailed(last, baseline, previous) : null,
    usable,
    sessionsNeeded: Math.max(0, BASELINE_N - usable),
  };
}