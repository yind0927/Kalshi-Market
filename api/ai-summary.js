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
    const w = { ECMWF: "40%", HRRR: "30%", GFS: "20%", NAM: "10%" }[k] || "?%";
    return `  ${k}(${w}): ${m.dailyMax}°F 峰值${m.peakHour}:00`;
  }).join("\n");

  const corr = distribution?.corrections;
  const corrLine = corr
    ? `修正(站点${corr.station > 0 ? "+" : ""}${corr.station}°F · 风速${corr.wind}°F · 云量${corr.cloud}°F · 观测融合${corr.observation > 0 ? "+" : ""}${corr.observation}°F = 总${corr.total > 0 ? "+" : ""}${corr.total}°F)`
    : "";

  const prompt = `你是Kalshi天气预测市场的量化分析师，为中文用户提供简洁交易参考。

【${city} 今日最高气温合约】结算依据：NWS ASOS官方观测站读数

当前NWS实测：${observation?.temperature != null ? `${observation.temperature}°F` : "暂无"}${observation?.windSpeed != null ? ` · 风${observation.windCompass} ${observation.windSpeed}kt` : ""}

模型集合预测：
${modelLines}
加权均值：${distribution?.mean}°F → 修正后：${distribution?.adjustedMean}°F (σ=±${distribution?.adjustedStd}°F)
${corrLine}

各区间市场定价 vs 模型概率：
${bucketLines}

请用中文3句话给出：
1）最大Edge机会在哪个区间，买YES还是NO，净优势多少（已扣价差）
2）核心判断依据（哪项修正影响最大，模型是否有分歧）
3）主要风险（σ意味着什么，可能让预测失效的因素）

要求：数字具体，不超过80字，专业直接，不用"建议"/"推荐"等措辞。`;

  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model:      "claude-sonnet-4-6",   // Sonnet for higher-quality analysis
    max_tokens: 350,
    system: "你是一位专业的天气预测市场量化分析师，擅长从气象模型数据中提取交易信号。你的分析简洁、数字具体、不含废话。",
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
