"""Shared figure style. Palette: validated reference categorical slots 1–3 (blue, orange,
aqua; all-pairs CVD-safe), recessive gray grid, text in neutral ink (never series colour)."""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

S1, S2, S3 = "#2a78d6", "#eb6834", "#1baf7a"
INK, INK2, MUTED, GRID, SURFACE = "#0b0b0b", "#52514e", "#8a8984", "#e6e5e1", "#fcfcfb"
EYE_COLOR = {"OD": S1, "OS": S2}
EYE_NAME = {"OD": "Right eye (OD)", "OS": "Left eye (OS)"}

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": MUTED, "axes.labelcolor": INK, "text.color": INK,
    "xtick.color": INK2, "ytick.color": INK2, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.spines.top": False, "axes.spines.right": False, "font.size": 10, "axes.titlesize": 11.5,
    "axes.titleweight": "bold", "axes.titlelocation": "left", "legend.frameon": False,
    "lines.linewidth": 2, "lines.markersize": 6, "font.family": "DejaVu Sans", "svg.fonttype": "none",
})

CATEGORY_NOTE = {
    "MEASURED": "MEASURED — experimental data",
    "CALCULATED": "CALCULATED — from optics formulas and stated assumptions, not measured",
    "SIMULATED": "SIMULATED — synthetic data for algorithm validation, NOT experimental results",
}


def stamp(fig, category: str, source: str):
    """Provenance footer on every figure; SIMULATED figures also get a watermark."""
    fig.text(0.01, 0.005, f"{CATEGORY_NOTE[category]} · source: {source}", fontsize=7.5, color=INK2, ha="left", va="bottom")
    if category == "SIMULATED":
        fig.text(0.5, 0.5, "SIMULATED", fontsize=54, color="#d9d8d3", alpha=0.45, ha="center", va="center",
                 rotation=28, zorder=0, weight="bold")


def save(fig, path_stem):
    from pathlib import Path

    p = Path(path_stem)
    p.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(p.with_suffix(".png"), dpi=200, bbox_inches="tight")
    fig.savefig(p.with_suffix(".svg"), bbox_inches="tight")
    plt.close(fig)
