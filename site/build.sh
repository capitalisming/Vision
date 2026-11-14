#!/usr/bin/env bash
# Copies the generated figures next to the project page. Run after analysis/simulate.py.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fig
cp ../results/calculated/c1_display_limit.png ../results/calculated/c2_accommodation_masking.png \
   ../results/calculated/c3_fog_lens_far_point_PROPOSED.png fig/
cp ../results/simulated/s1_staircase_accuracy.png ../results/simulated/s2_change_rule.png fig/
cp ../results/simulated_pipeline_demo/fig_dose_response.png fig/s3_dose_response.png
cp ../results/simulated_pipeline_demo/fig_detection.png fig/s3_detection.png
cp ../results/simulated_pipeline_demo/fig_raw_staircases.png fig/s3_raw_staircases.png
echo "figures copied to site/fig"
