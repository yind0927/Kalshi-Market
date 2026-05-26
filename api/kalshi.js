/* ============================================================
 * Kalshi Weather — Server-side Kalshi proxy
 * Runs as a Vercel serverless function so credentials stay
 * server-side and we avoid browser CORS restrictions.
 *
 * ENV required:
 *   KALSHI_EMAIL    — Kalshi account email
 *   KALSHI_PASSWORD — Kalshi account password
 * ========================================================== */

const BASE = "https://trading-api.kalshi.com/trade-api/v2";

// Module-level token cache (persists within one warm function instance)
let _token    = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email:    process.env.KALSHI_EMAIL,
      password: process.env.KALSHI_PASSWORD,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kalshi login ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = await res.json();
  _token    = data.token;
  _tokenExp = Date.now() + 20 * 60 * 1000; // cache 20 min
  return _token;
}

module.exports = async function handler(req, res) {
  // CORS — allow our own Vercel domain + localhost dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });

  if (!process.env.KALSHI_EMAIL || !process.env.KALSHI_PASSWORD) {
    return res.status(500).json({ error: "KALSHI_EMAIL / KALSHI_PASSWORD env vars not set" });
  }

  try {
    const token = await getToken();

    const url = `${BASE}/markets?event_ticker=${encodeURIComponent(ticker)}&status=open&limit=20`;
    const mres = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` },
    });

    if (!mres.ok) {
      if (mres.status === 401) { _token = null; _tokenExp = 0; } // force re-login next call
      throw new Error(`Kalshi markets API ${mres.status}`);
    }

    const data = await mres.json();
    const markets = (data.markets || []).map(m => ({
      ticker:      m.ticker,
      subtitle:    m.subtitle,
      yes_bid:     m.yes_bid  != null ? +(m.yes_bid  / 100).toFixed(4) : null,
      yes_ask:     m.yes_ask  != null ? +(m.yes_ask  / 100).toFixed(4) : null,
      mid:         m.yes_bid != null && m.yes_ask != null
                     ? +((m.yes_bid + m.yes_ask) / 200).toFixed(4) : null,
      volume:      m.volume,
      openInterest:m.open_interest,
    }));

    return res.status(200).json({ markets, fetchedAt: new Date().toISOString() });

  } catch (e) {
    if (String(e).includes("401")) { _token = null; _tokenExp = 0; }
    return res.status(500).json({ error: e.message });
  }
};
