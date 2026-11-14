"""Load app exports (nvm-profile-*.json) into tidy tables. Raw files are never modified."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .model import estimate_threshold


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_profiles(paths: list[Path]):
    trials, eyes, checks, files = [], [], [], []
    for path in paths:
        prof = json.loads(path.read_text(encoding="utf-8"))
        files.append({"file": path.name, "sha256": sha256(path), "sessions": len(prof.get("sessions", []))})
        for s in prof.get("sessions", []):
            ex = s.get("experiment") or {}
            base = {
                "file": path.name, "session_id": s["id"], "data_category": s.get("dataCategory", "MEASURED"),
                "started_at": s["startedAt"], "mode": s["mode"], "correction": s["correction"],
                "participant_id": ex.get("participantId"), "experiment_id": ex.get("experimentId"),
                "added_lens_D": ex.get("addedLensD"), "distance_mode": s.get("distanceMode"),
                "mm_per_device_px": s["device"]["mmPerDevicePx"], "dpr": s["device"]["dpr"], "app_version": s.get("appVersion"),
            }
            for e in s["eyes"]:
                for t in e["trials"]:
                    rd = t.get("rawDistance") or {}
                    trials.append({**base, "eye": e["eye"], **{k: v for k, v in t.items() if k != "rawDistance"},
                                   "dist_irisA": rd.get("irisA"), "dist_irisB": rd.get("irisB"), "dist_ipd": rd.get("ipd")})
                tr = pd.DataFrame(e["trials"])
                py = estimate_threshold(tr["logMAR"].to_numpy(), tr["correct"].to_numpy())
                eyes.append({**base, "eye": e["eye"], "n_trials": len(tr), "n_correct": int(tr["correct"].sum()),
                             "logMAR_app": e["estimate"]["logMAR"], "sd_app": e["estimate"]["sd"], "valid_app": e["valid"],
                             "logMAR": py["mean"], "sd": py["sd"], "mle": py["mle"], "at_boundary": py["at_boundary"],
                             "duration_s": e["durationS"], "dist_min": tr["distanceCm"].min(), "dist_max": tr["distanceCm"].max(),
                             "dist_mean": tr["distanceCm"].mean(), "stroke_px_min": tr["strokeDevPx"].min()})
        for c in prof.get("distanceChecks", []) or []:
            checks.append({"file": path.name, **c})
    T = pd.DataFrame(trials)
    E = pd.DataFrame(eyes)
    if len(E):
        E["js_py_diff"] = (E["logMAR"] - E["logMAR_app"]).abs()
        E["valid"] = (E["sd"] <= 0.12) & ~E["at_boundary"]
    return T, E, pd.DataFrame(checks), pd.DataFrame(files)


def audit_trials(T: pd.DataFrame) -> dict:
    """Structural checks on trial-level data (Phase 4 of the brief)."""
    if T.empty:
        return {"n_trials": 0}
    lo, hi = 36, 44
    return {
        "n_trials": int(len(T)),
        "n_sessions": int(T["session_id"].nunique()),
        "duplicate_session_trial_rows": int(T.duplicated(["session_id", "eye", "i"]).sum()),
        "missing_values": {k: int(v) for k, v in T[["logMAR", "distanceCm", "correct", "rtMs"]].isna().sum().items()},
        "nonfinite_logMAR": int((~np.isfinite(T["logMAR"])).sum()),
        "distance_outside_window": int(((T["distanceCm"] < lo) | (T["distanceCm"] > hi)).sum()),
        "rt_below_200ms": int((T["rtMs"] < 200).sum()),
        "rt_above_30s": int((T["rtMs"] > 30000).sum()),
        "stroke_below_1px": int((T["strokeDevPx"] < 0.999).sum()),
        "trials_with_distance_pause": int((T["pausedForDistance"] > 0).sum()),
        "manual_distance_trials": int((T["distanceSource"] == "manual").sum()),
    }
