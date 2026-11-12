# Pumpfun Top-5 Forecast (pumpfun-top5-forecast-01)

- **Owner:** Tadoenk
- **Referral Code:** pn0h53j2
- **Bounty:** [pumpfun-top5-forecast-01](https://make.fun/bounty/pumpfun-top5-forecast-01)

## Model Overview
This entry implements a self-calibrating Monte Carlo forecaster in TypeScript (Node 22, standard library only):
- **Self-Calibration:** Learns per-hour log-cap drift, increment standard deviation, survival hazards, and newcomer arrival rates directly from historical mark pairs.
- **Damped Drift & Spread:** Projects future coin market caps using damped drift, horizon-proportional spread ($\sigma = \sqrt{(\text{sdCoin} \cdot \sqrt{h})^2 + 0.02 \cdot h}$), and a per-bucket death hazard.
- **Phantom Newcomers:** Simulates phantom newcomers to account for unobserved future coins born after the cutoff.
- **Simulation & Aggregation:** Runs 4,000 Monte Carlo trajectories per answer read, smoothing size distributions and leaving unassigned probability mass on purpose to capture newcomers and unexpected shifts.
- **Determinism:** Seeded with a fixed PRNG seed (`424242`) ensuring byte-for-byte identical output across runs.

## Local Execution
```bash
mkdir -p out
MAKEFUN_INPUT_DIR=/home/hatch/workspace/makefun/pumpfun-top5-forecast-01-kit/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
