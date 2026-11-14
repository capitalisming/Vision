// AI-assisted (Claude Code), reviewed by a team member.
// Procedural iris texture for the home screen, drawn once at start-up from a seed.
// It is drawn in greys (structure only); the colour comes from a CSS tint layer, so it can change on scroll.
// Decorative only: no measurement, score or stored value depends on it.

const TAU = Math.PI * 2;

function hash(i, j, seed) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
const wrap = (i, n) => ((i % n) + n) % n;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1], periodic in `u` with period `n` cells, so there is no seam at 360 degrees. */
export function ringNoise(u, v, n, seed) {
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fu = smooth(u - i0);
  const fv = smooth(v - j0);
  const a = hash(wrap(i0, n), j0, seed);
  const b = hash(wrap(i0 + 1, n), j0, seed);
  const c = hash(wrap(i0, n), j0 + 1, seed);
  const d = hash(wrap(i0 + 1, n), j0 + 1, seed);
  return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
}

const INNER_LIGHTNESS = 0.62; // the zone around the pupil is lighter than the outer zone
const OUTER_LIGHTNESS = 0.48;

/**
 * Grey level of one point of the iris disc. `r` is the radius (0 centre, 1 outer edge) and `a` the angle as a
 * fraction of a full turn. Writes [G, G, G, A] (0-255) into `out`.
 */
export function irisPixel(r, a, seed, out) {
  if (r >= 1) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
  const fibres = 0.5 * ringNoise(a * 220, r * 5, 220, seed)
    + 0.3 * ringNoise(a * 440, r * 9 + 3, 440, seed + 1)
    + 0.2 * ringNoise(a * 90, r * 2, 90, seed + 2);
  const collarette = 0.46 + 0.05 * (ringNoise(a * 18, 0.5, 18, seed + 3) - 0.5); // wavy boundary between the zones
  const t = smoothstep(collarette - 0.035, collarette + 0.035, r);
  const blobs = 0.65 * ringNoise(a * 36, r * 11, 36, seed + 4) + 0.35 * ringNoise(a * 72, r * 22 + 5, 72, seed + 5);
  const crypt = smoothstep(0.58, 0.9, blobs) * smoothstep(0.3, 0.4, r) * (1 - smoothstep(0.7, 0.85, r));
  let lum = 0.45 + fibres;
  lum *= 1 - 0.4 * crypt;
  lum *= 1 - 0.85 * smoothstep(0.8, 0.99, r); // dark limbal ring
  lum *= 0.5 + 0.5 * smoothstep(0.17, 0.28, r); // shade at the pupil edge
  const grey = Math.min(255, Math.max(0, 255 * (INNER_LIGHTNESS + (OUTER_LIGHTNESS - INNER_LIGHTNESS) * t) * lum));
  out[0] = out[1] = out[2] = grey;
  out[3] = 255 * (1 - smoothstep(0.985, 1, r));
  return out;
}

/** RGBA pixels (size x size) of the grey iris disc on a transparent background. */
export function renderIris(size, seed = 1) {
  const data = new Uint8ClampedArray(size * size * 4);
  const px = [0, 0, 0, 0];
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      irisPixel(Math.hypot(dx, dy), (Math.atan2(dy, dx) + Math.PI) / TAU, seed, px);
      data.set(px, (y * size + x) * 4);
    }
  }
  return data;
}

/** Draw the iris into `canvas`. Returns false when the canvas cannot be drawn on (the page stays usable). */
export function paintIris(canvas, size = 720, seed = 1) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  canvas.width = size;
  canvas.height = size;
  ctx.putImageData(new ImageData(renderIris(size, seed), size, size), 0, 0);
  return true;
}
