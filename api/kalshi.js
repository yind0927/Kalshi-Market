/* ============================================================
 * Kalshi Weather — Server-side Kalshi proxy (v4 — robust discovery)
 *
 * ENV (one pair required):
 *   KALSHI_KEY_ID + KALSHI_PRIVATE_KEY  ← RSA API key (recommended)
 *   KALSHI_EMAIL  + KALSHI_PASSWORD     ← JWT fallback
 * ========================================================== */

const crypto = require("crypto");
const BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ── RSA-PSS signing ───────────────────────────────────────────
// Kalshi requires: timestamp + METHOD + /trade-api/v2/path  (NO query params)
function buildRsaHeaders(method, apiPath) {
  const ts  = Date.now().toString();
  // Full path from API root, query params stripped (Kalshi spec)
  const pathForSig = ("/trade-api/v2" + apiPath).split("?")[0];
  const msg = ts + method.toUpperCase() + pathForSig;
  const pem = (process.env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const key = crypto.createPrivateKey(pem);
  const sig = crypto.sign("SHA256", Buffer.from(msg), {
    key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
  return {
    "KALSHI-ACCESS-KEY":       process.env.KALSHI_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig,
  };
}

// ── JWT Token fallback ────────────────────────────────────────
let _token = null, _tokenExp = 0;
async function getJwtToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const r = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.KALSHI_EMAIL, password: process.env.KALSHI_PASSWORD }),
  });
  if (!r.ok) throw new Error(`Kalshi login ${r.status}`);
  const d = await r.json();
  _token = d.token; _tokenExp = Date.now() + 20 * 60 * 1000;
  return _token;
}

