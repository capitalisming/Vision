"""SIMULATED and CALCULATED studies. Nothing here is experimental data.

S1  Staircase accuracy vs number of trials, slope mis-specification and distance jitter.
S2  Operating characteristics of the change rule (false alarms, detection power).
S3  A synthetic lens experiment written in the app's export format (dataCategory=SIMULATED),
    used only to exercise run_analysis.py end-to-end and to preview the figures.
C1  CALCULATED: smallest optotype a display can draw at 40 cm vs pixel density.
C2  CALCULATED: why the lens test must use plus lenses > 1/d, and why near acuity can miss a
    hyperopic shift in an eye with spare accommodation.

    python simulate.py          (deterministic: fixed seeds)
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from vision_analysis.analyses import defocus_model
from vision_analysis.model import Psi, candidate_levels, logmar_from_stroke, p_correct, stroke_mm_for_logmar
from vision_analysis.norm import norm
from vision_analysis.style import INK2, MUTED, S1, S2, S3, save, stamp

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "results/simulated"
CALC = ROOT / "results/calculated"
FLOOR_460PPI = float(logmar_from_stroke(25.4 / 460, 44))  # 1-px stroke at the far edge of the window
LEVELS = candidate_levels(np.ceil(FLOOR_460PPI * 50) / 50)

# ---- ASSUMPTIONS used only for simulation (each is to be replaced by measured values) ----
TRUE_SLOPES = (6.0, 12.0, 24.0)      # observer psychometric slope (the app assumes 12)
DIST_SD_CM = 1.5                     # hand tremor / drift within the allowed window
SIGMA_DAY = 0.03                     # true day-to-day fluctuation of acuity, logMAR
MAR0, C_BLUR = 1.0, 3.5              # in-focus MAR (arcmin) and blur growth (arcmin/D) for S3/C2


def run_test(theta, rng, n_trials=24, slope=12.0, dist_sd=DIST_SD_CM, mm_px=25.4 / 460):
    """One monocular test as the app runs it: stroke chosen for the onset distance, realised
    logMAR from the mean distance, observer responds from the TRUE psychometric function."""
    st = Psi(LEVELS)
    rows = []
    for i in range(n_trials):
        x_req = st.next()
        d_on = float(np.clip(rng.normal(40, dist_sd), 36, 44))
        d_mean = float(np.clip(d_on + rng.normal(0, dist_sd / 2), 36, 44))
        stroke_px = max(1.0, float(stroke_mm_for_logmar(x_req, d_on)) / mm_px)
        x = float(logmar_from_stroke(stroke_px * mm_px, d_mean))
        correct = bool(rng.random() < p_correct(x, theta, slope=slope))
        st.update(x, correct)
        rows.append(dict(i=i + 1, requested=x_req, x=x, d_on=d_on, d=d_mean, stroke_px=stroke_px, correct=correct))
    from vision_analysis.model import estimate_threshold

    return estimate_threshold(st.x, st.r), rows


# ---------------------------------------------------------------------------------------------
def s1(rng):
    recs = []
    for n in (12, 16, 24, 32, 48):
        for slope in TRUE_SLOPES:
            for _ in range(300):
                th = rng.uniform(-0.2, 0.7)
                est, _ = run_test(th, rng, n_trials=n, slope=slope)
                recs.append(dict(n=n, slope=slope, theta=th, est=est["mean"], sd=est["sd"], err=est["mean"] - th))
    df = pd.DataFrame(recs)
    agg = df.groupby(["n", "slope"]).agg(bias=("err", "mean"), rmse=("err", lambda e: float(np.sqrt(np.mean(e**2)))),
                                         mean_post_sd=("sd", "mean")).reset_index()
    agg.to_csv(OUT / "s1_staircase_accuracy.csv", index=False)

    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 3.8))
    for slope, col in zip(TRUE_SLOPES, (S2, S1, S3)):
        g = agg[agg.slope == slope]
        lab = f"true slope {slope:g}" + (" (= assumed)" if slope == 12 else "")
        a1.plot(g.n, g.rmse, "-o", color=col, label=lab, mec="white", mew=1.2)
        a2.plot(g.n, g.bias, "-o", color=col, label=lab, mec="white", mew=1.2)
    a1.axvline(24, color=MUTED, ls="--", lw=1)
    a1.text(24.5, a1.get_ylim()[1] * 0.95 if a1.get_ylim()[1] else 0.1, "app: 24 trials/eye", fontsize=8, color=INK2, va="top")
    a1.set(xlabel="Trials per eye", ylabel="RMSE of threshold, logMAR", title="Precision", ylim=(0, None))
    a2.axhline(0, color=MUTED, lw=1)
    a2.set(xlabel="Trials per eye", ylabel="Mean error (bias), logMAR", title="Bias")
    a1.legend(fontsize=8)
    fig.suptitle("S1 · Adaptive test accuracy (300 simulated tests per point; distance jitter SD 1.5 cm)", x=0.01, ha="left", weight="bold")
    fig.tight_layout(rect=(0, 0.04, 1, 0.94))
    stamp(fig, "SIMULATED", "analysis/simulate.py · s1")
    save(fig, OUT / "s1_staircase_accuracy")
    return agg


# ---------------------------------------------------------------------------------------------
def s2(rng, sigma_meas):
    """Change rule: 3 baseline sessions, then follow-ups with a true shift Δ."""
    sig = np.sqrt(sigma_meas**2 + SIGMA_DAY**2)
    deltas = np.round(np.arange(0, 0.41, 0.025), 3)
    rows = []
    N = 20000
    for dlt in deltas:
        base = rng.normal(0, sig, (N, 3))
        f1 = rng.normal(dlt, sig, N)
        f2 = rng.normal(dlt, sig, N)
        m = base.mean(1)
        s = base.std(1, ddof=1)
        k, n = 3, 3
        df = k + n - 1
        s_eff = np.sqrt((k * 0.06**2 + (n - 1) * s**2) / df)
        from scipy import stats

        lim = stats.t.ppf(0.95, df) * s_eff * np.sqrt(1 + 1 / n)
        one = (f1 - m) > lim
        two = one & ((f2 - m) > lim)
        rows.append(dict(delta=dlt, p_flag_single=one.mean(), p_confirmed_two=two.mean(), median_limit=float(np.median(lim))))
    df = pd.DataFrame(rows)
    df.to_csv(OUT / "s2_change_rule.csv", index=False)

    fig, ax = plt.subplots(figsize=(7.5, 4))
    ax.plot(df.delta, df.p_flag_single, "-o", color=S1, ms=4, label="flag on 1 session (→ 'repeat tomorrow')")
    ax.plot(df.delta, df.p_confirmed_two, "-o", color=S2, ms=4, label="confirmed on 2 consecutive sessions")
    ax.axhline(0.05, color=MUTED, ls=":", lw=1)
    ax.axhline(0.8, color=MUTED, ls=":", lw=1)
    ax.text(0.405, 0.06, "5 %", fontsize=8, color=INK2, ha="right")
    ax.text(0.405, 0.81, "80 %", fontsize=8, color=INK2, ha="right")
    for P, lab in ((0.25, "0.25 D"), (0.5, "0.5 D"), (0.75, "0.75 D")):
        dl = float(defocus_model(P, MAR0, C_BLUR, 0) - defocus_model(0, MAR0, C_BLUR, 0))
        if dl <= 0.4:
            ax.axvline(dl, color=S3, lw=1, ls="--")
            ax.text(dl, 0.02, f" ≈{lab} defocus*", fontsize=8, color=INK2, rotation=90, va="bottom")
    ax.set(xlabel="True worsening Δ, logMAR", ylabel="Probability", ylim=(0, 1.02),
           title=f"S2 · Change rule: σ_measurement = {sigma_meas:.3f}, σ_day = {SIGMA_DAY} (assumed), 3 baseline sessions")
    ax.legend(loc="upper left", fontsize=8)
    fig.text(0.01, 0.045, f"*defocus equivalents use an ASSUMED blur model (MAR0 = {MAR0}′, c = {C_BLUR}′/D); E1 measures the real c.",
             fontsize=7.5, color=INK2)
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    stamp(fig, "SIMULATED", "analysis/simulate.py · s2")
    save(fig, OUT / "s2_change_rule")
    return df


# ---------------------------------------------------------------------------------------------
def s3(rng):
    """Synthetic E1 dataset in the app's own JSON format, labelled SIMULATED."""
    participants = [("SIM1", 0.9, 3.0, 2.5), ("SIM2", 1.1, 3.8, 2.75), ("SIM3", 0.8, 2.6, 2.25), ("SIM4", 1.0, 4.4, 2.5)]
    lenses = [1.0, 2.0, 2.5, 3.0, 3.5, 4.0]
    sessions = []
    t0 = pd.Timestamp("2026-01-01T18:00:00Z")
    k = 0
    for pid, mar0, c, p0 in participants:
        order = [0.0, 0.0] + list(rng.permutation(lenses)) + [0.0]
        for P in order:
            eyes = []
            for eye in ("OD", "OS"):
                th = float(defocus_model(P, mar0 * (1.0 if eye == "OD" else 1.08), c, p0)) + rng.normal(0, SIGMA_DAY)
                slope = float(rng.uniform(8, 16))
                est, rows = run_test(th, rng, slope=slope)
                trials = [dict(i=r["i"], orientation="right", response="right" if r["correct"] else "left", correct=r["correct"],
                               requestedLogMAR=r["requested"], strokeDevPx=r["stroke_px"], strokeMm=r["stroke_px"] * 25.4 / 460,
                               distanceCmOnset=r["d_on"], distanceCmResponse=r["d"], distanceCm=r["d"], logMAR=r["x"], rtMs=1500.0,
                               distanceSource="camera", ambientLuma=None, pausedForDistance=0) for r in rows]
                eyes.append(dict(eye=eye, trials=trials, valid=bool(est["sd"] <= 0.12 and not est["at_boundary"]), durationS=40.0,
                                 estimate=dict(logMAR=est["mean"], sd=est["sd"], mle=est["mle"], atBoundary=est["at_boundary"],
                                               nCorrect=int(sum(r["correct"] for r in rows)), n=len(rows)),
                                 _sim_true_theta=th, _sim_true_slope=slope))
            ts = (t0 + pd.Timedelta(minutes=3 * k)).isoformat()
            k += 1
            sessions.append(dict(id=f"sim-{k:03d}", dataCategory="SIMULATED", appVersion="sim", startedAt=ts, endedAt=ts, mode="experiment",
                                 correction="own glasses", experiment=dict(participantId=pid, experimentId="E1-SIM", addedLensD=P, note="SIMULATED"),
                                 targetDistanceCm=40, distanceWindow=[36, 44], distanceMode="camera",
                                 device=dict(userAgent="sim", dpr=3, cssW=390, cssH=844, mmPerDevicePx=25.4 / 460),
                                 screenCalibration=None, distanceCalibration=None, psych=dict(guess=0.25, lapse=0.02, slope=12),
                                 trialsPerEye=24, eyes=eyes, notes="SIMULATED"))
    prof = dict(version=1, createdAt=t0.isoformat(), screen=None, camera=None, sessions=sessions, distanceChecks=[],
                _note="SIMULATED dataset generated by analysis/simulate.py (S3). Not experimental data.")
    dst = ROOT / "data/simulated/nvm-profile-SIMULATED-E1.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(prof, indent=1))
    return dst


