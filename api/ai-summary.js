/* ============================================================
 * /api/ai-summary — Claude-powered real-time market analysis
 *
 * POST body: { city, distribution, observation, models }
 * ENV: ANTHROPIC_API_KEY
 * ========================================================== */
const Anthropic = require("@anthropic-ai/sdk");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured in Vercel env vars." });
  }

  const { city, distribution, observation, models } = req.body || {};
  if (!city) return res.status(400).json({ error: "city required" });

  // Build bucket summary from distribution.buckets (already merged market + model)
  const buckets = distribution?.buckets || [];
  const bucketLines = buckets.map(b => {
    const mid   = b.mid   != null ? Math.round(b.mid   * 100) : "—";
    const model = b.modelProb != null ? Math.round(b.modelProb * 100) : "—";
    const edge  = b.modelProb != null && b.mid != null
      ? Math.round((b.modelProb - b.mid) * 100) : "—";
    const netYes = b.modelProb != null && b.yes_ask != null
      ? Math.round((b.modelProb - b.yes_ask) * 100) : null;
    const netNo  = b.modelProb != null && b.yes_bid != null
      ? Math.round((b.yes_bid - b.modelProb) * 100) : null;
    let signal = "";
    if      (netYes != null && netYes > 3) signal = ` ✅BUY YES净+${netYes}¢`;
    else if (netNo  != null && netNo  > 3) signal = ` ✅BUY NO净+${netNo}¢`;
    else if (b.yes_bid != null)            signal = " —观望";
    return `  ${b.range || b.label}: 市场${mid}¢ 模型${model}% Edge${edge > 0 ? "+" : ""}${edge}pp${signal}`;
  }).join("\n");

  const modelLines = Object.entries(models || {}).map(([k, m]) => {
    const w = { HRRR: "35%", GFS: "30%", ICON: "25%", NAM: "10%" }[k] || "?%";
    return `  ${k}(${w}): ${m.dailyMax}°F 峰值${m.peakHour}:00`;
  }).join("\n");

  const corr = distribution?.corrections;
  const corrLine = corr
    ? `修正(站点${corr.station > 0 ? "+" : ""}${corr.station}°F · 风速${corr.wind}°F · 云量${corr.cloud}°F · 观测融合${corr.observation > 0 ? "+" : ""}${corr.observation}°F = 总${corr.total > 0 ? "+" : ""}${corr.total}°F)`
    : "";

  const prompt = `${city} 今天最高温合约（Kalshi，NWS ASOS结算）

现在实测：${observation?.temperature != null ? `${observation.temperature}°F` : "暂无"}${observation?.windSpeed != null ? `，风${observation.windCompass} ${observation.windSpeed}kt` : ""}

各模型：
${modelLines}
加权均值 ${distribution?.mean}°F → 修正后 ${distribution?.adjustedMean}°F（σ±${distribution?.adjustedStd}°F）
${corrLine}

市场 vs 模型概率：
${bucketLines}

用口语中文，像跟朋友说话，给我3条bullet point，每条以"•"开头，一条一行：
• 下注点：哪个区间最值得下，买YES还是NO，净赚多少分（已扣价差）
• 核心判断：哪个修正最影响结果，几个模型一不一致
• 主要风险：σ范围意味着什么，什么情况会翻车

每条1句话，数字要具体，总计不超过100字，不要废话。`;

  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 350,
    system: "你是一个在交易圈混的朋友，熟悉Kalshi天气预测市场。说话直接、口语化，不废话，数字具体，不用'建议''推荐'这种词。",
    messages:  [{ role: "user", content: prompt }],
  });

  return res.status(200).json({
    summary:     message.content[0].text,
    model:       message.model,
    tokens:      { input: message.usage.input_tokens, output: message.usage.output_tokens },
    generatedAt: new Date().toISOString(),
    city,
  });
};
