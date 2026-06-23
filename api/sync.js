/* ============================================================
 * /api/sync — per-match cloud storage via Vercel KV
 * GET  /api/sync?matchId=xxx        → read all data for match
 * POST /api/sync {matchId, patch}   → merge patch (null = delete field)
 * ========================================================== */

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL      = 90 * 24 * 3600; // 90-day expiry

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}

async function kvPipeline(commands) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const matchId = req.method === "GET" ? req.query.matchId : req.body?.matchId;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  const key = `wc_match_${matchId}`;

  if (req.method === "GET") {
    try { return res.json(await kvGet(key) || {}); }
    catch { return res.json({}); }
  }

  if (req.method === "POST") {
    const { patch } = req.body || {};
    if (!patch) return res.status(400).json({ error: "patch required" });
    try {
      const current = await kvGet(key) || {};
      const updated = { ...current };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete updated[k];
        else updated[k] = v;
      }
      if (Object.keys(updated).length === 0) {
        await kvPipeline([["DEL", key]]);
      } else {
        await kvPipeline([["SET", key, JSON.stringify(updated), "EX", String(TTL)]]);
      }
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
