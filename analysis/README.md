# analysis/

`analyze.py` turns the raw app exports in `data/raw/` into every figure and table
the project quotes. Nothing in `analysis/out/` is edited by hand.

```bash
pip install -r analysis/requirements.txt
python analysis/analyze.py --R OD=2.50 --R OS=2.25   # real exports -> analysis/out/
python analysis/analyze.py --synthetic               # fake exports -> analysis/synthetic/ (git-ignored)
```

`R` is the magnitude of the blur participant's myopia per eye, in diopters, as a
positive number (a −2.50 D eye is `OD=2.50`). `PARTICIPANT:EYE=D` is also accepted.
If `--R` is not given, `data/raw/refraction.csv` (columns `eye,R_D`, optional
`participant_id`) is used when present.

Exit codes: `0` everything computed; `1` outputs written but the dose analysis is
incomplete (no R for some eye); `2` an input does not match the contract below
(nothing written).

## Outputs

| File | Content |
|---|---|
| `repeatability.png` | condition `rep`: every session per participant-eye, mean bar |
| `dose_response.png` | logMAR vs defocus_D, `dose_noglasses` + `dose_glasses`, OLS line |
| `dose_control.png` | `dose_glasses` only: logMAR vs mean camera distance |
| `camera_vs_tape.png` | camera error (%) vs tape distance, glasses / no glasses |
| `summary.md` | every number with N and units, run date, app version, exclusions |
| `tables/*.csv` | the same numbers, machine-readable |

Markers: filled circle = scored; hollow circle = scored with `near_floor = true`;
▼ floor_hit (drawn at `floor_logmar`); ▲ worse_than_1.3 (drawn at 1.3);
✕ camera_stop (drawn on the top edge; not drawn when it has no distance).
Sessions without a score are counted in `summary.md` and never enter means, SDs or fits.

## Input contract

Column names are matched case-insensitively and camelCase is accepted
(`tapeMm` = `tape_mm`). Extra columns are ignored.

**sessions.csv** — one row per test session

| column | type | meaning |
|---|---|---|
| `session_id` | text, unique | |
| `participant_id` | text | |
| `condition` | `rep` / `dose_noglasses` / `dose_glasses` | other values are counted, not analysed |
| `eye` | `OD` / `OS` / `OU` | |
| `app_version` | text | printed in summary.md |
| `mean_mm` | number | mean camera distance during the session, mm |
| `outcome` | `ok` / `floor_hit` / `worse_than_1.3` / `camera_stop` | anything else is an error |
| `logmar` | number | required when `outcome = ok`, empty otherwise |
| `near_floor` | true / false | |
| `floor_logmar` | number, optional | best logMAR the screen could show at that distance |

**trials.csv** — needs `session_id`; only checked for consistency (scores come from sessions.csv).

**distance_check.csv** — `tapeMm`, `cameraMm`, `glasses` (true/false); optional
`target_mm` (nominal tape mark, used for grouping; otherwise exact `tapeMm` values are grouped),
optional `app_version`.

**EXCLUSIONS.md** — must exist. Either a Markdown table with a `session_id` column
(and a `reason` column), or bullets:

```markdown
| session_id | reason |
|---|---|
| S-0012 | phone call mid-test |

- S-0031: wrong eye covered
```

Only sessions listed here are removed. IDs that are not in sessions.csv are reported.

## Statistics

- Repeatability: unit = participant × eye; sample SD (n − 1); pooled within-subject
  SD `Sw = sqrt(Σ(nᵢ−1)·sᵢ² / Σ(nᵢ−1))` over units with ≥ 2 scored sessions;
  `CR = 1.96 × √2 × Sw`.
- Dose: `defocus_D = max(0, R − 1000 / mean_mm)` without glasses, 0 in glasses;
  unweighted OLS over all scored dose sessions; slope in logMAR per diopter.
- Camera: `(cameraMm − tapeMm) / tapeMm × 100`; mean, mean absolute and max absolute
  error per distance, glasses and no glasses separately.
- Not done, by design: outlier removal, smoothing, thresholds chosen after seeing
  the data, p-values for a single person.
