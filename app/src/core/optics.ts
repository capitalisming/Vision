/**
 * Geometric optics for optotype sizing.
 *
 * Conventions
 *  - MAR (minimum angle of resolution) = angular size of the critical detail
 *    (stroke / gap) of the optotype, in arc minutes.
 *  - logMAR = log10(MAR in arcmin). 0.0 = "20/20" = decimal 1.0.
 *  - A tumbling-E is 5 strokes tall and 5 strokes wide, so letter height = 5 × stroke.
 *  - Distances are eye→screen in centimetres; physical sizes in millimetres.
 */
export const ARCMIN_PER_RAD = (60 * 180) / Math.PI;

/** Angular size (arcmin) of a detail of `sizeMm` seen from `distanceCm`. */
export function marArcmin(sizeMm: number, distanceCm: number): number {
  return 2 * Math.atan(sizeMm / (2 * distanceCm * 10)) * ARCMIN_PER_RAD;
}

/** logMAR of a stroke of `strokeMm` seen from `distanceCm`. */
export function logMARFromStroke(strokeMm: number, distanceCm: number): number {
  return Math.log10(marArcmin(strokeMm, distanceCm));
}

/** Physical stroke width (mm) that produces `logMAR` at `distanceCm`. */
export function strokeMmForLogMAR(logMAR: number, distanceCm: number): number {
  const marRad = Math.pow(10, logMAR) / ARCMIN_PER_RAD;
  return 2 * distanceCm * 10 * Math.tan(marRad / 2);
}

export const decimalAcuity = (logMAR: number) => Math.pow(10, -logMAR);
export const snellen20 = (logMAR: number) => 20 * Math.pow(10, logMAR);
/** Accommodative (vergence) demand of a target at `distanceCm`, dioptres. */
export const vergenceDemandD = (distanceCm: number) => 100 / distanceCm;

/**
 * Smallest logMAR that a display can draw at `distanceCm` if the stroke may not be
 * thinner than `minStrokePx` device pixels of pitch `pixelMm`.
 */
export function minRenderableLogMAR(pixelMm: number, distanceCm: number, minStrokePx = 1): number {
  return logMARFromStroke(pixelMm * minStrokePx, distanceCm);
}

/** Pixel pitch (mm) from pixels-per-inch. */
export const pitchFromPpi = (ppi: number) => 25.4 / ppi;
