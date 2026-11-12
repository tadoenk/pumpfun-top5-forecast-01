# Pumpfun Top-5 Forecast (pumpfun-top5-forecast-01) — v2 Entry

- **Owner:** Tadoenk
- **Referral Code:** pn0h53j2
- **Bounty:** [pumpfun-top5-forecast-01](https://make.fun/bounty/pumpfun-top5-forecast-01)

## v2 Model Overview
This entry implements a self-calibrating two-channel Monte Carlo forecaster in TypeScript (Node 22, standard library only):
- **Self-Calibration:** Learns per-hour log-cap leader drift, robust MAD-based idiosyncratic volatility across rank bands and venues, place-threshold drifts, entrant offset distributions, and newcomer outsider share saturation curves ($\tau, S_{inf}$) directly from historical mark pairs as a function of answer-read horizons.
- **Two-Channel Dynamics:** Combines incumbent wobble (Gaussian fluctuations around damped drift and common market factors) with Poisson arrivals of phantom newcomers entering top-5 slots from outside the top 30.
- **Monte Carlo Simulation & Unrenormalised Output:** Runs 8,000 trajectories per answer read with a seeded Mulberry32 PRNG and Box-Muller normal sampler. Reports model probabilities unrenormalised, intentionally leaving unnamed probability mass below 1 as a real hedge against surprise jump arrivals.
- **Incumbency Anchor & Fallbacks:** Ranks candidates by pooled top-5 probability, mean place, and place-1 share with fallback to persistence on any failure.
- **Complete Design Notes:** Full diagnosis of v1 failure modes and detailed v2 specifications are documented in [V2_NOTES.md](./V2_NOTES.md).

## Local Execution
```bash
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
