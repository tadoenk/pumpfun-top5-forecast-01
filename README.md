# Pumpfun Top-5 Forecast (pumpfun-top5-forecast-01) — v3 Two-Channel Monte Carlo with Calibration Layer

- **Owner:** Tadoenk
- **Referral Code:** pn0h53j2
- **Bounty:** [pumpfun-top5-forecast-01](https://make.fun/bounty/pumpfun-top5-forecast-01)

## v3 Model Overview
This entry implements a self-calibrating two-channel Monte Carlo forecaster combined with an output calibration layer in TypeScript (Node 22, standard library only):
- **Two-Channel Core (v2):** Learns per-hour leader drift, robust MAD-based idiosyncratic volatility across rank bands and venues, place-threshold drifts, entrant offset distributions, and outsider share saturation curves directly from historical mark pairs. Combines incumbent wobble with Poisson arrivals of phantom newcomers.
- **Output Calibration Layer (v3):** Corrects overconfidence in Monte Carlo place assignments and sharp size distributions through three sequential post-processing steps: (1) place-kernel smoothing ($\text{SMOOTH\_W} = 0.25$) over neighbouring places per coin to borrow mass when pair evidence is thin; (2) probability temperature flattening ($\text{ORDER\_TEMP} = 0.8$) per place preserving named sums; (3) size-bin temperature flattening ($\text{SIZE\_TEMP} = 0.8$) preserving named size sums.
- **Performance:** Achieves a walk-forward mean score of **-36.834** on the kit fixture, outperforming v2 (-39.455) and the house baseline (-43.118).
- **Design Notes:** Detailed v3 calibration specifications are documented in [V3_NOTES.md](./V3_NOTES.md).

## Local Execution
```bash
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License
MIT License
