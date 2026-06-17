/* ============================================================
 * /api/live-score — live match score proxy
 *
 * Sources (tried in order):
 *   1. football-data.org  — free tier, requires FOOTBALL_DATA_API_KEY env var
 *      Register at https://www.football-data.org/client/register
 *   2. ESPN unofficial   — no key needed, works from Vercel
 *
 * Query params:
 *   homeTeam  — team name substring (default "France")
 *   awayTeam  — team name substring (default "Senegal")
 *   date      — YYYY-MM-DD (default today UTC)
 *
 * Response:
 *   { status, homeScore, awayScore, minute, homeTeam, awayTeam, source, fetchedAt }
 *   status: "prematch" | "live" | "ht" | "finished" | "unavailable"
 * ========================================================== */
"use strict";

const ESPN_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FD_BASE  = "https://api.football-data.org/v4";

function normalizeStatus(raw) {
  const s = (raw || "").toLowerCase();
  if (s.includes("in_play") || s.includes("in_progress") || s.includes("live")) return "live";
  if (s.includes("paused")  || s.includes("halftime")    || s.includes("half_time")) return "ht";
  if (s.includes("finished")|| s.includes("final")       || s.includes("full_time")) return "finished";
  if (s.includes("scheduled")|| s.includes("timed")      || s.includes("ns")) return "prematch";
  return "unknown";
}

function nameMatch(a, b) {
  if (!a || !b) return false;
  const al = a.toLowerCase(), bl = b.toLowerCase();
  return al.includes(bl.slice(0, 4)) || bl.includes(al.slice(0, 4));
}

// ── Source 1: football-data.org ───────────────────────────────
async function tryFootballData(homeTeam, awayTeam, date) {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("no key");

  // Fetch live + scheduled + paused + finished for the day
  const url = `${FD_BASE}/competitions/WC/matches?dateFrom=${date}&dateTo=${date}`;
  const r = await fetch(url, {
    headers: { "X-Auth-Token": key, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`FD ${r.status}`);
  const d = await r.json();

  for (const m of (d.matches || [])) {
    if (nameMatch(m.homeTeam?.name, homeTeam) && nameMatch(m.awayTeam?.name, awayTeam)) {
      const sc  = m.score || {};
      const ft  = sc.fullTime   || {};
      const ht  = sc.halfTime   || {};
      const reg = sc.regularTime || {};
      const homeScore = ft.home ?? ht.home ?? reg.home ?? null;
      const awayScore = ft.away ?? ht.away ?? reg.away ?? null;
      return {
        homeScore: homeScore ?? 0,
        awayScore: awayScore ?? 0,
        minute:    m.minute ?? 0,
        status:    normalizeStatus(m.status),
        homeTeam:  m.homeTeam?.name,
        awayTeam:  m.awayTeam?.name,
        source:    "football-data",
      };
    }
  }
  throw new Error("match not found");
}

// ── Source 2: ESPN unofficial (no key) ────────────────────────
async function tryESPN(homeTeam, awayTeam) {
  const r = await fetch(ESPN_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KalshiWeather/1.0)" },
  });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  const d = await r.json();

  for (const evt of (d.events || [])) {
    const comp = (evt.competitions || [])[0];
    if (!comp) continue;
    const home = comp.competitors?.find(c => c.homeAway === "home");
    const away = comp.competitors?.find(c => c.homeAway === "away");
    if (!home || !away) continue;
    const hName = home.team?.displayName || "";
    const aName = away.team?.displayName || "";
    if (nameMatch(hName, homeTeam) && nameMatch(aName, awayTeam)) {
      const clockStr = evt.status?.displayClock || "0'";
      const minute   = parseInt(clockStr.replace(/[^0-9]/g, "")) || 0;
      return {
        homeScore: parseInt(home.score || 0),
        awayScore: parseInt(away.score || 0),
        minute,
        status:   normalizeStatus(evt.status?.type?.name || ""),
        homeTeam: hName,
        awayTeam: aName,
        source:   "espn",
      };
    }
  }
  throw new Error("match not found");
}

// ── Handler ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, no-cache");
  if (req.method === "OPTIONS") return res.status(200).end();

  const {
    homeTeam = "France",
    awayTeam = "Senegal",
    date,
  } = req.query;

  const matchDate = date || new Date().toUTCString().slice(0,16).replace(/ /g,"-"); // fallback
  const isoDate   = date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const errors = [];

  // 1. football-data.org (most reliable if key set)
  try {
    const result = await tryFootballData(homeTeam, awayTeam, isoDate);
    return res.status(200).json({ ...result, fetchedAt: new Date().toISOString() });
  } catch (e) { errors.push(`football-data: ${e.message}`); }

  // 2. ESPN unofficial
  try {
    const result = await tryESPN(homeTeam, awayTeam);
    return res.status(200).json({ ...result, fetchedAt: new Date().toISOString() });
  } catch (e) { errors.push(`espn: ${e.message}`); }

  // All sources failed — return unavailable (not an error, match may just not have started)
  return res.status(200).json({
    status:     "unavailable",
    homeScore:  null,
    awayScore:  null,
    minute:     null,
    homeTeam:   null,
    awayTeam:   null,
    errors,
    source:     null,
    fetchedAt:  new Date().toISOString(),
  });
};
