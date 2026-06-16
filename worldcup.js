/* ============================================================
 * worldcup.js — World Cup match prediction engine (TEMPORARY)
 *
 * Mirrors api.js for weather: produce a probability DISTRIBUTION over
 * match outcomes, compare to Kalshi prices, surface edge + Kelly.
 *
 * Physics here is the bivariate-Poisson goals model (Dixon-Coles low-score
 * correction) driven by team Elo. One scoreline matrix yields every Kalshi
 * sub-market (1X2, O/U, BTTS, exact score) at once.
 *
 * Parallel to the weather pipeline:
 *   Gaussian N(mean,σ)        →  Poisson scoreline matrix
 *   station-bias corrections  →  home advantage / heat / params
 *   max-so-far obs FLOOR      →  live current score (already-realized goals)
 *   Kalshi bucket edge+Kelly  →  identical, reused
 * ========================================================== */
window.KW_WC = (function () {
  "use strict";

  // ── math helpers ─────────────────────────────────────────
  function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
  function poisson(k, lambda) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
  }

  // Dixon-Coles τ: corrects the Poisson independence assumption for the four
  // low-scoring scorelines where real football is correlated (rho ~ 0.05-0.10).
  function dcTau(i, j, lA, lB, rho) {
    if (i === 0 && j === 0) return 1 - lA * lB * rho;
    if (i === 0 && j === 1) return 1 + lA * rho;
    if (i === 1 && j === 0) return 1 + lB * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  }

  // American moneyline → implied probability (incl. vig)
  function americanToProb(ml) {
    return ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
  }
  // Remove the overround from a set of implied probs → "true" probabilities
  function devig(impliedArr) {
    const s = impliedArr.reduce((a, b) => a + b, 0);
    return s > 0 ? impliedArr.map(p => p / s) : impliedArr;
  }

  // ── Core: Elo → λ → scoreline matrix → every sub-market ──
  // params: { eloA, eloB, homeAdv, k, muTotal, rho, maxGoals }
  //   k       — Elo points per goal of supremacy (MUST be calibrated by backtest)
  //   muTotal — expected total goals (international ~2.5-2.6)
  //   rho     — Dixon-Coles correlation
  function buildMatchModel(p) {
    const k       = p.k       ?? 150;
    const muTotal = p.muTotal ?? 2.55;
    const rho     = p.rho     ?? 0.06;
    const maxG    = p.maxGoals ?? 8;
    const homeAdv = p.homeAdv ?? 0;

    const dr        = p.eloA - p.eloB + homeAdv;     // Elo supremacy (Elo pts)
    const supremacy = dr / k;                         // → goal supremacy
    const lambdaA   = Math.max(0.12, (muTotal + supremacy) / 2);
    const lambdaB   = Math.max(0.12, (muTotal - supremacy) / 2);

    // Build + normalize the joint scoreline matrix
    const matrix = [];
    let total = 0;
    for (let i = 0; i <= maxG; i++) {
      matrix[i] = [];
      for (let j = 0; j <= maxG; j++) {
        const cell = poisson(i, lambdaA) * poisson(j, lambdaB) * dcTau(i, j, lambdaA, lambdaB, rho);
        matrix[i][j] = cell;
        total += cell;
      }
    }
    let home = 0, draw = 0, away = 0, over25 = 0, btts = 0;
    const scores = [];
    for (let i = 0; i <= maxG; i++) {
      for (let j = 0; j <= maxG; j++) {
        const prob = matrix[i][j] / total;
        matrix[i][j] = prob;
        if (i > j) home += prob; else if (i === j) draw += prob; else away += prob;
        if (i + j >= 3) over25 += prob;
        if (i >= 1 && j >= 1) btts += prob;
        scores.push({ i, j, p: prob });
      }
    }
    scores.sort((a, b) => b.p - a.p);

    return {
      lambdaA: +lambdaA.toFixed(2),
      lambdaB: +lambdaB.toFixed(2),
      supremacy: +supremacy.toFixed(2),
      probs: { home, draw, away },
      markets: { over25, under25: 1 - over25, btts, noBtts: 1 - btts },
      topScores: scores.slice(0, 6).map(s => ({ ...s, p: +s.p.toFixed(4) })),
      matrix,
    };
  }

  // ── LIVE in-play model — the direct analogue of the max-so-far FLOOR ──
  // Current goals are already realized (certain). We only model the residual
  // over the minutes that remain, then add the locked-in current score.
  // params: same as buildMatchModel + { scoreA, scoreB, minute }
  function buildLiveModel(p) {
    const minute = Math.max(0, Math.min(95, p.minute ?? 0));
    const frac   = Math.max(0, (90 - minute) / 90);     // share of match left
    const base   = buildMatchModel(p);                  // gives full-match λ
    const remA   = base.lambdaA * frac;                 // expected remaining goals
    const remB   = base.lambdaB * frac;
    const maxRem = 7;
    const sA = p.scoreA ?? 0, sB = p.scoreB ?? 0;

    let home = 0, draw = 0, away = 0, over25 = 0, btts = 0, total = 0;
    const scores = [];
    for (let i = 0; i <= maxRem; i++) {
      for (let j = 0; j <= maxRem; j++) {
        const cell = poisson(i, remA) * poisson(j, remB)
                   * dcTau(i, j, remA || 0.0001, remB || 0.0001, p.rho ?? 0.06);
        total += cell;
        scores.push({ fi: sA + i, fj: sB + j, w: cell });
      }
    }
    for (const s of scores) {
      const prob = s.w / total;
      if (s.fi > s.fj) home += prob; else if (s.fi === s.fj) draw += prob; else away += prob;
      if (s.fi + s.fj >= 3) over25 += prob;
      if (s.fi >= 1 && s.fj >= 1) btts += prob;
    }
    // collapse to final-scoreline probabilities
    const agg = {};
    for (const s of scores) {
      const key = `${s.fi}-${s.fj}`;
      agg[key] = (agg[key] || 0) + s.w / total;
    }
    const topScores = Object.entries(agg)
      .map(([key, p]) => { const [i, j] = key.split("-").map(Number); return { i, j, p: +p.toFixed(4) }; })
      .sort((a, b) => b.p - a.p).slice(0, 6);

    return {
      minute, scoreA: sA, scoreB: sB,
      remLambdaA: +remA.toFixed(2), remLambdaB: +remB.toFixed(2),
      probs: { home, draw, away },
      markets: { over25, under25: 1 - over25, btts, noBtts: 1 - btts },
      topScores,
    };
  }

  // ── Edge + Kelly (identical to the weather app's logic) ──
  // For backing YES at price `mkt` with model prob `model`:
  //   edge  = model - mkt
  //   Kelly = edge / (1 - mkt)     (fraction of bankroll)
  function edgeKelly(model, mkt) {
    const edge = model - mkt;
    const kelly = mkt < 1 ? edge / (1 - mkt) : 0;
    return { edge, kelly };
  }

  // ── ① De-vig + calibration ───────────────────────────────
  // Normalize a 3-way price set to a true PMF (removes overround / bid-ask slack).
  function devig3way(home, draw, away) {
    const s = (home || 0) + (draw || 0) + (away || 0);
    return s > 0 ? { home: home / s, draw: draw / s, away: away / s, overround: s }
                 : { home, draw, away, overround: s };
  }

  // Solve for the Elo→goals scale k that reproduces a target home-win probability.
  // home-win prob is monotonically DECREASING in k (bigger k → smaller supremacy).
  // Bisection — lets us read off the "market-implied k" and compare to our prior.
  function impliedK(params, targetHomeProb, lo = 50, hi = 500) {
    if (targetHomeProb == null) return null;
    for (let it = 0; it < 44; it++) {
      const mid = (lo + hi) / 2;
      const h = buildMatchModel({ ...params, k: mid }).probs.home;
      if (h > targetHomeProb) lo = mid; else hi = mid;
    }
    return +((lo + hi) / 2).toFixed(0);
  }

  // Shrink model probabilities toward the de-vigged market (0 = pure model,
  // 1 = fully defer to market). The standard "trust the sharp price" dial;
  // not circular — your model stays the prior, shrink is your confidence.
  function shrinkToMarket(modelP, mktP, shrink) {
    const s = Math.max(0, Math.min(1, shrink || 0));
    const mix = (a, b) => a * (1 - s) + (b ?? a) * s;
    const home = mix(modelP.home, mktP.home),
          draw = mix(modelP.draw, mktP.draw),
          away = mix(modelP.away, mktP.away);
    const t = home + draw + away;
    return { home: home / t, draw: draw / t, away: away / t };
  }

  // ── ② Live Kalshi prices via the existing /api/kalshi proxy ──
  // Reuses the weather proxy's series-discovery; maps the 3-way outcomes by
  // matching subtitle/ticker to team name/code or "draw". Returns null fields
  // when an outcome can't be resolved → caller falls back to the seed market.
  async function fetchKalshiMatch(ticker, home, away) {
    const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`Kalshi proxy ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const markets = data.markets || [];

    // Match an outcome by SUBTITLE (authoritative) or the ticker's LAST segment
    // only. NB: the event ticker itself (…FRASEN) contains both "fra" and "sen",
    // so we must NOT substring-match the full ticker — that's ambiguous.
    const matchOne = (keys) => markets.find(m => {
      const sub    = (m.subtitle || "").toLowerCase();
      const suffix = (m.ticker || "").split("-").pop().toLowerCase();
      return keys.some(k => {
        if (!k) return false;
        k = k.toLowerCase();
        return sub.includes(k) || suffix === k;
      });
    });
    const price = (m) => (m && m.mid != null) ? m.mid : null;

    const hM = matchOne([home.name, home.cn, home.code]);   // "France" / "法国" / suffix "fra"
    const aM = matchOne([away.name, away.cn, away.code]);   // "Senegal" / "塞内加尔" / suffix "sen"
    const dM = matchOne(["draw", "tie", "平局", "平"]);

    return {
      resolvedTicker: data.resolvedTicker || null,
      marketCount: markets.length,
      home: price(hM), draw: price(dM), away: price(aM),
      fetchedAt: data.fetchedAt || null,
      raw: markets,
    };
  }

  // ── Sample match seed (TEMPORARY): France vs Senegal ─────
  // Elo from World Football Elo Ratings (Jan 2026): FRA 2063 (#3), SEN 1869 (#17).
  // Market = de-vigged from bookmaker FRA -245 / SEN +550 with draw inferred.
  const MATCH = {
    id: "WC2026-FRA-SEN",
    competition: "FIFA World Cup 2026 · Group I",
    venue: "MetLife Stadium · East Rutherford, NJ",
    neutral: true,
    koUTC: "2026-06-16T19:00:00Z",   // 15:00 ET = 19:00 UTC = BJT 03:00 (6/17)
    koBJT: "6/17 03:00",
    eloAsOf: "2026-01",
    home: { code: "FRA", name: "France",  cn: "法国",       elo: 2063, fifaRank: 3,  flag: "🇫🇷" },
    away: { code: "SEN", name: "Senegal", cn: "塞内加尔",   elo: 1869, fifaRank: 17, flag: "🇸🇳" },
    params: { k: 150, muTotal: 2.55, rho: 0.06, homeAdv: 0 },  // neutral venue
    odds:   { home: -245, away: 550 },
    // Seed = real Kalshi 3-way (FRA 68% / draw ~19% / SEN 13%, observed
    // 2026-06-16) as the fallback; overwritten live from the Kalshi proxy.
    market: { home: 0.68, draw: 0.19, away: 0.13, over25: 0.52, btts: 0.46 },
    // Kalshi event/series ticker. The proxy discovers by series prefix (chars
    // before the first "-"). ⚠ VERIFY on kalshi.com — update this one line if
    // the World Cup match-winner series differs (e.g. KXWCGAME / KXWCMATCH…).
    kalshiTicker: "KXWCGAME-26JUN16FRASEN",
  };

  return {
    buildMatchModel, buildLiveModel, edgeKelly,
    americanToProb, devig, devig3way, impliedK, shrinkToMarket,
    fetchKalshiMatch, MATCH,
  };
})();
