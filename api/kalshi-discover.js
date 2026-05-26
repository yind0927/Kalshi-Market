/* ============================================================
 * /api/kalshi-discover  — comprehensive API diagnostic
 * Visit this URL after deploy to see exactly what Kalshi returns.
 * ========================================================== */
const crypto = require("crypto");
const BASE = "https://api.elections.kalshi.com/trade-api/v2";

let _token = null, _tokenExp = 0;
async function getHeaders(method, path) {
  const keyId  = process.env.KALSHI_KEY_ID || "";
  const pemRaw = (process.env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (keyId && pemRaw) {
    const ts  = Date.now().toString();
    // Full path from API root, query params stripped (Kalshi spec)
    const pathForSig = ("/trade-api/v2" + path).split("?")[0];
    const msg = ts + method.toUpperCase() + pathForSig;
    const key = crypto.createPrivateKey(pemRaw);
    const sig = crypto.sign("SHA256", Buffer.from(msg), {
      key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64");
    return {
      "KALSHI-ACCESS-KEY":       keyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": sig,
    };
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

async function get(path) {
  try {
    const headers = await getHeaders("GET", path);
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, ok: res.ok, body, rawText: body ? null : text.slice(0, 300) };
  } catch (e) {
    return { status: 0, ok: false, body: null, error: e.message };
  }
}

function summariseMarkets(markets) {
  if (!markets || markets.length === 0) return { count: 0 };
  const events = [...new Set(markets.map(m => m.event_ticker))];
  return {
    count: markets.length,
    events,
    statuses: [...new Set(markets.map(m => m.status))],
    sample: markets.slice(0, 5).map(m => ({
      ticker:   m.ticker,
      subtitle: m.subtitle,
      event:    m.event_ticker,
      status:   m.status,
      yes_bid:  m.yes_bid_dollars,
      yes_ask:  m.yes_ask_dollars,
    })),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const now = new Date();
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const yy  = String(now.getUTCFullYear()).slice(2);
  const mmm = MONTHS[now.getUTCMonth()];
  const dd  = String(now.getUTCDate()).padStart(2, "0");
  const todayDate = `${yy}${mmm}${dd}`;  // e.g. 26MAY26

  // All known series + their today's event tickers
  const SERIES = [
    { name: "New York",    series: "KXHIGHNY"   },
    { name: "Miami",       series: "KXHIGHMIA"  },
    { name: "Chicago",     series: "KXHIGHCHI"  },
    { name: "Austin",      series: "KXHIGHAUS"  },
    { name: "Dallas",      series: "KXHIGHTDAL" },
    { name: "Los Angeles", series: "KXHIGHLAX"  },
    { name: "Denver",      series: "KXHIGHDEN"  },
  ];

  const results = {};

  await Promise.allSettled(SERIES.map(async ({ name, series }) => {
    const todayEvent = `${series}-${todayDate}`;
    const r = {};

    // A) series_ticker + status=open (our new primary approach)
    const a = await get(`/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=200`);
    r.series_open = a.ok ? summariseMarkets(a.body?.markets) : { error: `HTTP ${a.status}`, detail: a.error, rawText: a.rawText };

    // B) series_ticker without status filter — only run if A failed (save quota)
    if (a.ok) {
      r.series_all = { skipped: "A succeeded" };
    } else {
      const b = await get(`/markets?series_ticker=${encodeURIComponent(series)}&limit=200`);
      r.series_all = b.ok ? summariseMarkets(b.body?.markets) : { error: `HTTP ${b.status}`, detail: b.error, rawText: b.rawText };
    }

    // C) exact event_ticker for today
    const c = await get(`/markets?event_ticker=${encodeURIComponent(todayEvent)}&limit=50`);
    r.event_today = c.ok ? summariseMarkets(c.body?.markets) : { error: `HTTP ${c.status}`, detail: c.error, rawText: c.rawText };

    results[name] = { todayEvent, ...r };
  }));

  // Bonus: list all KXHIGH events to see what's available
  const eventsResp = await get(`/events?series_ticker_contains=KXHIGH&limit=50`);
  const events = eventsResp.ok
    ? (eventsResp.body?.events || []).map(e => ({ ticker: e.event_ticker, status: e.status }))
    : { error: `HTTP ${eventsResp.status}`, detail: eventsResp.error, rawText: eventsResp.rawText };

  return res.status(200).json({
    utcNow:   now.toISOString(),
    todayDate,
    results,
    allKxhighEvents: events,
  });
};
