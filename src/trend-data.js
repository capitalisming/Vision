// AI-assisted (Claude Code), reviewed by a team member.
// Bridges our stored sessions (contract format, snake_case) to what src/baseline.js, src/ui-trend.js and
// src/ui-action.js expect (logMAR, floorHit, targetMm, timestamp).
import { computeBaseline, classify, eligibleSessions, BASELINE_N } from './baseline.js';

const REASON = {
  floor_hit: 'floor hit',
  'worse_than_1.3': 'worse than 1.3',
  aborted_camera: 'no distance',
  aborted_user: 'stopped',
};

const timeOf = (s) => Date.parse(s.timestamp);

/** Sessions for the trend and the personal baseline, oldest first. Practice tests are left out. */
export function toBaselineSessions(sessions) {
  return sessions
    .filter((s) => s.condition !== 'practice')
    .map((s) => ({
      participant: s.participant,
      eye: s.eye,
      glasses: s.glasses,
      targetMm: s.target_mm,
      timestamp: s.started_at,
      logMAR: s.outcome === 'ok' ? s.logmar : null,
      floorHit: Boolean(s.floor_hit) || s.outcome === 'floor_hit',
      reason: s.outcome === 'ok' ? '' : (REASON[s.outcome] ?? s.outcome),
    }))
    .sort((a, b) => timeOf(a) - timeOf(b));
}

/**
 * What the Action screen shows: the newest test compared with the personal baseline of its own participant,
 * eye and glasses setting. Null when there is no test to show.
 */
export function latestAction(sessions) {
  const all = toBaselineSessions(sessions);
  const latest = all.at(-1);
  if (!latest) return null;
  const same = all.filter((s) => s.participant === latest.participant && s.eye === latest.eye && s.glasses === latest.glasses);
  return {
    state: classify(latest, computeBaseline(same), same.at(-2)),
    needed: Math.max(0, BASELINE_N - eligibleSessions(same).length),
    latest,
  };
}
