/* ============================================================
 * Kalshi Weather — Server-side Kalshi proxy (v3 — auto-discover)
 *
 * ENV (one pair required):
 *   KALSHI_KEY_ID + KALSHI_PRIVATE_KEY  ← RSA API key (recommended)
 *   KALSHI_EMAIL  + KALSHI_PASSWORD     ← JWT fallback
 * ========================================================== */

const crypto = require("crypto");
const BASE = "https://trading-api.kalshi.com/trade-api/v2";

// ── RSA-PSS signing ───────────────────────────────────────────
function buildRsaHeaders(method, path) {
  const ts  = Date.now().toString();
  // Kalshi signs: timestamp + METHOD + /trade-api/v2<path>  (full URL path, no host)
  // Some implementations sign with query string, some without.
  // We sign the path AS PASSED so caller controls what gets signed.
  const msg = ts + method.toUpperCase() + path;
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

// ── JWT Token (email+password fallback) ──────────────────────
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
function normaliseMarket(m) {
  return {
    ticker:       m.ticker,
    subtitle:     m.subtitle,
    status:       m.status,
    result:       m.result,
    yes_bid:      m.yes_bid  != null ? +(m.yes_bid  / 100).toFixed(4) : null,
    yes_ask:      m.yes_ask  != null ? +(m.yes_ask  / 100).toFixed(4) : null,
    mid:          m.yes_bid != null && m.yes_ask != null
                    ? +((m.yes_bid + m.yes_ask) / 200).toFixed(4)
                    : m.result === "yes" ? 1.0
                    : m.result === "no"  ? 0.0
                    : null,
    volume:       m.volume,
    openInterest: m.open_interest,
  };
}

// ── Auto-discover: exact ticker → series fallback ─────────────
// Returns { markets[], resolvedTicker, debug{} }
async function findMarkets(ticker) {
  const dbg = { tried: [], errors: [] };

  // ① Exact event ticker
  try {
    dbg.tried.push(ticker);
    const d = await kalshiGet(`/markets?event_ticker=${encodeURIComponent(ticker)}&limit=20`);
    if (d.markets?.length > 0) return { markets: d.markets, resolvedTicker: ticker, dbg };
    dbg.errors.push(`${ticker}: 0 markets returned`);
  } catch (e) { dbg.errors.push(`${ticker}: ${e.message}`); }

  // ② Extract series prefix (e.g. KXHIGHMIA from KXHIGHMIA-26MAY26)
  const m = ticker.match(/^([A-Z0-9]+)-/);
  if (!m) return { markets: [], resolvedTicker: ticker, dbg };
  const series = m[1];

  // ③ List recent events for this series (no status filter → open+settled)
  let events = [];
  try {
    const ed = await kalshiGet(`/events?series_ticker=${encodeURIComponent(series)}&limit=10`);
    events = ed.events || [];
    dbg.seriesEvents = events.map(e => e.event_ticker);
  } catch (e) { dbg.errors.push(`series ${series}: ${e.message}`); }

  // ④ Try each discovered event ticker
  for (const ev of events) {
    if (ev.event_ticker === ticker) continue;
    try {
      dbg.tried.push(ev.event_ticker);
      const d = await kalshiGet(`/markets?event_ticker=${encodeURIComponent(ev.event_ticker)}&limit=20`);
      if (d.markets?.length > 0) {
        return { markets: d.markets, resolvedTicker: ev.event_ticker, dbg };
      }
      dbg.errors.push(`${ev.event_ticker}: 0 markets`);
    } catch (e) { dbg.errors.push(`${ev.event_ticker}: ${e.message}`); }
  }

  return { markets: [], resolvedTicker: ticker, dbg };
}

// ── Vercel handler ────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  // No caching — market prices change every few seconds
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
    const markets = raw.map(normaliseMarket);

    const payload = {
      markets,
      resolvedTicker,               // may differ from requested ticker if auto-discovered
      requestedTicker: ticker,
      fetchedAt: new Date().toISOString(),
      authMethod: hasKey ? "api-key" : "jwt",
      ...(showDebug ? { debug: dbg } : {}),
    };

    // If empty, include debug info automatically so the UI can surface it
    if (markets.length === 0) {
      payload.debug = dbg;
    }

    return res.status(200).json(payload);
  } catch (e) {
    if (String(e).includes("401")) { _token = null; _tokenExp = 0; }
    return res.status(500).json({ error: e.message });
  }
};