# ---------------------------------------------------------------------------------------------
def c1():
    ppi = np.linspace(90, 560, 300)
    fig, ax = plt.subplots(figsize=(7.5, 3.9))
    for d, col in ((40, S1), (33, S2)):
        ax.plot(ppi, logmar_from_stroke(25.4 / ppi, d), color=col, label=f"1-pixel stroke at {d} cm")
    ax.axhspan(-0.3, 0.0, color=S3, alpha=0.08, lw=0)
    ax.text(95, -0.27, "range of normal adult acuity (better than 0.0 logMAR)", fontsize=8, color=INK2)
    for lo, hi, lab in ((100, 220, "typical laptop / monitor"), (400, 530, "typical recent phone")):
        ax.axvspan(lo, hi, color=MUTED, alpha=0.08, lw=0)
        ax.text((lo + hi) / 2, 0.55, lab, fontsize=8, color=INK2, ha="center")
    ax.axhline(0, color=MUTED, lw=1)
    ax.set(xlabel="Display pixel density, pixels per inch", ylabel="Smallest drawable optotype, logMAR",
           title="C1 · A display cannot test acuity finer than its pixels", ylim=(-0.35, 0.65))
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    stamp(fig, "CALCULATED", "optics: MAR = 2·atan(pitch / 2d)")
    save(fig, CALC / "c1_display_limit")


