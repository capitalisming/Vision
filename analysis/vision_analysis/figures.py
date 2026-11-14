"""Figures for measured (or, for pipeline demos, SIMULATED) data."""
from __future__ import annotations

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

from .analyses import defocus_model
from .style import EYE_COLOR, EYE_NAME, INK2, MUTED, S1, S2, S3, save, stamp


def staircase_traces(T: pd.DataFrame, E: pd.DataFrame, out, cat, src, max_sessions=4):
    sids = T["session_id"].drop_duplicates().tolist()[:max_sessions]
    fig, axes = plt.subplots(len(sids), 2, figsize=(9, 2.3 * len(sids) + 0.6), squeeze=False, sharey=True)
    for r, sid in enumerate(sids):
        for c, eye in enumerate(["OD", "OS"]):
            ax = axes[r, c]
            g = T[(T.session_id == sid) & (T.eye == eye)]
            if g.empty:
                ax.set_visible(False)
                continue
            ax.plot(g["i"], g["logMAR"], color=MUTED, lw=1, zorder=1)
            ok = g[g.correct]
            bad = g[~g.correct]
            ax.scatter(ok["i"], ok["logMAR"], s=28, color=EYE_COLOR[eye], label="correct", zorder=3, edgecolor="white", lw=1.5)
            ax.scatter(bad["i"], bad["logMAR"], s=30, marker="x", color=INK2, label="wrong", zorder=3)
            e = E[(E.session_id == sid) & (E.eye == eye)].iloc[0]
            ax.axhline(e["logMAR"], color=EYE_COLOR[eye], ls="--", lw=1.2)
            ax.axhspan(e["logMAR"] - e["sd"], e["logMAR"] + e["sd"], color=EYE_COLOR[eye], alpha=0.10, lw=0)
            lens = e["added_lens_D"]
            ax.set_title(f"{EYE_NAME[eye]} · {e['participant_id'] or 'monitor'} · lens {lens if pd.notna(lens) else '—'} D", fontsize=9.5)
            ax.text(0.98, 0.92, f"θ = {e['logMAR']:.2f} ± {e['sd']:.2f}", transform=ax.transAxes, ha="right", fontsize=8.5, color=INK2)
            if r == len(sids) - 1:
                ax.set_xlabel("Trial number")
            if c == 0:
                ax.set_ylabel("Optotype size, logMAR")
    axes[0, 0].legend(loc="upper right", bbox_to_anchor=(1.0, 0.82), fontsize=8)
    fig.suptitle("Raw adaptive sequences: presented size and response per trial", x=0.01, ha="left", weight="bold")
    fig.tight_layout(rect=(0, 0.03, 1, 0.97))
    stamp(fig, cat, src)
    save(fig, out / "fig_raw_staircases")


def distance_per_trial(T: pd.DataFrame, out, cat, src):
    fig, ax = plt.subplots(figsize=(9, 3.2))
    ax.axhspan(36, 44, color=S3, alpha=0.10, lw=0, label="allowed window 36–44 cm")
    ax.axhline(40, color=S3, lw=1, ls="--")
    for k, (sid, g) in enumerate(T.groupby("session_id", sort=False)):
        idx = np.arange(len(g)) + k * 50
        ax.plot(idx, g["distanceCm"], color=S1, lw=1)
        ax.scatter(idx, g["distanceCm"], color=S1, s=8)
    ax.set_xlabel("Trial (sessions concatenated)")
    ax.set_ylabel("Eye–screen distance, cm")
    ax.set_ylim(30, 50)
    ax.set_title("Distance during each trial (mean of onset…response)")
    ax.legend(loc="lower right")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    stamp(fig, cat, src)
    save(fig, out / "fig_distance_per_trial")


def dose_response(E: pd.DataFrame, fits: pd.DataFrame, detect: pd.DataFrame, out, cat, src):
    X = E[(E["mode"] == "experiment") & E["added_lens_D"].notna()]
    pids = sorted(X["participant_id"].unique())
    fig, axes = plt.subplots(1, len(pids), figsize=(3.3 * len(pids) + 0.6, 3.8), squeeze=False, sharey=True)
    for k, pid in enumerate(pids):
        ax = axes[0, k]
        for eye, off in (("OD", -0.04), ("OS", 0.04)):
            g = X[(X.participant_id == pid) & (X.eye == eye)]
            if g.empty:
                continue
            v, nv = g[g.valid], g[~g.valid]
            ax.errorbar(v["added_lens_D"] + off, v["logMAR"], yerr=v["sd"], fmt="o", color=EYE_COLOR[eye], ms=5,
                        mec="white", mew=1.2, elinewidth=1, capsize=0, label=EYE_NAME[eye])
            if len(nv):
                ax.scatter(nv["added_lens_D"] + off, nv["logMAR"], marker="x", color=INK2, s=25, label="failed QC" if eye == "OD" else None)
            f = fits[(fits.participant_id == pid) & (fits.eye == eye)]
            if len(f) and f.iloc[0].get("ok"):
                p = np.linspace(0, X["added_lens_D"].max() + 0.2, 200)
                r = f.iloc[0]
                ax.plot(p, defocus_model(p, r.mar0, r.c_arcmin_per_D, r.P0_D), color=EYE_COLOR[eye], lw=1.5, alpha=0.8)
            d = detect[(detect.participant_id == pid) & (detect.eye == eye)]
            if len(d) and np.isfinite(d["baseline_mean"].iloc[0]):
                b, lim = d["baseline_mean"].iloc[0], d["limit"].iloc[0]
                ax.axhline(b + lim, color=EYE_COLOR[eye], lw=0.8, ls=":")
        ax.axvline(2.5, color=MUTED, lw=1, ls="--")
        ax.text(2.52, 0.98, "1/d = 2.5 D", transform=ax.get_xaxis_transform(), fontsize=8, color=INK2, va="top")
        ax.set_title(f"Participant {pid}")
        ax.set_xlabel("Added plus lens, D")
        if k == 0:
            ax.set_ylabel("Near acuity, logMAR (higher = worse)")
    axes[0, 0].legend(loc="upper left", fontsize=8)
    fig.suptitle("Lens dose–response: acuity vs added lens power (dotted = personal change limit)", x=0.01, ha="left", weight="bold")
    fig.tight_layout(rect=(0, 0.04, 1, 0.95))
    stamp(fig, cat, src)
    save(fig, out / "fig_dose_response")


