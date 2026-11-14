"""Pipeline QA. Run from analysis/:  python -m pytest -q"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from vision_analysis.io import load_profiles  # noqa: E402
from vision_analysis.model import estimate_threshold, logmar_from_stroke, stroke_mm_for_logmar  # noqa: E402
from vision_analysis.norm import norm  # noqa: E402

FIX = HERE / "fixtures/e2e_profile_SIMULATED_OBSERVER.json"


def test_python_reproduces_app_threshold_exactly():
    """The app's stored estimate must be recomputable from its own logged trials."""
    _, E, _, _ = load_profiles([FIX])
    assert len(E) == 2
    assert E["js_py_diff"].max() < 1e-9
    assert (E["sd"] - E["sd_app"]).abs().max() < 1e-9


def test_fixture_is_labelled_simulated():
    prof = json.loads(FIX.read_text())
    assert all(s["dataCategory"] == "SIMULATED" for s in prof["sessions"])


def test_optics_round_trip():
    for x in (-0.3, 0.0, 0.5, 1.0):
        assert abs(logmar_from_stroke(stroke_mm_for_logmar(x, 40), 40) - x) < 1e-12
    assert abs(stroke_mm_for_logmar(0, 40) - 0.11636) < 1e-5


def test_threshold_order_invariant():
    x = np.array([0.5, 0.2, 0.0, 0.1, 0.05, 0.15])
    c = np.array([1, 1, 0, 1, 0, 1], bool)
    assert abs(estimate_threshold(x, c)["mean"] - estimate_threshold(x[::-1], c[::-1])["mean"]) < 1e-12


def test_norm_matches_app_rule():
    # same case as app/src/core/__tests__/core.test.ts: 3 identical sessions → limit > 0.08
    n = norm(np.array([0.0, 0.0, 0.0]))
    assert n["s_eff"] > 0.04 and n["limit"] > 0.08
    # app table t95(5) = 2.015 vs scipy exact
    n = norm(np.array([0.0, 0.04, -0.03]))
    assert abs(n["limit"] / (n["s_eff"] * np.sqrt(1 + 1 / 3)) - 2.015) < 0.005


def test_measured_run_ignores_simulated_and_handles_no_data(tmp_path):
    out = tmp_path / "out"
    r = subprocess.run([sys.executable, str(HERE.parent / "run_analysis.py"), "--input", str(FIX.parent), "--out", str(out)],
                       capture_output=True, text=True, cwd=HERE.parent)
    assert r.returncode == 0, r.stderr
    s = json.loads((out / "summary.json").read_text())
    assert s["audit"] == {"n_trials": 0}  # the SIMULATED fixture must not leak into MEASURED results
    empty = tmp_path / "empty"
    empty.mkdir()
    r = subprocess.run([sys.executable, str(HERE.parent / "run_analysis.py"), "--input", str(empty), "--out", str(out)],
                       capture_output=True, text=True, cwd=HERE.parent)
    assert json.loads((out / "summary.json").read_text())["status"] == "NO_DATA"
