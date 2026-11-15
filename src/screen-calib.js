// AI-assisted (Claude Code), reviewed by a team member.
// Screen calibration with an ID-1 bank card (85.60 x 53.98 mm). Stores CSS px per mm.

export const CARD_WIDTH_MM = 85.60;
export const CARD_HEIGHT_MM = 53.98;
export const STORAGE_KEY = 'px_per_mm';
const DPR_KEY = 'px_per_mm_dpr'; // devicePixelRatio at calibration time, used only to warn on zoom change

const MIN_WIDTH_PX = 120;
const MAX_WIDTH_PX = 1200;
const DEFAULT_WIDTH_PX = 323.5; // 85.6 mm at the CSS reference 96 px/in

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** CSS pixels per millimetre, or null before a valid calibration has been saved. */
export function getPxPerMm() {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (raw == null) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Save a calibration from the card rectangle width in CSS pixels. Returns pxPerMm. */
export function savePxPerMmFromCardWidth(widthCssPx) {
  if (!(widthCssPx >= MIN_WIDTH_PX && widthCssPx <= MAX_WIDTH_PX)) {
    throw new RangeError(`Card width ${widthCssPx}px is outside ${MIN_WIDTH_PX}-${MAX_WIDTH_PX}px`);
  }
  const pxPerMm = widthCssPx / CARD_WIDTH_MM;
  const s = storage();
  if (!s) throw new Error('localStorage is not available; calibration cannot be saved');
  s.setItem(STORAGE_KEY, String(pxPerMm));
  s.setItem(DPR_KEY, String(globalThis.devicePixelRatio || 1));
  return pxPerMm;
}

/** True when the browser zoom / devicePixelRatio differs from the one at calibration. */
export function calibrationDprChanged() {
  const saved = Number(storage()?.getItem(DPR_KEY));
  if (!Number.isFinite(saved) || saved <= 0) return false;
  return Math.abs(saved - (globalThis.devicePixelRatio || 1)) > 1e-6;
}

/**
 * The largest outline width that fits in `availablePx` (the inside of the card area), within the allowed range.
 * Returns MAX_WIDTH_PX when the space is unknown (0 or not a number).
 */
export function maxFittingWidth(availablePx) {
  if (!(availablePx > 0)) return MAX_WIDTH_PX;
  return Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, Math.floor(availablePx * 2) / 2)); // 0.5 px steps
}

/**
 * Render the calibration UI into `root`.
 * @param {HTMLElement} root
 * @param {{onSaved?: (pxPerMm:number) => void}} [opts]
 */
