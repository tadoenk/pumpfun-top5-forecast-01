# pumpfun-top5-forecast-01 — v2 diagnosis and design notes

## Where v1 stands

Live PRACTICE board (dev phase, 432 entries, graded by the server on the sealed
practice instance: 1h of marks from 2026-11-11T20:00Z, 7 answer reads 10 minutes
apart over the next hour):

- v1 (submission 01a1ce56): rank 404/432, log score **-43.5213**
  = order **-24.1501** (component rank 419) + size **-19.3711** (rank 358),
  agreement **32**.
- House persistence baseline on the same practice: **-40.408345**
  (order -21.380389, size -19.027956), agreement 56.
- Top entry: -31.8 (order -17.6121, size -14.2227), agreement 58.
- A perfectly uniform forecast scores -45.059447; its order part alone is
  5 * ln(1/100) = **-23.026**. v1's order score (-24.15) is *worse than naming
  nothing at all*.

The final (what prizes pay on) is a different regime: 11h of marks, 7 hourly
answer reads 7-13h after the cut. v2 must be horizon-adaptive, not tuned to the
practice's 1-hour geometry; every parameter below is estimated from whatever
history the program is given, as a function of the actual read horizons in
task.json.

## Local evaluation harness (built for this diagnosis)

There is no local grade for this competition, so we built a walk-forward
harness on the kit fixture itself: truncate the 6-mark history after mark
c (c = 1..4), let each program forecast from the truncated history, and score
against the remaining marks' charts with the canonical scorer's rules
(place-probability with unnamed-share sharing, knownOnly dropping of rows that
name mints the truncated history never named, per-place size bins, floor 1e-4).
It reproduces the house baseline's known fixture behaviour (cut 3: -33.478,
matching the previously recorded -33.48) and v1's live failure mode:

| cut | baseline order | baseline size | baseline total | v1 order | v1 size | v1 total |
|-----|---------------|---------------|----------------|----------|---------|----------|
| 1   | -25.258 | -33.911 | -59.169 | -28.352 | -32.703 | -61.055 |
| 2   | -26.249 | -23.709 | -49.958 | -36.458 | -25.717 | -62.175 |
| 3   | -18.589 | -14.889 | -33.478 | -20.294 | -13.308 | -33.602 |
| 4   | -15.246 | -14.621 | -29.867 | -15.885 | -11.922 | -27.807 |
| mean| -21.335 | -21.782 | -43.118 | -25.247 | -20.912 | -46.160 |

Agreement per cut: baseline 15.2, v1 13.2. v1's order component is worse than
uniform on the walk-forward too (-25.25 vs -23.03), exactly as on the live
board. What this harness can prove: short-horizon (10-50 min) calibration and
output discipline on real recorder data. What it cannot prove: behaviour at
the final's 7-13h horizons or on an 11h history; for that we rely on the
estimator being fitted to the input's own history at run time (see design).

## Diagnosis — why v1 fails (each claim measured)

1. **Over-naming with near-total named mass (the fatal flaw).** v1 emits up to
   60 rows per place with named sums of 0.67-0.99 (full-fixture run: place sums
   0.989 / 0.974 / 0.948 / 0.904 / 0.842; walk-forward cut 2: 0.97-0.99 with
   37-50 rows/place). The scorer shares a place's *unnamed* mass over the
   answer chart's unnamed coins: with sum S = 0.99 over n = 47 named, a
   surprise holder gets (1-S)/(100-n) = 0.00019, i.e. ln = -8.6, near the
   -9.21 floor. The baseline names 3 coins/place with sum 0.5, so a surprise
   costs it only ln(0.5/97) = -5.27. In a market where 40% of top-5 slots at
   +10 min (mature fixture marks) are held by coins absent from the previous
   mark, v1 pays the near-floor price again and again. Candidate angle
   "phantom/newcomer mass too high" is therefore REJECTED as the primary
   cause: v1's problem is the opposite — its *named* mass is too high and too
   flat; the phantom share inside its simulation never reaches the output as
   unnamed mass because the output layer rescales/caps emitted rows to ~0.99.
