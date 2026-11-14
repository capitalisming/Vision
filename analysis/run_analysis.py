"""Reproducible analysis of app exports.

    python run_analysis.py                                  # data/raw/*.json → results/measured/
    python run_analysis.py --input ../data/simulated --category SIMULATED --out ../results/simulated_pipeline_demo

Raw files are read-only inputs; every output is regenerated from them. Records whose
dataCategory differs from --category are ignored, so simulated and measured data can never mix.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from vision_analysis import analyses, figures
from vision_analysis.io import audit_trials, load_profiles

ROOT = Path(__file__).resolve().parent.parent


def jsonable(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, pd.DataFrame):
        return json.loads(o.to_json(orient="records"))
    raise TypeError(type(o))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "data/raw"))
    ap.add_argument("--out", default=str(ROOT / "results/measured"))
    ap.add_argument("--category", default="MEASURED", choices=["MEASURED", "SIMULATED"])
    a = ap.parse_args()
    inp, out = Path(a.input), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(inp.glob("*.json"))
    if not files:
        msg = {"status": "NO_DATA", "input": str(inp), "note": "No exports found. Run protocols E0–E2 and place nvm-profile-*.json here."}
        (out / "summary.json").write_text(json.dumps(msg, indent=2, ensure_ascii=False))
        print(json.dumps(msg, indent=2, ensure_ascii=False))
        return

    T, E, D, F = load_profiles(files)
    T = T[T["data_category"] == a.category] if len(T) else T
    E = E[E["data_category"] == a.category] if len(E) else E
    if len(D):
        D = D[D["dataCategory"] == a.category]
    src = f"{inp.name}/ ({len(files)} file(s))"

    T.to_csv(out / "trials.csv", index=False)
    E.to_csv(out / "eye_estimates.csv", index=False)
    D.to_csv(out / "distance_checks.csv", index=False)
    F.to_csv(out / "input_files_sha256.csv", index=False)

    summary = {"category": a.category, "input_files": F, "audit": audit_trials(T)}
    if len(E):
        summary["js_vs_python_max_abs_diff_logMAR"] = float(E["js_py_diff"].max())
        summary["sessions_valid"] = f"{int(E['valid'].sum())}/{len(E)} eye-runs pass QC (posterior SD ≤ 0.12, not at grid edge)"
        detect, fits = analyses.lens_experiment(E)
        detect.to_csv(out / "lens_detection.csv", index=False)
        fits.to_csv(out / "lens_fits.csv", index=False)
        rep = analyses.repeatability(E)
        summary.update({"lens_detection": detect, "lens_fits": fits, "repeatability": {k: v for k, v in rep.items() if k != "pairs"}})
        figures.staircase_traces(T, E, out, a.category, src)
        figures.distance_per_trial(T, out, a.category, src)
        if len(detect):
            figures.dose_response(E, fits, detect, out, a.category, src)
            figures.detection_plot(detect, out, a.category, src)
        figures.bland_altman_repeat(rep, out, a.category, src)
    if len(D):
        ag = analyses.distance_agreement(D)
        ag.to_csv(out / "distance_agreement.csv", index=False)
        summary["distance_agreement"] = ag
        figures.distance_bland_altman(D, out, a.category, src)

    (out / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=jsonable))
    print(json.dumps({k: v for k, v in summary.items() if k in ("category", "audit", "js_vs_python_max_abs_diff_logMAR", "sessions_valid", "repeatability")},
                     indent=2, ensure_ascii=False, default=jsonable))


if __name__ == "__main__":
    main()
