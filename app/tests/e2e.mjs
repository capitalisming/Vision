// End-to-end QA in real Chromium, phone emulation (DPR 3).
//   MEASURED (software): stroke width of every rendered optotype, read back from canvas pixels.
//   SIMULATED: the observer. A bot answers with p(correct) from a psychometric function with a
//   known true threshold, using the orientation decoded from the pixels. This validates the
//   pipeline (render → response → log → estimate); it is NOT a measurement of anyone's vision.
// Usage: node tests/e2e.mjs [url]   (default http://localhost:4173/)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // uses the pre-installed Playwright
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://localhost:4173/';
const DPR = 3, VIEW = { width: 390, height: 844 };
const PPI = 460; // emulated physical density
const mmPerDevPx = 25.4 / PPI, mmPerCssPx = mmPerDevPx * DPR, cardCssW = 53.98 / mmPerCssPx;
const TRUE = { OD: 0.0, OS: 0.3 }; // SIMULATED observer thresholds (logMAR)
const psych = { guess: 0.25, lapse: 0.02, slope: 12 };
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pc = (x, t) => psych.guess + (1 - psych.guess - psych.lapse) / (1 + Math.exp(-psych.slope * (x - t)));
const logMAR = (strokeMm, dCm) => Math.log10(2 * Math.atan(strokeMm / (2 * dCm * 10)) * (60 * 180 / Math.PI));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL);
await page.getByRole('button', { name: 'Начать калибровку' }).click();
await page.locator('input[type=range]').evaluate((el, v) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  el.max = '1000';
  set.call(el, String(v));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, cardCssW);
await page.getByRole('button', { name: 'Совпадает — дальше' }).click();
await page.getByRole('button', { name: 'Без камеры (ручной режим)' }).click();
await page.getByRole('button', { name: /Пройти тест/ }).click();
await page.getByRole('button', { name: 'Эксперимент' }).click();
await page.getByRole('button', { name: 'Начать', exact: true }).click();

const rows = [];
for (const eye of ['OD', 'OS']) {
  await page.getByRole('button', { name: /Начать \(/ }).click();
  for (let i = 1; i <= 24; i++) {
    await page.getByText(`${eye} · ${i}/24`).waitFor();
    await page.waitForFunction(() => {
      const c = document.querySelector('canvas');
      if (!c || !c.width) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let k = 0; k < d.length; k += 4) if (d[k] < 250) return true;
      return false;
    });
    const m = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const { width: W, height: H } = c;
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      let sum = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const cov = (255 - d[(y * W + x) * 4]) / 255;
          if (cov <= 0) continue;
          sum += cov; sx += cov * (x + 0.5); sy += cov * (y + 0.5);
          if (cov > 0.02) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
        }
      return { sum, cx: sx / sum, cy: sy / sum, bx: (x0 + x1) / 2, by: (y0 + y1) / 2, cssW: c.clientWidth, W };
    });
    const strokeMeasPx = Math.sqrt(m.sum / 17); // E area = 17 stroke²
    const dx = m.cx - m.bx, dy = m.cy - m.by;
    const orient = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'right' : 'left') : dy < 0 ? 'down' : 'up';
    const x = logMAR(strokeMeasPx * mmPerDevPx, 40);
    const correct = rnd() < pc(x, TRUE[eye]);
    const others = ['right', 'down', 'left', 'up'].filter((o) => o !== orient);
    const resp = correct ? orient : others[Math.floor(rnd() * 3)];
    rows.push({ eye, i, strokeMeasPx, decoded: orient, resp });
    await page.keyboard.press({ right: 'ArrowRight', left: 'ArrowLeft', up: 'ArrowUp', down: 'ArrowDown' }[resp]);
  }
}
await page.getByRole('heading', { name: 'Результат' }).waitFor();
mkdirSync('qa', { recursive: true });
await page.screenshot({ path: 'qa/result-screen.png' });
const profile = await page.evaluate(() => JSON.parse(localStorage.getItem('nvm.profile.v1')));
await browser.close();

const s = profile.sessions[0];
let maxRel = 0, orientOk = 0;
const out = [];
for (const e of s.eyes)
  for (const t of e.trials) {
    const r = rows.find((q) => q.eye === e.eye && q.i === t.i);
    const rel = Math.abs(r.strokeMeasPx - t.strokeDevPx) / t.strokeDevPx;
    maxRel = Math.max(maxRel, rel);
    if (r.decoded === t.orientation) orientOk++;
    out.push({ eye: e.eye, i: t.i, logged_px: t.strokeDevPx, measured_px: r.strokeMeasPx, rel_err: rel, logged_orient: t.orientation, decoded_orient: r.decoded });
  }
writeFileSync('qa/render_check.csv', 'eye,trial,logged_stroke_px,measured_stroke_px,rel_err,logged_orient,decoded_orient\n' +
  out.map((o) => [o.eye, o.i, o.logged_px.toFixed(4), o.measured_px.toFixed(4), o.rel_err.toFixed(5), o.logged_orient, o.decoded_orient].join(',')).join('\n') + '\n');
// The app labels every session MEASURED; here the responses came from a bot, so relabel.
const labelled = { ...profile, _note: 'SIMULATED observer (bot); rendering values are real canvas measurements',
  sessions: profile.sessions.map((x) => ({ ...x, dataCategory: 'SIMULATED' })) };
writeFileSync('qa/e2e_profile_SIMULATED_OBSERVER.json', JSON.stringify(labelled, null, 1));
const summary = {
  page_errors: errors,
  trials: out.length,
  stroke_px_range: [Math.min(...out.map((o) => o.logged_px)), Math.max(...out.map((o) => o.logged_px))],
  max_rel_stroke_error: maxRel,
  orientation_decoded_matches_log: `${orientOk}/${out.length}`,
  estimates: s.eyes.map((e) => ({ eye: e.eye, true_SIMULATED: TRUE[e.eye], estimate: e.estimate.logMAR, sd: e.estimate.sd, valid: e.valid })),
  mmPerDevicePx_logged: s.device.mmPerDevicePx, mmPerDevicePx_expected: mmPerDevPx, dpr: s.device.dpr,
};
writeFileSync('qa/e2e_summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const pass = errors.length === 0 && maxRel < 0.03 && orientOk === out.length && s.eyes.every((e) => Math.abs(e.estimate.logMAR - TRUE[e.eye]) < 3 * e.estimate.sd + 0.05);
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
process.exit(pass ? 0 : 1);
