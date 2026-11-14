#!/usr/bin/env python3
"""Build every figure and table for the project from the raw app exports.

Usage
-----
    python analysis/analyze.py --R OD=2.50 --R OS=2.25
    python analysis/analyze.py --synthetic          # debugging only

Inputs (default: data/raw/)
    sessions.csv, trials.csv, distance_check.csv, EXCLUSIONS.md
    refraction.csv (optional; used only when --R is not given)
Outputs (default: analysis/out/; with --synthetic: analysis/synthetic/out/)
    repeatability.png, dose_response.png, dose_control.png, camera_vs_tape.png,
    summary.md, tables/*.csv

The column contract is documented in analysis/README.md.

Deliberately NOT done here: thresholds chosen after seeing data, smoothing,
outlier removal, p-values for a single person. The only sessions removed are
the ones listed by session_id in EXCLUSIONS.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw"
DEFAULT_OUT = ROOT / "analysis" / "out"
SYNTH_DIR = ROOT / "analysis" / "synthetic"

CONDITIONS = ("rep", "dose_noglasses", "dose_glasses")
OUTCOMES = ("ok", "floor_hit", "worse_than_1.3", "camera_stop")
NO_NUMBER = ("floor_hit", "worse_than_1.3", "camera_stop")
WORSE_LIMIT = 1.3  # logMAR, app's upper limit for worse_than_1.3
CR_FACTOR = 1.96 * math.sqrt(2)

# Palette: reference dataviz palette, light surface.
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"
BLUE = "#2a78d6"
ORANGE = "#eb6834"
GRAY = "#8a8984"

CENSOR_STYLE = {
    "floor_hit": dict(marker="v", label="floor hit (better than shown)"),
    "worse_than_1.3": dict(marker="^", label="worse than 1.3 logMAR"),
    "camera_stop": dict(marker="X", label="stopped by camera (no score)"),
}


class InputError(Exception):
    """Raw export does not match the contract. Message is shown to the user."""


# --------------------------------------------------------------------------- io

def snake(name: str) -> str:
    name = name.strip()
    name = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name)
    return re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower()


def read_csv(path: Path, required: list[str]) -> pd.DataFrame:
    if not path.exists():
        raise InputError(f"missing input file: {path}")
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    df.columns = [snake(c) for c in df.columns]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise InputError(f"{path.name}: missing columns {missing}; found {list(df.columns)}")
    for c in df.columns:
        df[c] = df[c].str.strip()
    return df


def to_float(s: pd.Series, what: str) -> pd.Series:
    out = pd.to_numeric(s.replace("", np.nan), errors="coerce")
    bad = s[(s != "") & out.isna()]
    if len(bad):
        raise InputError(f"{what}: non-numeric values {sorted(set(bad))[:5]}")
    return out


TRUE = {"true", "1", "yes", "y", "t"}
FALSE = {"false", "0", "no", "n", "f", ""}


def to_bool(s: pd.Series, what: str) -> pd.Series:
    low = s.str.lower()
    bad = low[~low.isin(TRUE | FALSE)]
    if len(bad):
        raise InputError(f"{what}: not a boolean {sorted(set(bad))[:5]}")
    return low.isin(TRUE)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


@dataclass
class Exclusion:
    session_id: str
    reason: str
    found: bool = False


BULLET = re.compile(r"^\s*[-*]\s+`?(?P<id>[^\s`:|]+)`?\s*(?::|\s[—–-]\s)\s*(?P<reason>.*)$")


def parse_exclusions(path: Path) -> list[Exclusion]:
    """Markdown table with a session_id column, or bullets `- <id>: reason`."""
    if not path.exists():
        raise InputError(
            f"missing {path}. Create it even if nothing is excluded "
            "(a heading and the line 'None.' are enough)."
        )
    out: list[Exclusion] = []
    header: list[str] | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("|"):
            cells = [c.strip().strip("`") for c in line.strip("|").split("|")]
            if header is None:
                header = [snake(c) for c in cells]
                continue
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue
            row = dict(zip(header, cells))
            sid = row.get("session_id", "")
            if sid:
                reason = row.get("reason") or " / ".join(
                    v for k, v in row.items() if k != "session_id" and v)
                out.append(Exclusion(sid, reason))
            continue
        header = None
        m = BULLET.match(raw)
        if m:
            out.append(Exclusion(m["id"], m["reason"].strip()))
    seen: set[str] = set()
    for e in out:
        if e.session_id in seen:
            raise InputError(f"EXCLUSIONS.md lists {e.session_id} twice")
        seen.add(e.session_id)
    return out


def parse_R(items: list[str]) -> dict[str, float]:
    R: dict[str, float] = {}
    for it in items:
        if "=" not in it:
            raise InputError(f"--R expects EYE=DIOPTERS (e.g. OD=2.50), got {it!r}")
        k, v = it.split("=", 1)
        val = float(v)
        if val < 0:
            raise InputError(
                f"--R {it}: R is the magnitude of myopia, a positive number "
                f"(a -2.50 D eye is given as {k}=2.50)")
        R[k.strip()] = val
    return R


# ----------------------------------------------------------------------- data

@dataclass
class Data:
    sessions: pd.DataFrame
    trials: pd.DataFrame
    checks: pd.DataFrame
    exclusions: list[Exclusion]
    excluded: pd.DataFrame
    inputs: dict[str, str]
    notes: list[str] = field(default_factory=list)


def load(raw: Path) -> Data:
    s = read_csv(raw / "sessions.csv",
                 ["session_id", "participant_id", "condition", "eye", "app_version",
                  "mean_mm", "outcome", "logmar", "near_floor"])
    t = read_csv(raw / "trials.csv", ["session_id"])
    c = read_csv(raw / "distance_check.csv", ["tape_mm", "camera_mm", "glasses"])
    ex = parse_exclusions(raw / "EXCLUSIONS.md")

    dup = s["session_id"][s["session_id"].duplicated()]
    if len(dup):
        raise InputError(f"sessions.csv: duplicate session_id {sorted(set(dup))[:5]}")
    bad = sorted(set(s["outcome"]) - set(OUTCOMES))
    if bad:
        raise InputError(f"sessions.csv: unknown outcome {bad}; expected {list(OUTCOMES)}")

    s["mean_mm"] = to_float(s["mean_mm"], "sessions.mean_mm")
    s["logmar"] = to_float(s["logmar"], "sessions.logmar")
    s["near_floor"] = to_bool(s["near_floor"], "sessions.near_floor")
    s["floor_logmar"] = to_float(s.get("floor_logmar", pd.Series("", index=s.index)),
                                 "sessions.floor_logmar")
    miss = s[(s["outcome"] == "ok") & s["logmar"].isna()]
    if len(miss):
        raise InputError(f"sessions.csv: outcome=ok but logmar empty: {list(miss.session_id)[:5]}")

    c["tape_mm"] = to_float(c["tape_mm"], "distance_check.tapeMm")
    c["camera_mm"] = to_float(c["camera_mm"], "distance_check.cameraMm")
    c["glasses"] = to_bool(c["glasses"], "distance_check.glasses")
    if "target_mm" in c.columns:
        c["target_mm"] = to_float(c["target_mm"], "distance_check.target_mm")
    else:
        c["target_mm"] = c["tape_mm"]
    if (c["tape_mm"] <= 0).any():
        raise InputError("distance_check.csv: tapeMm must be > 0")

    ids = set(s["session_id"])
    for e in ex:
        e.found = e.session_id in ids
    ex_ids = {e.session_id for e in ex}
    excluded = s[s["session_id"].isin(ex_ids)].copy()
    reasons = {e.session_id: e.reason for e in ex}
    excluded["reason"] = excluded["session_id"].map(reasons)
    s = s[~s["session_id"].isin(ex_ids)].copy()

    inputs = {p.name: sha256(p) for p in
              [raw / "sessions.csv", raw / "trials.csv", raw / "distance_check.csv",
               raw / "EXCLUSIONS.md"]}
    d = Data(s, t, c, ex, excluded, inputs)
    other = sorted(set(s["condition"]) - set(CONDITIONS))
    if other:
        d.notes.append(f"Sessions with other conditions are not analysed: "
                       f"{', '.join(f'{k} (N={(s.condition == k).sum()})' for k in other)}.")
    return d


# ----------------------------------------------------------------- analysis

def unit_label(df: pd.DataFrame) -> pd.Series:
    return df["participant_id"] + " " + df["eye"]


def repeatability(s: pd.DataFrame):
    rep = s[s["condition"] == "rep"].copy()
    rep["unit"] = unit_label(rep)
    rows = []
    for unit, g in rep.groupby("unit", sort=True):
        num = g[g["outcome"] == "ok"]
        vals = num["logmar"].to_numpy()
        rows.append({
            "unit": unit,
            "sessions_total": len(g),
            "n_scored": len(vals),
            "mean_logmar": vals.mean() if len(vals) else np.nan,
            "sd_logmar": vals.std(ddof=1) if len(vals) >= 2 else np.nan,
            "n_near_floor": int(num["near_floor"].sum()),
            **{f"n_{k}": int((g["outcome"] == k).sum()) for k in NO_NUMBER},
        })
    tab = pd.DataFrame(rows)
    ok = tab[tab["n_scored"] >= 2] if len(tab) else tab
    df = int((ok["n_scored"] - 1).sum()) if len(ok) else 0
    if df > 0:
        sw = math.sqrt(float(((ok["n_scored"] - 1) * ok["sd_logmar"] ** 2).sum()) / df)
    else:
        sw = float("nan")
    return rep, tab, {"sw": sw, "cr": CR_FACTOR * sw, "df": df,
                      "units": len(ok), "n_sessions": int(ok["n_scored"].sum()) if len(ok) else 0}


def lookup_R(R: dict[str, float], pid: str, eye: str):
    return R.get(f"{pid}:{eye}", R.get(eye))


def dose(s: pd.DataFrame, R: dict[str, float]):
    d = s[s["condition"].isin(["dose_noglasses", "dose_glasses"])].copy()
    missing = sorted({f"{p}:{e}" for p, e in
                      d.loc[d.condition == "dose_noglasses", ["participant_id", "eye"]]
                      .itertuples(index=False)
                      if lookup_R(R, p, e) is None})
    d["R_D"] = [lookup_R(R, p, e) if c == "dose_noglasses" else np.nan
                for p, e, c in d[["participant_id", "eye", "condition"]].itertuples(index=False)]
    vergence = 1000.0 / d["mean_mm"]
    d["defocus_D"] = np.where(d["condition"] == "dose_glasses", 0.0,
                              np.maximum(0.0, d["R_D"] - vergence))
    fit = ols(d[(d.outcome == "ok") & d.defocus_D.notna()], "defocus_D", "logmar")
    ctrl = d[d.condition == "dose_glasses"].copy()
    cfit = ols(ctrl[(ctrl.outcome == "ok") & ctrl.mean_mm.notna()].assign(
        mean_m=lambda x: x.mean_mm / 1000.0), "mean_m", "logmar")
    return d, fit, ctrl, cfit, missing


def ols(df: pd.DataFrame, x: str, y: str) -> dict:
    n = len(df)
    if n < 2 or df[x].nunique() < 2:
        return {"n": n, "slope": np.nan, "intercept": np.nan, "resid_sd": np.nan,
                "x_min": df[x].min() if n else np.nan, "x_max": df[x].max() if n else np.nan,
                "y_min": df[y].min() if n else np.nan, "y_max": df[y].max() if n else np.nan}
    slope, intercept = np.polyfit(df[x], df[y], 1)
    resid = df[y] - (slope * df[x] + intercept)
    return {"n": n, "slope": slope, "intercept": intercept,
            "resid_sd": float(np.sqrt((resid ** 2).sum() / (n - 2))) if n > 2 else np.nan,
            "x_min": df[x].min(), "x_max": df[x].max(),
            "y_min": df[y].min(), "y_max": df[y].max()}


def camera(c: pd.DataFrame):
    c = c.copy()
    c["err_pct"] = (c["camera_mm"] - c["tape_mm"]) / c["tape_mm"] * 100.0
    c["abs_err_pct"] = c["err_pct"].abs()
    tab = (c.dropna(subset=["err_pct"])
            .groupby(["glasses", "target_mm"])
            .agg(n=("err_pct", "size"), mean_err_pct=("err_pct", "mean"),
                 mean_abs_err_pct=("abs_err_pct", "mean"), max_abs_err_pct=("abs_err_pct", "max"))
            .reset_index().sort_values(["glasses", "target_mm"]))
    return c, tab


# -------------------------------------------------------------------- plots

def style_axes(ax):
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRAY)
    ax.tick_params(colors=INK_2, labelsize=9)
    ax.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def new_fig(title: str, subtitle: str, synthetic: bool):
    fig, ax = plt.subplots(figsize=(8, 5), dpi=200)
    fig.patch.set_facecolor(SURFACE)
    style_axes(ax)
    if synthetic:
        title = "SYNTHETIC DATA — " + title
    fig.suptitle(title, x=0.06, ha="left", fontsize=13, fontweight="bold", color=INK)
    import textwrap
    ax.set_title("\n".join(textwrap.wrap(subtitle, 110)), loc="left", fontsize=9, color=INK_2)
    return fig, ax


def watermark(fig):
    fig.text(0.5, 0.5, "SYNTHETIC DATA", fontsize=64, color="#d03b3b", alpha=0.18,
             ha="center", va="center", rotation=25, fontweight="bold", zorder=100)


def save(fig, path: Path, synthetic: bool):
    if synthetic:
        watermark(fig)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(path, facecolor=SURFACE)
    plt.close(fig)


def empty_note(ax, text):
    ax.text(0.5, 0.5, text, transform=ax.transAxes, ha="center", va="center",
            color=INK_2, fontsize=11)


def scored_points(ax, x, y, hollow, color, label):
    """Filled circle = scored; hollow circle = scored but near the screen floor."""
    hollow = np.asarray(hollow, bool)
    if (~hollow).any():
        ax.scatter(x[~hollow], y[~hollow], s=36, color=color, edgecolor=SURFACE,
                   linewidth=1, zorder=3, label=f"{label} (N={int((~hollow).sum())})")
    if hollow.any():
        ax.scatter(x[hollow], y[hollow], s=36, facecolor="none", edgecolor=color,
                   linewidth=1.5, zorder=3, label=f"{label}, near screen floor (N={int(hollow.sum())})")


def censored_points(ax, df, xcol, ytop, ybottom, color=GRAY):
    """Sessions without a number: shape-coded, drawn at the limit they hit."""
    for kind, st in CENSOR_STYLE.items():
        g = df[df.outcome == kind]
        if g.empty:
            continue
        if kind == "worse_than_1.3":
            y = np.full(len(g), WORSE_LIMIT)
        elif kind == "floor_hit":
            y = g["floor_logmar"].fillna(ybottom).to_numpy()
        else:
            y = np.full(len(g), ytop)
        x = g[xcol].to_numpy(dtype=float)
        pos = ~np.isnan(x)
        label = f"{st['label']} (N={len(g)})"
        if not pos.all():
            label += f"; {int((~pos).sum())} without distance, not drawn"
        ax.scatter(x[pos], y[pos], s=60, marker=st["marker"], color=color, edgecolor=SURFACE,
                   linewidth=0.8, zorder=4, label=label)


def y_limits(values, extra=()):
    vals = [v for v in list(values) + list(extra) if v is not None and np.isfinite(v)]
    if not vals:
        return -0.3, 1.0
    lo, hi = min(vals), max(vals)
    pad = max(0.05, 0.08 * (hi - lo))
    return lo - pad, hi + pad * 2


def plot_repeatability(rep, tab, stats, path, synthetic):
    sub = (f"condition = rep · each point = one session · Sw = {fmt(stats['sw'])} logMAR, "
           f"CR = {fmt(stats['cr'])} logMAR ({stats['units']} participant-eyes, "
           f"{stats['n_sessions']} scored sessions)")
    fig, ax = new_fig("Test–retest repeatability", sub, synthetic)
    if rep.empty:
        empty_note(ax, "No rep sessions in export")
        save(fig, path, synthetic)
        return
    units = list(tab["unit"])
    xpos = {u: i for i, u in enumerate(units)}
    rep = rep.sort_values(["unit", "session_id"]).copy()
    rep["x"] = rep["unit"].map(xpos).astype(float)
    # Deterministic spread so equal scores do not hide each other (display only).
    rep["x"] += rep.groupby("unit").cumcount().map(lambda k: ((k % 7) - 3) * 0.04)
    ok = rep[rep.outcome == "ok"]
    lo, hi = y_limits(rep["logmar"], list(rep.loc[rep.outcome == "floor_hit", "floor_logmar"].dropna()) +
                      ([WORSE_LIMIT] if (rep.outcome == "worse_than_1.3").any() else []))
    hi_band = hi
    scored_points(ax, ok["x"].to_numpy(), ok["logmar"].to_numpy(), ok["near_floor"],
                  BLUE, "session score")
    censored_points(ax, rep, "x", hi_band, lo)
    for _, r in tab.iterrows():
        x = xpos[r["unit"]]
        if np.isfinite(r["mean_logmar"]):
            ax.hlines(r["mean_logmar"], x - 0.3, x + 0.3, color=INK, linewidth=2, zorder=5)
    ax.hlines([], 0, 0, color=INK, linewidth=2, label="participant mean")
    ax.set_xticks(range(len(units)))
    ax.set_xticklabels([f"{u}\nN={int(n)} scored / {int(t)}" for u, n, t in
                        zip(tab.unit, tab.n_scored, tab.sessions_total)], fontsize=8, color=INK_2)
    ax.set_xlim(-0.6, len(units) - 0.4)
    ax.set_ylim(lo, hi_band + 0.05)
    ax.set_ylabel("logMAR (higher = worse)", color=INK_2)
    ax.legend(fontsize=8, frameon=False, loc="upper left", bbox_to_anchor=(1.0, 1.0))
    save(fig, path, synthetic)


def plot_dose(d, fit, missing, path, synthetic):
    sub = (f"each point = one session · defocus = max(0, R − 1000 / mean_mm); in glasses = 0 · "
           f"OLS slope = {fmt(fit['slope'])} logMAR/D (N = {fit['n']})")
    fig, ax = new_fig("Blur dose → acuity", sub, synthetic)
    if d.empty:
        empty_note(ax, "No dose sessions in export")
        save(fig, path, synthetic)
        return
    if missing:
        ax.text(0.01, 0.01, f"No R for {', '.join(missing)}: those no-glasses sessions are not plotted",
                transform=ax.transAxes, fontsize=8, color="#d03b3b")
    lo, hi = y_limits(d["logmar"], list(d.loc[d.outcome == "floor_hit", "floor_logmar"].dropna()) +
                      ([WORSE_LIMIT] if (d.outcome == "worse_than_1.3").any() else []))
    for cond, color, label in (("dose_noglasses", BLUE, "no glasses"),
                               ("dose_glasses", ORANGE, "in glasses (defocus 0)")):
        g = d[(d.condition == cond) & (d.outcome == "ok") & d.defocus_D.notna()]
        if len(g):
            scored_points(ax, g["defocus_D"].to_numpy(), g["logmar"].to_numpy(),
                          g["near_floor"], color, label)
    censored_points(ax, d[d.defocus_D.notna() | (d.outcome == "camera_stop")], "defocus_D", hi, lo)
    if np.isfinite(fit["slope"]):
        xs = np.linspace(fit["x_min"], fit["x_max"], 50)
        ax.plot(xs, fit["slope"] * xs + fit["intercept"], color=INK_2, linewidth=2, zorder=2,
                label="least-squares line")
        ax.annotate(f"{fit['slope']:.3f} logMAR per D", (xs[-1], fit["slope"] * xs[-1] + fit["intercept"]),
                    xytext=(-4, 8), textcoords="offset points", ha="right", fontsize=9, color=INK)
    ax.set_ylim(lo, hi + 0.05)
    ax.set_xlabel("defocus (D)", color=INK_2)
    ax.set_ylabel("logMAR (higher = worse)", color=INK_2)
    ax.legend(fontsize=8, frameon=False, loc="upper left", bbox_to_anchor=(1.0, 1.0))
    save(fig, path, synthetic)


def plot_control(ctrl, cfit, path, synthetic):
    sub = (f"condition = dose_glasses · expected flat · OLS slope = {fmt(cfit['slope'])} logMAR per metre "
           f"(N = {cfit['n']})")
    fig, ax = new_fig("Control: acuity in glasses vs distance", sub, synthetic)
    if ctrl.empty:
        empty_note(ax, "No dose_glasses sessions in export")
        save(fig, path, synthetic)
        return
    ok = ctrl[(ctrl.outcome == "ok") & ctrl.mean_mm.notna()]
    lo, hi = y_limits(ctrl["logmar"], list(ctrl.loc[ctrl.outcome == "floor_hit", "floor_logmar"].dropna()) +
                      ([WORSE_LIMIT] if (ctrl.outcome == "worse_than_1.3").any() else []))
    scored_points(ax, ok["mean_mm"].to_numpy(), ok["logmar"].to_numpy(), ok["near_floor"],
                  ORANGE, "in glasses")
    censored_points(ax, ctrl, "mean_mm", hi, lo)
    if np.isfinite(cfit["slope"]):
        xs = np.linspace(cfit["x_min"], cfit["x_max"], 50)
        ax.plot(xs * 1000, cfit["slope"] * xs + cfit["intercept"], color=INK_2, linewidth=2,
                label="least-squares line")
    ax.set_ylim(lo, hi + 0.05)
    ax.set_xlabel("mean camera distance during session (mm)", color=INK_2)
    ax.set_ylabel("logMAR (higher = worse)", color=INK_2)
    ax.legend(fontsize=8, frameon=False, loc="upper left", bbox_to_anchor=(1.0, 1.0))
    save(fig, path, synthetic)


def plot_camera(c, path, synthetic):
    sub = "error = (cameraMm − tapeMm) / tapeMm × 100 · each point = one check"
    fig, ax = new_fig("Camera distance vs tape measure", sub, synthetic)
    if c.empty:
        empty_note(ax, "No distance checks in export")
        save(fig, path, synthetic)
        return
    targets = sorted(c["target_mm"].dropna().unique())
    width = (min(np.diff(targets)) if len(targets) > 1 else 100) * 0.12
    for glasses, color, label, off in ((False, BLUE, "no glasses", -width),
                                       (True, ORANGE, "in glasses", width)):
        g = c[c.glasses == glasses].dropna(subset=["err_pct"])
        if g.empty:
            continue
        ax.scatter(g["target_mm"] + off, g["err_pct"], s=36, color=color, edgecolor=SURFACE,
                   linewidth=1, zorder=3, label=f"{label} (N={len(g)})")
    ax.axhline(0, color=INK_2, linewidth=1)
    ax.set_xticks(targets)
    ax.set_xlabel("tape distance (mm)", color=INK_2)
    ax.set_ylabel("camera error (%)", color=INK_2)
    ax.legend(fontsize=8, frameon=False, loc="upper left", bbox_to_anchor=(1.0, 1.0))
    save(fig, path, synthetic)


# ------------------------------------------------------------------ summary

def fmt(x, nd=3):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "n/a"
    return f"{x:.{nd}f}"


def md_table(df: pd.DataFrame, cols: dict[str, tuple[str, int | None]]) -> str:
    head = "| " + " | ".join(h for h, _ in cols.values()) + " |"
    sep = "|" + "|".join("---" for _ in cols) + "|"
    lines = [head, sep]
    for _, r in df.iterrows():
        cells = []
        for k, (_, nd) in cols.items():
            v = r[k]
            if nd is None:
                cells.append(str(v))
            else:
                cells.append(fmt(float(v), nd) if pd.notna(v) else "n/a")
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def summary(d: Data, R, rep_tab, rep_stats, dose_df, fit, cfit, missing_R, cam, cam_tab,
            synthetic: bool, raw: Path) -> str:
    L: list[str] = []
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if synthetic:
        L += ["# ⚠ SYNTHETIC DATA — NOT RESULTS ⚠", "",
              "**Everything below is computed from artificial exports generated by "
              "`analyze.py --synthetic` for debugging. Do not quote any number from this file.**", ""]
    L += ["# Analysis summary", "",
          f"- Run: {now}",
          f"- Input folder: `{raw.relative_to(ROOT) if raw.is_relative_to(ROOT) else raw}`",
          "- Input files (sha256, first 12 hex): " +
          ", ".join(f"`{k}` {v}" for k, v in d.inputs.items())]
    all_sessions = pd.concat([d.sessions, d.excluded])
    versions = all_sessions["app_version"].replace("", "(empty)").value_counts()
    L.append("- App version(s) in sessions.csv: " +
             ", ".join(f"`{v}` (N={n} sessions)" for v, n in versions.items()))
    if "app_version" in d.checks.columns:
        cv = d.checks["app_version"].replace("", "(empty)").value_counts()
        L.append("- App version(s) in distance_check.csv: " +
                 ", ".join(f"`{v}` (N={n} checks)" for v, n in cv.items()))
    L.append(f"- Sessions in export: N = {len(all_sessions)}; excluded: N = {len(d.excluded)}; "
             f"analysed: N = {len(d.sessions)}")
    L.append("- Not done: outlier removal, smoothing, thresholds chosen after seeing data, "
             "p-values for a single person.")
    L += [f"- {n}" for n in d.notes]

    # Exclusions
    L += ["", "## Excluded sessions (from EXCLUSIONS.md)", ""]
    if not d.exclusions:
        L.append("None listed. No session was excluded.")
    else:
        L += ["| session_id | condition | participant | reason |", "|---|---|---|---|"]
        cond = d.excluded.set_index("session_id")
        for e in d.exclusions:
            if e.found:
                r = cond.loc[e.session_id]
                L.append(f"| {e.session_id} | {r.condition} | {r.participant_id} | "
                         f"{e.reason or '**no reason given**'} |")
        unknown = [e for e in d.exclusions if not e.found]
        if unknown:
            L += ["", "**Listed in EXCLUSIONS.md but not present in sessions.csv:** " +
                  ", ".join(f"`{e.session_id}`" for e in unknown)]

    # Sessions without a number
    L += ["", "## Sessions without a score", "",
          "Counted, kept in the export and drawn with their own markers; not used in means, SDs or fits.", "",
          "| condition | scored | floor_hit | worse_than_1.3 | camera_stop | scored near floor (hollow) |",
          "|---|---|---|---|---|---|"]
    for cond in CONDITIONS:
        g = d.sessions[d.sessions.condition == cond]
        ok = g[g.outcome == "ok"]
        L.append(f"| {cond} | {len(ok)} | " +
                 " | ".join(str(int((g.outcome == k).sum())) for k in NO_NUMBER) +
                 f" | {int(ok.near_floor.sum())} |")

    # Repeatability
    L += ["", "## 1. Repeatability (condition = rep)", "",
          "Unit = participant × eye. SD is the sample SD (n − 1). Pooled within-subject SD "
          "Sw = sqrt(Σ(nᵢ − 1)·sᵢ² / Σ(nᵢ − 1)); coefficient of repeatability "
          "CR = 1.96 × √2 × Sw.", ""]
    if rep_tab.empty:
        L.append("No rep sessions.")
    else:
        L.append(md_table(rep_tab, {
            "unit": ("participant eye", None), "sessions_total": ("sessions, N", None),
            "n_scored": ("scored, N", None), "mean_logmar": ("mean (logMAR)", 3),
            "sd_logmar": ("SD (logMAR)", 3), "n_near_floor": ("near floor, N", None),
            "n_floor_hit": ("floor_hit, N", None), "n_worse_than_1.3": ("worse_than_1.3, N", None),
            "n_camera_stop": ("camera_stop, N", None)}))
        L += ["", f"- Within-subject SD Sw = **{fmt(rep_stats['sw'])} logMAR** "
                  f"({rep_stats['units']} participant-eyes with ≥ 2 scored sessions, "
                  f"N = {rep_stats['n_sessions']} sessions, {rep_stats['df']} degrees of freedom)",
              f"- Coefficient of repeatability CR = **{fmt(rep_stats['cr'])} logMAR**"]

    # Dose
    L += ["", "## 2. Blur dose → acuity (dose_noglasses, dose_glasses)", "",
          "defocus_D = max(0, R − 1000 / mean_mm) for sessions without glasses; 0 for sessions in glasses. "
          "Ordinary least squares over every scored session of both conditions; no weighting.", "",
          "R used (D, magnitude of myopia): " +
          (", ".join(f"{k} = {v:.2f}" for k, v in R.items()) if R else "**none given**")]
    if missing_R:
        L += ["", f"**NOT COMPUTED for {', '.join(missing_R)}: no R given.** "
                  "Pass `--R EYE=DIOPTERS` (or `--R PARTICIPANT:EYE=DIOPTERS`) and rerun."]
    nd = dose_df[dose_df.condition == "dose_noglasses"]
    ng = dose_df[dose_df.condition == "dose_glasses"]
    L += ["",
          f"- Sessions: no glasses N = {len(nd)} (scored {int((nd.outcome == 'ok').sum())}), "
          f"in glasses N = {len(ng)} (scored {int((ng.outcome == 'ok').sum())})",
          f"- Defocus range in fit: {fmt(fit['x_min'], 2)}–{fmt(fit['x_max'], 2)} D",
          f"- **Slope = {fmt(fit['slope'])} logMAR per diopter** (N = {fit['n']} sessions); "
          f"intercept = {fmt(fit['intercept'])} logMAR; residual SD = {fmt(fit['resid_sd'])} logMAR"]
    if len(nd):
        L += ["", "Per-session values (no glasses):", "",
              md_table(nd.sort_values("defocus_D"), {
                  "session_id": ("session", None), "eye": ("eye", None),
                  "mean_mm": ("mean distance (mm)", 0), "defocus_D": ("defocus (D)", 2),
                  "outcome": ("outcome", None), "logmar": ("logMAR", 3)})]

    L += ["", "### Control: in glasses vs distance", "",
          f"- Scored sessions in glasses: N = {cfit['n']}, distance {fmt(cfit['x_min'] * 1000, 0) if np.isfinite(cfit['x_min']) else 'n/a'}"
          f"–{fmt(cfit['x_max'] * 1000, 0) if np.isfinite(cfit['x_max']) else 'n/a'} mm",
          f"- logMAR range: {fmt(cfit['y_min'])} to {fmt(cfit['y_max'])}",
          f"- OLS slope = {fmt(cfit['slope'])} logMAR per metre of distance"]

    # Camera
    L += ["", "## 3. Camera vs tape (distance_check.csv)", "",
          "error = (cameraMm − tapeMm) / tapeMm × 100. Grouped by "
          + ("`target_mm`" if "target_mm" in d.checks.columns else "tapeMm") + " and glasses.", ""]
    if cam_tab.empty:
        L.append("No distance checks.")
    else:
        t = cam_tab.copy()
        t["glasses"] = t["glasses"].map({True: "yes", False: "no"})
        L.append(md_table(t, {
            "glasses": ("glasses", None), "target_mm": ("distance (mm)", 0), "n": ("N", None),
            "mean_err_pct": ("mean error (%)", 1), "mean_abs_err_pct": ("mean abs error (%)", 1),
            "max_abs_err_pct": ("max abs error (%)", 1)}))
        bad = cam["err_pct"].isna().sum()
        if bad:
            L += ["", f"Checks with an empty cameraMm or tapeMm: N = {bad} (not in the table)."]

    # Trials
    t = d.trials
    known = set(pd.concat([d.sessions, d.excluded])["session_id"])
    per = t.groupby("session_id").size()
    L += ["", "## Trials (trials.csv)", "",
          f"- Rows: N = {len(t)}; sessions with trials: N = {per.size}"
          + (f"; trials per session median {int(per.median())} (range {per.min()}–{per.max()})" if per.size else ""),
          f"- Analysed sessions without any trial rows: N = {len(set(d.sessions.session_id) - set(per.index))}",
          f"- Trial rows whose session_id is not in sessions.csv: N = {int((~t.session_id.isin(known)).sum())}",
          "- Scores are taken from sessions.csv as computed by the app; trials.csv is only checked for consistency."]

    L += ["", "## Figures", "",
          "- `repeatability.png`", "- `dose_response.png`", "- `dose_control.png`", "- `camera_vs_tape.png`",
          "", "Filled circle = scored session; hollow circle = scored but near the screen floor; "
              "triangle down = floor hit; triangle up = worse than 1.3 logMAR; X = stopped by camera."]
    if synthetic:
        L += ["", "**SYNTHETIC DATA — NOT RESULTS.**"]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- synthetic

SYNTH_R = {"OD": 2.50, "OS": 2.25}


def make_synthetic(out: Path, seed: int = 7) -> None:
    rng = np.random.default_rng(seed)
    out.mkdir(parents=True, exist_ok=True)
    version = "0.0.0-synthetic"
    pitch_mm = 0.09   # simulated pixel pitch
    min_px = 5        # smallest renderable optotype, px

    def floor_at(mm):
        return math.log10(min_px * pitch_mm / (mm * math.tan(math.radians(5 / 60))))

    sessions, trials = [], []
    t0 = dt.datetime(2026, 11, 14, 21, 0)
    k = 0

    def add(pid, cond, eye, mm, true_lm, force=None):
        nonlocal k
        k += 1
        sid = f"SYN-{k:03d}"
        fl = floor_at(mm)
        lm = round(true_lm + rng.normal(0, 0.06), 2)
        outcome = force or ("floor_hit" if lm < fl else "worse_than_1.3" if lm > WORSE_LIMIT else "ok")
        sessions.append({
            "session_id": sid, "participant_id": pid, "condition": cond, "eye": eye,
            "started_at": (t0 + dt.timedelta(minutes=4 * k)).isoformat(),
            "app_version": version,
            "mean_mm": "" if outcome == "camera_stop" else round(mm + rng.normal(0, 8)),
            "outcome": outcome, "logmar": lm if outcome == "ok" else "",
            "floor_logmar": round(fl, 3),
            "near_floor": str(outcome == "ok" and lm - fl < 0.1).lower(),
        })
        for i in range(int(rng.integers(12, 20))):
            line = round(lm + rng.choice([-0.2, -0.1, 0, 0.1]), 1)
            shown = rng.choice(list("URDL"))
            correct = bool(rng.random() < (0.9 if line > lm else 0.4))
            trials.append({"session_id": sid, "trial_index": i + 1, "logmar_line": line,
                           "shown": shown,
                           "answered": shown if correct else rng.choice(list("URDL")),
                           "correct": str(correct).lower(),
                           "camera_mm": round(mm + rng.normal(0, 10))})

    for pid, base in (("P01", -0.05), ("P02", 0.02), ("P03", 0.10)):
        for _ in range(8):
            add(pid, "rep", "OD", 400, base)
    add("P02", "rep", "OD", 400, 0.0, force="camera_stop")
    add("P03", "rep", "OD", 400, 0.1)  # will be excluded
    for eye, R in SYNTH_R.items():
        for mm in (300, 400, 500, 650, 800, 1000, 1300, 1600, 2000):
            blur = max(0.0, R - 1000 / mm)
            add("P01", "dose_noglasses", eye, mm, -0.05 + 0.33 * blur)
            add("P01", "dose_glasses", eye, mm, -0.05)
    add("P01", "dose_noglasses", "OD", 3000, 1.35)          # worse than 1.3
    add("P01", "dose_glasses", "OS", 1200, 0, force="camera_stop")

    pd.DataFrame(sessions).to_csv(out / "sessions.csv", index=False)
    pd.DataFrame(trials).to_csv(out / "trials.csv", index=False)
    checks = []
    for glasses in (False, True):
        for target in (300, 400, 600, 800, 1000, 1500):
            for rep in range(3):
                tape = target + int(rng.integers(-3, 4))
                bias = 0.02 if glasses else -0.01
                cam = tape * (1 + bias + rng.normal(0, 0.025 + target / 1e5))
                checks.append({"check_id": f"C{len(checks) + 1:03d}", "app_version": version,
                               "glasses": str(glasses).lower(), "target_mm": target,
                               "tapeMm": tape, "cameraMm": round(cam)})
    pd.DataFrame(checks).to_csv(out / "distance_check.csv", index=False)
    excl_id = [s["session_id"] for s in sessions if s["participant_id"] == "P03"
               and s["condition"] == "rep"][-1]
    (out / "EXCLUSIONS.md").write_text(
        "# Exclusions (SYNTHETIC)\n\n| session_id | reason |\n|---|---|\n"
        f"| {excl_id} | participant interrupted mid-test (synthetic example) |\n"
        "| SYN-999 | listed but absent from export (synthetic example of a typo) |\n",
        encoding="utf-8")


# --------------------------------------------------------------------- main

def run(raw: Path, out: Path, R: dict[str, float], synthetic: bool) -> int:
    d = load(raw)
    out.mkdir(parents=True, exist_ok=True)
    (out / "tables").mkdir(exist_ok=True)

    rep, rep_tab, rep_stats = repeatability(d.sessions)
    dose_df, fit, ctrl, cfit, missing_R = dose(d.sessions, R)
    cam, cam_tab = camera(d.checks)

    plot_repeatability(rep, rep_tab, rep_stats, out / "repeatability.png", synthetic)
    plot_dose(dose_df, fit, missing_R, out / "dose_response.png", synthetic)
    plot_control(ctrl, cfit, out / "dose_control.png", synthetic)
    plot_camera(cam, out / "camera_vs_tape.png", synthetic)

    rep_tab.to_csv(out / "tables" / "repeatability.csv", index=False)
    dose_df.drop(columns=[], errors="ignore").to_csv(out / "tables" / "dose_sessions.csv", index=False)
    cam_tab.to_csv(out / "tables" / "camera_error.csv", index=False)
    pd.DataFrame([{"what": "dose", **fit}, {"what": "control_per_metre", **cfit}]).to_csv(
        out / "tables" / "fits.csv", index=False)

    text = summary(d, R, rep_tab, rep_stats, dose_df, fit, cfit, missing_R, cam, cam_tab,
                   synthetic, raw)
    (out / "summary.md").write_text(text, encoding="utf-8")
    print(f"wrote {out}/summary.md and 4 figures")
    if missing_R:
        print(f"WARNING: no R for {', '.join(missing_R)}; dose analysis incomplete", file=sys.stderr)
        return 1
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW, help="folder with raw exports")
    p.add_argument("--out", type=Path, default=None, help="output folder")
    p.add_argument("--R", action="append", default=[], metavar="EYE=D",
                   help="myopia magnitude per eye in diopters, e.g. --R OD=2.50 --R OS=2.25; "
                        "PARTICIPANT:EYE=D is also accepted")
    p.add_argument("--synthetic", action="store_true",
                   help="generate artificial exports in analysis/synthetic/ and analyse them")
    a = p.parse_args(argv)
    try:
        R = parse_R(a.R)
        if a.synthetic:
            make_synthetic(SYNTH_DIR)
            return run(SYNTH_DIR, a.out or SYNTH_DIR / "out", R or dict(SYNTH_R), True)
        if not R and (a.raw / "refraction.csv").exists():
            rf = read_csv(a.raw / "refraction.csv", ["eye", "r_d"])
            R = parse_R([f"{(r.participant_id + ':') if 'participant_id' in rf.columns and r.participant_id else ''}"
                         f"{r.eye}={r.r_d}" for r in rf.itertuples()])
        return run(a.raw, a.out or DEFAULT_OUT, R, False)
    except InputError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
