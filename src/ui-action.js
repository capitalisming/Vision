// Action screen (#screen-action): what the astronaut sees for a classify() result.
// These are the team's prototype rules, not a clinical protocol.

const STATES = {
  insufficient: { color: '#616161', text: (needed) => `Baseline not ready yet: ${needed} more session${needed === 1 ? '' : 's'} needed` },
  within: { color: '#2e7d32', text: () => 'No change' },
  improved: { color: '#2e7d32', text: () => 'Better than your usual range. No action needed' },
  single: { color: '#ef6c00', text: () => 'Repeat the test tomorrow under the same conditions' },
  persistent: {
    color: '#c62828',
    text: () =>
      'Persistent change: switch to the next pair of spare glasses, write down the date, and tell the doctor at the next communication session',
  },
  not_measurable: { color: '#616161', text: () => 'This session gave no result, so it was not compared with your baseline' },
};


const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// state: a classify() result; needed: sessions still missing for a baseline
// (used for 'insufficient'); why: the "Why this test" paragraphs. The section is left out until the text
// exists, so no placeholder ever reaches a user.
export function renderAction(container = document.getElementById('screen-action'), { state, needed = 0, why = [] }) {
  const s = STATES[state];
  if (!s) throw new Error(`unknown state: ${state}`);
  container.innerHTML = `
    <p class="action-message" data-state="${state}" style="font:700 2em/1.3 system-ui;color:${s.color};margin:0.5em 0">${esc(s.text(needed))}</p>
    <p class="action-disclaimer" style="color:#555">These rules are the team's prototype logic, not a NASA clinical protocol</p>
    ${why.length ? `<details class="action-why">
      <summary>Why this test</summary>
      ${why.map((p) => `<p>${esc(p)}</p>`).join('')}
    </details>` : ''}`;
}
