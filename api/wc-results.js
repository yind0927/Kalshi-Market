/* ============================================================
 * /api/wc-results — batch fetch all completed WC 2026 matches
 *
 * Fetches ESPN scoreboard for the past 8 days and returns every
 * finished match with team names and scores. Used by the frontend
 * to auto-populate R2/R3 results without manual seeding.
 *
 * Response: { ok, results: [{ homeName, awayName, homeScore, awayScore }] }
 * ========================================================== */
"use strict";

const ESPN_LEAGUES = ["fifa.world", "world.world", "fifa.worldcup"];

async function fetchESPNScoreboard(dateStr) {
  const d = dateStr.replace(/-/g, "");
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; KalshiWeather/1.0)" };
  for (const league of ESPN_LEAGUES) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${d}&limit=50`;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const j = await r.json();
      if ((j.events || []).length > 0) return j.events;
    } catch { /* try next league */ }
  }
  return [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Fetch past 8 days to cover all recently completed group-stage matches
    const dates = [];
    const now = new Date();
    for (let i = -8; i <= 0; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const allEvents = (
      await Promise.all(dates.map(d => fetchESPNScoreboard(d).catch(() => [])))
    ).flat();

    const results = [];
    const seen = new Set();

    for (const evt of allEvents) {
      const comp = (evt.competitions || [])[0];
      if (!comp) continue;

      const typeName = comp.status?.type?.name || "";
      if (!typeName.includes("FINAL") && !typeName.includes("POST")) continue;

      const home = comp.competitors?.find(c => c.homeAway === "home");
      const away = comp.competitors?.find(c => c.homeAway === "away");
      if (!home || !away) continue;

      const homeScore = parseInt(home.score, 10);
      const awayScore = parseInt(away.score, 10);
      if (!isFinite(homeScore) || !isFinite(awayScore) || homeScore < 0 || awayScore < 0) continue;

      const homeName = home.team?.displayName || "";
      const awayName = away.team?.displayName || "";
      if (!homeName || !awayName) continue;

      // Deduplicate by team pair (same match can appear across date fetches)
      const key = [homeName, awayName].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ homeName, awayName, homeScore, awayScore });
    }

    return res.json({ ok: true, results, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, results: [] });
  }
};
