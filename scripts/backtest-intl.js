/* ============================================================
 * scripts/backtest-intl.js  (v2 — ρ + WC-c + Platt calibration)
 * Backtests our bivariate-Poisson / Elo prediction engine
 * against 49k+ historical international football results.
 *
 * Run: node scripts/backtest-intl.js
 * Output: data/backtest-results.json
 * ========================================================== */
"use strict";
const fs   = require("fs");
const path = require("path");

// ── 1. Load CSV ───────────────────────────────────────────────
const csvPath = path.join(__dirname, "../data/intl_results.csv");
const raw = fs.readFileSync(csvPath, "utf8").trim().split("\n").slice(1);
const ALL_MATCHES = raw.map(line => {
  const parts = line.split(",");
  return {
    date:       parts[0],
    home:       parts[1],
    away:       parts[2],
    homeScore:  parseInt(parts[3], 10),
    awayScore:  parseInt(parts[4], 10),
    tournament: parts.slice(5, parts.length - 3).join(","),
    neutral:    parts[parts.length - 1]?.trim() === "TRUE",
  };
}).filter(r => !isNaN(r.homeScore) && !isNaN(r.awayScore));

console.log(`Loaded ${ALL_MATCHES.length} matches`);

// ── 2. K-factors ──────────────────────────────────────────────
function getK(tournament) {
  const t = tournament.toLowerCase();
  if (t.includes("fifa world cup") && !t.includes("qualif")) return 60;
  if (t.includes("confederations cup"))                       return 50;
  if (t.includes("uefa euro") || t.includes("european championship")) return 50;
  if (t.includes("copa america"))                             return 50;
  if (t.includes("africa cup") || t.includes("afcon"))        return 50;
  if (t.includes("asian cup"))                                return 45;
  if (t.includes("gold cup"))                                 return 40;
  if (t.includes("nations league"))                           return 35;
  if (t.includes("qualif") || t.includes("qualifying"))       return 40;
  if (t.includes("friendly"))                                 return 20;
  return 30;
}

// ── 3. Elo tracking ──────────────────────────────────────────
const INIT_ELO = 1500, HOME_ADV = 65;
const elo = {};
function getElo(team) { return elo[team] ?? INIT_ELO; }
function expectedScore(eloDiff) { return 1 / (1 + Math.pow(10, -eloDiff / 400)); }
function updateElo(homeTeam, awayTeam, homeScore, awayScore, K, neutral) {
  const eH = getElo(homeTeam), eA = getElo(awayTeam);
  const advDiff = neutral ? 0 : HOME_ADV;
  const weH = expectedScore(eH - eA + advDiff), weA = 1 - weH;
  let wH, wA;
  if (homeScore > awayScore)      { wH = 1;   wA = 0;   }
  else if (homeScore < awayScore) { wH = 0;   wA = 1;   }
  else                            { wH = 0.5; wA = 0.5; }
  const gd = Math.abs(homeScore - awayScore);
  let gdMult = 1;
  if (gd === 2) gdMult = 1.5;
  else if (gd === 3) gdMult = 1.75;
  else if (gd >= 4) gdMult = 1.75 + (gd - 3) * 0.05;
  elo[homeTeam] = eH + K * gdMult * (wH - weH);
  elo[awayTeam] = eA + K * gdMult * (wA - weA);
}