// ── Core authenticated GET ────────────────────────────────────
async function kalshiGet(apiPath) {
  const useKey = !!(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
  const hdrs = { "Content-Type": "application/json" };
  if (useKey) {
    Object.assign(hdrs, buildRsaHeaders("GET", apiPath));
  } else {
    hdrs["Authorization"] = `Bearer ${await getJwtToken()}`;
  }
  const r = await fetch(`${BASE}${apiPath}`, { headers: hdrs });
  if (!r.ok) {
    if (r.status === 401) { _token = null; _tokenExp = 0; }
    throw new Error(`Kalshi ${r.status} GET ${apiPath}`);
  }
  return r.json();
}

// ── Market data normaliser ────────────────────────────────────
// Kalshi returns _dollars fields as strings (e.g. "0.4800"), so parseFloat first.
function normaliseMarket(m) {
  const bid = m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : null;
  const ask = m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : null;
  return {
    ticker:       m.ticker,
    subtitle:     m.subtitle,
    status:       m.status,
    result:       m.result,
    yes_bid:      bid != null ? +bid.toFixed(4) : null,
    yes_ask:      ask != null ? +ask.toFixed(4) : null,
    mid:          bid != null && ask != null
                    ? +((bid + ask) / 2).toFixed(4)
                    : m.result === "yes" ? 1.0
                    : m.result === "no"  ? 0.0
                    : null,
    volume:       m.volume_fp       != null ? parseFloat(m.volume_fp)       : null,
    openInterest: m.open_interest_fp != null ? parseFloat(m.open_interest_fp) : null,
  };
}

// ── Synthetic subtitle from ticker suffix ─────────────────────
// Some Kalshi cities (LA, Dallas) return markets with no subtitle.
// We infer the human-readable range from the ticker suffix:
//   B{N.5} → "{floor(N)}° to {ceil(N)}°"  e.g. B68.5 → "68° to 69°"
//   T{N} (lowest)  → "{N}° or below"       e.g. T62 → "62° or below"
//   T{N} (others)  → "{N+1}° or above"     e.g. T69 → "70° or above", T84 → "85° or above"
function addSyntheticSubtitles(markets) {
  if (markets.every(m => m.subtitle)) return markets; // all have subtitles already

  // Collect T{N} values to identify the lower tail (smallest T = lower bound)
  const tNums = markets
    .map(m => { const s = m.ticker.split("-").pop(); const r = s.match(/^T(\d+(?:\.\d+)?)/); return r ? parseFloat(r[1]) : null; })
    .filter(n => n !== null)
    .sort((a, b) => a - b);
  const lowerTailN = tNums.length >= 2 ? tNums[0] : null;

  return markets.map(m => {
    if (m.subtitle) return m; // keep existing subtitle

    const suffix = m.ticker.split("-").pop();

    // B{N} bucket — N.5 means 1°F range centred at N
    const bm = suffix.match(/^B(\d+(?:\.\d+)?)$/);
    if (bm) {
      const n = parseFloat(bm[1]);
      const lo = Math.floor(n), hi = Math.ceil(n);
      const sub = lo === hi ? `${lo}° or below` : `${lo}° to ${hi}°`;
      return { ...m, subtitle: sub };
    }

    // T{N} tail bucket
    const tm = suffix.match(/^T(\d+(?:\.\d+)?)$/);
    if (tm) {
      const n = parseFloat(tm[1]);
      const sub = (n === lowerTailN) ? `${n}° or below` : `${n + 1}° or above`;
      return { ...m, subtitle: sub };
    }

    return m;
  });
}

// ── Date helpers ─────────────────────────────────────────────
const MONTHS_ABB = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function todayKalshiSuffix() {
  // Returns YYMONDD in UTC — e.g. "26MAY26" for May 26 2026
  const now = new Date();
  const yy  = String(now.getUTCFullYear()).slice(2);
  const mon = MONTHS_ABB[now.getUTCMonth()];
  const dd  = String(now.getUTCDate()).padStart(2, "0");
  return `${yy}${mon}${dd}`;
}

// ── Group markets by event_ticker ─────────────────────────────
function groupByEvent(markets) {
  const groups = {};
  for (const m of markets) {
    const et = m.event_ticker || "unknown";
    if (!groups[et]) groups[et] = [];
    groups[et].push(m);
  }
  return groups;
}

// Pick today's group, or fall back to the largest group in the result set
function pickBestGroup(groups, todayEventTicker) {
  // Exact match for today
  if (groups[todayEventTicker]?.length) {
    return { markets: groups[todayEventTicker], ticker: todayEventTicker };
  }
  // Partial match (e.g. event ticker uses a different suffix format)
  const todaySuffix = todayEventTicker.split("-").slice(1).join("-");
  for (const [et, mks] of Object.entries(groups)) {
    if (et.includes(todaySuffix)) return { markets: mks, ticker: et };
  }
  // Last resort: group with most markets (most likely today's event)
  const best = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)[0];
  return best ? { markets: groups[best], ticker: best } : { markets: [], ticker: null };
}

