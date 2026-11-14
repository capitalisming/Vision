"""Personal norm / change rule — port of app/src/core/baseline.ts (same constants)."""
from __future__ import annotations

import numpy as np
from scipy import stats

SIGMA0, PRIOR_DF, BASELINE_N, LARGE = 0.06, 3, 3, 0.30


def norm(baseline: np.ndarray, sigma0=SIGMA0, k=PRIOR_DF) -> dict:
    b = np.asarray(baseline, float)
    n = len(b)
    s = b.std(ddof=1) if n > 1 else 0.0
    df = k + n - 1
    s_eff = np.sqrt((k * sigma0**2 + (n - 1) * s**2) / df)
    # The app uses a tabulated t; scipy gives the exact quantile (differences < 0.005).
    limit = stats.t.ppf(0.95, df) * s_eff * np.sqrt(1 + 1 / n)
    return {"n": n, "mean": float(b.mean()), "s_raw": float(s), "s_eff": float(s_eff), "df": df, "limit": float(limit)}