def c2():
    """Predicted near acuity (40 cm) for lens manipulations, from geometric optics +
    Hofstetter mean amplitude A = 18.5 − 0.3·age (D) and the assumed blur model."""
    amp = lambda age: max(0.5, 18.5 - 0.3 * age)  # noqa: E731
    demand = 2.5
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10.5, 4))
    P = np.linspace(0, 4.5, 200)
    y_plus = defocus_model(P, MAR0, C_BLUR, demand)  # relaxed eye, emmetrope: any age
    a1.plot(P, y_plus, color=S1, label="plus lens (myopic defocus): all ages")
    M = np.linspace(0, 4.5, 200)
    for age, col in ((20, S2), (50, S3)):
        A = amp(age)
        defoc = np.maximum(0, demand + M - A)
        a1.plot(M, defocus_model(defoc, MAR0, C_BLUR, 0), color=col, ls="--", label=f"minus lens, age {age} (A≈{A:.1f} D)")
    a1.axvline(2.5, color=MUTED, lw=1, ls=":")
    a1.set(xlabel="Lens power magnitude, D", ylabel="Predicted near acuity, logMAR", title="Which lenses actually blur a 40 cm target")
    a1.legend(fontsize=8, loc="upper left")
    H = np.linspace(0, 3.0, 300)
    for age, col in ((40, S1), (50, S2), (55, S3)):
        A = amp(age)
        add = max(0.0, demand - A / 2)  # reading add that keeps half the amplitude in reserve
        reserve = A + add - demand
        a2.plot(H, defocus_model(np.maximum(0, H - reserve), MAR0, C_BLUR, 0), color=col,
                label=f"age {age}: A≈{A:.1f} D, add +{add:.2f}, reserve {reserve:.2f} D")
    a2.set(xlabel="Hyperopic shift since baseline, D", ylabel="Predicted near acuity, logMAR",
           title="Hyperopic shift vs near acuity (habitual near correction)")
    a2.legend(fontsize=8, loc="upper left")
    fig.text(0.01, 0.045, f"Assumptions: emmetropic eye; full amplitude usable in a brief test (optimistic); reading add leaves ½ amplitude in reserve; "
             f"blur model MAR0 = {MAR0}′, c = {C_BLUR}′/D; Hofstetter mean amplitude 18.5 − 0.3·age.", fontsize=7.5, color=INK2)
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    stamp(fig, "CALCULATED", "analysis/simulate.py · c2")
    save(fig, CALC / "c2_accommodation_masking")