def detection_plot(detect: pd.DataFrame, out, cat, src):
    d = detect.dropna(subset=["delta", "limit"])
    if d.empty:
        return
    fig, ax = plt.subplots(figsize=(7, 3.6))
    for eye, off in (("OD", -0.05), ("OS", 0.05)):
        g = d[d.eye == eye]
        ax.scatter(g["added_lens_D"] + off, g["delta"] / g["limit"], color=EYE_COLOR[eye], s=36, edgecolor="white", lw=1.2, label=EYE_NAME[eye], zorder=3)
    ax.axhline(1, color=INK2, lw=1.2, ls="--")
    ax.text(d["added_lens_D"].min() - 0.1, 1.08, "change flagged above this line", fontsize=8, color=INK2)
    ax.axhline(0, color=MUTED, lw=0.8)
    ax.set_xlabel("Added plus lens, D")
    ax.set_ylabel("Change ÷ personal limit")
    ax.set_title("Does the rule flag each lens? (each point = one participant-eye)")
    ax.legend(loc="upper left")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    stamp(fig, cat, src)
    save(fig, out / "fig_detection")


def bland_altman_repeat(rep: dict, out, cat, src):
    if not rep.get("pairs") or len(rep["pairs"]) < 2:
        return
    p = np.array(rep["pairs"])
    m, d = p.mean(1), p[:, 1] - p[:, 0]
    b, s = d.mean(), d.std(ddof=1)
    fig, ax = plt.subplots(figsize=(6, 3.8))
    ax.scatter(m, d, color=S1, s=30, edgecolor="white", lw=1.2, zorder=3)
    for y, lab in ((b, f"bias {b:+.3f}"), (b + 1.96 * s, f"+1.96 SD {b + 1.96 * s:+.3f}"), (b - 1.96 * s, f"−1.96 SD {b - 1.96 * s:+.3f}")):
        ax.axhline(y, color=INK2, lw=1, ls="--" if y != b else "-")
        ax.text(ax.get_xlim()[1] if False else m.max(), y, "  " + lab, fontsize=8, color=INK2, va="bottom", ha="right")
    ax.set_xlabel("Mean of run 1 and run 2, logMAR")
    ax.set_ylabel("Run 2 − run 1, logMAR")
    ax.set_title(f"Test–retest (Bland–Altman): Sw = {rep['Sw_logMAR']:.3f}, CoR = {rep['CoR_logMAR']:.3f} logMAR")
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    stamp(fig, cat, src)
    save(fig, out / "fig_repeatability_bland_altman")


def distance_bland_altman(D: pd.DataFrame, out, cat, src):
    D = D.dropna(subset=["appCm"])
    if D.empty:
        return
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 3.9))
    cols = {"both-open": S1, "left-covered": S2, "right-covered": S3}
    lim = [D["trueCm"].min() - 3, D["trueCm"].max() + 3]
    a1.plot(lim, lim, color=MUTED, lw=1, ls="--", label="identity")
    for cond, g in D.groupby("condition"):
        a1.scatter(g["trueCm"], g["appCm"], color=cols.get(cond, INK2), s=28, edgecolor="white", lw=1.2, label=cond, zorder=3)
        a2.scatter((g["trueCm"] + g["appCm"]) / 2, g["appCm"] - g["trueCm"], color=cols.get(cond, INK2), s=28, edgecolor="white", lw=1.2, zorder=3)
    d = D["appCm"] - D["trueCm"]
    b, s = d.mean(), d.std(ddof=1)
    for y in (b, b - 1.96 * s, b + 1.96 * s):
        a2.axhline(y, color=INK2, lw=1, ls="-" if y == b else "--")
    a1.set(xlabel="Tape measure, cm", ylabel="Camera estimate, cm", title="Camera vs tape")
    a2.set(xlabel="Mean of methods, cm", ylabel="Camera − tape, cm", title=f"Bland–Altman: bias {b:+.2f} cm, LoA ±{1.96 * s:.2f} cm")
    a1.legend(fontsize=8)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    stamp(fig, cat, src)
    save(fig, out / "fig_distance_agreement")
