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

  // Derive Pinnacle-based fair price zone for reference (±3¢ around de-vigged Pinnacle)
  const fairZone = (pinP) => {
    if (pinP == null) return "—";
    const fair = Math.round(pinP * 100);
    return `${fair - 3}–${fair + 2}¢`;
  };

  const H = matchInfo.home;
  const A = matchInfo.away;
  const eloDiff = Math.abs((H.elo || 0) - (A.elo || 0));
  const stronger = H.elo >= A.elo ? H.cn : A.cn;
  const weaker   = H.elo >= A.elo ? A.cn : H.cn;

  let prompt = `## 比赛信息
${H.flag} **${H.cn}**（${H.name}）Elo ${H.elo} · FIFA 第${H.fifaRank}名
${A.flag} **${A.cn}**（${A.name}）Elo ${A.elo} · FIFA 第${A.fifaRank}名
赛事：${matchInfo.competition}　时间：${matchInfo.koBJT}（北京时间）　场地：${matchInfo.venue}
实力差：${stronger} 领先 ${eloDiff} Elo分（${eloDiff >= 200 ? "压倒性差距" : eloDiff >= 100 ? "明显差距" : eloDiff >= 50 ? "中等差距" : "接近"}）

`;

  if (kalshiPrices || pinnacleOdds || modelProbs) {
    prompt += `## 当前定价参考
标的          Kalshi价格   Pinnacle参考区间   模型概率   统计偏差
${H.cn}胜    ${pc(kalshiPrices?.home).padEnd(10)}  ${fairZone(pinnacleOdds?.home).padEnd(16)}   ${pct(modelProbs?.home).padEnd(8)} ${edgeStr(modelProbs?.home, kalshiPrices?.home)}
平局          ${pc(kalshiPrices?.draw).padEnd(10)}  ${fairZone(pinnacleOdds?.draw).padEnd(16)}   ${pct(modelProbs?.draw).padEnd(8)} ${edgeStr(modelProbs?.draw, kalshiPrices?.draw)}
${A.cn}胜    ${pc(kalshiPrices?.away).padEnd(10)}  ${fairZone(pinnacleOdds?.away).padEnd(16)}   ${pct(modelProbs?.away).padEnd(8)} ${edgeStr(modelProbs?.away, kalshiPrices?.away)}

注：Pinnacle参考区间 = Pinnacle去水后±3¢，反映市场公允价。Kalshi价格高于区间上限则偏贵，低于下限则偏便宜。
`;
  }

  prompt += `\n本场资金：**${capital} 单位**　当前阶段：${phase}\n`;

  if (currentScore) {
    const min = currentScore.minute;
    const decayStage = min >= 75 ? "锁利润期（禁止情绪追仓）" : min >= 60 ? "时间衰减加速期" : min >= 45 ? "下半场建仓期" : "上半场建仓期";
    prompt += `当前比分：**${H.cn} ${currentScore.homeScore} – ${currentScore.awayScore} ${A.cn}**（第 ${min} 分钟 · ${decayStage}）\n`;
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
    prompt += `\n## 场面描述（用户实时观察）\n${userInput}\n`;
  }

  // ── Q&A mode ─────────────────────────────────────────────
  if (followUpQuestion && previousAnalysis) {
    prompt += `\n## 之前分析摘要\n${previousAnalysis.slice(0, 2000)}\n`;
    prompt += `\n## 追加提问\n${followUpQuestion}\n\n`;
    prompt += `请针对提问给出简洁直接的回答（3–8句），结合最新数据和之前分析背景，**粗体**标注关键价格和操作结论。`;

  // ── Prematch ──────────────────────────────────────────────
  } else if (phase === "prematch") {
    prompt += `
请按如下结构输出赛前策略分析（700–1000字）：

## 首发情报核查清单
列出两队各4–6名关键球员（决定进攻效率和防线稳定性的核心），以及首发缺席时对策略的具体影响。格式：
- **球员姓名**（位置）：缺席 → 影响（如：降仓/推迟入场/不买赛前）

## 强队价格纪律
基于Kalshi当前报价和Elo差距，给出**${stronger}胜 Yes** 的具体价格区间（必须与当前Kalshi价格挂钩，不能给脱节区间）：
- **强买区**（≤X¢）：大仓建立
- **正常入场区**（X–Y¢）：标准仓
- **小仓区**（Y–Z¢）：仅底仓
- **不追区**（≥Z¢）：放弃赛前买入，等滚球
同时给出**${weaker}胜 Yes** 的彩票仓条件（如果有）。

## 平局 Yes 时间价值策略
平局Yes是时间价值策略，不是方向性押注：
- **入场价格区间**（¢）和入场时机
- **目标持有时段**：0-0维持到XX分钟时开始分批卖出
- **卖出触发价格**（¢）：分批卖出区间
- **止损条件**：何时放弃这笔仓位

## 初始仓位结构（T-15参考）
基于${capital}单位资金，给出具体分配（4格结构）：
- **主方向 Yes**：X–Y单位（X–Y%），入场条件 ≤Z¢
- **平局 Yes**：X–Y单位，入场价格 X–Y¢
- **现金保留**：X–Y单位（滚球加仓弹药）
- **弱队彩票仓**：0–X单位（仅≤X¢时考虑）

## 分时段场景手册
按5个阶段（0–15'、15–30'进球前、进球后场景、半场重定价、60'后）分别给出：
比赛情景 → 价格区间 → 操作指令（加仓/卖出/不动/止损）

## 止盈与风控纪律
- 主方向止盈触发价（¢）：何时开始分批卖出
- 平局仓止盈触发价（¢）
- 强制止损条件（被系统性打穿时如何判断）
- 75分钟后纪律：具体禁止和允许的操作`;

  // ── Post-match ─────────────────────────────────────────────
  } else if (phase === "postmatch") {
    prompt += `
请按如下结构输出赛后复盘分析（400–600字）：

## 整体交易表现
总体评价：盈亏结果合理性、纪律执行评分（1–10分，重点评价是否遵守了价格纪律和时间衰减规则）。

## 逐笔决策复盘
每笔交易：入场价格是否在合理区间、是否追高、进球后的处理是否正确区分了偶发型和系统型进球。

## 价格纪律与场景判读验证
赛前设定的价格区间是否正确？滚球中的控场判断是否准确区分了"控球"和"真实压制"？

## 改进建议
具体优化方向：价格纪律（是否追高了）、仓位结构（现金保留是否充足）、时间衰减意识（60分钟后是否控制住了追仓冲动）。`;

  // ── In-play ─────────────────────────────────────────────
  } else {
    const periodName = {
      "0-25": "0–25分钟", "25-45": "25分钟至中场", ht: "中场休息",
      "45-70": "下半场45–70分钟", "70+": "70分钟至终场",
    }[phase] || phase;

    const min = currentScore?.minute || 0;
    const isLateGame = min >= 60;
    const isEndGame  = min >= 75;

    prompt += `
当前时段：**${periodName}**
${isEndGame ? "⚠️ 终场阶段：禁止情绪追仓，只做止盈和止损\n" : isLateGame ? "⚠️ 时间衰减加速：仓位只减不加，除非极低价格极小仓\n" : ""}
请按如下结构输出实时交易分析（500–700字）：

## 控场信号评估
根据比分和用户描述，评判强队是否形成**真实压制**（0–10分），明确区分：
- **真实压制**：禁区触球多、射门质量高（禁区内射门/大量扑救）、对方只能解围/定位球解围、角球持续领先
- **假性控球**：横传多、进攻慢、对方轻松防守 → 不等于压制 → 不加仓
如果用户未描述场面，说明无法判断控场，建议观察后再操作。

## 当前价格区间判断
基于现在的比分+时段+控场信号，给出**各标的Yes的合理价格区间**（好买点/可以买/不追）。
${currentScore && (currentScore.homeScore !== currentScore.awayScore) ? `
## 进球性质分析
判断是**偶发型进球**（定位球/折射/单次反击 → 强队压制仍在时是买点）还是**系统型进球**（中场失控/边路被反复打穿 → 不补仓）。
说明对当前价格区间操作的影响。` : ""}
## 持仓评估
每笔持仓：原始入场逻辑是否仍然成立、当前盈亏状态、继续持有的理由或平仓理由。
${isEndGame ? "重点：当前是否有止盈机会，不允许新开仓（除非价格在极低区间且极小仓）。" : isLateGame ? "重点：减仓而非加仓，除非价格提供了明显的安全垫。" : ""}

## 操作指令
明确指令（用**粗体**标出每条结论）：
- **持有**：哪些仓位不动，原因
- **加仓**：标的 + YES/NO + 价格区间 + 单位数（若时间过晚则明确说明不宜加仓）
- **止盈/平仓**：在什么价格或比分触发，分批还是一次性

## 风险提示
当前最大尾部风险（红牌/意外进球），对各标的价格的冲击预估，止损触发条件。`;
  }

  // ── System prompt ─────────────────────────────────────────
  const system = `你是一位专业的Kalshi足球预测市场交易员，核心专长是1X2合约的**价格纪律交易**和**滚球场景判读**。

【核心交易哲学】
- **价格 > 观点**：不因为看好某队就追高。赛前价格通常已经反映强队优势，追高反而是负期望
- 强队很可能赢 ≠ 强队Yes现在是好买点。入场价格决定期望值，不是结果概率
- **现金是仓位**：保留60–75%现金 = 保留滚球抓机会的能力，不是浪费
- **平局Yes时间价值**：0-0阶段平局概率随时间上升，平局Yes价格自然上涨。赛前7–13¢买入，0-0维持到25–40分钟在13–18¢分批卖出，是低风险时间价值策略，与方向判断无关
- **不买情绪仓**：进球后的冲动补仓、落后时的信仰补仓、领先时的贪婪追仓——这三种是最常见的亏损来源

【真实控场 vs 假性控球】
真实压制信号：禁区触球频率高、射门质量好（禁区内射门/门将大量扑救）、对方只能清解围、角球持续领先
假性控球：横传多、进攻慢、对方轻松防守、沙特/弱队反击越来越顺 → 不等于压制 → 不加仓

【进球性质分类】
- 偶发型：定位球/折射/单次反击，强队压制格局未变 → 价格下跌时是买点
- 系统型：中场持续失控/边路被反复打穿/连续反击成功 → 不补仓，考虑减仓

【时间衰减阶段意识】
- 0–60分钟：建仓期，可正常操作
- 60–75分钟：衰减加速，仓位只减不加，除非价格极低且极小仓
- 75分钟以后：**锁利润期**，禁止情绪追仓，只做止盈和止损

【止盈纪律】
- 主方向Yes 93¢+ → 开始分批止盈；96¢+ → 大部分清仓
- "不要把盈利仓变成信仰仓"——锁住利润比等待最后一分钱更重要

【Kalshi市场机制】
- 1X2合约：Yes结算100¢（正确）或0¢（错误）；买Yes@P¢ = 花P¢，赢得100¢
- 三标的之和105–108¢（含Kalshi手续费），不能简单套利
- Pinnacle为全球最高效体育定价参考；Kalshi高于Pinnacle区间 = 偏贵，低于 = 偏便宜
- 统计Edge（模型-Kalshi）作为辅助参考，但不是唯一决策依据

【世界杯小组赛特点】
- 中性场地，主客场优势不适用；平局率约28–32%，高于常规联赛
- 晋级压力差异会影响弱队打法（可能更保守或更激进）
- Elo差>150时强队明显占优，Elo差<80时结果不确定性显著上升

【输出规范】
- ## 章节标题，**粗体**关键数字/价格/结论/操作指令，- 列表要点
- 给出明确价格区间（如"62–68¢"），不用模糊表达
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
