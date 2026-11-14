"""Psychometric model, threshold estimation and the Psi staircase.

This is a line-by-line port of app/src/core/{psychometric,psi,optics}.ts. The threshold
estimate (posterior mean, uniform prior on the grid) must agree with the app to < 1e-6;
tests/test_pipeline.py checks this on a real export of the app.
"""
from __future__ import annotations

import numpy as np

ARCMIN_PER_RAD = 60 * 180 / np.pi
GRID = np.round(np.arange(round((1.4 + 0.6) / 0.005) + 1) * 0.005 - 0.6, 6)
GUESS, LAPSE, SLOPE = 0.25, 0.02, 12.0


def logmar_from_stroke(stroke_mm, distance_cm):
    return np.log10(2 * np.arctan(np.asarray(stroke_mm) / (2 * np.asarray(distance_cm) * 10)) * ARCMIN_PER_RAD)


def stroke_mm_for_logmar(logmar, distance_cm):
    return 2 * distance_cm * 10 * np.tan(10 ** np.asarray(logmar) / ARCMIN_PER_RAD / 2)


def p_correct(x, theta, guess=GUESS, lapse=LAPSE, slope=SLOPE):
    return guess + (1 - guess - lapse) / (1 + np.exp(-slope * (np.asarray(x) - np.asarray(theta))))


def log_likelihood(x, correct, grid=GRID, **psych):
    x = np.asarray(x, float)[:, None]
    c = np.asarray(correct, bool)[:, None]
    pc = p_correct(x, grid[None, :], **psych)
    return np.where(c, np.log(pc), np.log(1 - pc)).sum(axis=0)


def estimate_threshold(x, correct, grid=GRID, **psych) -> dict:
    ll = log_likelihood(x, correct, grid, **psych)
    w = np.exp(ll - ll.max())
    w /= w.sum()
    mean = float((w * grid).sum())
    sd = float(np.sqrt((w * (grid - mean) ** 2).sum()))
    edge = max(1, round(0.1 / 0.005))
    return {
        "mean": mean,
        "sd": sd,
        "mle": float(grid[int(np.argmax(ll))]),
        "at_boundary": bool(w[:edge].sum() > 0.05 or w[-edge:].sum() > 0.05),
    }


class Psi:
    """Port of PsiStaircase (minimum expected entropy placement, fixed slope)."""

    def __init__(self, candidates, prior_mean=0.1, prior_sd=0.5, **psych):
        self.c = np.asarray(candidates, float)
        self.psych = psych
        self.logpost = -0.5 * ((GRID - prior_mean) / prior_sd) ** 2
        self.x: list[float] = []
        self.r: list[bool] = []
        self.L = p_correct(self.c[:, None], GRID[None, :], **psych)  # candidates × grid

    def next(self) -> float:
        if not self.x:
            return float(self.c[np.argmin(np.abs(self.c - 0.5))])
        post = np.exp(self.logpost - self.logpost.max())
        post /= post.sum()
        qc = post[None, :] * self.L
        qw = post[None, :] * (1 - self.L)
        pc = qc.sum(1, keepdims=True)
        pw = qw.sum(1, keepdims=True)

        def ent(q, s):
            v = q / s
            with np.errstate(divide="ignore", invalid="ignore"):
                return -np.nansum(np.where(v > 0, v * np.log(v), 0), axis=1)

        h = pc[:, 0] * ent(qc, pc) + pw[:, 0] * ent(qw, pw)
        return float(self.c[int(np.argmin(h))])

    def update(self, x, correct):
        self.x.append(float(x))
        self.r.append(bool(correct))
        pc = p_correct(x, GRID, **self.psych)
        self.logpost += np.log(pc if correct else 1 - pc)


def candidate_levels(lo, hi=1.3, step=0.02):
    n = int(np.floor((hi - lo) / step + 1e-9)) + 1
    return np.round(lo + np.arange(n) * step, 4)
