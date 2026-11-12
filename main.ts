import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ==========================================
// TUNABLE CONSTANTS
// ==========================================
const DRAWS = 8000;
const SEED = 424242;
const EMIT_MIN_P = 0.008;
const MAX_ROWS_PER_PLACE = 24;
const EMIT_MIN_SIZE_P = 0.002;
const DRIFT_TAU_H = 3.0;
const TREND_MAX_WEIGHT = 0.3;
const TREND_SLOPE_CAP = 0.4;
const SIGMA_FLOOR = 0.08;
const CURVE_MULT = 1.4;
const STALE_MULT = 1.5;
const TOP5_INCUMBENT_BONUS = 0.06;
const TOP5_RANK_SHRINK = 0.4;
const MICRO = 1_000_000;

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ==========================================
// SEEDED RNG & STATISTICAL HELPERS
// ==========================================
class Mulberry32 {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let z = (this.s += 0x6d2b79f5);
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
}

function createRng(seed: number) {
  const rng = new Mulberry32(seed);
  return {
    uniform: () => rng.next(),
    normal: (mean = 0, sd = 1) => {
      let u = 0, v = 0;
      while (u === 0) u = rng.next();
      while (v === 0) v = rng.next();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return mean + z * sd;
    },
    poisson: (lam: number) => {
      if (lam <= 0) return 0;
      if (lam < 30) {
        let L = Math.exp(-lam);
        let k = 0;
        let p = 1;
        do {
          k++;
          p *= rng.next();
        } while (p > L);
        return k - 1;
      }
      const z = rng.normal(0, 1);
      return Math.max(0, Math.round(lam + Math.sqrt(lam) * z));
    }
  };
}

