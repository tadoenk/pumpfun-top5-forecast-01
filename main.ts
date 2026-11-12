// pumpfun-top5-forecast-01 entry: Self-calibrating Monte Carlo forecaster.
// Model: Learns per-hour drift, increment SD, survival hazard, and newcomer arrival rates
// from historical mark pairs. Projects future coin market caps with damped drift, death hazard,
// and horizon-proportional spread (sigma = sqrt((sdCoin * sqrt(h))^2 + 0.02 * h)),
// simulates phantom newcomers for unobserved future coins, and draws 4000 Monte Carlo trajectories
// per answer read. Unnamed probability mass is left on purpose to capture newcomers and unexpected shifts.
// Seed: 424242

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DRAWS = 4000;
const SEED = 424242;

// Mulberry32 PRNG
function mulberry32(seed: number) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t ^ Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
let spareRandom: number | null = null;
function randomNormal(mean = 0, stdDev = 1): number {
  if (spareRandom !== null) {
    const val = spareRandom;
    spareRandom = null;
    return mean + stdDev * val;
  }
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  spareRandom = Math.sqrt(-2.0 * Math.log(u)) * Math.sin(2.0 * Math.PI * v);
  return mean + stdDev * num;
}

interface MarkRow {
  rank: number;
  mint: string;
  market_cap_lamports: string;
  venue: string;
  slot: number;
  name: string;
  symbol: string;
  created_at: string;
  complete: boolean;
  mayhem: boolean;
  quote_reserves_lamports: string;
}

interface Mark {
  schema: string;
  at: string;
  ok: boolean;
  error: string | null;
  kind: string;
  t0: string;
  counts: any;
  rows: MarkRow[];
}

interface Task {
  schema: string;
  competition: string;
  t0: string;
  history_until: string;
  window: { deadline: string; answer_at: string };
  reads: string[];
  places: number;
  chart_size: number;
  size: { edges: number[] };
  cadence_minutes: number;
  output: string;
  marks: number;
}