// ── 4. Prediction model ───────────────────────────────────────
function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}
function dcTau(i, j, lA, lB, rho) {
  if (i === 0 && j === 0) return 1 - lA * lB * rho;
  if (i === 0 && j === 1) return 1 + lA * rho;
  if (i === 1 && j === 0) return 1 + lB * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

function modelPredict(eloA, eloB, { c = 225, muTotal = 2.71, rho = 0.06, homeAdvElo = 0, maxG = 8 } = {}) {
  const dr      = eloA - eloB + homeAdvElo;
  const r       = Math.exp(dr / c);
  const lambdaA = Math.max(0.02, muTotal * r / (1 + r));
  const lambdaB = Math.max(0.02, muTotal * 1 / (1 + r));
  const matrix = [];
  let tot = 0;
  for (let i = 0; i <= maxG; i++) {
    matrix[i] = [];
    for (let j = 0; j <= maxG; j++) {
      const cell = poisson(i, lambdaA) * poisson(j, lambdaB) * dcTau(i, j, lambdaA, lambdaB, rho);
      matrix[i][j] = cell; tot += cell;
    }
  }
  for (let i = 0; i <= maxG; i++) for (let j = 0; j <= maxG; j++) matrix[i][j] /= tot;
  let pW = 0, pD = 0, pL = 0;
  for (let i = 0; i <= maxG; i++) for (let j = 0; j <= maxG; j++) {
    if (i > j) pW += matrix[i][j]; else if (i === j) pD += matrix[i][j]; else pL += matrix[i][j];
  }
  // low-score cell probabilities (for ρ calibration)
  return { pW, pD, pL, lambdaA, lambdaB, p00: matrix[0][0], p01: matrix[0][1], p10: matrix[1][0], p11: matrix[1][1] };
}

function brierScore3(pW, pD, pL, outcome) {
  const oW = outcome === "W" ? 1 : 0, oD = outcome === "D" ? 1 : 0, oL = outcome === "L" ? 1 : 0;
  return ((pW-oW)**2 + (pD-oD)**2 + (pL-oL)**2) / 3;
}

// ── 5. Build Elo + collect predictions ───────────────────────
const CUTOFF_MIN = "2018-06-01";
const CUTOFF_MAX = "2026-06-15";

console.log("Building Elo ratings and collecting predictions...");
const predictions = [];

for (const m of ALL_MATCHES) {
  if (m.date >= CUTOFF_MAX) break;
  const K = getK(m.tournament);
  const eH = getElo(m.home), eA = getElo(m.away);
  if (m.date >= CUTOFF_MIN && K >= 35) {
    const homeEloAdv = m.neutral ? 0 : 65;
    const pred = modelPredict(eH, eA, { homeAdvElo: homeEloAdv });
    const outcome = m.homeScore > m.awayScore ? "W" : m.homeScore < m.awayScore ? "L" : "D";
    predictions.push({
      date: m.date, home: m.home, away: m.away,
      homeScore: m.homeScore, awayScore: m.awayScore,
      tournament: m.tournament, neutral: m.neutral,
      eloH: Math.round(eH), eloA: Math.round(eA),
      pW: pred.pW, pD: pred.pD, pL: pred.pL, outcome,
      isWC: m.tournament.toLowerCase().includes("fifa world cup") && !m.tournament.toLowerCase().includes("qualif"),
    });
  }
  updateElo(m.home, m.away, m.homeScore, m.awayScore, K, m.neutral);
}

const N = predictions.length;
const wcPreds = predictions.filter(p => p.isWC);
console.log(`Test set: ${N} total, ${wcPreds.length} WC matches`);

// ── 6. Sweep ρ (all + WC-only) ────────────────────────────────
console.log("\n── Sweeping ρ (rho) ────────────────────────────────");
const rhoValues = [0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15];
let bestRho = 0.06, bestRhoBrier = Infinity;
let bestRhoWC = 0.06, bestRhoBrierWC = Infinity;

for (const rho of rhoValues) {
  let sumAll = 0, sumWC = 0;
  for (const p of predictions) {
    const pred = modelPredict(p.eloH, p.eloA, { rho, homeAdvElo: p.neutral ? 0 : 65 });
    const b = brierScore3(pred.pW, pred.pD, pred.pL, p.outcome);
    sumAll += b;
    if (p.isWC) sumWC += b;
  }
  const avgAll = sumAll / N;
  const avgWC  = sumWC / (wcPreds.length || 1);
  console.log(`ρ=${rho}: all=${avgAll.toFixed(4)} WC=${avgWC.toFixed(4)}`);
  if (avgAll < bestRhoBrier)   { bestRhoBrier   = avgAll; bestRho   = rho; }
  if (avgWC  < bestRhoBrierWC) { bestRhoBrierWC = avgWC;  bestRhoWC = rho; }
}
console.log(`→ Best ρ overall=${bestRho}  WC-only=${bestRhoWC}`);

// ── 7. Sweep c (all + WC-only) ────────────────────────────────
console.log("\n── Sweeping c ──────────────────────────────────────");
const cValues = [150, 175, 200, 225, 250, 275, 300, 350];
let bestC = 225, bestCBrier = Infinity;
let bestCWC = 225, bestCBrierWC = Infinity;

for (const c of cValues) {
  let sumAll = 0, sumWC = 0;
  for (const p of predictions) {
    const pred = modelPredict(p.eloH, p.eloA, { c, rho: bestRho, homeAdvElo: p.neutral ? 0 : 65 });
    const b = brierScore3(pred.pW, pred.pD, pred.pL, p.outcome);
    sumAll += b;
    if (p.isWC) sumWC += b;
  }
  const avgAll = sumAll / N;
  const avgWC  = sumWC / (wcPreds.length || 1);
  console.log(`c=${c}: all=${avgAll.toFixed(4)} WC=${avgWC.toFixed(4)}`);
  if (avgAll < bestCBrier)   { bestCBrier   = avgAll; bestC   = c; }
  if (avgWC  < bestCBrierWC) { bestCBrierWC = avgWC;  bestCWC = c; }
}
console.log(`→ Best c overall=${bestC}  WC-only=${bestCWC}`);

// ── 8. Calibration curve at best params ──────────────────────
console.log("\n── Calibration curve (best params) ─────────────────");
const calPreds = predictions.map(p => {
  const pred = modelPredict(p.eloH, p.eloA, { c: bestC, rho: bestRho, homeAdvElo: p.neutral ? 0 : 65 });
  return { ...p, pW: pred.pW, pD: pred.pD, pL: pred.pL };
});

function calibrationCurve(preds, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ preds: [], actuals: [] }));
  for (const p of preds) {
    const bi = Math.min(bins - 1, Math.floor(p.pW * bins));
    buckets[bi].preds.push(p.pW);
    buckets[bi].actuals.push(p.outcome === "W" ? 1 : 0);
  }
  return buckets.map((b, i) => {
    if (b.preds.length === 0) return null;
    const meanPred   = b.preds.reduce((a,x)=>a+x,0) / b.preds.length;
    const meanActual = b.actuals.reduce((a,x)=>a+x,0) / b.actuals.length;
    return { bin: i/bins, meanPred: +meanPred.toFixed(3), meanActual: +meanActual.toFixed(3), n: b.preds.length };
  }).filter(Boolean);
}

