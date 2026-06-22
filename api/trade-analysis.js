"use strict";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const {
    matchInfo,    // { home, away, competition, koBJT, venue }
    phase,        // "prematch" | "0-25" | "25-45" | "ht" | "45-70" | "70+"
    capital,      // number
    kalshiPrices, // { home, draw, away } in cents (0-100)
    pinnacleOdds, // { home, draw, away } | null
    currentScore, // { homeScore, awayScore, minute } | null
    positions,    // array of open trades
    userInput,    // user's free text description of current situation
    totalPnl,     // current float P&L
  } = req.body || {};

  if (!matchInfo || !phase || !capital) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const pc = (v) => v != null ? `${v}¢` : "—";

  let prompt = `比赛信息：
${matchInfo.home.flag} ${matchInfo.home.name}（${matchInfo.home.cn}）Elo ${matchInfo.home.elo} · FIFA #${matchInfo.home.fifaRank}
vs
${matchInfo.away.flag} ${matchInfo.away.name}（${matchInfo.away.cn}）Elo ${matchInfo.away.elo} · FIFA #${matchInfo.away.fifaRank}

赛事：${matchInfo.competition}
时间：${matchInfo.koBJT}（北京时间）
场地：${matchInfo.venue}

`;

  if (kalshiPrices) {
    prompt += `Kalshi 实时价格：
  ${matchInfo.home.cn}胜: ${pc(kalshiPrices.home)}  平局: ${pc(kalshiPrices.draw)}  ${matchInfo.away.cn}胜: ${pc(kalshiPrices.away)}\n\n`;
  }

  if (pinnacleOdds) {
    prompt += `Pinnacle 参考价格：
  ${matchInfo.home.cn}胜: ${pc(pinnacleOdds.home)}  平局: ${pc(pinnacleOdds.draw)}  ${matchInfo.away.cn}胜: ${pc(pinnacleOdds.away)}\n\n`;
  }

  prompt += `用户本场资金：${capital} 单位\n`;
  prompt += `当前阶段：${phase}\n`;

  if (currentScore) {
    prompt += `\n当前比分：${matchInfo.home.cn} ${currentScore.homeScore} – ${currentScore.awayScore} ${matchInfo.away.cn}（${currentScore.minute}'）\n`;
  }

  if (positions && positions.length > 0) {
    prompt += `\n当前持仓：\n`;
    for (const t of positions) {
      const out = t.outcome === "home" ? matchInfo.home.cn + "胜" :
                  t.outcome === "away" ? matchInfo.away.cn + "胜" : "平局";
      prompt += `  · ${out} ${t.direction} @ ${t.entryPrice}¢ · ${t.units} 单位\n`;
    }
    if (totalPnl != null) {
      prompt += `  浮盈亏：${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)} 单位\n`;
    }
  }

  if (userInput) {
    prompt += `\n当前场面描述（用户输入）：\n${userInput}\n`;
  }

  if (phase === "prematch") {
    prompt += `\n请给出这场比赛的完整交易策略分析。直接分析这两支球队的具体情况和当前市场定价机会，给出各时间段（0-25'、25'至中场、中场、45-70'、70'至终场）的交易思路和条件，不要使用通用框架。`;
  } else if (phase === "postmatch") {
    prompt += `\n请复盘这场比赛的交易策略，分析决策是否正确，有哪些可以改进的地方。`;
  } else {
    prompt += `\n请根据当前比赛情况和持仓状态，给出具体的操作建议（持有/加仓/减仓/平仓及理由）。`;
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1800,
        system: "你是一位专业的Kalshi足球预测市场交易员。你只交易主胜/平局/客胜（YES或NO方向）三种合约。分析应该直接、具体、可执行，不套用固定框架，每场比赛的策略因比赛而异。用中文回答。",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(500).json({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` });
    }
    const data = await r.json();
    const analysis = data.content?.[0]?.text || "";
    return res.json({ ok: true, analysis, phase });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
