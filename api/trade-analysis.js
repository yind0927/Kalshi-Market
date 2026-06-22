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
    pinnacleOdds, // { home, draw, away } in cents | null
    modelProbs,   // { home, draw, away } 0-1 from Bivariate Poisson + Elo | null
    currentScore, // { homeScore, awayScore, minute } | null
    positions,    // array of open trades
    userInput,    // user's free text description
    totalPnl,     // current float P&L
  } = req.body || {};

  if (!matchInfo || !phase || !capital) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const pc  = (v) => v != null ? `${v}¢` : "—";
  const pct = (v) => v != null ? `${(v * 100).toFixed(1)}%` : "—";
  const edge = (modelP, kalshiC) =>
    modelP != null && kalshiC != null
      ? `${((modelP - kalshiC / 100) * 100).toFixed(1)}%`
      : "—";

  const H = matchInfo.home;
  const A = matchInfo.away;

  let prompt = `## 比赛基本信息
${H.flag} **${H.cn}**（${H.name}）Elo ${H.elo} · FIFA 第${H.fifaRank}
${A.flag} **${A.cn}**（${A.name}）Elo ${A.elo} · FIFA 第${A.fifaRank}
赛事：${matchInfo.competition}　时间：${matchInfo.koBJT}（北京时间）　场地：${matchInfo.venue}
Elo差：${H.elo > A.elo ? H.cn : A.cn} 领先 ${Math.abs((H.elo || 0) - (A.elo || 0))} 分

`;

  // Pricing table with edge
  if (kalshiPrices || pinnacleOdds || modelProbs) {
    prompt += `## 定价对比（隐含概率）\n`;
    prompt += `标的         Kalshi    Pinnacle   模型       Edge(模型-Kalshi)\n`;
    prompt += `${H.cn}胜   ${pc(kalshiPrices?.home)}      ${pc(pinnacleOdds?.home)}      ${pct(modelProbs?.home)}   ${edge(modelProbs?.home, kalshiPrices?.home)}\n`;
    prompt += `平局         ${pc(kalshiPrices?.draw)}      ${pc(pinnacleOdds?.draw)}      ${pct(modelProbs?.draw)}   ${edge(modelProbs?.draw, kalshiPrices?.draw)}\n`;
    prompt += `${A.cn}胜   ${pc(kalshiPrices?.away)}      ${pc(pinnacleOdds?.away)}      ${pct(modelProbs?.away)}   ${edge(modelProbs?.away, kalshiPrices?.away)}\n\n`;
  }

  prompt += `本场资金：**${capital} 单位**　当前阶段：${phase}\n`;

  if (currentScore) {
    prompt += `当前比分：**${H.cn} ${currentScore.homeScore} – ${currentScore.awayScore} ${A.cn}**（${currentScore.minute}'）\n`;
  }

  if (positions && positions.length > 0) {
    prompt += `\n## 当前持仓\n`;
    for (const t of positions) {
      const out = t.outcome === "home" ? H.cn + "胜" : t.outcome === "away" ? A.cn + "胜" : "平局";
      prompt += `- ${out} ${t.direction} @ **${t.entryPrice}¢** · ${t.units} 单位\n`;
    }
    if (totalPnl != null) {
      prompt += `浮动盈亏：**${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)} 单位**\n`;
    }
  }

  if (userInput) {
    prompt += `\n## 用户描述当前局面\n${userInput}\n`;
  }

  if (phase === "prematch") {
    prompt += `
请基于以上数据，按如下结构输出完整赛前策略分析：

## 市场定价判断
分析Kalshi vs Pinnacle vs 模型各标的的定价差异，判断哪个标的存在可利用的边际（edge），哪个被高估或低估。

## 两队综合评估
结合Elo差距、FIFA排名，分析两队实际实力差距，以及在本次赛事背景下（世界杯）可能影响比赛走向的关键因素。

## 分时段交易计划
针对 0–25'、25'至中场、中场、45–70'、70'至终场 分别给出：有利于开仓的比赛情景、触发条件、建议方向（YES/NO）及目标标的。

## 资金管理
根据本场资金 ${capital} 单位，建议单笔仓位大小、最大总仓位、止损逻辑。`;
  } else if (phase === "postmatch") {
    prompt += `
请按如下结构输出赛后复盘分析：

## 整体交易表现
对本场所有持仓的整体评价，盈亏结果的合理性分析。

## 逐笔决策复盘
每笔交易的开仓时机、方向、价格是否合理，结果是运气还是判断正确。

## 改进建议
下次类似比赛应该如何优化入场时机、仓位管理和退出策略。`;
  } else {
    const periodName = {
      "0-25": "0–25分钟", "25-45": "25分钟至中场", ht: "中场休息",
      "45-70": "下半场45–70分钟", "70+": "70分钟至终场",
    }[phase] || phase;
    prompt += `
当前时段：${periodName}
请按如下结构输出实时分析：

## 当前局面判断
分析比分、时段、场面走势对三个标的（${H.cn}胜/平局/${A.cn}胜）当前概率的影响。

## 持仓评估
评估当前持仓的盈亏状态和继续持有的逻辑是否仍成立，是否需要调整。

## 操作建议
给出具体指令：持有 / 加仓（标的+方向+目标价格） / 减仓 / 平仓，并说明理由。

## 风险提示
当前最大风险情景是什么，如何设置止损。`;
  }

  const system = `你是一位专业的Kalshi足球预测市场交易员，专注1X2合约（主胜/平局/客胜，YES或NO方向）。
输出规范（必须严格遵守）：
- 使用 ## 作为主要章节标题
- 使用 **粗体** 标注关键数字、结论和操作指令
- 使用 - 开头的列表表达要点
- 分析直接、具体、可执行，每场因比赛和市场定价而异，不套固定框架
- 数字精确，给出明确的价格区间和仓位建议
- 用中文回答`;

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
        max_tokens: 2000,
        system,
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
