"""Statistical analyses for protocols E0 (distance), E1 (lens dose–response), E2 (repeatability)."""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import optimize, stats

from .norm import norm

TARGET_CM = 40.0


# ---------- E0: camera distance vs tape -----------------------------------------------------
def distance_agreement(D: pd.DataFrame) -> pd.DataFrame:
    """Bland–Altman per condition: bias, SD, 95% limits of agreement, relative error."""
    if D.empty:
        return pd.DataFrame()
    D = D.dropna(subset=["appCm"]).copy()
    D["diff"] = D["appCm"] - D["trueCm"]
    D["rel"] = D["diff"] / D["trueCm"]
    out = []
    for cond, g in D.groupby("condition"):
        b, s, n = g["diff"].mean(), g["diff"].std(ddof=1), len(g)
        out.append({"condition": cond, "n": n, "bias_cm": b, "sd_cm": s, "loa_low": b - 1.96 * s, "loa_high": b + 1.96 * s,
                    "mean_abs_rel_err_pct": 100 * g["rel"].abs().mean(), "max_abs_err_cm": g["diff"].abs().max(),
                    # what a distance error does to the logMAR scale: Δlog = log10(d_true/d_app)
                    "logMAR_error_at_LoA": float(np.log10(TARGET_CM / (TARGET_CM + max(abs(b - 1.96 * s), abs(b + 1.96 * s)))) * -1)})
    return pd.DataFrame(out)


# ---------- E1: lens dose–response ----------------------------------------------------------
def defocus_model(P, mar0, c, p0):
    """logMAR = log10( sqrt(MAR0² + (c·max(0, P − P0))²) ).

    P  – added plus lens (D). For a target at distance d, the eye can relax accommodation
         to clear plus lenses up to about 1/d (+2.5 D at 40 cm) plus its own refractive
         offset; beyond P0 the excess is uncorrectable myopic defocus.
    c  – blur growth, arcmin of MAR per dioptre (depends mainly on pupil size).
    Assumed functional form (blur ∝ defocus, added in quadrature to the in-focus MAR),
    cf. Smith 1991, Optom Vis Sci 68:591–598. Parameters are FITTED, not assumed."""
    return np.log10(np.sqrt(mar0**2 + (c * np.maximum(0, np.asarray(P) - p0)) ** 2))


def fit_defocus(P, y, sd):
    try:
        popt, pcov = optimize.curve_fit(defocus_model, P, y, p0=[1.0, 3.0, 2.5], sigma=np.maximum(sd, 0.02),
                                        absolute_sigma=True, bounds=([0.2, 0.1, 0.0], [10, 20, 5]), maxfev=20000)
        se = np.sqrt(np.diag(pcov))
        resid = y - defocus_model(P, *popt)
        return {"mar0": popt[0], "c_arcmin_per_D": popt[1], "P0_D": popt[2], "se_mar0": se[0], "se_c": se[1], "se_P0": se[2],
                "rmse": float(np.sqrt(np.mean(resid**2))), "ok": True}
    except (RuntimeError, ValueError) as e:  # too few points / no knee in range
        return {"ok": False, "error": str(e)}


def lens_experiment(E: pd.DataFrame):
    X = E[(E["mode"] == "experiment") & E["added_lens_D"].notna()].copy()
    if X.empty:
        return pd.DataFrame(), pd.DataFrame()
    detect, fits = [], []
    for (pid, eye), g in X.groupby(["participant_id", "eye"]):
        g = g.sort_values("started_at")
        base = g[(g["added_lens_D"] == 0) & g["valid"]]
        nrm = norm(base["logMAR"].to_numpy()) if len(base) >= 2 else None
        for P, h in g[g["added_lens_D"] != 0].groupby("added_lens_D"):
            hv = h[h["valid"]]
            y = hv["logMAR"].mean() if len(hv) else np.nan
            row = {"participant_id": pid, "eye": eye, "added_lens_D": P, "n_runs": len(h), "n_valid": len(hv), "logMAR": y,
                   "baseline_n": len(base), "baseline_mean": nrm["mean"] if nrm else np.nan, "limit": nrm["limit"] if nrm else np.nan}
            row["delta"] = y - row["baseline_mean"]
            row["detected"] = bool(row["delta"] > row["limit"]) if nrm and np.isfinite(y) else None
            detect.append(row)
        v = g[g["valid"]]
        f = fit_defocus(v["added_lens_D"].to_numpy(float), v["logMAR"].to_numpy(), v["sd"].to_numpy())
        hi = v[v["added_lens_D"] >= 2.5]
        rho, p = stats.spearmanr(hi["added_lens_D"], hi["logMAR"]) if hi["added_lens_D"].nunique() >= 3 else (np.nan, np.nan)
        fits.append({"participant_id": pid, "eye": eye, "n_runs": len(v), "spearman_rho_P>=2.5": rho, "spearman_p": p, **f,
                     "mean_distance_cm": g["dist_mean"].mean()})
    return pd.DataFrame(detect), pd.DataFrame(fits)


# ---------- E2: repeatability ----------------------------------------------------------------
def repeatability(E: pd.DataFrame) -> dict:
    """Within-subject SD from repeated no-lens runs (Bland & Altman 1996, BMJ 313:744)."""
    B = E[(E["valid"]) & (((E["mode"] == "experiment") & (E["added_lens_D"] == 0)) | (E["mode"] == "monitor"))]
    groups = [g["logMAR"].to_numpy() for _, g in B.groupby(["participant_id", "eye", "correction"], dropna=False) if len(g) >= 2]
    if not groups:
        return {"n_groups": 0}
    ss = sum(((x - x.mean()) ** 2).sum() for x in groups)
    df = sum(len(x) - 1 for x in groups)
    sw = float(np.sqrt(ss / df))
    pairs = np.array([[x[0], x[1]] for x in groups])
    return {"n_groups": len(groups), "df": df, "Sw_logMAR": sw, "CoR_logMAR": 2.77 * sw,
            "ba_bias": float((pairs[:, 1] - pairs[:, 0]).mean()), "ba_sd": float((pairs[:, 1] - pairs[:, 0]).std(ddof=1)) if len(pairs) > 1 else np.nan,
            "pairs": pairs.tolist()}