/** erfc(x), Numerical Recipes' erfcc (fractional error under 1.2e-7 everywhere). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const above = (x: number, mean: number, sd: number): number => (x === -Infinity ? 1 : x === Infinity ? 0 : 0.5 * erfc((x - mean) / (sd * Math.SQRT2)));

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function robustStd(arr: number[]): number {
  if (arr.length === 0) return 0.35;
  const med = median(arr);
  const absDevs = arr.map((x) => Math.abs(x - med));
  const mad = median(absDevs);
  const sd = 1.4826 * mad;
  return Number.isFinite(sd) && sd > 0 ? sd : 0.35;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

// ==========================================
// TYPES
// ==========================================
interface Row {
  rank: number;
  mint: string;
  market_cap_lamports: string | number;
  venue?: string;
  complete?: boolean;
}

interface Mark {
  at: string;
  ok: boolean;
  rows: Row[];
  timeHours: number;
}

// ==========================================
// FALLBACK EXECUTOR
// ==========================================
function writePersistenceFallback(task: any, marks: Mark[]) {
  const lastMark = marks[marks.length - 1];
  const chart = [...lastMark.rows].sort((a, b) => a.rank - b.rank);
  const sizeOf = (lamports: string | number): number => Math.log10(Number(BigInt(lamports))) - 9;
  
  const probabilities: Array<{ mint: string; place: number; p: number }> = [];
  const sizes: Array<{ place: number; bin: number; p: number }> = [];
  const edges = task.size.edges;

  for (let place = 1; place <= task.places; place++) {
    if (chart[place - 1]) probabilities.push({ mint: chart[place - 1].mint, place, p: 0.3 });
    if (place > 1 && chart[place - 2]) probabilities.push({ mint: chart[place - 2].mint, place, p: 0.1 });
    if (chart[place]) probabilities.push({ mint: chart[place].mint, place, p: 0.1 });

    if (chart[place - 1]) {
      const mean = sizeOf(chart[place - 1].market_cap_lamports);
      for (let bin = 0; bin <= edges.length; bin++) {
        const lo = bin === 0 ? -Infinity : edges[bin - 1];
        const hi = bin === edges.length ? Infinity : edges[bin];
        const u = Math.floor((above(lo, mean, 0.35) - above(hi, mean, 0.35)) * MICRO);
        if (u > 0) sizes.push({ place, bin, p: u / MICRO });
      }
    }
  }
  const top5 = chart.slice(0, task.places).map((r) => r.mint);
  writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
}

// ==========================================
// MAIN MODEL
// ==========================================
function main() {
  const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
    t0: string;
    reads: string[];
    places: number;
    chart_size: number;
    output: string;
    size: { edges: number[] };
  };

  const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '');
  const t0Time = new Date(task.t0).getTime();

  const marks: Mark[] = [];
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (m.ok && Array.isArray(m.rows)) {
        const atTime = new Date(m.at).getTime();
        const timeHours = (atTime - t0Time) / 3600000;
        const sortedRows = [...m.rows].sort((a, b) => a.rank - b.rank);
        marks.push({ at: m.at, ok: true, rows: sortedRows, timeHours });
      }
    } catch {}
  }

  if (marks.length < 2) {
    writePersistenceFallback(task, marks);
    return;
  }

  const lastMark = marks[marks.length - 1];
  if (!lastMark || lastMark.rows.length < task.places) {
    writePersistenceFallback(task, marks);
    return;
  }

  const sizeOf = (lamports: string | number): number => Math.log10(Number(BigInt(lamports))) - 9;

  // 1. Pair Statistics over ALL ordered pairs (a before b)
  const normIncrements: number[] = [];
  const bandInc1_10: number[] = [];
  const bandInc11_30: number[] = [];
  const bandInc31_100: number[] = [];
  const venuePoolInc: number[] = [];
  const venueCurveInc: number[] = [];
  const leaderMedianRates: number[] = [];
  const marketSigmaPoints: number[] = [];
  const thresholdDrifts: number[][] = Array.from({ length: task.places + 1 }, () => []);
  const outsiderSharePoints: Array<{ gapH: number; share: number }> = [];
  const entrantOffsets: number[] = [];

  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const ma = marks[i]!;
      const mb = marks[j]!;
      const gapH = mb.timeHours - ma.timeHours;
      if (gapH <= 0) continue;
      const sqrtGap = Math.sqrt(gapH);

      const mapA = new Map<string, Row>();
      for (const r of ma.rows) mapA.set(r.mint, r);
      const mapB = new Map<string, Row>();
      for (const r of mb.rows) mapB.set(r.mint, r);

      // Top 30 set at a
      const top30MintsA = new Set<string>();
      for (const r of ma.rows) {
        if (r.rank <= 30) top30MintsA.add(r.mint);
      }

      const pairIncrementsTop30: number[] = [];
      for (const rB of mb.rows) {
        const rA = mapA.get(rB.mint);
        if (rA && rA.rank <= 100) {
          const szA = sizeOf(rA.market_cap_lamports);
          const szB = sizeOf(rB.market_cap_lamports);
          const d = szB - szA;
          const nd = d / sqrtGap;
          normIncrements.push(nd);

          if (rA.rank <= 10) bandInc1_10.push(nd);
          else if (rA.rank <= 30) bandInc11_30.push(nd);
          else bandInc31_100.push(nd);

          const venue = rA.venue ?? 'curve';
          if (venue === 'pool') venuePoolInc.push(nd);
          else venueCurveInc.push(nd);

          if (rA.rank <= 30) {
            pairIncrementsTop30.push(d / gapH);
          }
        }
      }

      if (pairIncrementsTop30.length > 0) {
        const medRate = median(pairIncrementsTop30);
        leaderMedianRates.push(medRate);
        marketSigmaPoints.push(medRate * sqrtGap); // approximate per sqrt-hour
      }

      // Place threshold drift
      for (let k = 1; k <= task.places; k++) {
        const rowAk = ma.rows[k - 1];
        const rowBk = mb.rows[k - 1];
        if (rowAk && rowBk) {
          const szAk = sizeOf(rowAk.market_cap_lamports);
          const szBk = sizeOf(rowBk.market_cap_lamports);
          thresholdDrifts[k]!.push((szBk - szAk) / gapH);
        }
      }

      // Outsider share in top 5 at b
      let top5Outsiders = 0;
      const top5B = mb.rows.slice(0, 5);
      for (const rB of top5B) {
        if (!top30MintsA.has(rB.mint)) {
          top5Outsiders++;
        }
      }
      const share = top5B.length > 0 ? top5Outsiders / top5B.length : 0;
      outsiderSharePoints.push({ gapH, share });

      // Entrant offsets
      const place5Bk = mb.rows[4];
      const sz5B = place5Bk ? sizeOf(place5Bk.market_cap_lamports) : 0;
      for (const rB of top5B) {
        if (!top30MintsA.has(rB.mint)) {
          const szB = sizeOf(rB.market_cap_lamports);
          entrantOffsets.push(szB - sz5B);
        }
      }
    }
  }

  const baseSigma = robustStd(normIncrements);
  const sd1_10 = robustStd(bandInc1_10);
  const sd11_30 = robustStd(bandInc11_30);
  const sd31_100 = robustStd(bandInc31_100);

  const bandMult = (rank: number): number => {
    if (rank <= 10) return clamp(bandInc1_10.length >= 20 ? sd1_10 / baseSigma : 1.0, 0.7, 1.8);
    if (rank <= 30) return clamp(bandInc11_30.length >= 20 ? sd11_30 / baseSigma : 1.0, 0.7, 1.8);
    return clamp(bandInc31_100.length >= 20 ? sd31_100 / baseSigma : 1.0, 0.7, 1.8);
  };

  const sdPool = robustStd(venuePoolInc);
  const sdCurve = robustStd(venueCurveInc);
  const venueMult = clamp(venuePoolInc.length >= 20 && venueCurveInc.length >= 20 ? sdCurve / sdPool : 1.0, 0.7, 1.6);

  let g = median(leaderMedianRates) * 0.5;
  g = clamp(g, -0.1, 0.1);

  const placeDrift: number[] = [];
  for (let k = 1; k <= task.places; k++) {
    placeDrift[k] = clamp(median(thresholdDrifts[k]!), -0.1, 0.15);
  }

  // Fit outsider share share(h) = Sinf * (1 - exp(-h / tau))
  let bestSinf = 0.5;
  let bestTau = 2.0;
  let bestErr = Infinity;
  const sinfGrid = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
  const tauGrid = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12];

  for (const Sinf of sinfGrid) {
    for (const tau of tauGrid) {
      let err = 0;
      for (const pt of outsiderSharePoints) {
        const pred = Sinf * (1 - Math.exp(-pt.gapH / tau));
        const diff = pred - pt.share;
        err += diff * diff;
      }
      if (err < bestErr) {
        bestErr = err;
        bestSinf = Sinf;
        bestTau = tau;
      }
    }
  }
  const fitShare = (h: number) => bestSinf * (1 - Math.exp(-h / bestTau));

  const entrantOffsetMean = median(entrantOffsets);
  const entrantOffsetSd = clamp(robustStd(entrantOffsets), 0.1, 0.8);

  const sigmaM = clamp(robustStd(marketSigmaPoints), 0.02, 0.5);

  // 2. Candidates
  const candidateMap = new Map<string, {
    mint: string;
    lastSize: number;
    lastRank: number;
    venue: string;
    complete: boolean;
    obs: Array<{ timeHours: number; size: number }>;
    inLastMark: boolean;
  }>();

  // Add all mints from last mark
  for (const r of lastMark.rows) {
    candidateMap.set(r.mint, {
      mint: r.mint,
      lastSize: sizeOf(r.market_cap_lamports),
      lastRank: r.rank,
      venue: r.venue ?? 'curve',
      complete: r.complete ?? false,
      obs: [{ timeHours: lastMark.timeHours, size: sizeOf(r.market_cap_lamports) }],
      inLastMark: true
    });
  }

  // Add mints ranked <= 30 in either of the two marks before last
  const recentMarks = marks.slice(Math.max(0, marks.length - 3), marks.length - 1);
  for (const m of recentMarks) {
    for (const r of m.rows) {
      if (r.rank <= 30) {
        let cand = candidateMap.get(r.mint);
        if (!cand) {
          cand = {
            mint: r.mint,
            lastSize: sizeOf(r.market_cap_lamports),
            lastRank: r.rank,
            venue: r.venue ?? 'curve',
            complete: r.complete ?? false,
            obs: [],
            inLastMark: false
          };
          candidateMap.set(r.mint, cand);
        }
        cand.obs.push({ timeHours: m.timeHours, size: sizeOf(r.market_cap_lamports) });
      }
    }
  }

  // Populate all historical observations for candidates from all marks
  for (const m of marks) {
    for (const r of m.rows) {
      const cand = candidateMap.get(r.mint);
      if (cand) {
        // Check if observation already exists for this timeHours
        if (!cand.obs.some((o) => Math.abs(o.timeHours - m.timeHours) < 1e-5)) {
          cand.obs.push({ timeHours: m.timeHours, size: sizeOf(r.market_cap_lamports) });
        }
      }
    }
  }

  // Precompute trend for each candidate
  const candidateProcessed = Array.from(candidateMap.values()).map((cand) => {
    cand.obs.sort((a, b) => a.timeHours - b.timeHours);
    let trend = 0;
    const nObs = cand.obs.length;
    if (nObs >= 2) {
      let sumT = 0, sumS = 0, sumTS = 0, sumTT = 0;
      for (const o of cand.obs) {
        sumT += o.timeHours;
        sumS += o.size;
        sumTS += o.timeHours * o.size;
        sumTT += o.timeHours * o.timeHours;
      }
      const denom = nObs * sumTT - sumT * sumT;
      if (Math.abs(denom) > 1e-9) {
        const rawSlope = (nObs * sumTS - sumT * sumS) / denom;
        trend = clamp(rawSlope, -TREND_SLOPE_CAP, TREND_SLOPE_CAP);
      }
    }
    const weight = Math.min(TREND_MAX_WEIGHT, nObs / (nObs + 8));
    const sigma_i = Math.max(
      SIGMA_FLOOR,
      baseSigma * bandMult(cand.lastRank) * venueMult * (cand.venue !== 'pool' ? CURVE_MULT : 1) * (cand.inLastMark ? 1 : STALE_MULT)
    );
    return { ...cand, trend, weight, sigma_i, nObs };
  });

  const lastPlace5Row = lastMark.rows[4] ?? lastMark.rows[lastMark.rows.length - 1];
  const lastPlace5Size = lastPlace5Row ? sizeOf(lastPlace5Row.market_cap_lamports) : 0;
  const edges = task.size.edges;

  // Aggregators for output
  // winCounts[place][mint] = count
  const winCounts: Array<Map<string, number>> = Array.from({ length: task.places + 1 }, () => new Map());
  // top5Counts.set(mint, count)
  const top5Counts = new Map<string, number>();
  const totalPlaceSums: Array<number[]> = Array.from({ length: task.places + 1 }, () => Array(edges.length + 1).fill(0));
  const totalDraws = task.reads.length * DRAWS;

  const rng = createRng(SEED);

  // 3. Simulation per read
  for (const readStr of task.reads) {
    const readTime = new Date(readStr).getTime();
    const h = Math.max(0.05, (readTime - new Date(lastMark.at).getTime()) / 3600000);
    const hEff = DRIFT_TAU_H * (1 - Math.exp(-h / DRIFT_TAU_H));
    const shareVal = fitShare(h);
    const lambda = Math.min(8, (5 * shareVal) / Math.max(0.05, 1 - shareVal));

    for (let d = 0; d < DRAWS; d++) {
      const market = rng.normal(0, sigmaM * Math.sqrt(h));
      const simulatedDraws: Array<{ mint: string | null; size: number; isPhantom: boolean }> = [];

      for (const cand of candidateProcessed) {
        const mu = cand.lastSize + g * hEff + cand.weight * cand.trend * hEff;
        const sizeDraw = mu + market + rng.normal(0, cand.sigma_i * Math.sqrt(h));
        simulatedDraws.push({ mint: cand.mint, size: sizeDraw, isPhantom: false });
      }

      // Phantoms
      const phantomCount = rng.poisson(lambda);
      for (let p = 0; p < phantomCount; p++) {
        const phantomSize = lastPlace5Size + (placeDrift[5] ?? 0) * hEff + rng.normal(entrantOffsetMean, entrantOffsetSd);
        simulatedDraws.push({ mint: null, size: phantomSize, isPhantom: true });
      }

      simulatedDraws.sort((a, b) => b.size - a.size);

      const top5MintsInDraw = new Set<string>();
      for (let place = 1; place <= task.places; place++) {
        const drawItem = simulatedDraws[place - 1];
        if (!drawItem) break;

        if (!drawItem.isPhantom && drawItem.mint) {
          const map = winCounts[place]!;
          map.set(drawItem.mint, (map.get(drawItem.mint) ?? 0) + 1);
          if (place <= 5) top5MintsInDraw.add(drawItem.mint);
        }

        // Size histogram
        const sz = drawItem.size;
        let bin = 0;
        while (bin < edges.length && sz >= edges[bin]!) {
          bin++;
        }
        totalPlaceSums[place]![bin]!++;
      }

      for (const m of top5MintsInDraw) {
        top5Counts.set(m, (top5Counts.get(m) ?? 0) + 1);
      }
    }
  }

  // 4. Output Construction
  const probabilities: Array<{ mint: string; place: number; p: number }> = [];
  for (let place = 1; place <= task.places; place++) {
    const map = winCounts[place]!;
    const placeRows: Array<{ mint: string; p: number }> = [];
    for (const [mint, count] of map.entries()) {
      const p = count / totalDraws;
      if (p >= EMIT_MIN_P) {
        placeRows.push({ mint, p });
      }
    }
    placeRows.sort((a, b) => b.p - a.p);
    const topRows = placeRows.slice(0, MAX_ROWS_PER_PLACE);
    for (const r of topRows) {
      probabilities.push({ mint: r.mint, place, p: Number(r.p.toFixed(6)) });
    }
  }

  const sizes: Array<{ place: number; bin: number; p: number }> = [];
  for (let place = 1; place <= task.places; place++) {
    const bins = totalPlaceSums[place]!;
    for (let bin = 0; bin <= edges.length; bin++) {
      const count = bins[bin] ?? 0;
      const p = count / totalDraws;
      if (p >= EMIT_MIN_SIZE_P) {
        sizes.push({ place, bin, p: Number(p.toFixed(6)) });
      }
    }
  }

  // Compute mean place and place-1 share for candidate ranking
  const meanPlaceMap = new Map<string, number>();
  const place1ShareMap = new Map<string, number>();
  for (let place = 1; place <= task.places; place++) {
    const map = winCounts[place]!;
    for (const [mint, count] of map.entries()) {
      const p = count / totalDraws;
      meanPlaceMap.set(mint, (meanPlaceMap.get(mint) ?? 0) + place * p);
      if (place === 1) place1ShareMap.set(mint, p);
    }
  }

  // Last mark top 5 rank map
  const lastMarkTop5Set = new Set<string>();
  const lastMarkRankMap = new Map<string, number>();
  for (const r of lastMark.rows) {
    lastMarkRankMap.set(r.mint, r.rank);
    if (r.rank <= 5) lastMarkTop5Set.add(r.mint);
  }

  const allCandidateMints = Array.from(new Set([...top5Counts.keys(), ...lastMarkTop5Set]));

  // Selection score: pooled P(in top 5) + incumbent bonus if in last mark top 5
  const scoredCandidates = allCandidateMints.map((mint) => {
    const pTop5 = (top5Counts.get(mint) ?? 0) / totalDraws;
    const isIncumbent = lastMarkTop5Set.has(mint) ? 1 : 0;
    const score = pTop5 + isIncumbent * TOP5_INCUMBENT_BONUS;
    return { mint, score };
  });

  scoredCandidates.sort((a, b) => b.score - a.score);
  const selectedTop5 = scoredCandidates.slice(0, task.places).map((c) => c.mint);

  // Pad from last mark if fewer than 5
  for (const r of lastMark.rows) {
    if (selectedTop5.length < task.places && !selectedTop5.includes(r.mint)) {
      selectedTop5.push(r.mint);
    }
  }

  // Ordering of selected 5 by adjusted place = 0.6 * win-weighted mean place + 0.4 * min(lastMarkRank, 8)
  selectedTop5.sort((a, b) => {
    const winMeanPlaceA = (meanPlaceMap.get(a) ?? (task.places + 1));
    const winMeanPlaceB = (meanPlaceMap.get(b) ?? (task.places + 1));
    const rankA = lastMarkRankMap.get(a) ?? 8;
    const rankB = lastMarkRankMap.get(b) ?? 8;
    const adjA = 0.6 * winMeanPlaceA + 0.4 * Math.min(rankA, 8);
    const adjB = 0.6 * winMeanPlaceB + 0.4 * Math.min(rankB, 8);
    if (Math.abs(adjA - adjB) > 1e-5) return adjA - adjB;
    return a.localeCompare(b);
  });

  const top5: string[] = selectedTop5;

  writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
}

try {
  main();
} catch (err) {
  try {
    const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8'));
    const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '');
    const marks = lines.map((l) => JSON.parse(l)).filter((m: any) => m.ok && Array.isArray(m.rows));
    writePersistenceFallback(task, marks);
  } catch {
    // Ultimate fallback if even task.json fails to read
  }
}
