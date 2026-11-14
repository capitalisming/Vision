import { describe, expect, it } from 'vitest';
import { logMARFromStroke, strokeMmForLogMAR, marArcmin, minRenderableLogMAR, pitchFromPpi } from '../optics';
import { PsiStaircase, candidateLevels, estimateThreshold } from '../psi';
import { DEFAULT_PSYCH, pCorrect } from '../psychometric';
import { assess, computeNorm, SessionPoint } from '../baseline';
import { t95 } from '../stats';
import { calibrate, estimateDistance, featuresFromLandmarks } from '../distance';

// deterministic PRNG for SIMULATED observers (algorithm tests only)
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('optics', () => {
  it('1 arcmin stroke at 40 cm ≈ 0.1164 mm and logMAR 0', () => {
    expect(strokeMmForLogMAR(0, 40)).toBeCloseTo(0.11636, 4);
    expect(logMARFromStroke(0.11636, 40)).toBeCloseTo(0, 4);
    expect(marArcmin(strokeMmForLogMAR(0.3, 40), 40)).toBeCloseTo(10 ** 0.3, 6);
  });
  it('device limits: phone vs laptop at 40 cm', () => {
    // 460 ppi phone, 1 px stroke
    expect(minRenderableLogMAR(pitchFromPpi(460), 40)).toBeCloseTo(-0.326, 2);
    // 110 ppi laptop → cannot show anything below ~+0.3 logMAR without anti-aliasing
    expect(minRenderableLogMAR(pitchFromPpi(110), 40)).toBeGreaterThan(0.29);
  });
});

describe('stats', () => {
  it('t quantiles', () => {
    expect(t95(1)).toBeCloseTo(6.314, 3);
    expect(t95(5)).toBeCloseTo(2.015, 3);
    expect(t95(1e9)).toBeCloseTo(1.645, 2);
    expect(t95(11)).toBeGreaterThan(1.782);
    expect(t95(11)).toBeLessThan(1.812);
  });
});

describe('psi staircase (SIMULATED observer)', () => {
  it('recovers threshold within ~0.1 logMAR in 24 trials', () => {
    const r = rng(42);
    const errs: number[] = [];
    for (let rep = 0; rep < 60; rep++) {
      const truth = -0.2 + r() * 0.8;
      const st = new PsiStaircase(candidateLevels(-0.3, 1.3));
      for (let i = 0; i < 24; i++) {
        const x = st.next();
        st.update(x, r() < pCorrect(x, truth, DEFAULT_PSYCH));
      }
      errs.push(st.estimate().mean - truth);
    }
    const bias = errs.reduce((a, b) => a + b, 0) / errs.length;
    const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length);
    expect(Math.abs(bias)).toBeLessThan(0.04);
    expect(rmse).toBeLessThan(0.12);
  });
  it('estimate depends only on realised trials (uniform prior)', () => {
    const tr = [
      { x: 0.5, correct: true }, { x: 0.2, correct: true }, { x: 0.0, correct: false }, { x: 0.1, correct: true },
      { x: 0.05, correct: false }, { x: 0.15, correct: true },
    ];
    const a = estimateThreshold(tr);
    const b = estimateThreshold([...tr].reverse());
    expect(a.mean).toBeCloseTo(b.mean, 10);
  });
});

describe('personal norm', () => {
  const pt = (id: string, x: number, valid = true): SessionPoint => ({ id, t: id, logMAR: x, sd: 0.05, valid });
  it('needs 3 sessions', () => {
    expect(assess([pt('a', 0), pt('b', 0.02)]).status).toBe('need_baseline');
    expect(computeNorm([pt('a', 0), pt('b', 0.02)])).toBeNull();
  });
  it('limit is shrunk toward sigma0 when observed spread is tiny', () => {
    const n = computeNorm([pt('a', 0), pt('b', 0), pt('c', 0)])!;
    expect(n.sEff).toBeGreaterThan(0.04);
    expect(n.limit).toBeGreaterThan(0.08);
  });
  it('flags, then confirms, worsening', () => {
    const base = [pt('a', 0.0), pt('b', 0.04), pt('c', -0.03)];
    expect(assess([...base, pt('d', 0.01)]).status).toBe('stable');
    expect(assess([...base, pt('d', 0.2)]).status).toBe('possible_worsening');
    expect(assess([...base, pt('d', 0.2), pt('e', 0.22)]).status).toBe('confirmed_worsening');
    expect(assess([...base, pt('d', 0.45)]).status).toBe('large_worsening');
    expect(assess([...base, pt('d', 0.2, false)]).status).toBe('low_quality');
  });
});

describe('distance', () => {
  it('inverse-proportional estimate after calibration', () => {
    const W = 640, H = 480;
    // synthetic geometric landmarks (not a real face): two circles of radius r px
    const mk = (r: number, sep: number) => {
      const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
      const put = (c: number, cx: number) => {
        lm[c] = { x: cx / W, y: 240 / H };
        [[r, 0], [0, r], [-r, 0], [0, -r]].forEach(([dx, dy], k) => (lm[c + 1 + k] = { x: (cx + dx) / W, y: (240 + dy) / H }));
      };
      put(468, 320 + sep / 2);
      put(473, 320 - sep / 2);
      return lm;
    };
    const cal = calibrate(Array.from({ length: 10 }, () => featuresFromLandmarks(mk(10, 120), W, H)), 40, W, H);
    const far = estimateDistance(featuresFromLandmarks(mk(8, 96), W, H), cal, W);
    expect(far.cm).toBeCloseTo(50, 6);
    // stream resolution doubled → same physical distance
    const hi = estimateDistance(featuresFromLandmarks(mk(10, 120), W, H), cal, W);
    expect(hi.cm).toBeCloseTo(40, 6);
  });
});