// ── Main discovery (4-step, series_ticker as primary) ─────────
// Confirmed working approach from Kalshi weather-trading bots:
//   GET /markets?series_ticker=KXHIGHNY&status=open&limit=200
// (event_ticker filter is unreliable/not always supported as query param)
async function findMarkets(ticker) {
  const dbg = { tried: [], errors: [] };

  // Extract series prefix: KXHIGHMIA-26MAY26 → KXHIGHMIA
  const sm = ticker.match(/^([A-Z0-9]+)-/);
  const series = sm ? sm[1] : ticker;

  // Compute today's canonical event ticker server-side
  // (don't trust the client-supplied date in ticker)
  const todaySuffix      = todayKalshiSuffix();
  const todayEventTicker = `${series}-${todaySuffix}`;
  dbg.series         = series;
  dbg.todayTicker    = todayEventTicker;
  dbg.requestedTicker = ticker;

  // ⓪ Fully-specified event ticker (suffix beyond the YYMONDD date, e.g.
  //   KXWCGAME-26JUN16FRASEN) → the exact event is authoritative because many
  //   events share the same series+date (multiple matches per day). Look it up
  //   directly FIRST. Weather tickers (KXHIGHNY-26MAY26, date-only suffix)
  //   don't match this and fall through to the discovery steps unchanged.
  const isFullEvent = /^[A-Z0-9]+-\d{2}[A-Z]{3}\d{2}.+$/.test(ticker);
  if (isFullEvent) {
    try {
      dbg.tried.push(`exact:${ticker}`);
      const d = await kalshiGet(`/markets?event_ticker=${encodeURIComponent(ticker)}&limit=50`);
      if (d.markets?.length > 0) return { markets: d.markets, resolvedTicker: ticker, dbg };
      dbg.errors.push(`exact ${ticker}: 0 markets`);
    } catch (e) { dbg.errors.push(`exact ${ticker}: ${e.message}`); }
  }

  // ① series_ticker + status=open — primary confirmed approach
  //   Returns all currently open markets for the series (may include today + tomorrow);
  //   group by event_ticker to isolate today's markets.
  try {
    dbg.tried.push(`${series}?open`);
    const d = await kalshiGet(
      `/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200`
    );
    dbg.openCount = d.markets?.length ?? 0;
    if (d.markets?.length > 0) {
      const groups = groupByEvent(d.markets);
      dbg.openEvents = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
      const { markets, ticker: resolved } = pickBestGroup(groups, todayEventTicker);
      if (markets.length > 0) return { markets, resolvedTicker: resolved, dbg };
    }
    dbg.errors.push(`${series} open: 0 markets`);
  } catch (e) { dbg.errors.push(`${series} open: ${e.message}`); }

  // ② Direct event_ticker lookup (today's server-computed ticker)
  try {
    dbg.tried.push(`event:${todayEventTicker}`);
    const d = await kalshiGet(
      `/markets?event_ticker=${encodeURIComponent(todayEventTicker)}&limit=20`
    );
    if (d.markets?.length > 0) return { markets: d.markets, resolvedTicker: todayEventTicker, dbg };
    dbg.errors.push(`${todayEventTicker}: 0 markets`);
  } catch (e) { dbg.errors.push(`${todayEventTicker}: ${e.message}`); }

  // ③ Client-supplied ticker (may differ from server-computed; fallback for NYC-like cases)
  if (ticker !== todayEventTicker) {
    try {
      dbg.tried.push(`event:${ticker}`);
      const d = await kalshiGet(
        `/markets?event_ticker=${encodeURIComponent(ticker)}&limit=20`
      );
      if (d.markets?.length > 0) return { markets: d.markets, resolvedTicker: ticker, dbg };
      dbg.errors.push(`${ticker}: 0 markets`);
    } catch (e) { dbg.errors.push(`${ticker}: ${e.message}`); }
  }

  // ④ series_ticker without status filter (catches already-settled markets for today)
  try {
    dbg.tried.push(`${series}?all`);
    const d = await kalshiGet(
      `/markets?series_ticker=${encodeURIComponent(series)}&limit=200`
    );
    if (d.markets?.length > 0) {
      const groups = groupByEvent(d.markets);
      dbg.allEvents = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
      const { markets, ticker: resolved } = pickBestGroup(groups, todayEventTicker);
      if (markets.length > 0) return { markets, resolvedTicker: resolved, dbg };
    }
    dbg.errors.push(`${series} all: 0 markets`);
  } catch (e) { dbg.errors.push(`${series} all: ${e.message}`); }

  return { markets: [], resolvedTicker: ticker, dbg };
}

// ── Vercel handler ────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, no-cache");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker, debug: showDebug } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });

  const hasKey = !!(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
  const hasJwt = !!(process.env.KALSHI_EMAIL  && process.env.KALSHI_PASSWORD);
  if (!hasKey && !hasJwt) {
    return res.status(500).json({ error: "No Kalshi credentials configured in Vercel env vars." });
  }

  try {
    const { markets: raw, resolvedTicker, dbg } = await findMarkets(ticker);
    const withSubtitles = addSyntheticSubtitles(raw); // fill missing subtitles from ticker suffix
    const markets = withSubtitles.map(normaliseMarket);

    const payload = {
      markets,
      resolvedTicker,
      requestedTicker: ticker,
      fetchedAt: new Date().toISOString(),
      authMethod: hasKey ? "api-key" : "jwt",
      ...(showDebug ? { debug: dbg } : {}),
    };

    if (markets.length === 0) payload.debug = dbg;

    return res.status(200).json(payload);
  } catch (e) {
    if (String(e).includes("401")) { _token = null; _tokenExp = 0; }
    return res.status(500).json({ error: e.message });
  }
};
