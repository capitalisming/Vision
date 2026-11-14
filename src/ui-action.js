/**
 * Action screen (#screen-action): what the astronaut should do after the latest session.
 *
 * Four team states plus a fallback for a session that produced no number:
 *   insufficient → norm not ready
 *   within       → no change
 *   single       → one session outside the band
 *   persistent   → two sessions in a row outside the band, same direction
 *   not_measurable (fallback) → repeat the test
 *
 * The wording below is the team's prototype logic, not a NASA clinical protocol; that line is
 * printed on the screen as required. The "Why this test" text is a placeholder to be replaced
 * by participant 3's copy: three short paragraphs, no numbers.
 */
import { assessSeries, BASELINE_N } from './baseline.js';

export const ACTION_TEXT = {
  insufficient: (needed) =>
    `Your norm is not ready yet: ${needed} more session${needed === 1 ? '' : 's'} needed`,
  within: () => 'No change',
  single: () => 'Repeat the test tomorrow under the same conditions',
  persistent: () =>
    'Sustained change: take the next pair of spare glasses, record the date, and tell the doctor at the next communication session',
  not_measurable: () => 'This test could not be measured — repeat it under the same conditions',
  empty: () => 'No sessions yet — run a test first',
};

const WHY_PARAGRAPHS = [
  'Near vision is easy to take for granted, and it is one of the first things a person notices when it changes.',
  'A single test on a single day says little. What matters is the comparison with your own earlier results on the same device and in the same conditions, because your normal is not somebody else’s normal.',
  'The test is short enough to repeat, so a change can be noticed early and discussed at the next communication session rather than discovered when it matters most.',
];

const TEMPLATE = `
<div class="nvm-screen">
  <h1>Next step</h1>
  <div class="nvm-action" data-role="card" data-state="empty">
    <p class="nvm-action-text" data-role="text"></p>
    <p class="nvm-action-detail" data-role="detail"></p>
  </div>
  <p class="nvm-note nvm-disclaimer">These rules are the team's prototype logic, not a NASA clinical protocol</p>
  <details class="nvm-why">
    <summary>Why this test</summary>
    <div data-role="why"></div>
  </details>
</div>`;

const d2 = (v) => (v == null ? '—' : v.toFixed(2));

/**
 * @param {HTMLElement} container the #screen-action container.
 * @param {{sessions?: object[], group?: object}} [options]
 */
export function mountActionScreen(container, options = {}) {
  if (!container) throw new TypeError('mountActionScreen(container): container required');

  container.innerHTML = TEMPLATE;
  const $ = (role) => container.querySelector(`[data-role="${role}"]`);
  const card = $('card');
  const textEl = $('text');
  const detailEl = $('detail');
  const whyEl = $('why');

  whyEl.innerHTML = WHY_PARAGRAPHS.map((p) => `<p>${p}</p>`).join('');

  function show(state, detail = '', needed = 0) {
    card.dataset.state = state;
    textEl.textContent =
      state === 'insufficient'
        ? ACTION_TEXT.insufficient(needed)
        : (ACTION_TEXT[state] ?? ACTION_TEXT.not_measurable)();
    detailEl.textContent = detail;
  }

  /**
   * @param {object[]} sessions
   * @param {object} [group] {participant, eye, glasses, targetMm}; defaults to the latest
   *   session's series so a mixed export still shows the right person.
   */
  function update(sessions, group = null) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (list.length === 0) {
      show('empty');
      return;
    }

    const a = assessSeries(list, group);
    const state = a.detail?.state ?? (a.usable < BASELINE_N ? 'insufficient' : 'not_measurable');

    if (state === 'insufficient') {
      show(
        'insufficient',
        `${a.usable} of ${BASELINE_N} usable sessions for ${a.group?.participant ?? '?'} · ` +
          `${a.group?.eye ?? '?'} · glasses ${a.group?.glasses === true ? 'yes' : a.group?.glasses === false ? 'no' : '?'}`,
        a.sessionsNeeded,
      );
      return;
    }

    if (state === 'not_measurable') {
      const why = a.last?.floorHit
        ? 'The test hit the floor of the chart.'
        : 'The session produced no logMAR number.';
      show('not_measurable', why);
      return;
    }

    const b = a.baseline;
    const delta = a.detail?.delta;
    const detail =
      b && a.last
        ? `${new Date(a.last.timestamp ?? Date.now()).toLocaleString()} · ` +
          `${d2(a.last.logMAR)} logMAR · norm ${d2(b.mean)} ± ${d2(b.threshold)} · ` +
          `change ${delta == null ? '—' : `${delta >= 0 ? '+' : ''}${d2(delta)}`}`
        : '';
    show(state, detail);
  }

  update(options.sessions ?? [], options.group ?? null);

  return { update, show, container };
}