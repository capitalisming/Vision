// AI-assisted (Claude Code), reviewed by a team member.
// Test helpers: an in-memory localStorage and a scripted (SYNTHETIC) observer.

export function installLocalStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
  return m;
}

const OTHER = { up: 'down', down: 'left', left: 'right', right: 'up' };

/**
 * SYNTHETIC observer. `plan(phase, logmar)` returns how many of the presentations at that level are
 * answered correctly (descent: 1 or 0; main: 0..5). Plan may return a boolean for presentation i (counted per phase+level across restarts).
 */
export function scriptedObserver(plan) {
  const seen = new Map();
  return async (spec) => {
    const key = `${spec.phase}:${spec.logmar.toFixed(1)}`;
    const i = seen.get(key) ?? 0;
    seen.set(key, i + 1);
    const nCorrect = plan(spec.phase, Math.round(spec.logmar * 10) / 10, i);
    const ok = typeof nCorrect === 'boolean' ? nCorrect : i < nCorrect;
    return { response: ok ? spec.orientation : OTHER[spec.orientation], rtMs: 500 };
  };
}

export const manualDistance = (mm) => () => ({ mm, ageMs: 0, ok: true, reason: '' });
export const noWait = async () => {};
