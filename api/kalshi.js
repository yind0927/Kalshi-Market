/* ============================================================
 * Kalshi Weather — Server-side Kalshi proxy
 * Runs as a Vercel serverless function so credentials stay
 * server-side and we avoid browser CORS restrictions.
 *
 * Supports two auth methods (auto-detected):
 *
 * ── Method A: API Key (RSA-PSS) ── RECOMMENDED ───────────────
 *   KALSHI_KEY_ID       — Key ID from Kalshi Settings → API
 *   KALSHI_PRIVATE_KEY  — PEM private key (-----BEGIN PRIVATE KEY-----)
 *                         In Vercel: paste the full PEM including newlines
 *
 * ── Method B: Email + Password (JWT) ─────────────────────────
 *   KALSHI_EMAIL        — Kalshi account email
 *   KALSHI_PASSWORD     — Kalshi account password
 *
 * Method A is used if KALSHI_KEY_ID is set; otherwise Method B.
 * ========================================================== */

const crypto = require("crypto");

const BASE = "https://trading-api.kalshi.com/trade-api/v2";

// ── Method A: RSA-PSS signing ─────────────────────────────────
function buildRsaHeaders(method, path) {
  const timestamp = Date.now().toString();
  const message   = timestamp + method.toUpperCase() + path;

  // Support both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
  const pemRaw = process.env.KALSHI_PRIVATE_KEY || "";
  // Vercel stores newlines as literal \n in env vars — normalise
  const pem = pemRaw.replace(/\\n/g, "\n");

  const privateKey = crypto.createPrivateKey(pem);
  const signature  = crypto.sign("SHA256", Buffer.from(message), {
    key:        privateKey,
    padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    "KALSHI-ACCESS-KEY":       process.env.KALSHI_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
  };
}

// ── Method B: Email + Password (JWT) ─────────────────────────
let _token    = null;
let _tokenExp = 0;

async function getJwtToken() {
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
    throw new Error(`Kalshi login ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  _token    = data.token;
  _tokenExp = Date.now() + 20 * 60 * 1000; // cache 20 min
  return _token;
}

// ── Unified fetch with correct auth ──────────────────────────
async function kalshiFetch(method, path) {
  const useApiKey = !!(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);

  let headers = { "Content-Type": "application/json" };

  if (useApiKey) {
    Object.assign(headers, buildRsaHeaders(method, path));
  } else {
    const token = await getJwtToken();
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, { method, headers });

  if (!res.ok) {
    // On 401, clear JWT cache so next call re-logs in
    if (res.status === 401) { _token = null; _tokenExp = 0; }
    throw new Error(`Kalshi API ${res.status} ${method} ${path}`);
  }

  return res.json();
}

// ── Vercel handler ────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });

  // Check credentials
  const hasApiKey   = !!(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
  const hasPassword = !!(process.env.KALSHI_EMAIL  && process.env.KALSHI_PASSWORD);
  if (!hasApiKey && !hasPassword) {
    return res.status(500).json({
      error: "No Kalshi credentials. Set KALSHI_KEY_ID+KALSHI_PRIVATE_KEY (recommended) or KALSHI_EMAIL+KALSHI_PASSWORD in Vercel env vars.",
    });
  }

  try {
    const path = `/markets?event_ticker=${encodeURIComponent(ticker)}&status=open&limit=20`;
    const data = await kalshiFetch("GET", path);

    const markets = (data.markets || []).map(m => ({
      ticker:       m.ticker,
      subtitle:     m.subtitle,
      yes_bid:      m.yes_bid  != null ? +(m.yes_bid  / 100).toFixed(4) : null,
      yes_ask:      m.yes_ask  != null ? +(m.yes_ask  / 100).toFixed(4) : null,
      mid:          m.yes_bid != null && m.yes_ask != null
                      ? +((m.yes_bid + m.yes_ask) / 200).toFixed(4) : null,
      volume:       m.volume,
      openInterest: m.open_interest,
    }));

    return res.status(200).json({
      markets,
      fetchedAt: new Date().toISOString(),
      authMethod: hasApiKey ? "api-key" : "jwt",
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
