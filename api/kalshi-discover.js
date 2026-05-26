/* ============================================================
 * /api/kalshi-discover
 * Diagnostic: tries a list of tickers and reports what Kalshi
 * actually returns (markets count, subtitles, statuses).
 * Usage: GET /api/kalshi-discover
 * ========================================================== */
const crypto = require("crypto");

const BASE = "https://trading-api.kalshi.com/trade-api/v2";

// ── Reuse auth logic from kalshi.js (duplicated to keep files independent) ──
let _token = null, _tokenExp = 0;
async function getHeaders(method, path) {
  const keyId = process.env.KALSHI_KEY_ID || "";
  const pemRaw = (process.env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (keyId && pemRaw) {
    const ts  = Date.now().toString();
    const msg = ts + method.toUpperCase() + path;
    const key = crypto.createPrivateKey(pemRaw);
    const sig = crypto.sign("SHA256", Buffer.from(msg), {
      key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64");
    return { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig };
  }
  if (!_token || Date.now() >= _tokenExp) {
    const r = await fetch(`${BASE}/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.KALSHI_EMAIL, password: process.env.KALSHI_PASSWORD }),
    });
    const d = await r.json();
    _token = d.token; _tokenExp = Date.now() + 20*60*1000;
  }
  return { Authorization: `Bearer ${_token}` };
}

async function kalshiGet(path) {
  const headers = await getHeaders("GET", path);
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) return { error: res.status };
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  // Candidate tickers to probe (all without status filter)
  const today = new Date();
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const dd  = String(today.getUTCDate()).padStart(2,"0");
  const mmm = months[today.getUTCMonth()];
  const yy  = String(today.getUTCFullYear()).slice(2);
  const date = `${dd}${mmm}${yy}`;   // e.g. "26MAY26"

  const tickers = [
    // Miami
    `KXHIGHMIA-${date}`, `KXHIGHMIAMI-${date}`, `KXHIGHFL-${date}`,
    // Chicago
    `KXHIGHCHI-${date}`, `KXHIGHORD-${date}`, `KXHIGHIL-${date}`,
    // Austin
    `KXHIGHAUS-${date}`, `KXHIGHAUSTIN-${date}`, `KXHIGHTX-${date}`,
    // Dallas
    `KXHIGHDFW-${date}`, `KXHIGHDAL-${date}`,
    // Los Angeles
    `KXHIGHLAX-${date}`, `KXHIGHLA-${date}`, `KXHIGHCA-${date}`,
    // NYC sanity check
    `KXHIGHNY-${date}`, `KXHIGHNYC-${date}`,
  ];

  const results = {};
  await Promise.allSettled(
    tickers.map(async t => {
      const d = await kalshiGet(`/markets?event_ticker=${encodeURIComponent(t)}&limit=10`);
      const markets = d.markets || [];
      results[t] = {
        count:    markets.length,
        statuses: [...new Set(markets.map(m => m.status))],
        subtitles:markets.slice(0,3).map(m => m.subtitle),
        error:    d.error || null,
      };
    })
  );

  // Also try searching events by series prefix
  const seriesProbe = await kalshiGet(`/events?series_ticker_contains=KXHIGH&limit=50`).catch(() => ({}));

  return res.status(200).json({
    date,
    marketProbes: results,
    seriesEvents: (seriesProbe.events || []).map(e => ({
      ticker: e.event_ticker,
      title:  e.title,
      status: e.status,
    })),
  });
};
