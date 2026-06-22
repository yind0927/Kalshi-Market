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
    matchInfo,
    phase,
    capital,
    kalshiPrices,
    pinnacleOdds,
    modelProbs,
    currentScore,
    positions,
    userInput,
    totalPnl,
    followUpQuestion,
    previousAnalysis,
  } = req.body || {};

  if (!matchInfo || !phase || !capital) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const pc  = (v) => v != null ? `${v}¢` : "—";
  const pct = (v) => v != null ? `${(v * 100).toFixed(1)}%` : "—";
  const edgeStr = (modelP, kalshiC) =>
    modelP != null && kalshiC != null
      ? `${((modelP - kalshiC / 100) * 100).toFixed(1)}%`
      : "—";

  // Quarter-Kelly position sizing (capped at 20% of capital)
  const kellyStr = (modelP, kalshiC) => {
    if (modelP == null || kalshiC == null) return "—";
    const edge = modelP - kalshiC / 100;
    if (edge <= 0.01) return "无优势";
    // binary Kelly: f* = edge / (1 - modelP), then quarter-Kelly
    const qk = Math.min((edge / (1 - modelP)) * 0.25, 0.20);
    return `${(qk * 100).toFixed(1)}% (${(qk * capital).toFixed(0)}u)`;
  };

  const H = matchInfo.home;
  const A = matchInfo.away;

  let prompt = `## 比赛信息
${H.flag} **${H.cn}**（${H.name}）Elo ${H.elo} · FIFA 第${H.fifaRank}名
${A.flag} **${A.cn}**（${A.name}）Elo ${A.elo} · FIFA 第${A.fifaRank}名
赛事：${matchInfo.competition}　时间：${matchInfo.koBJT}（北京时间）　场地：${matchInfo.venue}
Elo差：${H.elo > A.elo ? H.cn : A.cn} 领先 ${Math.abs((H.elo || 0) - (A.elo || 0))} 分

`;

  if (kalshiPrices || pinnacleOdds || modelProbs) {
    prompt += `## 定价对比
标的          Kalshi     Pinnacle    模型概率    Edge(模型-K)   1/4Kelly仓位
${H.cn}胜    ${pc(kalshiPrices?.home).padEnd(8)} ${pc(pinnacleOdds?.home).padEnd(9)} ${pct(modelProbs?.home).padEnd(9)} ${edgeStr(modelProbs?.home, kalshiPrices?.home).padEnd(12)} ${kellyStr(modelProbs?.home, kalshiPrices?.home)}
平局          ${pc(kalshiPrices?.draw).padEnd(8)} ${pc(pinnacleOdds?.draw).padEnd(9)} ${pct(modelProbs?.draw).padEnd(9)} ${edgeStr(modelProbs?.draw, kalshiPrices?.draw).padEnd(12)} ${kellyStr(modelProbs?.draw, kalshiPrices?.draw)}
${A.cn}胜    ${pc(kalshiPrices?.away).padEnd(8)} ${pc(pinnacleOdds?.away).padEnd(9)} ${pct(modelProbs?.away).padEnd(9)} ${edgeStr(modelProbs?.away, kalshiPrices?.away).padEnd(12)} ${kellyStr(modelProbs?.away, kalshiPrices?.away)}

`;
  }

  prompt += `本场资金：**${capital} 单位**　当前阶段：${phase}\n`;

  if (currentScore) {
    prompt += `当前比分：**${H.cn} ${currentScore.homeScore} – ${currentScore.awayScore} ${A.cn}**（第 ${currentScore.minute} 分钟）\n`;
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
    prompt += `\n## 场面描述（用户输入）\n${userInput}\n`;
  }

  // Q&A follow-up mode
  if (followUpQuestion && previousAnalysis) {
    prompt += `\n## 之前分析（摘要）\n${previousAnalysis.slice(0, 2000)}\n`;
    prompt += `\n## 追加提问\n${followUpQuestion}\n\n`;
    prompt += `请针对以上提问给出简洁直接的回答，结合最新数据和之前分析背景，**粗体**标注关键结论，3–8句为宜。`;

  } else if (phase === "prematch") {
    prompt += `
请基于以上数据，按如下结构输出完整赛前策略分析（600–900字）：

## 市场定价解读
精确分析三家来源（Kalshi / Pinnacle / 模型）的定价差异。哪个标的有正向Edge？Edge是否达到可操作阈值（>3%）？Pinnacle与模型方向若一致，说明市场共识；若有分歧，判断哪方更可信及原因。

## 实力与赛事背景
结合Elo差距和FIFA排名量化两队强弱。分析世界杯背景下的特殊因素：晋级形势与压力差异、中性场地影响、近期状态与伤病（如已知）、历史交锋倾向（如有参考价值）。

## 赛前开仓策略
针对存在正向Edge的标的，给出具体开仓计划：
- **目标标的与方向**：明确哪个结果的YES或NO（若无显著Edge则明确说明不建议赛前强入）
- **入场价格区间**：建议在 X¢–Y¢ 之间入场；超出此区间不追单
- **开盘确认逻辑**：是否等待开盘后5分钟观察流动性和方向再入
- **首仓规模**：基于1/4Kelly，建议首仓约 N 单位（资金的 X%）；保留余量用于实时加仓
- **多个Edge机会时**：按优先级排序，说明哪个优先级更高

## 分时段交易计划
5个阶段（0–25'、25–45'、中场、45–70'、70+）各给出：
有利于开仓的比赛情景 → 触发条件 → 方向（YES/NO）→ 建议价格区间

## 资金管理与止损
单笔最大仓位 / 本场最大总仓位 / 具体止损触发条件（价格或比分情景）/ 需避免的常见操作错误`;

  } else if (phase === "postmatch") {
    prompt += `
请按如下结构输出赛后复盘分析（400–600字）：

## 整体交易表现
总体评价：盈亏结果合理性、执行纪律评分（1–10分）、是否按赛前计划执行。

## 逐笔决策复盘
每笔交易的入场时机、方向依据、结果属于有边际优势的决策还是随机结果。

## 模型与市场验证
赛果与赛前模型/Pinnacle预测的吻合程度，哪些信号有效，哪些误导了判断。

## 改进建议
下次相似比赛（Elo差距相近）在入场时机、仓位管理、退出策略和信息使用上的具体优化方向。`;

  } else {
    const periodName = {
      "0-25": "0–25分钟", "25-45": "25分钟至中场", ht: "中场休息",
      "45-70": "下半场45–70分钟", "70+": "70分钟至终场",
    }[phase] || phase;

    prompt += `
当前时段：**${periodName}**
请按如下结构输出实时交易分析（500–700字）：

## 当前局面判断
结合比分、时段、场面描述，分析三个结果（${H.cn}胜/平局/${A.cn}胜）的实时概率相对于赛前的变化方向与幅度。分析比分对剩余时间内各结果可能性的影响，以及场面控制权归属对后续走势的预判。

## 比分情景树
列出接下来最可能的2–3个比分变化情景（如"${H.cn}再进1球"、"${A.cn}扳平"、"维持现状"），每个情景下三标的概率的预期变化方向，对应Kalshi价格的大致冲击幅度。

## 持仓评估
当前每笔持仓的盈亏现状、原始入场逻辑是否仍成立、继续持有的理由。是否存在可对冲或部分止盈的机会？

## 操作建议
给出明确指令：
- **持有**：哪些仓位不动，理由
- **加仓**：目标标的 + YES/NO + 入场价格区间 + 建议单位数
- **减仓/平仓**：在什么价格或比分情景下执行，具体触发条件

## 风险提示
当前最大尾部风险情景（如红牌、意外失球），对Kalshi价格的预期冲击幅度，止损触发条件与执行方式。`;
  }

  const system = `你是一位专业的Kalshi足球预测市场交易员，专注1X2合约（主胜/平局/客胜），拥有统计模型背景与大量实战经验。

【Kalshi市场机制】
- 1X2合约为二元合约：对应结果发生时YES结算100¢，否则0¢；买入YES @ P¢意味着花P¢换取胜出时100¢
- 三标的之和通常105–108¢（含Kalshi spread/手续费），故不能简单套利
- Pinnacle赔率被视为全球体育预测市场最高效定价参考，与其一致时信心更高
- **Edge阈值**：Edge < 2% 通常不值得入场；2–4% 谨慎小仓；> 4% 可正常仓位；> 7% 可加仓
- **1/4 Kelly**：full Kelly风险过大，实战建议使用1/4 Kelly控制单笔波动；连续亏损时进一步降仓

【世界杯特点】
- 小组赛在中性场地进行，主客场优势不适用；两队均有不同程度的晋级压力
- 平局概率高于常规联赛（约28–32%），应在定价对比中特别关注平局标的
- Elo模型对强弱差距显著的比赛（Elo差>100）预测置信度更高
- 强队对阵弱队时，大分差胜利概率上升，影响1X2之外的盘口

【分析原则】
- 输出具体可执行：给出明确价格区间（如"32¢–36¢"），不用"大约"、"可能"等模糊表达
- Edge不显著时，明确说"无明显入场机会"，不强行找理由
- 区分"有统计优势的决策"与"运气结果"，避免结果导向评价
- 承认不确定性：模型预测基于历史数据，实时场面信息有更高优先级

【输出规范】
- 使用 ## 作为章节标题，**粗体**标注关键数字/结论/操作指令，- 列表表达要点
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
        max_tokens: 3000,
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
    return res.json({ ok: true, analysis, phase, isQA: !!(followUpQuestion) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
