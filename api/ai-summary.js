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
    return `  ${k}: ${m.dailyMax}°F  peak ${m.peakHour != null ? String(m.peakHour).padStart(2,"0") + ":00" : "—"}`;
  }).join("\n");

  const corr = distribution?.corrections;
  const corrLine = corr
    ? `修正(站点${corr.station > 0 ? "+" : ""}${corr.station}°F · 风速${corr.wind}°F · 云量${corr.cloud}°F · 观测融合${corr.observation > 0 ? "+" : ""}${corr.observation}°F = 总${corr.total > 0 ? "+" : ""}${corr.total}°F)`
    : "";

  const prompt = `Kalshi Daily High Contract — ${city} (settles on NWS ASOS official max)

Current observation: ${observation?.temperature != null ? `${observation.temperature}°F` : "unavailable"}${observation?.windSpeed != null ? `, wind ${observation.windCompass} ${observation.windSpeed}kt` : ""}

Model forecasts (equal-weighted ensemble):
${modelLines}
Ensemble mean ${distribution?.mean}°F → corrected ${distribution?.adjustedMean}°F (σ ±${distribution?.adjustedStd}°F)
${corrLine}

Market vs model probability by bucket:
${bucketLines}

Provide exactly 3 bullet points in Chinese, each starting with "•" on its own line:
• 交易信号：最具优势的区间，方向（YES/NO），净边际（扣除价差后），用具体数字
• 预报分析：模型一致性，关键修正因子及其影响幅度
• 风险提示：σ范围含义，可能导致预测失效的主要气象因素

要求：每条不超过40字，专业客观，数字精确，不加主观评价词。`;

  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: "你是一位量化气象交易分析师，专注于Kalshi天气衍生品市场。输出风格：专业、简洁、数据驱动。直接陈述事实和数据，不使用主观评价或情绪化语言。中文输出。",
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