const calCurve = calibrationCurve(calPreds, 10);
for (const b of calCurve) {
  console.log(`[${(b.bin*100).toFixed(0).padStart(2)}–${((b.bin+0.1)*100).toFixed(0).padStart(2)}%] pred=${(b.meanPred*100).toFixed(1)}% actual=${(b.meanActual*100).toFixed(1)}% n=${b.n}`);
}

// ── 9. Low-score cell calibration for ρ verification ────────
// Compare observed vs model-predicted rates of 0-0, 0-1, 1-0, 1-1
console.log("\n── Low-score cell rates ─────────────────────────────");
const cells = { "0-0": 0, "0-1": 0, "1-0": 0, "1-1": 0 };
const cellModel = { "0-0": 0, "0-1": 0, "1-0": 0, "1-1": 0 };
for (const p of predictions) {
  const key = `${p.homeScore}-${p.awayScore}`;
  if (cells[key] !== undefined) cells[key]++;
  const pred = modelPredict(p.eloH, p.eloA, { c: bestC, rho: bestRho, homeAdvElo: p.neutral ? 0 : 65 });
  cellModel["0-0"] += pred.p00; cellModel["0-1"] += pred.p01;
  cellModel["1-0"] += pred.p10; cellModel["1-1"] += pred.p11;
}
for (const [k, obs] of Object.entries(cells)) {
  console.log(`${k}: observed=${(obs/N*100).toFixed(2)}% model=${(cellModel[k]/N*100).toFixed(2)}%`);
}

