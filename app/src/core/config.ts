/** Protocol constants. Changing any of these breaks comparability with earlier sessions. */
export const APP_VERSION = '0.1.0';
export const TARGET_DISTANCE_CM = 40;
/** ±10 %: vergence demand 2.27–2.78 D, i.e. within ±0.25 D of the nominal 2.5 D. */
export const DISTANCE_WINDOW: [number, number] = [36, 44];
export const TRIALS_PER_EYE = 24;
export const MIN_STROKE_DEV_PX = 1.0;
export const MAX_LOGMAR = 1.3;
/** ISO/IEC 7810 ID-1 card. The SHORT side is matched: the long side (85.6 mm) is wider than
 *  most phone screens in portrait. 1 mm matching error → 1.9 % size error (≈0.008 logMAR). */
export const ID1_SHORT_MM = 53.98;
export const ID1_LONG_MM = 85.6;
