/**
 * Eye-to-screen distance from the front camera.
 *
 * Principle (pinhole camera): an object of fixed physical size S at distance d images to
 * s = f·S/d pixels, so d = (f·S)/s = K/s. The constant K is obtained per person and per
 * device in a one-off calibration at a tape-measured distance d0:  K = s0 · d0.
 * Calibrating per person removes the need to assume a population iris size
 * (adult HVID ≈ 11.7–12 mm, but varies by ±0.5 mm, i.e. ±4% distance error).
 *
 * Three independent features are used; each is calibrated separately:
 *   irisA, irisB — visible iris diameter of each eye (max chord of the 4 MediaPipe iris
 *                  contour points 469–472 / 474–477: insensitive to small yaw or pitch);
 *   ipd          — distance between iris centres 468 and 473.
 * During monocular testing one eye is covered and its landmarks are extrapolated by the
 * model, so the reported distance is the median of the available estimates and all
 * three raw estimates are logged per trial for post-hoc validation (protocol E0).
 *
 * Eye labels A/B refer to image left/right, NOT to anatomical OD/OS, because whether the
 * camera frame is mirrored is platform dependent. Mapping is not needed for distance.
 */
import { median } from './stats';

export interface Pt { x: number; y: number }

export interface FaceFeaturesPx {
  irisA: number | null;
  irisB: number | null;
  ipd: number | null;
}

export interface DistanceCalibration {
  kIrisA: number | null;
  kIrisB: number | null;
  kIpd: number | null;
  frameW: number;
  frameH: number;
  distanceCm: number;
  at: string;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function maxChord(pts: Pt[]): number {
  let m = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.max(m, dist(pts[i], pts[j]));
  return m;
}

/** Extract pixel-space features from a 478-point MediaPipe face mesh (normalised coords). */
export function featuresFromLandmarks(lm: Pt[], frameW: number, frameH: number): FaceFeaturesPx {
  if (lm.length < 478) return { irisA: null, irisB: null, ipd: null };
  const px = (i: number): Pt => ({ x: lm[i].x * frameW, y: lm[i].y * frameH });
  const c1 = px(468), c2 = px(473);
  const i1 = maxChord([469, 470, 471, 472].map(px));
  const i2 = maxChord([474, 475, 476, 477].map(px));
  // A = iris whose centre is further left in the image
  const [a, b] = c1.x <= c2.x ? [i1, i2] : [i2, i1];
  return { irisA: a > 1 ? a : null, irisB: b > 1 ? b : null, ipd: dist(c1, c2) > 1 ? dist(c1, c2) : null };
}

/** Build calibration constants from frames captured at a known distance. */
export function calibrate(samples: FaceFeaturesPx[], distanceCm: number, frameW: number, frameH: number): DistanceCalibration {
  const k = (key: keyof FaceFeaturesPx) => {
    const v = samples.map((s) => s[key]).filter((x): x is number => x != null);
    return v.length >= Math.max(5, samples.length / 2) ? median(v) * distanceCm : null;
  };
  return { kIrisA: k('irisA'), kIrisB: k('irisB'), kIpd: k('ipd'), frameW, frameH, distanceCm, at: new Date().toISOString() };
}

export interface DistanceEstimate {
  cm: number | null;
  irisA: number | null;
  irisB: number | null;
  ipd: number | null;
}

/**
 * Per-frame distance. K scales linearly with frame width if the stream resolution
 * changed since calibration (same sensor, same field of view assumed).
 */
export function estimateDistance(f: FaceFeaturesPx, cal: DistanceCalibration, frameW: number): DistanceEstimate {
  const scale = frameW / cal.frameW;
  const e = (k: number | null, s: number | null) => (k != null && s != null ? (k * scale) / s : null);
  const irisA = e(cal.kIrisA, f.irisA);
  const irisB = e(cal.kIrisB, f.irisB);
  const ipd = e(cal.kIpd, f.ipd);
  const avail = [irisA, irisB, ipd].filter((x): x is number => x != null && isFinite(x));
  return { cm: avail.length ? median(avail) : null, irisA, irisB, ipd };
}

/** Temporal median filter over a short window (rejects single-frame landmark glitches). */
export class DistanceSmoother {
  private buf: { t: number; v: number }[] = [];
  constructor(private windowMs = 400) {}
  push(t: number, v: number | null) {
    if (v != null && isFinite(v)) this.buf.push({ t, v });
    this.buf = this.buf.filter((s) => t - s.t <= this.windowMs);
  }
  value(): number | null {
    return this.buf.length >= 3 ? median(this.buf.map((s) => s.v)) : null;
  }
  clear() {
    this.buf = [];
  }
}
