import type { DistanceCheck, Profile, Session } from './types';

const KEY = 'nvm.profile.v1';

export function emptyProfile(): Profile {
  return { version: 1, createdAt: new Date().toISOString(), screen: null, camera: null, sessions: [], distanceChecks: [] };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Profile;
  } catch {
    /* storage unavailable or corrupt: start empty, never throw */
  }
  return emptyProfile();
}

export function saveProfile(p: Profile): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

/** Flat, one-row-per-trial CSV for spreadsheets / the Python pipeline. */
export function trialsCsv(sessions: Session[]): string {
  const cols = [
    'session_id', 'data_category', 'started_at', 'mode', 'participant_id', 'experiment_id', 'added_lens_D',
    'correction', 'eye', 'trial', 'orientation', 'response', 'correct', 'requested_logMAR', 'logMAR',
    'stroke_dev_px', 'stroke_mm', 'distance_cm', 'distance_cm_onset', 'distance_cm_response', 'distance_source',
    'dist_irisA_cm', 'dist_irisB_cm', 'dist_ipd_cm', 'ambient_luma', 'rt_ms', 'paused_for_distance',
  ];
  const rows = [cols.join(',')];
  const q = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  for (const s of sessions)
    for (const e of s.eyes)
      for (const t of e.trials)
        rows.push(
          [
            s.id, s.dataCategory, s.startedAt, s.mode, s.experiment?.participantId, s.experiment?.experimentId,
            s.experiment?.addedLensD, s.correction, e.eye, t.i, t.orientation, t.response, t.correct ? 1 : 0,
            t.requestedLogMAR.toFixed(4), t.logMAR.toFixed(4), t.strokeDevPx.toFixed(3), t.strokeMm.toFixed(5),
            t.distanceCm.toFixed(2), t.distanceCmOnset.toFixed(2), t.distanceCmResponse.toFixed(2), t.distanceSource,
            t.rawDistance?.irisA?.toFixed(2), t.rawDistance?.irisB?.toFixed(2), t.rawDistance?.ipd?.toFixed(2),
            t.ambientLuma?.toFixed(1), Math.round(t.rtMs), t.pausedForDistance,
          ].map(q).join(','),
        );
  return rows.join('\n');
}

export function download(name: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

export function distanceChecksCsv(rows: DistanceCheck[]): string {
  const cols = ['at', 'data_category', 'participant_id', 'true_cm', 'condition', 'app_cm', 'irisA_cm', 'irisB_cm', 'ipd_cm', 'frames', 'sd_cm'];
  const f = (v: number | null) => (v == null ? '' : v.toFixed(2));
  return [cols.join(','), ...rows.map((r) => [r.at, r.dataCategory, r.participantId, r.trueCm, r.condition, f(r.appCm), f(r.irisA), f(r.irisB), f(r.ipd), r.frames, f(r.sdCm)].join(','))].join('\n');
}
