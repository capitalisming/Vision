/**
 * Trend screen (#screen-trend): personal norm band and one point per session.
 *
 * Plain SVG, no chart library. X is session time, Y is logMAR with the axis inverted so
 * better vision is higher. The band is mean ± threshold of the personal norm; points outside
 * it are highlighted. Sessions without a number (refused, floor hit) get a separate marker at
 * the bottom with the reason on hover.
 */
import { computeBaseline, normalizeSession } from './baseline.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 900;
const H = 420;
const M = { top: 20, right: 20, bottom: 78, left: 64 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = String(text);
  return node;
};

const glassesLabel = (g) => (g === true ? 'yes' : g === false ? 'no' : 'unknown');
const glassesValue = (label) => (label === 'yes' ? true : label === 'no' ? false : null);

const time = (s) => {
  const t = Date.parse(s.timestamp);
  return Number.isFinite(t) ? t : null;
};

function fmtTick(t, spanMs) {
  const d = new Date(t);
  const day = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (spanMs > 2 * 864e5) return day;
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const TEMPLATE = `
<div class="nvm-screen">
  <h1>Your trend</h1>
  <div class="nvm-row">
    <label class="nvm-field">Participant <select data-filter="participant"></select></label>
    <label class="nvm-field">Eye <select data-filter="eye"></select></label>
    <label class="nvm-field">Glasses <select data-filter="glasses"></select></label>
  </div>
  <p class="nvm-hint" data-role="note"></p>
  <div class="nvm-chart" data-role="chart"></div>
  <div class="nvm-legend">
    <span><i class="nvm-swatch nvm-swatch-band"></i>personal norm (mean ± threshold)</span>
    <span><i class="nvm-swatch nvm-swatch-in"></i>inside the norm</span>
    <span><i class="nvm-swatch nvm-swatch-out"></i>outside the norm</span>
    <span><i class="nvm-swatch nvm-swatch-void"></i>no number (hover for the reason)</span>
  </div>
</div>`;

/**
 * @param {HTMLElement} container the #screen-trend container.
 * @param {{sessions?: object[]}} [options]
 */
export function mountTrendScreen(container, options = {}) {
  if (!container) throw new TypeError('mountTrendScreen(container): container required');

  container.innerHTML = TEMPLATE;
  const $ = (sel) => container.querySelector(sel);
  const selectP = $('[data-filter="participant"]');
  const selectE = $('[data-filter="eye"]');
  const selectG = $('[data-filter="glasses"]');
  const chartEl = $('[data-role="chart"]');
  const noteEl = $('[data-role="note"]');

  let sessions = [];
  let destroyed = false;

  const allRows = () => sessions.map(normalizeSession);

  function uniqueValues(rows, key) {
    const seen = [];
    for (const r of rows) if (!seen.includes(r[key])) seen.push(r[key]);
    return seen;
  }

  function fillSelect(select, values, format = (v) => String(v)) {
    const previous = select.value;
    const options = values.map(format);
    select.innerHTML = options.map((v) => `<option value="${v}">${v}</option>`).join('');
    if (options.includes(previous)) select.value = previous;
  }

  /** Each filter only offers combinations that actually exist, so a change never lands on an
      empty chart unless the data itself is empty. */
  function rebuildFilters() {
    const rows = allRows();
    fillSelect(selectP, uniqueValues(rows, 'participant').filter((v) => v != null));

    const participant = selectP.value;
    const byParticipant = rows.filter((s) => s.participant === participant);
    fillSelect(selectE, uniqueValues(byParticipant, 'eye').filter((v) => v != null));

    const eye = selectE.value;
    const byEye = byParticipant.filter((s) => s.eye === eye);
    fillSelect(selectG, uniqueValues(byEye, 'glasses').map(glassesLabel));
  }

  function selectedRows() {
    const participant = selectP.value;
    const eye = selectE.value;
    const glasses = glassesValue(selectG.value);
    const rows = allRows()
      .filter((s) => s.participant === participant && s.eye === eye && s.glasses === glasses)
      .filter((s) => time(s) != null)
      .sort((a, b) => time(a) - time(b));
    if (rows.length === 0) return { rows, targetMm: null };
    // targetMm is not a filter in the UI: use the distance of the latest session of the series.
    const targetMm = rows[rows.length - 1].targetMm;
    return { rows: rows.filter((s) => s.targetMm === targetMm), targetMm };
  }

  function render() {
    if (destroyed) return;
    const { rows, targetMm } = selectedRows();
    chartEl.innerHTML = '';

    if (rows.length === 0) {
      noteEl.textContent = 'No sessions for this filter yet.';
      chartEl.innerHTML = '<p class="nvm-empty">Nothing to plot. Run a test first.</p>';
      return;
    }

    const measurable = rows.filter((s) => s.logMAR != null && !s.floorHit);
    const unmeasurable = rows.filter((s) => s.logMAR == null || s.floorHit);
    const baseline = computeBaseline(rows);

    noteEl.textContent =
      `Target ${targetMm ?? '?'} mm · ${measurable.length} measurable session(s)` +
      (baseline
        ? ` · norm ${baseline.mean.toFixed(2)} ± ${baseline.threshold.toFixed(2)} logMAR (n = ${baseline.n})`
        : ' · norm not ready: needs five usable sessions');

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': 'Session logMAR over time with the personal norm band',
    });
    svg.classList.add('nvm-svg');

    // ---- scales -------------------------------------------------------------------
    const values = measurable.map((s) => s.logMAR);
    if (baseline) values.push(baseline.mean - baseline.threshold, baseline.mean + baseline.threshold);
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 0.3;
    lo = Math.floor((lo - 0.05) / 0.05) * 0.05;
    hi = Math.ceil((hi + 0.05) / 0.05) * 0.05;
    if (hi - lo < 0.3) {
      const mid = (hi + lo) / 2;
      lo = mid - 0.15;
      hi = mid + 0.15;
    }
    const y = (v) => M.top + ((v - lo) / (hi - lo)) * PLOT_H;

    const times = rows.map(time);
    let t0 = Math.min(...times);
    let t1 = Math.max(...times);
    if (t1 === t0) {
      t0 -= 6 * 3600e3;
      t1 += 6 * 3600e3;
    }
    const x = (t) => M.left + ((t - t0) / (t1 - t0)) * PLOT_W;

    // ---- grid and axes ------------------------------------------------------------
    const grid = svgEl('g', { class: 'nvm-grid' });
    for (let v = Math.ceil(lo * 10) / 10; v <= hi + 1e-9; v += 0.1) {
      const yy = y(v);
      grid.appendChild(svgEl('line', { x1: M.left, x2: M.left + PLOT_W, y1: yy, y2: yy }));
      svg.appendChild(svgEl('text', { x: M.left - 10, y: yy + 4, class: 'nvm-axis-label nvm-axis-y' }, v.toFixed(1)));
    }
    svg.appendChild(grid);

    const xAxisY = M.top + PLOT_H;
    svg.appendChild(
      svgEl('line', { x1: M.left, x2: M.left + PLOT_W, y1: xAxisY, y2: xAxisY, class: 'nvm-axis' }),
    );
    svg.appendChild(
      svgEl('line', { x1: M.left, x2: M.left, y1: M.top, y2: xAxisY, class: 'nvm-axis' }),
    );

    const span = t1 - t0;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + (span * i) / ticks;
      const xx = x(t);
      svg.appendChild(svgEl('line', { x1: xx, x2: xx, y1: xAxisY, y2: xAxisY + 5, class: 'nvm-axis' }));
      svg.appendChild(
        svgEl('text', { x: xx, y: xAxisY + 22, class: 'nvm-axis-label', 'text-anchor': 'middle' }, fmtTick(t, span)),
      );
    }

    svg.appendChild(
      svgEl('text', { x: M.left + PLOT_W / 2, y: H - 12, class: 'nvm-axis-title', 'text-anchor': 'middle' }, 'Session date'),
    );
    svg.appendChild(
      svgEl(
        'text',
        { x: 16, y: M.top + PLOT_H / 2, class: 'nvm-axis-title', transform: `rotate(-90 16 ${M.top + PLOT_H / 2})`, 'text-anchor': 'middle' },
        'logMAR (better up)',
      ),
    );

    // ---- personal norm band -------------------------------------------------------
    if (baseline) {
      const top = y(baseline.mean + baseline.threshold);
      const bottom = y(baseline.mean - baseline.threshold);
      svg.appendChild(
        svgEl('rect', {
          x: M.left,
          y: top,
          width: PLOT_W,
          height: Math.max(1, bottom - top),
          class: 'nvm-band',
        }),
      );
      svg.appendChild(
        svgEl('line', {
          x1: M.left,
          x2: M.left + PLOT_W,
          y1: y(baseline.mean),
          y2: y(baseline.mean),
          class: 'nvm-mean-line',
        }),
      );
      svg.appendChild(
        svgEl('text', { x: M.left + PLOT_W - 6, y: top - 6, class: 'nvm-band-label', 'text-anchor': 'end' }, 'personal norm'),
      );
    }

    // ---- points -------------------------------------------------------------------
    const out = (s) => baseline && Math.abs(s.logMAR - baseline.mean) > baseline.threshold;

    measurable.forEach((s) => {
      const t = time(s);
      const cx = x(t);
      const cy = y(s.logMAR);
      const delta = baseline ? s.logMAR - baseline.mean : null;
      const dot = svgEl('circle', { cx, cy, r: 5, class: `nvm-dot ${out(s) ? 'is-out' : 'is-in'}` });
      const when = new Date(t).toLocaleString();
      dot.appendChild(
        svgEl(
          'title',
          {},
          `${when} · ${s.logMAR.toFixed(2)} logMAR` +
            (delta == null ? '' : ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs norm`) +
            (s.floorHit ? ' · floor hit' : ''),
        ),
      );
      svg.appendChild(dot);
    });

    unmeasurable.forEach((s) => {
      const t = time(s);
      const cx = x(t);
      const cy = xAxisY + 12;
      const reason = s.floorHit ? 'Floor hit: no number' : s.reason || 'No logMAR number';
      const marker = svgEl('path', {
        d: `M ${cx} ${cy - 6} L ${cx + 6} ${cy + 5} L ${cx - 6} ${cy + 5} Z`,
        class: 'nvm-void',
      });
      marker.appendChild(svgEl('title', {}, `${new Date(t).toLocaleString()} · ${reason}`));
      svg.appendChild(marker);
    });

    if (rows.length === 1) {
      svg.appendChild(
        svgEl('text', { x: x(times[0]) + 10, y: y(measurable[0]?.logMAR ?? lo) - 10, class: 'nvm-axis-label' }, 'first session'),
      );
    }

    chartEl.appendChild(svg);
  }

  selectP.addEventListener('change', () => {
    rebuildFilters();
    render();
  });
  selectE.addEventListener('change', () => {
    rebuildFilters();
    render();
  });
  selectG.addEventListener('change', render);

  function update(nextSessions) {
    sessions = Array.isArray(nextSessions) ? nextSessions : [];
    rebuildFilters();
    render();
  }

  update(options.sessions ?? []);

  return {
    update,
    render,
    destroy() {
      destroyed = true;
      container.innerHTML = '';
    },
    getFiltered: selectedRows,
  };
}