/**
 * Bayesian adaptive threshold estimation on a discrete θ grid.
 *
 * Stimulus placement: minimum expected posterior entropy (Kontsevich & Tyler, 1999,
 * "Bayesian adaptive estimation of psychometric slope and threshold", Vision Res 39:2729)
 * restricted to threshold only (slope fixed).
 *
 * Reported estimate: posterior mean and SD computed with a UNIFORM prior over the grid
 * from the realised (actually displayed, distance-corrected) logMAR values. This makes the
 * estimate a pure function of the logged trials, so it can be recomputed independently
 * (see analysis/vision_analysis/threshold.py, which must give identical numbers).
 */
import { DEFAULT_PSYCH, PsychParams, pCorrect } from './psychometric';

export const GRID_MIN = -0.6;
export const GRID_MAX = 1.4;
export const GRID_STEP = 0.005;

export function makeGrid(min = GRID_MIN, max = GRID_MAX, step = GRID_STEP): number[] {
  const n = Math.round((max - min) / step) + 1;
  return Array.from({ length: n }, (_, i) => +(min + i * step).toFixed(6));
}

export interface TrialOutcome {
  /** realised logMAR of the displayed optotype */
  x: number;
  correct: boolean;
}

/** Log-likelihood of all trials for every grid θ. */
export function logLikelihood(trials: TrialOutcome[], grid: number[], p: PsychParams = DEFAULT_PSYCH): number[] {
  const ll = new Array(grid.length).fill(0);
  for (const t of trials) {
    for (let j = 0; j < grid.length; j++) {
      const pc = pCorrect(t.x, grid[j], p);
      ll[j] += Math.log(t.correct ? pc : 1 - pc);
    }
  }
  return ll;
}

function normalise(logw: number[]): number[] {
  const m = Math.max(...logw);
  const w = logw.map((v) => Math.exp(v - m));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
}

export interface Estimate {
  mean: number;
  sd: number;
  /** maximum-likelihood θ on the grid */
  mle: number;
  n: number;
  nCorrect: number;
  /** true if the posterior mass piles up at a grid edge (estimate unreliable) */
  atBoundary: boolean;
}

export function estimateThreshold(trials: TrialOutcome[], p: PsychParams = DEFAULT_PSYCH, grid = makeGrid()): Estimate {
  const ll = logLikelihood(trials, grid, p);
  const w = normalise(ll);
  let mean = 0;
  for (let j = 0; j < grid.length; j++) mean += w[j] * grid[j];
  let v = 0;
  for (let j = 0; j < grid.length; j++) v += w[j] * (grid[j] - mean) ** 2;
  let jm = 0;
  for (let j = 1; j < grid.length; j++) if (ll[j] > ll[jm]) jm = j;
  const edge = Math.max(1, Math.round(0.1 / GRID_STEP));
  const massLow = w.slice(0, edge).reduce((a, b) => a + b, 0);
  const massHigh = w.slice(-edge).reduce((a, b) => a + b, 0);
  return {
    mean,
    sd: Math.sqrt(v),
    mle: grid[jm],
    n: trials.length,
    nCorrect: trials.filter((t) => t.correct).length,
    atBoundary: massLow > 0.05 || massHigh > 0.05,
  };
}

/**
 * Adaptive staircase object. The placement prior is weakly informative
 * (Normal(0.1, 0.5) logMAR) purely to choose sensible early stimuli; it does not
 * enter the reported estimate.
 */
export class PsiStaircase {
  readonly grid: number[];
  private logPost: number[];
  readonly trials: TrialOutcome[] = [];
  constructor(
    private candidates: number[],
    private p: PsychParams = DEFAULT_PSYCH,
    priorMean = 0.1,
    priorSd = 0.5,
  ) {
    if (candidates.length === 0) throw new Error('no renderable stimulus levels');
    this.grid = makeGrid();
    this.logPost = this.grid.map((g) => -0.5 * ((g - priorMean) / priorSd) ** 2);
  }

  /** Next stimulus logMAR (requested; the realised value may differ slightly). */
  next(): number {
    if (this.trials.length === 0) {
      // first trial: clearly supra-threshold so the task is understood
      return this.closest(0.5);
    }
    const post = normalise(this.logPost);
    let best = this.candidates[0];
    let bestH = Infinity;
    for (const x of this.candidates) {
      let pc = 0;
      const lc = new Array(this.grid.length);
      for (let j = 0; j < this.grid.length; j++) {
        lc[j] = pCorrect(x, this.grid[j], this.p);
        pc += post[j] * lc[j];
      }
      const h = pc * entropyOf(post, lc, true) + (1 - pc) * entropyOf(post, lc, false);
      if (h < bestH) {
        bestH = h;
        best = x;
      }
    }
    return best;
  }

  update(x: number, correct: boolean) {
    this.trials.push({ x, correct });
    for (let j = 0; j < this.grid.length; j++) {
      const pc = pCorrect(x, this.grid[j], this.p);
      this.logPost[j] += Math.log(correct ? pc : 1 - pc);
    }
  }

  estimate(): Estimate {
    return estimateThreshold(this.trials, this.p, this.grid);
  }

  private closest(x: number) {
    return this.candidates.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
  }
}

function entropyOf(post: number[], lc: number[], correct: boolean): number {
  let s = 0;
  const q = new Array(post.length);
  for (let j = 0; j < post.length; j++) {
    q[j] = post[j] * (correct ? lc[j] : 1 - lc[j]);
    s += q[j];
  }
  let h = 0;
  for (let j = 0; j < post.length; j++) {
    const v = q[j] / s;
    if (v > 0) h -= v * Math.log(v);
  }
  return h;
}

/** Candidate logMAR levels between lo and hi in steps of `step`. */
export function candidateLevels(lo: number, hi: number, step = 0.02): number[] {
  const out: number[] = [];
  for (let x = lo; x <= hi + 1e-9; x += step) out.push(+x.toFixed(4));
  return out;
}
