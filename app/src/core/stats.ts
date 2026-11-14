export const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
export function sd(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
export function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** One-sided 95% Student-t quantiles (t_{0.95, df}); linear interpolation in 1/df. */
const T95: [number, number][] = [
  [1, 6.314], [2, 2.92], [3, 2.353], [4, 2.132], [5, 2.015], [6, 1.943], [7, 1.895],
  [8, 1.86], [9, 1.833], [10, 1.812], [12, 1.782], [15, 1.753], [20, 1.725], [30, 1.697],
  [60, 1.671], [120, 1.658], [Infinity, 1.645],
];
export function t95(df: number): number {
  if (df <= 1) return T95[0][1];
  for (let i = 1; i < T95.length; i++) {
    const [d1, v1] = T95[i - 1];
    const [d2, v2] = T95[i];
    if (df <= d2) {
      const a = 1 / d1, b = d2 === Infinity ? 0 : 1 / d2, x = 1 / df;
      return v1 + ((a - x) / (a - b)) * (v2 - v1);
    }
  }
  return 1.645;
}
