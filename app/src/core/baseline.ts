/**
 * Personal norm and change detection.
 *
 * For one eye and one correction (e.g. "own glasses"), the baseline is the set of the
 * first N valid sessions (N = baselineSessions; default 3 for the one-evening protocol,
 * 5 recommended for pre-flight use, sessions on different days). Once N sessions exist the
 * norm is frozen; later sessions never change it (a slow drift must not redefine "normal"). Their spread is the
 * person's own session-to-session variability s.
 *
 * Because s from 3–5 sessions is itself very uncertain (a lucky low s would cause false
 * alarms), it is shrunk toward a prior value σ0 with k pseudo-degrees of freedom:
 *
 *     s_eff² = (k·σ0² + (n−1)·s²) / (k + n − 1),      df = k + n − 1
 *
 * A new session x is compared to the baseline mean m with a one-sided 95% prediction limit
 *
 *     limit = t_{0.95, df} · s_eff · sqrt(1 + 1/n)
 *
 * i.e. under "no change" a single new session exceeds the limit with probability ≈ 5%.
 * Requiring two consecutive exceedances before escalating cuts the false-alarm rate to
 * well below 1% (quantified by simulation in analysis/simulate.py).
 *
 * ASSUMPTIONS (PROPOSED, not clinically validated):
 *   σ0 = 0.06 logMAR — of the order of published letter-chart test–retest SD
 *                      (95% limits ≈ ±0.1–0.15 logMAR; Arditi & Cagenello 1993).
 *   k  = 3 pseudo-df.
 *   LARGE_CHANGE = 0.30 logMAR (3 chart lines) → advise contacting the physician directly.
 * All decision thresholds are parameters and must be reviewed by a clinician.
 */
import { mean, sd, t95 } from './stats';

export interface NormConfig {
  baselineSessions: number;
  sigma0: number;
  priorDf: number;
  largeChange: number;
  maxSessionSd: number;
}

export const DEFAULT_NORM: NormConfig = {
  baselineSessions: 3,
  sigma0: 0.06,
  priorDf: 3,
  largeChange: 0.3,
  maxSessionSd: 0.12,
};

export interface SessionPoint {
  id: string;
  t: string; // ISO time
  logMAR: number;
  sd: number; // posterior SD of this session's estimate
  valid: boolean; // quality gate passed
}

export interface Norm {
  n: number;
  mean: number;
  sRaw: number; // NaN if n < 2
  sEff: number;
  df: number;
  limit: number; // one-sided 95% prediction limit for a single new session
  ids: string[];
}

export function computeNorm(baseline: SessionPoint[], cfg: NormConfig = DEFAULT_NORM): Norm | null {
  const pts = baseline.filter((p) => p.valid).slice(0, cfg.baselineSessions);
  const n = pts.length;
  if (n < cfg.baselineSessions) return null;
  const xs = pts.map((p) => p.logMAR);
  const m = mean(xs);
  const s = sd(xs);
  const df = cfg.priorDf + n - 1;
  const sEff = Math.sqrt((cfg.priorDf * cfg.sigma0 ** 2 + (n - 1) * (isNaN(s) ? 0 : s) ** 2) / df);
  const limit = t95(df) * sEff * Math.sqrt(1 + 1 / n);
  return { n, mean: m, sRaw: s, sEff, df, limit, ids: pts.map((p) => p.id) };
}

export type Status =
  | 'need_baseline'
  | 'low_quality'
  | 'stable'
  | 'better'
  | 'possible_worsening'
  | 'confirmed_worsening'
  | 'large_worsening';

export interface Assessment {
  status: Status;
  delta: number | null; // logMAR change vs norm (+ = worse)
  limit: number | null;
  norm: Norm | null;
  sessionsToBaseline: number;
}

/**
 * Assess the most recent session of a time-ordered series (same eye, same correction).
 * The first valid sessions form the baseline; later sessions are compared to it.
 */
export function assess(series: SessionPoint[], cfg: NormConfig = DEFAULT_NORM): Assessment {
  const valid = series.filter((p) => p.valid);
  const last = series[series.length - 1];
  const baseN = Math.min(cfg.baselineSessions, valid.length);
  const norm = computeNorm(valid, cfg);
  if (!last) return { status: 'need_baseline', delta: null, limit: null, norm: null, sessionsToBaseline: cfg.baselineSessions };
  if (!last.valid) return { status: 'low_quality', delta: null, limit: norm?.limit ?? null, norm, sessionsToBaseline: 0 };
  if (!norm || norm.ids.includes(last.id)) {
    return {
      status: 'need_baseline',
      delta: null,
      limit: norm?.limit ?? null,
      norm,
      sessionsToBaseline: Math.max(0, cfg.baselineSessions - baseN),
    };
  }
  const delta = last.logMAR - norm.mean;
  const follow = valid.filter((p) => !norm.ids.includes(p.id));
  const prev = follow.length >= 2 ? follow[follow.length - 2] : null;
  const prevOver = prev ? prev.logMAR - norm.mean > norm.limit : false;
  let status: Status;
  if (delta >= cfg.largeChange && delta > norm.limit) status = 'large_worsening';
  else if (delta > norm.limit) status = prevOver ? 'confirmed_worsening' : 'possible_worsening';
  else if (delta < -norm.limit) status = 'better';
  else status = 'stable';
  return { status, delta, limit: norm.limit, norm, sessionsToBaseline: 0 };
}

/**
 * When the person re-tests wearing a stronger spare pair (e.g. NASA "space anticipation
 * glasses"), compare that result to the norm obtained with the usual correction.
 * restores=true  → the loss is optically correctable (consistent with a refractive shift).
 * restores=false → stronger glasses do not restore acuity: not explained by defocus alone.
 */
export function correctionRestores(norm: Norm, withStronger: number): boolean {
  return withStronger - norm.mean <= norm.limit;
}

export const SESSION_VALID = (sdEst: number, atBoundary: boolean, cfg: NormConfig = DEFAULT_NORM) =>
  sdEst <= cfg.maxSessionSd && !atBoundary;