2. **Over-dispersion dilutes the true contenders.** v1's per-coin sigma comes
   from per-hour increment rates over mixed gaps (sd clamped up to 1.2) and a
   per-coin increment sd from as few as 3 ten-minute increments; sigma is then
   clamped up to 2.5 dex. Measured reality (fixture): 10-minute log-cap
   increments of top-100 coins have sd 0.143 (0.35 per sqrt-hour), and the
   leaders' caps at the cut are bunched within ~0.05 dex of each other, so a
   calibrated sigma at 10-70 min horizons is ~0.15-0.45, not 1-2.5. With v1's
   sigma, win shares smear over dozens of coins: its top place-1 probability
   on the full fixture is 0.19 (baseline effectively bets 0.30 on its #1).
3. **Momentum chasing.** v1 extrapolates each coin's own recent slope
   (weight 0.5, from 10-minute increments, clamped at ±2 dex/hour) with a
   damping horizon of 6h. At 10-minute spacing that slope is mostly noise, and
   leaders sit at local peaks (their next-increment mean is -0.04, sd 0.26):
   the extrapolation systematically promotes coins that just spiked and buries
   the incumbents — agreement 32 vs the baseline's 56 live, 13.2 vs 15.2 per
   cut locally.
4. **Broken calibration estimators.** (a) "Survival" is measured as presence
   in a later mark's rows, but rows are truncated at 200 while the priced
   universe grows (313 priced vs 200 rows at the last fixture mark), so the
   hazard mixes chart truncation with death. (b) Drift buckets pool per-hour
   rates from gaps of 10-50 min in the fixture (and would pool 10-min with
   11h gaps in the final), although increments scale with sqrt(gap), not gap.
   (c) The entrant/newcomer rate is measured only from pairs with gap >= 0.5h
   and an arbitrary "rank > 80 at a" rule, then phantom sizes are drawn around
   the 5th-largest *projected mean* — never validated against the actual
   top-5 turnover it is meant to reproduce.
5. **Size component: wide but roughly centred.** v1's size score (-19.37 live)
   is close to the baseline's (-19.03) and far from the top entry's (-14.22).
   Its simulated place-cap distributions inherit the inflated sigma, then a
   [0.25, 0.5, 0.25] smoothing pass flattens them further; on the walk-forward
   it beats the baseline's sizes at the later cuts (it does capture the
   market's upward drift, which the fixed baseline cannot) but loses at the
   early cuts where its drift estimate is fitted on <= 2 marks. Candidate
   angle "size distribution too wide" is CONFIRMED; "too narrow" rejected.
6. **Incumbency prior too weak.** Fixture mature marks: at +10 min, 60% of
   top-5 slots stay with the previous top 5; the rest are jump arrivals
   (coins absent from the previous mark: unborn, unpriced, or below the
   200-row cut) — *zero* slots came from ranks 6-200 via gradual movement.
   The market moves in two channels: incumbents wobble (sd ~0.26 dex/10min
   for top-5 coins, slight negative mean) and newcomers *jump* in. v1 has no
   such structure: one Gaussian channel for everyone, with the deep tail
   (ranks 31-200, whose measured increment sd is only 0.02-0.03 — dead
   curves) assigned the same bucket drift/sd machinery as the leaders.

## v2 design (implemented in the new main.ts)

Principles: two-channel dynamics (incumbent wobble + jump arrivals), every
parameter estimated from the given history as a function of horizon, and an
output layer that reports the model's probabilities *as they are* — no
renormalisation toward 1, named mass deliberately left well below 1 so the
unnamed share stays a real hedge (target per-place unnamed share per unnamed
chart coin of roughly 0.004-0.01, the baseline's -5.27 regime or better).

1. Parse task.json + ok marks. Work in size = log10(cap_lamports) - 9.
2. Transition statistics over all ordered mark pairs (a before b):
   - Increments of coins present in both, rank <= 100 at a, normalised by
     sqrt(gap hours). Robust scale (1.4826 * MAD) gives the per-sqrt-hour
     idiosyncratic vol; band multipliers for rank bands 1-10 / 11-30 /
     31-100 (clamped to [0.7, 1.8]) and a venue multiplier for pool vs curve.
   - Leader drift: per pair, the median increment of the top-30 coins;
     pooled as a per-hour rate g (median over pairs), shrunk toward 0.
   - Place-threshold drift per place k: median over pairs of
     (size of place k at b - size of place k at a) / gap, for the size model.
   - Outsider share: per pair, the share of b's top-5 slots held by coins
     not in a's top 30 (absent or ranked > 30). Fit a saturating curve
     share(h) = S_inf * (1 - exp(-h / tau)) by grid search over
     S_inf in [0.1..0.95], tau in [0.25..12h], least squares on pair points;
     fallbacks S_inf = 0.5, tau = 2h.
3. Simulation per answer read (seeded mulberry32, 6000 draws per read):
   - Candidates: the last mark's rows plus any coin ranked <= 30 in any of
     the last 3 marks. Each candidate's future size at horizon h:
     lastSize + g * hEff + ownTrend + market + eps, where
     hEff = tau_d * (1 - exp(-h / tau_d)) with tau_d = 3h (drift saturates),
     ownTrend is the coin's OLS slope over its observations winsorised to
     ±0.4 dex/h, weighted by nObs/(nObs+8) and capped at weight 0.3,
     market ~ N(0, sigmaM * sqrt(h)) shared across coins (sigmaM = sd of the
     pairs' median increments per sqrt-hour), eps ~ N(0, sigma_i * sqrt(h)),
     sigma_i = base vol * band multiplier * venue multiplier (curve coins
     x1.4), floored at 0.08. Coins whose last observation is not in the last
     mark get sigma x1.5.
   - Jump channel: the number of phantom arrivals is drawn so that the
     simulated outsider share tracks share(h): phantoms ~
     Poisson(lambda(h)) with lambda(h) = 5 * share(h) / max(0.05, 1 -
     share(h)) capped at 8; each phantom's size = (place-5 size of the last
     mark) + thresholdDrift * hEff + N(entrantOffsetMean, entrantOffsetSd),
     where the entrant offset distribution is measured from the pairs
     (size at b of top-5 coins that were outsiders at a, minus size of
     place 5 at b); fallbacks mean 0.0, sd 0.3.
   - Rank the draw's candidates + phantoms; record place holders 1-5 and
     each place's cap.
4. Output construction (no renormalisation):
   - Coin rows: pooled win fraction per (coin, place) over all reads' draws;
     emit p >= 0.008, at most 24 rows per place, floored to 6 decimals.
     Named sums land wherever the model puts them (expected 0.5-0.85).
   - Size rows: pooled bin fraction per place; emit bins with p >= 0.002,
     floored to 6 decimals, no smoothing pass (the simulation is already
     smooth at 42k draws).
   - top5: coins ordered by pooled P(in top 5), tie-break by pooled mean
     place, then by place-1 share.
5. Fallbacks: any internal error, or fewer than 2 usable marks, or a last
   chart with < 5 coins -> emit a persistence forecast in the baseline's
   shape (0.30 / 0.10 neighbours, normal sizes sd 0.35) from whatever chart
   exists; never throw, never emit an invalid file. Deterministic: fixed
   seed, no Date/Math.random dependence in the model path.

Runtime budget: the grader allows 300s wall / 1GB. Candidates are a few
hundred; 7 reads x 6000 draws is a few million normal draws — seconds.

## Results (walk-forward on the kit fixture, same harness as the diagnosis)

| program | order | size | total | agreement/cut |
|---------|-------|------|-------|---------------|
| house baseline | -21.335 | -21.782 | -43.118 | 15.2 |
| v1 | -25.247 | -20.912 | -46.160 | 13.2 |
| **v2** | **-20.879** | **-18.576** | **-39.455** | **15.2** |

Per-cut totals (baseline / v1 / v2): cut 1: -59.169 / -61.055 / **-57.537**;
cut 2: -49.958 / -62.175 / **-49.363**; cut 3: -33.478 / -33.602 / **-26.897**;
cut 4: -29.867 / -27.807 / **-24.022**. v2 beats the baseline's total at every
cut and beats v1's total at every cut; the order component is no longer the
weak half (v2 order -20.88 vs size -18.58; v1's order was -25.25, worse than
the uniform -23.03). Agreement now ties the baseline on average (15.2/cut)
after the incumbency-anchored top5 fix (cut 3: 26 vs baseline 25; cut 4: 16 vs
17).

Mechanics verified: two runs on the kit input produce byte-identical
forecast.json (deterministic, seeded). On a synthetic final-scale input
(67 marks x 200 rows, reads at +7..+13h horizons) v2 runs in ~6s (budget
300s) and its named sums rise to 0.87-0.91 with 11-15 rows/place — i.e. the
concentration adapts to a calm regime instead of importing the fixture
frenzy's outsider rate; on the frenzy fixture itself the named sums are
0.18-0.36 at places 2-5, leaving an unnamed share of ~0.008 per unnamed chart
coin (ln ~ -4.8, the baseline's hedge regime or better).

Honest expectations for the live final: the fixture can only validate
10-50 minute horizons on a 1-hour-old market; the final scores 7-13h
horizons on an 11-hour-old market. v2's defence is that every parameter
(vol, drift, outsider share curve, entrant offsets) is re-estimated from
the final's own 11h of history at run time, with saturating horizon
functions, so nothing is hard-coded to the practice's geometry. Whether it
beats the house *model* forecast (the real prize gate alongside the
persistence baseline) is unknowable locally.

Residual risks:
- The pair estimators pool all mark pairs equally; in the final's history
  the first ~2 hours are launch frenzy and the last hours are calmer, so
  pooled vol/outsider estimates may sit above the answer window's true
  regime (biasing toward extra unnamed mass — costly if the final's top 5
  turns out stable, mildly protective if not).
- The outsider-share curve is extrapolated from in-history gaps (<= 11h) to
  the 7-13h answer horizons; the saturating form caps the error, but the
  level (S_inf) is fitted mostly by shorter gaps.
- Jump arrivals are modelled as anonymous phantoms; a riser that was
  visible in the history (nameable) but individually unpredictable gets
  only the unnamed share, by design.
- Monte Carlo noise at 8000 draws/read is ~±0.004 on a p of 0.1 — small
  versus the modelling errors above.