def c3():
    """PROPOSED extension (not implemented): fogging-lens far-point refractometry.
    Through a plus lens P the eye cannot accommodate away myopic defocus, so the farthest
    distance at which a small target stays sharp is FP = 100 / (P − H) cm, where H is the
    hyperopic shift relative to the baseline refraction. The app already measures distance,
    so H = P − 100/FP follows for any age."""
    H = np.linspace(0, 2.0, 200)
    fig, ax = plt.subplots(figsize=(7.5, 3.9))
    for P, col in ((3.5, S1), (4.0, S2), (5.0, S3)):
        ax.plot(H, 100 / (P - H), color=col, label=f"fog lens +{P:.1f} D")
    ax.axhspan(20, 65, color=MUTED, alpha=0.06, lw=0)
    ax.text(0.02, 61, "comfortable arm's-length range", fontsize=8, color=INK2)
    ax.set(xlabel="Hyperopic shift H, D", ylabel="Far point through lens, cm", ylim=(15, 70),
           title="C3 · PROPOSED: distance-to-blur through a fog lens measures refraction")
    ax.legend(fontsize=8, loc="upper left", bbox_to_anchor=(0, 0.92))
    fig.text(0.01, 0.045, "Slope at +4.0 D, H = 0: 6.3 cm per dioptre. Depth of focus (±~0.3 D) and camera error set the real precision — untested.",
             fontsize=7.5, color=INK2)
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    stamp(fig, "CALCULATED", "FP = 100/(P − H); PROPOSED method, not implemented")
    save(fig, CALC / "c3_fog_lens_far_point_PROPOSED")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    CALC.mkdir(parents=True, exist_ok=True)
    c1()
    c2()
    c3()
    rng = np.random.default_rng(20261114)
    agg = s1(rng)
    sm = float(agg[(agg.n == 24) & (agg.slope == 12)].rmse.iloc[0])
    s2(rng, sm)
    p = s3(rng)
    print(agg.to_string(index=False))
    print(f"S2 used sigma_meas = {sm:.4f}; S3 written to {p}")
