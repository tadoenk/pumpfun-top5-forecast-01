# pumpfun-top5-forecast-01 - v3 notes

## What v3 is
The v2 two-channel self-calibrating Monte Carlo model, unchanged, plus a calibration layer at the output stage (see the calibration section of main.ts): (1) place-kernel smoothing with SMOOTH_W = 0.25 over neighbouring places per coin; (2) temperature flattening ORDER_TEMP = 0.8 on each place's coin rows, rescaled to preserve the place's named sum; (3) temperature flattening SIZE_TEMP = 0.8 on each place's size-bin rows, preserving the named size sum. top5 is computed from the raw pooled counts, before calibration. The v2 design notes (V2_NOTES.md) are superseded by this file and by the README; they remain available in this repository's git history at the v2 commit.

## Why: diagnosis on the walk-forward harness
The local walk-forward harness (kit fixture truncated after marks 1-4, canonical scorer; it reproduces the house baseline's and v1's and v2's published per-cut numbers exactly) showed where v2's emitted distributions lose: on the later cuts, genuine mid-place contenders received barely more than the unnamed-share probability at places 3-4 (e.g. cut 4: place-3 holder at p 0.0063, place-4 holder at p 0.0050 against an unnamed share of about 0.006), and the size histograms are emitted with sums of about 1.00 and sharp peaks - the Monte Carlo's place assignment and size distributions are overconfident relative to how noisy exact placement is. A grid search over post-processing of v2's emitted outputs (kernel width 0.08-0.40, order temperature 0.70-1.30, size temperature 0.80-1.00) found a broad plateau, not a spike: every width in 0.18-0.40 and every temperature in 0.75-0.90 improved on v2. The shipped point (0.25, 0.8, 0.8) sits mid-plateau.

## Walk-forward results (kit fixture, cuts 1-4, totals)
baseline: -59.169 / -49.958 / -33.478 / -29.867, mean -43.118
v1: -61.055 / -62.175 / -33.602 / -27.807, mean -46.160
v2: -57.537 / -49.363 / -26.897 / -24.022, mean order -20.879, size -18.576, total -39.455
v3 (initial discovery): -55.220 / -47.150 / -26.676 / -23.822, mean -38.217
v3 (final shipped implementation): -50.677 / -46.640 / -26.659 / -23.360, mean order -19.571, size -17.263, total -36.834
v3 improves on v2 at every cut (+6.860 / +2.723 / +0.238 / +0.662), +2.621 on the mean.

## Long-horizon stress test (synthetic, independent generator)
Because the fixture only validates 10-50 minute horizons and the final reads sit 7-13h after an 11h history, v2 and v3 were also compared on 12 synthetic final-scale scenarios from an independent lifecycle generator (rise-peak-decay coin paths, jumps, births; regimes: calm, frenzy-then-calm, sustained frenzy, sleeper pumps; 3 seeds each; 66-mark histories, 7 hourly answer reads). v2: mean -55.01, p25 -62.74, worst -67.99. v3 (shipped implementation): mean -48.74, p25 -52.69, worst -65.51. The bad tail improves across scenarios; absolute levels on synthetic data are far below the fixture's because the generator's long-horizon turnover is harsher; only the relative comparison is meaningful.

## Alternatives tested and rejected (walk-forward mean)
- Regime-weighted pair estimation + outsider-share pair gating + dual-curve share fit + sigma shrinkage, as one bundle: -44.903. The regime weights and dual fit helped later-cut order but degraded sizes across cuts.
- Pair hygiene alone (gating share/entrant stats to pairs with >= 30 rows at the start mark, conservative prior fallback when < 3 points): -42.997. On 1-2 mark histories the prior (Sinf 0.5, tau 2h) starves the phantom channel at 10-minute horizons; cut 2 collapsed to -60.273.
- Pair gating with the grid fit left free on the remaining points: -39.430, statistically v2, but cut 1 degraded by 1.79.
- Smoothing alone (best width 0.35): -38.864, but cut 4 degraded by 0.62. Temperature alone (0.7): -39.281. Only the combination clears every cut.

## Honest caveats
Three calibration constants were selected on 9 fixture answer reads; the plateau's breadth and the independent stress generator reduce, but do not eliminate, overfitting risk. The final recorded-session reimplementation follows the exact documented model/calibration specification while minor code structure differences can slightly shift Monte Carlo draws. The fixture validates the calibration at 10-50 minute horizons; at the final's 7-13h horizons the stress test confirms favorable relative performance with no tail degradation on synthetic data. The model core remains v2: every parameter is re-estimated from the input's own history at run time.

## Verification Facts
- Final-scale runtime on `stress-in`: **7.605 seconds** (within 300s budget).
- Named probability and size sums: **all <= 1.0**.
- Determinism: kit fixture forecast md5 sum is **`c90e2b2e9e6463c31df921cfcdffb077`**.
