/* ============================================================
 * scripts/backtest-intl.js
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
  // date,home,away,home_score,away_score,tournament,city,country,neutral
  return {
    date:       parts[0],
    home:       parts[1],
    away:       parts[2],
    homeScore:  parseInt(parts[3], 10),
    awayScore:  parseInt(parts[4], 10),
    tournament: parts.slice(5, parts.length - 3).join(","), // tournament name may contain commas
    neutral:    parts[parts.length - 1]?.trim() === "TRUE",
  };
}).filter(r => !isNaN(r.homeScore) && !isNaN(r.awayScore));

console.log(`Loaded ${ALL_MATCHES.length} matches`);

// ── 2. K-factor by tournament importance ────────────────────
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
  return 30; // other competitive
}

// ── 3. Elo tracking ──────────────────────────────────────────
const INIT_ELO   = 1500;
const HOME_ADV   = 65;   // Elo points added to home team We calc (only when not neutral)
const elo = {};          // { teamName → currentElo }

function getElo(team) { return elo[team] ?? INIT_ELO; }

function expectedScore(eloDiff) {
  // Standard Elo expected score for team with eloDiff advantage
  return 1 / (1 + Math.pow(10, -eloDiff / 400));
}

function updateElo(homeTeam, awayTeam, homeScore, awayScore, K, neutral) {
  const eH = getElo(homeTeam);
  const eA = getElo(awayTeam);

  // Apply home advantage to expected score (not to stored Elo)
  const advDiff = neutral ? 0 : HOME_ADV;
  const weH = expectedScore(eH - eA + advDiff);
  const weA = 1 - weH;

  // Actual score (W=1, D=0.5, L=0)
  let wH, wA;
  if (homeScore > awayScore)      { wH = 1;   wA = 0;   }
  else if (homeScore < awayScore) { wH = 0;   wA = 1;   }
  else                            { wH = 0.5; wA = 0.5; }

  // Goal difference multiplier (reduces noise in large-margin games)
  const gd = Math.abs(homeScore - awayScore);
  let gdMult = 1;
  if (gd === 2) gdMult = 1.5;
  else if (gd === 3) gdMult = 1.75;
  else if (gd >= 4) gdMult = 1.75 + (gd - 3) * 0.05;

  elo[homeTeam] = eH + K * gdMult * (wH - weH);
  elo[awayTeam] = eA + K * gdMult * (wA - weA);
}

// ── 4. Poisson prediction model (mirrors worldcup.js exactly) ─
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

function modelPredict(eloA, eloB, { c = 175, muTotal = 2.55, rho = 0.06, homeAdvElo = 0, maxG = 8 } = {}) {
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
  for (let i = 0; i <= maxG; i++)
    for (let j = 0; j <= maxG; j++) matrix[i][j] /= tot;

  let pW = 0, pD = 0, pL = 0;
  for (let i = 0; i <= maxG; i++)
    for (let j = 0; j <= maxG; j++) {
      if (i > j) pW += matrix[i][j];
      else if (i === j) pD += matrix[i][j];
      else pL += matrix[i][j];
    }
  return { pW, pD, pL, lambdaA, lambdaB };
}

// ── 5. Brier score helper ────────────────────────────────────
// For a 3-outcome (W/D/L) market, Brier = mean of (p-o)^2 over all 3 outcomes
function brierScore3(pW, pD, pL, outcome) {
  const oW = outcome === "W" ? 1 : 0;
  const oD = outcome === "D" ? 1 : 0;
  const oL = outcome === "L" ? 1 : 0;
  return ((pW-oW)**2 + (pD-oD)**2 + (pL-oL)**2) / 3;
}

// ── 6. Run pass: build Elo + collect predictions ──────────────
// PASS 1: Build Elo from all history (pre-2018)
console.log("Pass 1: Building Elo ratings from full history...");
const CUTOFF_TRAIN = "2018-01-01"; // start collecting after this
const CUTOFF_MIN   = "2018-06-01"; // only count competitive matches
const CUTOFF_MAX   = "2026-06-15"; // stop just before France-Senegal

const predictions = []; // { eloA, eloB, pW, pD, pL, outcome, tournament, date }

for (const m of ALL_MATCHES) {
  if (m.date >= CUTOFF_MAX) break; // dataset is sorted chronologically
  const K = getK(m.tournament);
  const eH = getElo(m.home);
  const eA = getElo(m.away);

  // Collect predictions for matches in our window
  if (m.date >= CUTOFF_MIN && K >= 35) { // only competitive (not friendlies)
    const homeEloAdv = m.neutral ? 0 : 65; // Elo home advantage for prediction
    const pred = modelPredict(eH, eA, { homeAdvElo: homeEloAdv });
    const outcome = m.homeScore > m.awayScore ? "W" : m.homeScore < m.awayScore ? "L" : "D";
    predictions.push({
      date: m.date,
      home: m.home,
      away: m.away,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      tournament: m.tournament,
      neutral: m.neutral,
      eloH: Math.round(eH),
      eloA: Math.round(eA),
      pW: pred.pW,
      pD: pred.pD,
      pL: pred.pL,
      lambdaH: +pred.lambdaA.toFixed(3),
      lambdaA: +pred.lambdaB.toFixed(3),
      outcome,
    });
  }

  updateElo(m.home, m.away, m.homeScore, m.awayScore, K, m.neutral);
}

console.log(`Collected ${predictions.length} test predictions (competitive, 2018-2026)`);

// ── 7. Brier scores ──────────────────────────────────────────
let modelBrier = 0, naiveBrier = 0, skillfulBrier = 0;
const outcomes = { W: 0, D: 0, L: 0 };
const totalGoals = [];
for (const p of predictions) {
  modelBrier   += brierScore3(p.pW, p.pD, p.pL, p.outcome);
  naiveBrier   += brierScore3(1/3,  1/3,  1/3,  p.outcome); // dumb uniform
  skillfulBrier += brierScore3(0.45, 0.27, 0.28, p.outcome); // historical base rates
  outcomes[p.outcome]++;
  totalGoals.push(p.homeScore + p.awayScore);
}
const N = predictions.length;
modelBrier    /= N;
naiveBrier    /= N;
skillfulBrier /= N;

const avgGoals = totalGoals.reduce((a,b)=>a+b,0) / totalGoals.length;
const bss = 1 - modelBrier / naiveBrier; // Brier Skill Score vs naive

console.log(`\n── Brier Scores (${N} matches) ─────────────────────`);
console.log(`Model:         ${modelBrier.toFixed(4)}`);
console.log(`Naive (1/3):   ${naiveBrier.toFixed(4)}`);
console.log(`Historical:    ${skillfulBrier.toFixed(4)}`);
console.log(`BSS vs naive:  ${(bss*100).toFixed(1)}%`);
console.log(`Outcome dist:  W=${outcomes.W} D=${outcomes.D} L=${outcomes.L}`);
console.log(`Avg goals/game: ${avgGoals.toFixed(2)}`);

// ── 8. Calibration curve (probability bins) ────────────────────
// For the "home win" probability bucket, check actual win rate
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

const calCurve = calibrationCurve(predictions, 10);
console.log("\n── Calibration (home-win) ──────────────────────────");
for (const b of calCurve) {
  const bar = "█".repeat(Math.round(b.meanActual * 20));
  console.log(`[${(b.bin*100).toFixed(0).padStart(2)}%–${((b.bin+0.1)*100).toFixed(0).padStart(2)}%] pred=${(b.meanPred*100).toFixed(1)}% actual=${(b.meanActual*100).toFixed(1)}% n=${b.n}`);
}

// ── 9. Sweep c parameter to find optimal value ────────────────
console.log("\n── Sweeping c parameter ────────────────────────────");
const cValues = [100, 125, 150, 175, 200, 225, 250, 300];
let bestC = 175, bestBrier = Infinity;
for (const c of cValues) {
  let sumBrier = 0;
  for (const p of predictions) {
    const homeEloAdv = p.neutral ? 0 : 65;
    const pred = modelPredict(p.eloH, p.eloA, { c, homeAdvElo: homeEloAdv });
    sumBrier += brierScore3(pred.pW, pred.pD, pred.pL, p.outcome);
  }
  const avg = sumBrier / N;
  console.log(`c=${c}: Brier=${avg.toFixed(4)}`);
  if (avg < bestBrier) { bestBrier = avg; bestC = c; }
}
console.log(`→ Optimal c = ${bestC} (Brier=${bestBrier.toFixed(4)})`);

// ── 10. WC-specific stats (FIFA World Cup only) ───────────────
const wcPreds = predictions.filter(p => p.tournament.toLowerCase().includes("fifa world cup") && !p.tournament.toLowerCase().includes("qualif"));
let wcBrier = 0;
for (const p of wcPreds) wcBrier += brierScore3(p.pW, p.pD, p.pL, p.outcome);
wcBrier /= wcPreds.length || 1;
console.log(`\n── WC-only (n=${wcPreds.length}) Brier=${wcBrier.toFixed(4)}`);

// Avg goals in WC
const wcGoals = wcPreds.map(p => p.homeScore + p.awayScore);
const wcAvgGoals = wcGoals.reduce((a,b)=>a+b,0) / (wcGoals.length || 1);
console.log(`WC avg goals/game: ${wcAvgGoals.toFixed(2)}`);

// ── 11. Current Elo snapshots for major nations ───────────────
const TEAMS_OF_INTEREST = [
  "France","Brazil","England","Argentina","Germany","Spain",
  "Portugal","Netherlands","Belgium","Italy","Croatia",
  "Morocco","Senegal","Japan","United States","Mexico",
  "Uruguay","Colombia","Ecuador","Canada",
];
const eloSnapshot = {};
for (const t of TEAMS_OF_INTEREST) if (elo[t]) eloSnapshot[t] = Math.round(elo[t]);
const sortedElo = Object.entries(eloSnapshot).sort((a,b)=>b[1]-a[1]);
console.log("\n── Elo snapshot (backtest-computed) ──────────────────");
for (const [t, e] of sortedElo) console.log(`  ${t}: ${e}`);

// ── 12. Write results JSON ────────────────────────────────────
const results = {
  generatedAt:  new Date().toISOString(),
  matchCount:   N,
  wcMatchCount: wcPreds.length,
  cutoffFrom:   CUTOFF_MIN,
  cutoffTo:     CUTOFF_MAX,
  brier: {
    model:     +modelBrier.toFixed(4),
    naive:     +naiveBrier.toFixed(4),
    historical:+skillfulBrier.toFixed(4),
    skillScore:+(bss*100).toFixed(1), // % improvement vs naive
  },
  wcBrier:     +wcBrier.toFixed(4),
  avgGoals:    +avgGoals.toFixed(2),
  wcAvgGoals:  +wcAvgGoals.toFixed(2),
  optimalC:    bestC,
  currentC:    175,
  outcomeDist: {
    W: +(outcomes.W/N*100).toFixed(1),
    D: +(outcomes.D/N*100).toFixed(1),
    L: +(outcomes.L/N*100).toFixed(1),
  },
  calibration: calCurve,
  eloSnapshot: Object.fromEntries(sortedElo),
};

const outPath = path.join(__dirname, "../data/backtest-results.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\n✓ Written to ${outPath}`);