function main() {
  const taskPath = join(INPUT_DIR, 'task.json');
  const historyPath = join(INPUT_DIR, 'history.ndjson');

  const task: Task = JSON.parse(readFileSync(taskPath, 'utf-8'));
  const historyRaw = readFileSync(historyPath, 'utf-8');
  const marks: Mark[] = historyRaw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
    .filter(m => m.ok && Array.isArray(m.rows));

  if (marks.length === 0) {
    throw new Error('No valid marks found in history.ndjson');
  }

  const firstMarkTime = new Date(marks[0].at).getTime();

  // 1. Build Series and Observations per mint
  // Observations: { timeHours, size, venue, complete, mayhem, created_at, rank }
  const mintObservations = new Map<string, Array<{
    timeHours: number;
    size: number;
    venue: string;
    complete: boolean;
    mayhem: boolean;
    created_at: string;
    rank: number;
  }>>();

  // Latest metadata per mint
  const mintLatestMeta = new Map<string, {
    venue: string;
    complete: boolean;
    mayhem: boolean;
    created_at: string;
  }>();

  for (const m of marks) {
    const timeHours = (new Date(m.at).getTime() - firstMarkTime) / 3600000;
    for (const row of m.rows) {
      const lamports = BigInt(row.market_cap_lamports);
      const size = Math.log10(Number(lamports)) - 9;
      if (!mintObservations.has(row.mint)) {
        mintObservations.set(row.mint, []);
      }
      mintObservations.get(row.mint)!.push({
        timeHours,
        size,
        venue: row.venue,
        complete: row.complete,
        mayhem: row.mayhem,
        created_at: row.created_at,
        rank: row.rank
      });
      mintLatestMeta.set(row.mint, {
        venue: row.venue,
        complete: row.complete,
        mayhem: row.mayhem,
        created_at: row.created_at
      });
    }
  }

  // Candidates: every mint in the last mark's rows, plus any mint ranked <= 30 in either of the two marks before the last.
  const candidateMints = new Set<string>();
  const lastMark = marks[marks.length - 1];
  for (const row of lastMark.rows) {
    candidateMints.add(row.mint);
  }
  for (let i = Math.max(0, marks.length - 2); i < marks.length; i++) {
    for (const row of marks[i].rows) {
      if (row.rank <= 30) {
        candidateMints.add(row.mint);
      }
    }
  }

  // 2. Self-calibration over all ordered mark pairs (a before b)
  // Buckets for drift & SD: venue at a ('pool' vs 'not_pool') x size at a (above vs below median of top 100)
  const driftBuckets: { [key: string]: number[] } = {};
  const hazardBuckets: { [key: string]: { total: number; survived: number } } = {
    pool: { total: 0, survived: 0 },
    not_pool: { total: 0, survived: 0 }
  };

  let entrantCountsPerGapHour: number[] = [];
  let entrantSizeDiffs: number[] = [];

  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const ma = marks[i];
      const mb = marks[j];
      const gapHours = (new Date(mb.at).getTime() - new Date(ma.at).getTime()) / 3600000;
      if (gapHours <= 0) continue;

      const top100A = ma.rows.filter(r => r.rank <= 100);
      if (top100A.length === 0) continue;
      const sizesA = top100A.map(r => Math.log10(Number(BigInt(r.market_cap_lamports))) - 9).sort((x, y) => x - y);
      const medianSizeA = sizesA[Math.floor(sizesA.length / 2)];

      const mapA = new Map<string, MarkRow>();
      for (const r of ma.rows) mapA.set(r.mint, r);

      const mapB = new Map<string, MarkRow>();
      for (const r of mb.rows) mapB.set(r.mint, r);

      // Drift & SD from coins in both with rank <= 100 at a
      for (const ra of top100A) {
        const rb = mapB.get(ra.mint);
        if (rb) {
          const sizeA = Math.log10(Number(BigInt(ra.market_cap_lamports))) - 9;
          const sizeB = Math.log10(Number(BigInt(rb.market_cap_lamports))) - 9;
          const rate = (sizeB - sizeA) / gapHours;
          const venueCat = (ra.venue === 'pool') ? 'pool' : 'not_pool';
          const sizeCat = (sizeA >= medianSizeA) ? 'above' : 'below';
          const key = `${venueCat}_${sizeCat}`;
          if (!driftBuckets[key]) driftBuckets[key] = [];
          driftBuckets[key].push(rate);
        }
      }

      // Survival from top 20 of a
      const top20A = ma.rows.filter(r => r.rank <= 20);
      for (const ra of top20A) {
        const venueCat = (ra.venue === 'pool') ? 'pool' : 'not_pool';
        hazardBuckets[venueCat].total++;
        if (mapB.has(ra.mint)) {
          hazardBuckets[venueCat].survived++;
        }
      }

      // Newcomers for pairs with gap >= 0.5 hours
      if (gapHours >= 0.5) {
        const top5B = mb.rows.filter(r => r.rank <= 5);
        let newcomersCount = 0;
        const bSizes = mb.rows.map(r => Math.log10(Number(BigInt(r.market_cap_lamports))) - 9).sort((x, y) => y - x);
        const fifthSizeB = bSizes.length >= 5 ? bSizes[4] : (bSizes[bSizes.length - 1] ?? 0);

        for (const rb of top5B) {
          const ra = mapA.get(rb.mint);
          if (!ra || ra.rank > 80) {
            newcomersCount++;
            const sizeB = Math.log10(Number(BigInt(rb.market_cap_lamports))) - 9;
            entrantSizeDiffs.push(sizeB - fifthSizeB);
          }
        }
        entrantCountsPerGapHour.push(newcomersCount / gapHours);
      }
    }
  }

  // Compute stats with fallbacks
  const driftStats: { [key: string]: { mean: number; sd: number } } = {};
  const defaultDriftMean = 0;
  const defaultDriftSd = 0.5;

  const bucketsList = ['pool_above', 'pool_below', 'not_pool_above', 'not_pool_below'];
  for (const b of bucketsList) {
    const arr = driftBuckets[b];
    if (arr && arr.length > 5) {
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length;
      let sd = Math.sqrt(variance);
      sd = Math.max(0.12, Math.min(1.2, sd));
      driftStats[b] = { mean, sd };
    } else {
      driftStats[b] = { mean: defaultDriftMean, sd: defaultDriftSd };
    }
  }

  // Hazards
  const hazardLambdas: { [key: string]: number } = {};
  for (const venueCat of ['pool', 'not_pool']) {
    const h = hazardBuckets[venueCat];
    if (h.total > 0 && h.survived > 0) {
      const share = h.survived / h.total;
      // Approximate average gap over history pairs or use 1 hour
      let lambda = -Math.log(Math.max(0.0001, Math.min(1.0, share))) / 1.0;
      lambda = Math.max(0.005, Math.min(0.6, lambda));
      hazardLambdas[venueCat] = lambda;
    } else {
      hazardLambdas[venueCat] = venueCat === 'pool' ? 0.02 : 0.08;
    }
  }

  // Newcomer stats
  let entrantsPerHour = 0.3;
  if (entrantCountsPerGapHour.length > 0) {
    entrantsPerHour = entrantCountsPerGapHour.reduce((a, b) => a + b, 0) / entrantCountsPerGapHour.length;
  }

  let entrantDiffMean = -0.05;
  let entrantDiffSd = 0.35;
  if (entrantSizeDiffs.length > 5) {
    entrantDiffMean = entrantSizeDiffs.reduce((a, b) => a + b, 0) / entrantSizeDiffs.length;
    const variance = entrantSizeDiffs.reduce((s, v) => s + Math.pow(v - entrantDiffMean, 2), 0) / entrantSizeDiffs.length;
    entrantDiffSd = Math.max(0.1, Math.min(1.0, Math.sqrt(variance)));
  }

  // 3. Simulation per read
  const lastMarkTimeHours = mintObservations.size > 0 ? Math.max(...Array.from(mintObservations.values()).flatMap(obs => obs.map(o => o.timeHours))) : 0;
  const edges = task.size.edges;
  const numBins = edges.length + 1; // 82 bins: 0 to 81

  // Aggregation containers
  // placeWinCounts[place (1..5)][mint] = count
  const placeWinCounts: Array<Map<string, number>> = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
  // placeTop5Wins[mint] = total wins across places 1..5
  const mintTop5TotalWins = new Map<string, number>();
  // mintPlaceSum[mint] = sum of (win_place * place) for weighted mean place calculation
  const mintPlaceSum = new Map<string, number>();
  const mintPlace1Wins = new Map<string, number>();

  // sizeBinCounts[place (1..5)][bin (0..81)] = count
  const sizeBinCounts: Array<number[]> = Array.from({ length: 6 }, () => Array(numBins).fill(0));

  const totalReads = task.reads.length;
  const totalSims = totalReads * DRAWS;

  for (const readTimeStr of task.reads) {
    const readTime = new Date(readTimeStr).getTime();
    let h = (readTime - (firstMarkTime + lastMarkTimeHours * 3600000)) / 3600000;
    if (h < 0.05) h = 0.05;

    // We simulate DRAWS times for this read
    for (let draw = 0; draw < DRAWS; draw++) {
      const candidateDraws: Array<{ mint: string; size: number; isPhantom: boolean }> = [];

      // Median size of last mark top 100 for bucketing
      const lastTop100Sizes = lastMark.rows.filter(r => r.rank <= 100).map(r => Math.log10(Number(BigInt(r.market_cap_lamports))) - 9).sort((x, y) => x - y);
      const medianLastSize = lastTop100Sizes.length > 0 ? lastTop100Sizes[Math.floor(lastTop100Sizes.length / 2)] : 3;

      // Project each candidate
      for (const mint of candidateMints) {
        const obs = mintObservations.get(mint);
        if (!obs || obs.length === 0) continue;
        const lastObs = obs[obs.length - 1];

        // Venue category and size category
        const venueCat = (lastObs.venue === 'pool') ? 'pool' : 'not_pool';
        const sizeCat = (lastObs.size >= medianLastSize) ? 'above' : 'below';
        const bucketKey = `${venueCat}_${sizeCat}`;
        const driftStat = driftStats[bucketKey] || { mean: defaultDriftMean, sd: defaultDriftSd };
        const lambda = hazardLambdas[venueCat] ?? 0.05;

        // Death check
        const survivalProb = Math.exp(-lambda * h);
        if (rng() >= survivalProb) {
          continue; // dead in this draw
        }

        // Slope from last up to 4 observations
        const recentObs = obs.slice(-4);
        let slope = 0;
        if (recentObs.length >= 2) {
          let totalDt = 0;
          let totalDs = 0;
          for (let k = 1; k < recentObs.length; k++) {
            const dt = recentObs[k].timeHours - recentObs[k - 1].timeHours;
            const ds = recentObs[k].size - recentObs[k - 1].size;
            if (dt > 0) {
              totalDt += dt;
              totalDs += ds;
            }
          }
          if (totalDt > 0) {
            const rawSlope = totalDs / totalDt;
            slope = 0.5 * rawSlope + 0.5 * driftStat.mean;
            slope = Math.max(-2, Math.min(2, slope));
          }
        } else {
          slope = driftStat.mean;
        }

        const he = 6 * (1 - Math.exp(-h / 6));
        const mu = lastObs.size + slope * he;

        // Spread sdCoin
        let sdCoin = driftStat.sd;
        if (recentObs.length >= 4) {
          const increments: number[] = [];
          for (let k = 1; k < recentObs.length; k++) {
            const dt = recentObs[k].timeHours - recentObs[k - 1].timeHours;
            const ds = recentObs[k].size - recentObs[k - 1].size;
            if (dt > 0) increments.push(ds / Math.sqrt(dt));
          }
          if (increments.length >= 3) {
            const incMean = increments.reduce((a, b) => a + b, 0) / increments.length;
            const incVar = increments.reduce((a, b) => a + Math.pow(b - incMean, 2), 0) / increments.length;
            sdCoin = Math.sqrt(incVar);
          }
        }

        let sigma = Math.sqrt(Math.pow(sdCoin * Math.sqrt(h), 2) + 0.02 * h);
        sigma = Math.max(0.25, Math.min(2.5, sigma));

        const sizeDraw = randomNormal(mu, sigma);
        candidateDraws.push({ mint, size: sizeDraw, isPhantom: false });
      }

      // Phantom newcomers
      const expectedEntrants = entrantsPerHour * h;
      const numPhantoms = Math.max(0, Math.min(10, Math.round(expectedEntrants + (rng() < (expectedEntrants % 1) ? 1 : 0))));

      if (numPhantoms > 0 && candidateDraws.length > 0) {
        const sortedMus = candidateDraws.map(c => {
          const obs = mintObservations.get(c.mint)!;
          const last = obs[obs.length - 1];
          return last.size;
        }).sort((x, y) => y - x);

        const fifthMu = sortedMus.length >= 5 ? sortedMus[4] : sortedMus[sortedMus.length - 1] - 0.3;
        const maxMu = sortedMus[0];

        for (let p = 0; p < numPhantoms; p++) {
          let phantomSize = fifthMu + randomNormal(entrantDiffMean, entrantDiffSd);
          if (phantomSize > maxMu + 0.3) phantomSize = maxMu + 0.3;
          candidateDraws.push({ mint: `phantom_${draw}_${p}`, size: phantomSize, isPhantom: true });
        }
      }

      // Sort candidates by size descending
      candidateDraws.sort((a, b) => b.size - a.size);

      // Record places 1..5
      const top5Draw = candidateDraws.slice(0, 5);
      for (let pIdx = 0; pIdx < top5Draw.length; pIdx++) {
        const place = pIdx + 1;
        const holder = top5Draw[pIdx];
        const sizeVal = holder.size;

        // Size bin
        let bin = 0;
        if (sizeVal < edges[0]) {
          bin = 0;
        } else if (sizeVal >= edges[edges.length - 1]) {
          bin = edges.length; // 81
        } else {
          for (let b = 1; b < edges.length; b++) {
            if (sizeVal >= edges[b - 1] && sizeVal < edges[b]) {
              bin = b;
              break;
            }
          }
        }
        sizeBinCounts[place][bin]++;

        if (!holder.isPhantom) {
          const m = holder.mint;
          const map = placeWinCounts[place];
          map.set(m, (map.get(m) || 0) + 1);

          mintTop5TotalWins.set(m, (mintTop5TotalWins.get(m) || 0) + 1);
          mintPlaceSum.set(m, (mintPlaceSum.get(m) || 0) + place);
          if (place === 1) {
            mintPlace1Wins.set(m, (mintPlace1Wins.get(m) || 0) + 1);
          }
        }
      }
    }
  }

  // 4. Build probabilities output
  // probabilities: place probability of a mint = its wins / totalSims
  // Emit mints with p >= 0.002, at most 60 per place, floored to 6 decimals, sum cap 0.995.
  const probabilities: Array<{ mint: string; place: number; p: number }> = [];

  for (let place = 1; place <= 5; place++) {
    const map = placeWinCounts[place];
    const placeRows: Array<{ mint: string; p: number }> = [];
    for (const [mint, wins] of map.entries()) {
      const pRaw = wins / totalSims;
      if (pRaw >= 0.002) {
        placeRows.push({ mint, p: pRaw });
      }
    }
    // Sort by p descending, then mint ascending
    placeRows.sort((a, b) => b.p - a.p || a.mint.localeCompare(b.mint));
    const topRows = placeRows.slice(0, 60);

    // Floor and cap at 0.995 sum
    let sum = 0;
    const flooredRows = topRows.map(r => {
      const pFloor = Math.floor(r.p * 1e6) / 1e6;
      sum += pFloor;
      return { mint: r.mint, p: pFloor };
    });

    if (sum > 0.995) {
      const scale = 0.995 / sum;
      sum = 0;
      for (const r of flooredRows) {
        r.p = Math.floor((r.p * scale) * 1e6) / 1e6;
        sum += r.p;
      }
    }

    for (const r of flooredRows) {
      if (r.p > 0) {
        probabilities.push({ mint: r.mint, place, p: r.p });
      }
    }
  }

  // Sort probabilities by place then p descending then mint
  probabilities.sort((a, b) => a.place - b.place || b.p - a.p || a.mint.localeCompare(b.mint));

  // 5. Build sizes output
  // bin frequency per place, smoothed once with kernel [0.25, 0.5, 0.25], emit p >= 0.0015, floored to 6 decimals, sum cap 0.995.
  const sizes: Array<{ place: number; bin: number; p: number }> = [];

  for (let place = 1; place <= 5; place++) {
    const rawCounts = sizeBinCounts[place];
    const rawProbs = rawCounts.map(c => c / totalSims);

    // Smooth once with [0.25, 0.5, 0.25]
    const smoothed = Array(numBins).fill(0);
    for (let i = 0; i < numBins; i++) {
      const prev = i > 0 ? rawProbs[i - 1] : 0;
      const curr = rawProbs[i];
      const next = i < numBins - 1 ? rawProbs[i + 1] : 0;
      smoothed[i] = 0.25 * prev + 0.5 * curr + 0.25 * next;
    }

    const binRows: Array<{ bin: number; p: number }> = [];
    for (let b = 0; b < numBins; b++) {
      if (smoothed[b] >= 0.0015) {
        binRows.push({ bin: b, p: smoothed[b] });
      }
    }

    let sum = 0;
    const flooredBins = binRows.map(r => {
      const pFloor = Math.floor(r.p * 1e6) / 1e6;
      sum += pFloor;
      return { bin: r.bin, p: pFloor };
    });

    if (sum > 0.995) {
      const scale = 0.995 / sum;
      sum = 0;
      for (const r of flooredBins) {
        r.p = Math.floor((r.p * scale) * 1e6) / 1e6;
        sum += r.p;
      }
    }

    for (const r of flooredBins) {
      if (r.p > 0) {
        sizes.push({ place, bin: r.bin, p: r.p });
      }
    }
  }

  sizes.sort((a, b) => a.place - b.place || a.bin - b.bin);

  // 6. Build top5
  // top5: 5 mints with highest total top-5 win share; order by win-weighted mean place, tie-break by place-1 share then total share then mint ascending.
  const mintList = Array.from(mintTop5TotalWins.keys());
  mintList.sort((m1, m2) => {
    const wins1 = mintTop5TotalWins.get(m1)!;
    const wins2 = mintTop5TotalWins.get(m2)!;

    const meanPlace1 = mintPlaceSum.get(m1)! / wins1;
    const meanPlace2 = mintPlaceSum.get(m2)! / wins2;

    if (Math.abs(meanPlace1 - meanPlace2) > 1e-6) {
      return meanPlace1 - meanPlace2; // lower mean place first
    }

    const p1_1 = mintPlace1Wins.get(m1) || 0;
    const p1_2 = mintPlace1Wins.get(m2) || 0;
    if (p1_1 !== p1_2) {
      return p1_2 - p1_1; // higher place-1 wins first
    }

    if (wins1 !== wins2) {
      return wins2 - wins1; // higher total wins first
    }

    return m1.localeCompare(m2);
  });

  const top5 = mintList.slice(0, 5);
  // Ensure we have exactly 5 if available, pad from lastMark top 5 if fewer
  if (top5.length < 5) {
    for (const r of lastMark.rows) {
      if (!top5.includes(r.mint)) {
        top5.push(r.mint);
        if (top5.length === 5) break;
      }
    }
  }

  const outputObj = {
    probabilities,
    top5,
    sizes
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = join(OUTPUT_DIR, task.output);
  writeFileSync(outputPath, JSON.stringify(outputObj) + '\n', 'utf-8');
}

main();