export function mountScreenCalibration(root, opts = {}) {
  const saved = getPxPerMm();
  let width = saved ? saved * CARD_WIDTH_MM : DEFAULT_WIDTH_PX;

  root.innerHTML = `
    <div class="calib">
      <p class="hint">Keep browser zoom at 100%. Hold a bank card flat against the screen and resize the outline
        until it matches the card edges exactly. Then press Save.</p>
      <div class="panel calib-panel">
        <div class="calib-controls">
          <button type="button" data-step="-1" aria-label="Smaller">−</button>
          <input type="range" min="${MIN_WIDTH_PX}" max="${MAX_WIDTH_PX}" step="0.5" aria-label="Card width">
          <button type="button" data-step="1" aria-label="Larger">+</button>
          <span class="calib-readout"></span>
        </div>
        <p class="hint kbd-hint">Arrow keys change by 0.5 px, Shift + arrow by 5 px.</p>
        <div class="row">
          <button type="button" class="primary" data-action="save">Save</button>
          <span class="calib-status" role="status"></span>
          <button type="button" class="ghost" data-nav="screen-setup" data-role="next" hidden>Next: new session</button>
        </div>
      </div>
      <div class="calib-stage"><div class="card-rect" aria-label="Card outline"></div></div>
      <p class="hint calib-fit" hidden>The outline cannot be larger in this window. If the card is still bigger,
        turn the device sideways or make the window wider.</p>
      <div class="panel">
        <h2>Check with a ruler</h2>
        <p class="hint ruler-hint"></p>
        <div class="ruler-wrap"><div class="ruler-100"></div></div>
        <p class="ruler-label"></p>
      </div>
    </div>`;

  const rect = root.querySelector('.card-rect');
  const slider = root.querySelector('input[type=range]');
  const readout = root.querySelector('.calib-readout');
  const status = root.querySelector('.calib-status');
  const ruler = root.querySelector('.ruler-100');
  const rulerLabel = root.querySelector('.ruler-label');
  const rulerHint = root.querySelector('.ruler-hint');
  const rulerWrap = root.querySelector('.ruler-wrap');
  const stage = root.querySelector('.calib-stage');
  const fitHint = root.querySelector('.calib-fit');

  // The outline never gets wider than its area: on a small screen it would go past the edge.
  function maxWidth() {
    const cs = getComputedStyle(stage);
    const inner = stage.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    return maxFittingWidth(inner);
  }

  function render() {
    const max = maxWidth();
    slider.max = String(max);
    width = Math.min(max, Math.max(MIN_WIDTH_PX, width));
    fitHint.hidden = width < max || max >= MAX_WIDTH_PX;
    rect.style.width = `${width}px`;
    rect.style.height = `${width * CARD_HEIGHT_MM / CARD_WIDTH_MM}px`;
    slider.value = String(width);
    readout.textContent = `${width.toFixed(1)} px = ${(width / CARD_WIDTH_MM).toFixed(3)} px/mm`;
    const p = getPxPerMm();
    if (p) {
      // 100 mm when it fits, otherwise 50 mm so the whole bar can be measured on a narrow screen.
      const lengthMm = rulerWrap.clientWidth > 0 && 100 * p > rulerWrap.clientWidth ? 50 : 100;
      ruler.style.width = `${lengthMm * p}px`;
      ruler.style.setProperty('--mm', String(lengthMm));
      ruler.setAttribute('aria-label', `${lengthMm} mm check bar`);
      ruler.hidden = false;
      rulerHint.textContent = `After saving, the bar must measure ${lengthMm} mm (±1 mm).`;
      rulerLabel.textContent = `Saved: ${p.toFixed(4)} CSS px/mm. Bar width ${(lengthMm * p).toFixed(1)} CSS px.`;
      if (calibrationDprChanged()) {
        rulerLabel.textContent += ' Warning: browser zoom changed since calibration — recalibrate.';
      }
    } else {
      ruler.hidden = true;
      rulerHint.textContent = 'Save first, then check the bar with a ruler.';
      rulerLabel.textContent = 'Not calibrated yet.';
    }
  }

  slider.addEventListener('input', () => { width = Number(slider.value); render(); });
  root.querySelectorAll('button[data-step]').forEach((b) => {
    b.addEventListener('click', () => { width += Number(b.dataset.step) * 0.5; render(); });
  });
  const onKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.target instanceof HTMLInputElement && e.target.type === 'range') return; // slider handles its own keys
    e.preventDefault();
    const step = e.shiftKey ? 5 : 0.5;
    width += e.key === 'ArrowRight' ? step : -step;
    render();
  };
  root.addEventListener('keydown', onKey);
  root.tabIndex = -1;

  root.querySelector('[data-action=save]').addEventListener('click', () => {
    try {
      const p = savePxPerMmFromCardWidth(width);
      status.textContent = 'Saved.';
      status.className = 'calib-status ok';
      root.querySelector('[data-role=next]').hidden = false;
      render();
      opts.onSaved?.(p);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'calib-status error';
    }
  });

  render();
  root.focus({ preventScroll: true });
  // A narrower window (or the device turned) gives the outline less room.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => { if (root.isConnected) render(); else ro.disconnect(); });
    ro.observe(stage);
  }
}