// ── 10. Brier at final best params ────────────────────────────
let finalBrier = 0, finalNaive = 0;
const outcomes = { W: 0, D: 0, L: 0 };
const totalGoals = [];
for (const p of calPreds) {
  finalBrier += brierScore3(p.pW, p.pD, p.pL, p.outcome);
  finalNaive += brierScore3(1/3, 1/3, 1/3, p.outcome);
  outcomes[p.outcome]++;
  totalGoals.push(p.homeScore + p.awayScore);
}
finalBrier /= N; finalNaive /= N;
const bss = 1 - finalBrier / finalNaive;
const avgGoals = totalGoals.reduce((a,b)=>a+b,0) / N;

let wcBrier = 0;
for (const p of wcPreds) {
  const pred = modelPredict(p.eloH, p.eloA, { c: bestCWC, rho: bestRhoWC, homeAdvElo: p.neutral ? 0 : 65 });
  wcBrier += brierScore3(pred.pW, pred.pD, pred.pL, p.outcome);
}
wcBrier /= wcPreds.length || 1;
const wcGoals = wcPreds.map(p => p.homeScore + p.awayScore);
const wcAvgGoals = wcGoals.reduce((a,b)=>a+b,0) / (wcGoals.length || 1);

console.log(`\n── Final Brier (c=${bestC}, ρ=${bestRho}) ─────────────`);
console.log(`Model: ${finalBrier.toFixed(4)}  Naive: ${finalNaive.toFixed(4)}  BSS: ${(bss*100).toFixed(1)}%`);
console.log(`WC (c=${bestCWC},ρ=${bestRhoWC}): Brier=${wcBrier.toFixed(4)}`);

// ── 11. Platt calibration map (piecewise linear) ──────────────
// Maps raw model probability → calibrated probability using the 10 calibration bins.
// This corrects the systematic bias (model overestimates big favorites, underestimates underdogs).
// Format: [[meanPred, meanActual], ...] — sorted by meanPred for interpolation.
const plattMap = calCurve.map(b => [b.meanPred, b.meanActual]);
console.log("\n── Platt calibration map (meanPred → meanActual) ────");
for (const [p, a] of plattMap) console.log(`  ${(p*100).toFixed(1)}% → ${(a*100).toFixed(1)}%`);

// ── 12. Elo snapshot ──────────────────────────────────────────
const TEAMS = ["France","Brazil","England","Argentina","Germany","Spain","Portugal",
               "Netherlands","Belgium","Italy","Croatia","Morocco","Senegal",
               "Japan","United States","Mexico","Uruguay","Colombia","Ecuador","Canada"];
const eloSnapshot = {};
for (const t of TEAMS) if (elo[t]) eloSnapshot[t] = Math.round(elo[t]);
const sortedElo = Object.entries(eloSnapshot).sort((a,b)=>b[1]-a[1]);
console.log("\n── Elo snapshot ─────────────────────────────────────");
for (const [t, e] of sortedElo) console.log(`  ${t}: ${e}`);

// ── 13. Write results JSON ────────────────────────────────────
const results = {
  generatedAt:  new Date().toISOString(),
  matchCount:   N,
  wcMatchCount: wcPreds.length,
  cutoffFrom:   CUTOFF_MIN,
  cutoffTo:     CUTOFF_MAX,
  brier:        { model: +finalBrier.toFixed(4), naive: +finalNaive.toFixed(4), skillScore: +(bss*100).toFixed(1) },
  wcBrier:      +wcBrier.toFixed(4),
  avgGoals:     +avgGoals.toFixed(2),
  wcAvgGoals:   +wcAvgGoals.toFixed(2),
  optimalC:     bestC,
  optimalCwc:   bestCWC,
  optimalRho:   bestRho,
  optimalRhoWC: bestRhoWC,
  outcomeDist:  { W: +(outcomes.W/N*100).toFixed(1), D: +(outcomes.D/N*100).toFixed(1), L: +(outcomes.L/N*100).toFixed(1) },
  calibration:  calCurve,
  plattMap,
  eloSnapshot:  Object.fromEntries(sortedElo),
};

const outPath = path.join(__dirname, "../data/backtest-results.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\n✓ Written to ${outPath}`);
