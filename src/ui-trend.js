// Trend screen (#screen-trend): logMAR over time with the personal baseline band.
// Plain SVG, no chart library.
import { computeBaseline, classify, isMeasurable } from './baseline.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 720;
const H = 380;
const M = { top: 20, right: 44, bottom: 70, left: 56 };
const FAIL_ROW = H - M.bottom + 34; // y of the "no result" marker row

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const timeOf = (s) => new Date(s.timestamp).getTime();
const day = (t) => new Date(t).toISOString().slice(0, 10);
const failReason = (s) => s.reason || (s.floorHit ? 'floor hit' : 'no result');

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawChart(sessions) {
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'logMAR trend' });
  svg.style.maxWidth = `${W}px`;
  svg.style.font = '12px system-ui';
  if (sessions.length === 0) {
    svg.append(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'No sessions for this filter'));
    return svg;
  }

  const baseline = computeBaseline(sessions);
  const measured = sessions.filter(isMeasurable);
  const ys = measured.map((s) => s.logMAR);
  if (baseline) ys.push(baseline.mean - baseline.threshold, baseline.mean + baseline.threshold);
  const yMin = Math.floor(((ys.length ? Math.min(...ys) : 0) - 0.05) * 10) / 10;
  const yMax = Math.ceil(((ys.length ? Math.max(...ys) : 0.5) + 0.05) * 10) / 10;
  const times = sessions.map(timeOf);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (t) => (tMax === tMin ? M.left + plotW / 2 : M.left + ((t - tMin) / (tMax - tMin)) * plotW);
  // Inverted axis: lower logMAR (better vision) is drawn higher.
  const y = (v) => M.top + ((v - yMin) / (yMax - yMin)) * plotH;

  // Baseline band.
  if (baseline) {
    const top = y(baseline.mean - baseline.threshold);
    const bottom = y(baseline.mean + baseline.threshold);
    svg.append(
      svgEl('rect', { x: M.left, y: top, width: plotW, height: bottom - top, fill: '#4a90d9', 'fill-opacity': 0.15 }),
      svgEl('line', { x1: M.left, x2: M.left + plotW, y1: y(baseline.mean), y2: y(baseline.mean), stroke: '#4a90d9', 'stroke-dasharray': '4 3' }),
    );
  }

  // Y axis with ticks every 0.1 logMAR.
  svg.append(svgEl('line', { x1: M.left, x2: M.left, y1: M.top, y2: M.top + plotH, stroke: 'currentColor' }));
  for (let v = yMin; v <= yMax + 1e-9; v += 0.1) {
    svg.append(
      svgEl('line', { x1: M.left - 4, x2: M.left, y1: y(v), y2: y(v), stroke: 'currentColor' }),
      svgEl('text', { x: M.left - 8, y: y(v) + 4, 'text-anchor': 'end', fill: 'currentColor' }, v.toFixed(1)),
    );
  }
  svg.append(
    svgEl('text', { transform: `translate(14 ${M.top + plotH / 2}) rotate(-90)`, 'text-anchor': 'middle', fill: 'currentColor' }, 'logMAR (better ↑)'),
  );

  // X axis with up to 6 date ticks.
  svg.append(svgEl('line', { x1: M.left, x2: M.left + plotW, y1: M.top + plotH, y2: M.top + plotH, stroke: 'currentColor' }));
  const nTicks = tMax === tMin ? 1 : Math.min(6, sessions.length);
  for (let i = 0; i < nTicks; i++) {
    const t = nTicks === 1 ? tMin : tMin + ((tMax - tMin) * i) / (nTicks - 1);
    svg.append(svgEl('text', { x: x(t), y: M.top + plotH + 16, 'text-anchor': 'middle', fill: 'currentColor' }, day(t)));
  }
  svg.append(svgEl('text', { x: M.left - 8, y: FAIL_ROW + 4, 'text-anchor': 'end', fill: '#777' }, 'no result'));

  // Sessions: in-band dots, out-of-band dots highlighted, failed sessions as
  // triangles in a separate row with the reason on hover.
  sessions.forEach((s, i) => {
    const cx = x(timeOf(s));
    const state = classify(s, baseline, sessions[i - 1]);
    let mark;
    if (state === 'not_measurable') {
      mark = svgEl('path', { d: `M${cx} ${FAIL_ROW - 6} l6 11 h-12 z`, fill: '#777' });
      mark.append(svgEl('title', {}, `${day(timeOf(s))}: ${failReason(s)}`));
    } else {
      const out = state === 'single' || state === 'persistent';
      mark = svgEl('circle', {
        cx,
        cy: y(s.logMAR),
        r: out ? 7 : 4.5,
        fill: out ? '#d32f2f' : '#333',
        stroke: out ? '#fff' : 'none',
        'stroke-width': 1.5,
      });
      mark.append(svgEl('title', {}, `${day(timeOf(s))}: logMAR ${s.logMAR.toFixed(2)}${out ? ' (outside band)' : ''}`));
    }
    svg.append(mark);
  });
  return svg;
}

// Renders the trend with participant / eye / glasses filters. onChange gets
// the filtered sessions sorted by time each time the filter changes.
export function renderTrend(container = document.getElementById('screen-trend'), sessions = [], onChange) {
  const values = (key) => [...new Set(sessions.map((s) => String(s[key])))].sort();
  const select = (key, label) =>
    `<label>${label} <select name="${key}">${values(key).map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>`;
  container.innerHTML = `
    <h2>Trend</h2>
    <div class="trend-filters" style="display:flex;gap:12px;margin-bottom:8px">
      ${select('participant', 'Participant')}${select('eye', 'Eye')}${select('glasses', 'Glasses')}
    </div>
    <div class="trend-chart"></div>
    <p class="trend-legend" style="font-size:12px;color:#555">Band: personal baseline mean ± threshold.
      Red: outside the band. Triangle: no result (hover for the reason).</p>`;

  const update = () => {
    const pick = (key) => container.querySelector(`[name="${key}"]`).value;
    const filtered = sessions
      .filter((s) => ['participant', 'eye', 'glasses'].every((k) => String(s[k]) === pick(k)))
      .sort((a, b) => timeOf(a) - timeOf(b));
    container.querySelector('.trend-chart').replaceChildren(drawChart(filtered));
    if (onChange) onChange(filtered);
  };
  container.querySelector('.trend-filters').addEventListener('change', update);
  update();
}
