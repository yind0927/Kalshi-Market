/* ============================================================
 * /api/kalshi-status
 * Returns credential configuration status WITHOUT hitting Kalshi.
 * Used by the UI to show whether API is configured.
 * ========================================================== */
const crypto = require("crypto");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const keyId  = process.env.KALSHI_KEY_ID      || "";
  const pem    = (process.env.KALSHI_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const email  = process.env.KALSHI_EMAIL        || "";
  const hasPass= !!(process.env.KALSHI_PASSWORD);

  const hasApiKey = !!(keyId && pem);

  let keyValid = false;
  let keyError = null;
  if (hasApiKey) {
    try {
      crypto.createPrivateKey(pem);   // just parse, don't sign
      keyValid = true;
    } catch (e) {
      keyError = e.message.slice(0, 120);
    }
  }

  const method = hasApiKey
    ? (keyValid ? "api-key-ok" : "api-key-bad-pem")
    : (email && hasPass ? "jwt-password" : "none");

  return res.status(200).json({
    method,
    keyId:   keyId ? keyId.slice(0, 8) + "…" : null,   // partial for safety
    pemLines:pem ? pem.split("\n").length : 0,
    email:   email || null,
    keyValid,
    keyError,
    ready:   method === "api-key-ok" || method === "jwt-password",
  });
};
