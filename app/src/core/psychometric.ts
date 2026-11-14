/**
 * Psychometric model for a 4-alternative forced-choice tumbling-E task.
 *
 *   p(correct | x, θ) = γ + (1 − γ − λ) · 1 / (1 + exp(−β (x − θ)))
 *
 *  x — logMAR of the presented optotype (larger = bigger = easier)
 *  θ — threshold (logMAR); at x = θ the sigmoid is 0.5, i.e. p ≈ 0.615
 *  γ — guess rate = 1/4 for four orientations
 *  λ — lapse rate (finger slips, blinks)
 *  β — slope, 1/logMAR. ASSUMPTION: fixed at 12 (≈ cumulative-normal SD 0.14 logMAR).
 *      The analysis pipeline tests robustness of the estimate to β ∈ [6, 24].
 */
export interface PsychParams {
  guess: number;
  lapse: number;
  slope: number;
}

export const DEFAULT_PSYCH: PsychParams = { guess: 0.25, lapse: 0.02, slope: 12 };

export function pCorrect(x: number, theta: number, p: PsychParams = DEFAULT_PSYCH): number {
  return p.guess + (1 - p.guess - p.lapse) / (1 + Math.exp(-p.slope * (x - theta)));
}
