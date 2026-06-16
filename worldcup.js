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
  // params: { eloA, eloB, homeAdv, c, muTotal, rho, maxGoals }
  //   c       — Elo points per e-fold of the goal RATIO λA/λB (calibrate to market)
  //   muTotal — expected TOTAL goals (anchors the level; calibrate to O/U market)
  //   rho     — Dixon-Coles correlation
  //
  // MULTIPLICATIVE split (replaces the old additive (μ±s)/2):
  //   r  = exp(ΔElo / c)        goal ratio λA/λB, always > 0
  //   λA = μ · r/(1+r),  λB = μ · 1/(1+r)
  // → λA+λB = μ exactly (total anchored), both λ strictly positive (no clamp,
  //   no negative-λ blow-ups on big mismatches), supremacy carried by the ratio.
  function buildMatchModel(p) {
    const c       = p.c       ?? 175;
    const muTotal = p.muTotal ?? 2.55;
    const rho     = p.rho     ?? 0.06;
    const maxG    = p.maxGoals ?? 8;
    const homeAdv = p.homeAdv ?? 0;

    const dr      = p.eloA - p.eloB + homeAdv;   // Elo supremacy (Elo pts)
    const r       = Math.exp(dr / c);            // goal ratio λA/λB
    const lambdaA = Math.max(0.02, muTotal * r / (1 + r));
    const lambdaB = Math.max(0.02, muTotal * 1 / (1 + r));
    const supremacy = lambdaA - lambdaB;          // expected goal margin (display)

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

  // Market-implied SUPREMACY scale c. (Point 4) We match the home/away
  // LOG-ODDS ratio log(P_home/P_away) — pure "who's better", independent of the
  // draw/total level (which μ owns). Model supremacy is monotonically
  // DECREASING in c (bigger c → ratio→1). Bisection.
  function impliedC(params, market, lo = 40, hi = 800) {
    if (!market || market.home == null || market.away == null || market.away <= 0) return null;
    const target = Math.log(market.home / market.away);   // market supremacy (log-odds)
    for (let it = 0; it < 48; it++) {
      const mid = (lo + hi) / 2;
      const m = buildMatchModel({ ...params, c: mid }).probs;
      const sup = Math.log(m.home / m.away);
      if (sup > target) lo = mid; else hi = mid;          // model sup decreases in c
      void it;
    }
    return +((lo + hi) / 2).toFixed(0);
  }

  // Market-implied TOTAL-goals level μ: the μ that reproduces the market's
  // Over-2.5 prob. P(total≥3) is monotonically INCREASING in μ. Bisection.
  function impliedMu(params, targetOverProb, lo = 0.6, hi = 5.5) {
    if (targetOverProb == null) return null;
    for (let it = 0; it < 46; it++) {
      const mid = (lo + hi) / 2;
      const o = buildMatchModel({ ...params, muTotal: mid }).markets.over25;
      if (o < targetOverProb) lo = mid; else hi = mid;   // o increases in μ
      void it;
    }
    return +((lo + hi) / 2).toFixed(2);
  }

  // Joint two-market calibration: coordinate-descent on (c, μ).
  //   c ← from the MONEYLINE  (home/away log-odds) — "who's better"
  //   μ ← from the TOTALS     (Over-2.5 price)     — "how many goals"
  // Near-orthogonal coordinates, so 3-4 sweeps converge. The draw probability
  // then falls out and matches the market better than a 1-D home-only fit.
  // Leaves a parameter unchanged when its target market price is unavailable.
  function calibrate(params, market, iters = 4) {
    let c  = params.c       ?? 175;
    let mu = params.muTotal ?? 2.55;
    for (let i = 0; i < iters; i++) {
      const cNew = impliedC({ ...params, muTotal: mu }, market);
      if (cNew != null) c = cNew;
      if (market && market.over25 != null) mu = impliedMu({ ...params, c }, market.over25);
    }
    return { c, mu };
  }

  // (Point 5) Blend model toward market in LOGIT space (logarithmic opinion
  // pool): q'_i ∝ q_i^(1−s) · m_i^s, renormalized. Stable near 0/1 (no kink),
  // and the multi-class generalization of logit mixing.
  //   shrink s: 0 = pure model … 1 = fully defer to market.
  // NB once c & μ are calibrated to market, model≈market on 1X2/totals so this
  // barely moves them; its real job is confidence on UN-anchored markets.
  function shrinkToMarket(modelP, mktP, shrink) {
    const s = Math.max(0, Math.min(1, shrink || 0));
    const g = (a, b) => Math.pow(Math.max(a, 1e-9), 1 - s) * Math.pow(Math.max(b ?? a, 1e-9), s);
    const home = g(modelP.home, mktP.home),
          draw = g(modelP.draw, mktP.draw),
          away = g(modelP.away, mktP.away);
    const t = home + draw + away;
    return { home: home / t, draw: draw / t, away: away / t };
  }

  // (Points 6 & 7) Bid/ask-aware net edge + position sizing for ONE binary
  // outcome. q = model prob; bid/ask = YES quotes (raw).
  //   Buy YES: pay ask  → netYes = q − ask,   Kelly = netYes/(1−ask)
  //   Buy NO : pay 1−bid → netNo  = bid − q,   Kelly = netNo /bid
  // Then a FRACTIONAL-Kelly haircut (uncertainty in q) and a hard cap.
  // The 3-way outcomes are mutually exclusive → caller takes the single best.
  function tradeSignal(q, bid, ask, opts = {}) {
    const { minNet = 0.02, kellyFraction = 0.5, cap = 0.25 } = opts;
    const hasBA = bid != null && ask != null;
    const netYes = hasBA ? q - ask : null;
    const netNo  = hasBA ? bid - q : null;
    const bestNet = hasBA ? Math.max(netYes, netNo) : (q != null ? q : null);

    let side = null, net = null, entry = null, fullK = 0;
    if (hasBA && netYes >= netNo && netYes > minNet) {
      side = "YES"; net = netYes; entry = ask; fullK = ask < 1 ? netYes / (1 - ask) : 0;
    } else if (hasBA && netNo > minNet) {
      side = "NO";  net = netNo;  entry = +(1 - bid).toFixed(4); fullK = bid > 0 ? netNo / bid : 0;
    }
    const kelly = side ? Math.max(0, Math.min(cap, fullK * kellyFraction)) : 0;
    return { side, net, entry, bestNet, fullKelly: +fullK.toFixed(4), kelly: +kelly.toFixed(4) };
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
    const quote = (m) => ({
      mid: m && m.mid != null ? m.mid : null,
      bid: m && m.yes_bid != null ? m.yes_bid : null,
      ask: m && m.yes_ask != null ? m.yes_ask : null,
    });

    const hM = matchOne([home.name, home.cn, home.code]);   // "France" / "法国" / suffix "fra"
    const aM = matchOne([away.name, away.cn, away.code]);   // "Senegal" / "塞内加尔" / suffix "sen"
    const dM = matchOne(["draw", "tie", "平局", "平"]);

    return {
      resolvedTicker: data.resolvedTicker || null,
      marketCount: markets.length,
      home: price(hM), draw: price(dM), away: price(aM),
      quotes: { home: quote(hM), draw: quote(dM), away: quote(aM) },  // raw YES bid/ask
      fetchedAt: data.fetchedAt || null,
      raw: markets,
    };
  }

  // Pull the live Over-2.5 probability from the KXWCTOTAL event for this match.
  // Kalshi totals come in two shapes; we handle both, else return null (→ seed):
  //   (a) an explicit Over/Under 2.5 line  → use its mid directly
  //   (b) per-total buckets (0,1,2,3,4,5+) → P(total≥3) = Σ mids of buckets ≥3
  async function fetchKalshiTotal(ticker) {
    const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`Kalshi proxy ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const markets = (data.markets || []).filter(m => m.mid != null);
    if (!markets.length) return { over25: null, resolvedTicker: data.resolvedTicker || null, marketCount: 0 };

    // (a) explicit 2.5 line
    for (const m of markets) {
      const s = (m.subtitle || "").toLowerCase();
      if (/(over|more than|above|\+).*2\.?5|2\.?5\s*(or more|\+|or above)|3\s*(\+|or more|or above)|≥\s*3/.test(s))
        return { over25: m.mid, resolvedTicker: data.resolvedTicker, marketCount: markets.length, mode: "line" };
      if (/(under|less than|below|fewer).*2\.?5|2\.?5\s*(or fewer|or less)|2\s*(or fewer|or less)|≤\s*2/.test(s))
        return { over25: +(1 - m.mid).toFixed(4), resolvedTicker: data.resolvedTicker, marketCount: markets.length, mode: "line" };
    }

    // (b) numeric buckets → sum P(total ≥ 3)
    let over = 0, matched = 0;
    for (const m of markets) {
      const s = (m.subtitle || "").trim();
      const plus  = s.match(/(\d+)\s*(\+|or more|or above)/i);
      const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
      const exact = s.match(/^(\d+)\s*(goals?)?$/i);
      if (plus)       { if (+plus[1]  >= 3) over += m.mid; matched++; }
      else if (range) { if (+range[1] >= 3) over += m.mid; matched++; }
      else if (exact) { if (+exact[1] >= 3) over += m.mid; matched++; }
    }
    if (matched >= 3) return { over25: +Math.min(1, over).toFixed(4), resolvedTicker: data.resolvedTicker, marketCount: markets.length, mode: "buckets" };
    return { over25: null, resolvedTicker: data.resolvedTicker, marketCount: markets.length, mode: "unparsed" };
  }

  // Generic Yes/No market fetch (e.g. BTTS). Picks the "Yes" contract by
  // keyword, or the sole market if there's only one. Returns its mid+bid+ask so
  // the caller can run tradeSignal against a model-derived probability.
  async function fetchKalshiYesNo(ticker, yesKeys = ["yes"]) {
    const res = await fetch(`/api/kalshi?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`Kalshi proxy ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const markets = (data.markets || []).filter(m => m.mid != null);
    if (!markets.length) return { yes: null, bid: null, ask: null, resolvedTicker: data.resolvedTicker || null, marketCount: 0 };

    let m = markets.find(mk => yesKeys.some(k => (mk.subtitle || "").toLowerCase().includes(k)));
    if (!m) m = markets[0];           // single-contract events expose just the Yes side
    return {
      yes: m.mid, bid: m.yes_bid ?? null, ask: m.yes_ask ?? null,
      resolvedTicker: data.resolvedTicker || null, marketCount: markets.length,
    };
  }

  // ── Backtest scorecard (4,616 competitive intl matches 2018–2026) ───
  // Generated by scripts/backtest-intl.js against martj42/international_results.
  // c=225 minimises Brier (vs current 175); muTotal=2.71 is WC historical average.
  const BACKTEST = {
    generatedAt:  "2026-06-16T09:00:40Z",
    matchCount:   4616,
    wcMatchCount: 140,
    cutoffFrom:   "2018-06-01",
    cutoffTo:     "2026-06-15",
    brier:        { model: 0.1644, naive: 0.2222, skillScore: 26 },
    wcBrier:      0.2044,
    avgGoals:     2.78,
    wcAvgGoals:   2.71,
    optimalC:     225,
    outcomeDist:  { W: 47.2, D: 21.5, L: 31.3 },
    calibration: [
      { bin: 0,   meanPred: 0.047, meanActual: 0.080, n: 740  },
      { bin: 0.1, meanPred: 0.148, meanActual: 0.201, n: 482  },
      { bin: 0.2, meanPred: 0.250, meanActual: 0.316, n: 418  },
      { bin: 0.3, meanPred: 0.352, meanActual: 0.348, n: 359  },
      { bin: 0.4, meanPred: 0.452, meanActual: 0.413, n: 344  },
      { bin: 0.5, meanPred: 0.551, meanActual: 0.522, n: 391  },
      { bin: 0.6, meanPred: 0.650, meanActual: 0.584, n: 473  },
      { bin: 0.7, meanPred: 0.753, meanActual: 0.721, n: 580  },
      { bin: 0.8, meanPred: 0.853, meanActual: 0.854, n: 698  },
      { bin: 0.9, meanPred: 0.910, meanActual: 0.977, n: 131  },
    ],
    eloSnapshot: {
      France: 2113, Senegal: 1895, Spain: 2199, Argentina: 2157,
      England: 2080, Brazil: 2041, Germany: 2016, Portugal: 2026,
    },
  };

  // ── Sample match seed (TEMPORARY): France vs Senegal ─────
  // Elo: backtested from 49k matches up to 2026-06-15 (scripts/backtest-intl.js).
  // c=225 and muTotal=2.71 are the WC-validated parameter values from the backtest.
  // Market = de-vigged from bookmaker FRA -245 / SEN +550 with draw inferred.
  const MATCH = {
    id: "WC2026-FRA-SEN",
    competition: "FIFA World Cup 2026 · Group I",
    venue: "MetLife Stadium · East Rutherford, NJ",
    neutral: true,
    koUTC: "2026-06-16T19:00:00Z",   // 15:00 ET = 19:00 UTC = BJT 03:00 (6/17)
    koBJT: "6/17 03:00",
    eloAsOf: "2026-06-15",
    home: { code: "FRA", name: "France",  cn: "法国",       elo: 2113, fifaRank: 3,  flag: "🇫🇷" },
    away: { code: "SEN", name: "Senegal", cn: "塞内加尔",   elo: 1895, fifaRank: 17, flag: "🇸🇳" },
    params: { c: 225, muTotal: 2.71, rho: 0.06, homeAdv: 0 },  // backtested: c=225 minimises Brier; muTotal=2.71 is WC avg
    odds:   { home: -245, away: 550 },
    // Seed = real Kalshi prices (FRA 68% / draw ~19% / SEN 13%; Over-2.5 ~49%,
    // observed 2026-06-16) as the fallback; overwritten live from the proxy.
    market: { home: 0.68, draw: 0.19, away: 0.13, over25: 0.49, btts: 0.46 },
    // Kalshi event tickers (proxy discovers by the series prefix before "-").
    // Match-winner series KXWCGAME, total-goals series KXWCTOTAL — both verified
    // on kalshi.com (…/kxwcgame/… and …/kxwctotal/…).
    kalshiTicker:      "KXWCGAME-26JUN16FRASEN",   // moneyline (1X2) → calibrates c
    kalshiTotalTicker: "KXWCTOTAL-26JUN16FRASEN",  // total goals    → calibrates μ
    kalshiBttsTicker:  "KXWCBTTS-26JUN16FRASEN",   // both teams to score → edge hunt (⚠ verify)
  };

  return {
    buildMatchModel, buildLiveModel, edgeKelly, tradeSignal,
    americanToProb, devig, devig3way, impliedC, impliedMu, calibrate, shrinkToMarket,
    fetchKalshiMatch, fetchKalshiTotal, fetchKalshiYesNo, MATCH, BACKTEST,
  };
})();
