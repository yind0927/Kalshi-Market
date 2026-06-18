/* ============================================================
 * /api/match-odds — Pinnacle odds for WC 2026 matches
 *
 * Fetches from The Odds API (https://the-odds-api.com).
 * Requires: THE_ODDS_API_KEY environment variable.
 * Free tier: 500 req/month. Cached 5 min at the edge.
 *
 * Response: { ok, matches: [{ homeTeam, awayTeam, home, draw, away, over25, commenceTime }] }
 *   home/draw/away: raw Pinnacle implied probabilities (1/decimal), NOT de-vigged.
 *   The frontend calls devig3way() before using them.
 * ========================================================== */
"use strict";

const SPORT = "soccer_fifa_world_cup";
const BASE  = "https://api.the-odds-api.com/v4";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: "no_key", matches: [] });

  try {
    const url =
      `${BASE}/sports/${SPORT}/odds` +
      `?apiKey=${encodeURIComponent(apiKey)}` +
      `&regions=eu&markets=h2h,totals&bookmakers=pinnacle&oddsFormat=decimal&dateFormat=iso`;

    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.json({ ok: false, error: `odds-api ${r.status}: ${txt.slice(0, 200)}`, matches: [] });
    }

    const events = await r.json();
    if (!Array.isArray(events)) return res.json({ ok: false, error: "unexpected_response", matches: [] });

    const matches = [];

    for (const evt of events) {
      const pinnacle = evt.bookmakers?.find(b => b.key === "pinnacle");
      if (!pinnacle) continue;

      const h2h    = pinnacle.markets?.find(m => m.key === "h2h");
      const totals = pinnacle.markets?.find(m => m.key === "totals");
      if (!h2h?.outcomes?.length) continue;

      let home = null, draw = null, away = null;
      for (const o of h2h.outcomes) {
        const pImp = 1 / o.price; // raw implied (overround)
        if (o.name.toLowerCase() === "draw")       draw = pImp;
        else if (o.name === evt.home_team)          home = pImp;
        else                                        away = pImp;
      }
      if (home == null || away == null) continue;

      // Over 2.5 from totals market
      let over25 = null;
      if (totals?.outcomes) {
        for (const o of totals.outcomes) {
          if (o.name === "Over" && Math.abs((o.point || 0) - 2.5) < 0.01) {
            over25 = +(1 / o.price).toFixed(4);
            break;
          }
        }
      }

      matches.push({
        homeTeam:     evt.home_team,
        awayTeam:     evt.away_team,
        commenceTime: evt.commence_time,
        home:  +home.toFixed(4),
        draw:  draw != null ? +draw.toFixed(4) : null,
        away:  +away.toFixed(4),
        over25,
      });
    }

    return res.json({ ok: true, matches, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, matches: [] });
  }
};
