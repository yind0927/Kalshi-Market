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
    matchContext,
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

  // Open-Meteo weather fetch (free, no key) — 3s timeout, non-blocking on failure
  async function fetchWeather(lat, lon) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=auto`,
        { signal: ctrl.signal }
      );
      clearTimeout(tid);
      if (!r.ok) return null;
      return (await r.json()).current || null;
    } catch { return null; }
  }

  function wmoDesc(code) {
    if (code === 0)        return "晴";
    if (code <= 3)         return "多云";
    if (code <= 48)        return "雾";
    if (code <= 67)        return "雨";
    if (code <= 77)        return "雪";
    if (code <= 82)        return "阵雨";
    return "雷暴";
  }

  // Build multi-dimensional context section
  async function buildContextSection() {
    const venue = matchContext?.venue;
    const standings = matchContext?.standings;
    let s = "";

    // Venue + weather
    if (venue) {
      if (venue.indoor) {
        s += `🏟 **场地**：${venue.name}（${venue.city}）· 海拔${venue.alt}m · **室内恒温，无天气干扰**\n`;
      } else {
        s += `🏟 **场地**：${venue.name}（${venue.city}）· 海拔${venue.alt}m · 室外\n`;
        if (venue.alt >= 1500) {
          s += `⚠ **高海拔警告**（${venue.alt}m）：欧洲/亚洲球队体能影响显著，60分钟后差距扩大，体能差的队会明显下滑\n`;
        } else if (venue.alt >= 800) {
          s += `📍 中等海拔（${venue.alt}m）：对不适应高原的球队有轻微体能影响\n`;
        }
        // Fetch live weather for outdoor venues
        if (venue.lat && venue.lon) {
          const wx = await fetchWeather(venue.lat, venue.lon);
          if (wx) {
            const desc = wmoDesc(wx.weather_code);
            let wxLine = `🌤 **赛时天气**：${wx.temperature_2m}°C · ${desc}`;
            if (wx.precipitation > 0.5) wxLine += ` · 降水${wx.precipitation.toFixed(1)}mm（影响传控型打法）`;
            if (wx.wind_speed_10m > 25) wxLine += ` · 风速${Math.round(wx.wind_speed_10m)}km/h（影响长传和高空球）`;
            if (wx.temperature_2m > 30) wxLine += ` · 高温（${wx.temperature_2m}°C）影响体能，利于轮换深度更厚的队`;
            s += wxLine + "\n";
          }
        }
      }
    }

    // Group standings + qualification pressure
    if (standings) {
      const hCode = matchInfo.home?.code;
      const aCode = matchInfo.away?.code;
      const round = standings.round || "?";
      s += `\n📊 **第${round}轮 · ${H.cn}所在小组${standings.group}积分榜**（前2晋级）\n`;
      for (const r of standings.rows) {
        const tag = r.code === hCode ? ` ← ${H.cn}（本场）` : r.code === aCode ? ` ← ${A.cn}（本场）` : "";
        const gdStr = r.gd >= 0 ? `+${r.gd}` : `${r.gd}`;
        s += `  ${r.pos}. ${r.cn.padEnd(8)} ${String(r.pts).padStart(2)}分  ${r.w}W${r.d}D${r.l}L  GD${gdStr}${tag}\n`;
      }

      // Qualification need analysis
      const hRow = standings.rows.find(r => r.code === hCode);
      const aRow = standings.rows.find(r => r.code === aCode);
      if (hRow && aRow) {
        const hPlayed = hRow.w + hRow.d + hRow.l;
        const aPlayed = aRow.w + aRow.d + aRow.l;
        const isFinal = hPlayed === 2 || round === 3;
        s += `\n🎯 **晋级压力分析**（${isFinal ? "末轮决战" : `第${round}轮`}）\n`;

        const needStr = (row, isFinal, rows) => {
          const pos = rows.indexOf(row) + 1;
          const secondPts = rows[1]?.pts || 0;
          const thirdPts  = rows[2]?.pts || 0;
          if (row.pts > thirdPts + 3 && pos <= 2) return "已提前锁定晋级，无论结果";
          if (!isFinal) return pos <= 2 ? `当前第${pos}名，形势有利` : `当前第${pos}名，需要积分`;
          // Final round
          if (pos <= 2 && row.pts > thirdPts + 0) return "平局大概率可晋级（视另一场结果）";
          if (pos <= 2) return "必须赢，或等另一场结果配合";
          if (row.pts + 3 < secondPts) return "晋级希望渺茫，打法激进";
          return "必须赢才能晋级，预计全力进攻";
        };

        const hNeed = needStr(hRow, isFinal, standings.rows);
        const aNeed = needStr(aRow, isFinal, standings.rows);
        s += `  ${H.cn}：${hNeed}\n`;
        s += `  ${A.cn}：${aNeed}\n`;

        // Trading implication
        const aNeedWin = aNeed.includes("必须赢") || aNeed.includes("全力进攻");
        const hNeedWin = hNeed.includes("必须赢") || hNeed.includes("全力进攻");
        const bothSafe = hNeed.includes("提前锁定") || aNeed.includes("提前锁定");
        if (bothSafe) {
          s += `  💡 交易含义：一方或双方已提前晋级，可能轮换主力 → 强队Yes不宜追高，谨慎赛前建重仓\n`;
        } else if (aNeedWin && !hNeedWin) {
          s += `  💡 交易含义：${A.cn}必须赢 → 打法激进，平局概率下降，${A.cn}胜概率略升，${H.cn}胜因对手进攻更多反而适合低价防守反击\n`;
        } else if (hNeedWin && !aNeedWin) {
          s += `  💡 交易含义：${H.cn}必须赢 → 打法激进，平局概率下降，平局Yes不宜高价持有\n`;
        } else if (hNeedWin && aNeedWin) {
          s += `  💡 交易含义：双方都必须赢 → 激烈对攻，进球多可能性上升，平局概率下降，比分类盘口有价值\n`;
        }
      }
    }

    return s ? `\n## 多维赛事背景\n${s}\n` : "";
  }

  const H = matchInfo.home;
  const A = matchInfo.away;
  const eloDiff = Math.abs((H.elo || 0) - (A.elo || 0));
  const stronger = H.elo >= A.elo ? H.cn : A.cn;
  const weaker   = H.elo >= A.elo ? A.cn : H.cn;

  // Build context section (includes async weather fetch)
  const contextSection = await buildContextSection();

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

  prompt += contextSection;
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
    prompt += `请针对提问给出简洁直接的回答（5–10句），结合最新数据和之前分析背景，**粗体**标注关键价格和操作结论。`;

  // ── Prematch ──────────────────────────────────────────────
  } else if (phase === "prematch") {
    prompt += `
**输出要求**：前两章（赛事速览 + 首发核查）合计严格不超过200字；后五章（价格纪律起）每章必须详尽，每章不少于180字，不得以"见上"或一句话敷衍。总目标1200–1500字。

## 赛事速览
（仅3–4个要点，合计不超过80字）
- Elo差/实力级别 + 历史胜率参考
- 晋级形势对双方打法倾向的一句话总结
- 场地/天气/海拔关键点（若无特殊因素则一句带过）

## 首发核查要点
（不要捏造球员名字。仅列出用户赛前需要确认的信息类别，合计不超过120字）
用户在开赛前需自行确认以下信息，如有异常通过"最新消息"输入后重新分析：
- **${H.cn}** 需确认：主力进攻核心（翼锋/10号/9号）是否首发？中场核心是否首发？主力门将是否正常？
- **${A.cn}** 需确认：主力进攻核心是否首发？防线关键球员是否正常？
- 如任一队核心缺阵 → 对策：（一句话说明策略调整方向，如"降低首仓比例/等滚球"）
${userInput ? `\n用户提供的最新消息：${userInput}\n请在后续各章节中结合此信息给出调整建议。` : ""}

## 价格纪律与入场区间
基于当前Kalshi报价和Elo差距，给出每个标的的具体价格分级（必须与当前Kalshi价格挂钩）：

**${stronger}胜 Yes**（主方向）：
- **强买区**（≤X¢）：值得大仓入场的理由
- **正常入场区**（X–Y¢）：标准仓位，理由
- **小仓区**（Y–Z¢）：仅底仓，谨慎理由
- **不追区**（≥Z¢）：等滚球，赛前放弃

**平局 Yes**：入场区（X–Y¢）/ 不买区（≥Z¢）

**${weaker}胜 Yes**：彩票仓条件（≤X¢时可极小仓）或直接说明不建议

## 平局 Yes 时间价值完整策略
- 赛前入场时机和价格区间（X–Y¢）
- 持有逻辑：0-0时平局概率如何随时间变化，价格预期走势
- **分批卖出计划**：第一批在第X分钟/价格X¢时卖Y%；第二批在第Z分钟/价格Z¢时卖剩余
- **提前止损条件**：哪些情景强制清仓平局仓（早进球/大幅落后/场面极度不均衡）
- 本场特殊考量：晋级形势是否影响平局概率

## 初始仓位结构（T-15建仓参考）
基于**${capital}单位**资金的四格具体分配：
- **主方向 Yes**：X–Y单位（X–Y%），入场条件 ≤Z¢
- **平局 Yes**：X–Y单位（X–Y%），入场价格 X–Y¢
- **现金弹药**：X–Y单位（X–Y%），留作滚球加仓用途说明
- **弱队彩票仓**：0–X单位，条件
说明为何保留这么多现金，以及现金的具体使用时机

## 分时段场景手册
**0–15分钟（观察期）**：
- 判断真实压制的3个具体信号
- 0-0且压制明显 → 价格区间X–Y¢ + 加仓单位数
- 0-0但无压制/假性控球 → 操作
- 早进球（任一方）→ 操作

**15–30分钟（加仓窗口）**：
- 机会质量高时的加仓条件 + 价格区间
- 平局Yes的第一批卖出触发条件

**进球后（两种性质）**：
- ${stronger}先进球：价格预期 + 分批止盈计划
- ${weaker}先进球：偶发型 vs 系统型判断标准 + 各自操作

**中场重定价**：0-0/领先/落后三种情景的价格区间和操作

**60分钟以后**：仓位只减不加原则 + 最后可接受的入场条件 + 75分钟后禁止清单

## 止盈与风控纪律
- **主方向分批止盈**：第一批X¢卖Y%，第二批X¢卖剩余大部分
- **平局仓完整止盈**：分批计划
- **系统性止损的3个判断信号**（非偶发失球，而是格局已变的信号）
- 本场最大可承受损失（单位数）和止损触发方式
- **75分钟后绝对禁止的3种操作**（具体列出）`;

  // ── Post-match ─────────────────────────────────────────────
  } else if (phase === "postmatch") {
    prompt += `
请按如下结构输出赛后复盘分析（目标700–900字，每章节详尽）：

## 整体交易表现
- 盈亏结果（单位数）及其合理性：是运气还是有优势的决策？
- 纪律执行评分（1–10分）：价格纪律、仓位控制、时间衰减意识各项评分
- 赛前计划执行度：哪些做到了，哪些偏离了

## 逐笔决策复盘
每笔交易逐一分析：
- 入场时机和价格是否在合理区间
- 方向判断依据是否充分
- 进球后处理是否正确区分了偶发型/系统型
- 结论：这笔是有优势的决策 / 随机结果 / 错误决策

## 多维因素验证
- 场地/天气/海拔的实际影响是否与预期一致
- 晋级压力对双方打法的影响是否如预期
- 赛前价格区间判断是否准确（与实际走势对比）
- 控场判断是否准确区分了"控球"和"真实压制"

## 改进建议
针对本场具体问题给出下次改进方向：
- 价格纪律（入场价是否偏高）
- 仓位结构（现金保留是否充足，加仓时机）
- 信息利用（晋级形势/首发/场面描述是否充分利用）
- 时间衰减意识（60+分钟是否控制住了追仓冲动）`;

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
请按如下结构输出完整实时交易分析（目标900–1200字，每个章节必须详尽）：

## 当前局势综合判断
结合比分、时段、积分形势、场地条件，综合评估当前局势：
- 比分对三个结果概率的影响（相比赛前预期，概率如何变化）
- 当前时段的时间衰减阶段（建仓期/衰减期/锁利润期）
- 晋级压力是否在本时段开始影响双方打法

## 控场信号深度评估
根据比分和用户描述，给出控场评分（0–10分）并详细说明依据：
- **真实压制信号**（各项有无）：禁区触球频率、射门质量（禁区内/门将扑救次数）、对方解围频率、角球优势
- **假性控球信号**：横传比例、进攻推进速度、对方反击威胁
- 综合结论：当前控场程度 + 对后续进球概率的影响
- 如果用户未描述场面，说明无法判断，给出需要观察的具体指标
${currentScore && (currentScore.homeScore !== currentScore.awayScore) ? `
## 进球性质与市场影响
判断进球性质并分析价格影响：
- **偶发型**（定位球/折射/单次反击）：强队压制格局未变 → 价格下跌幅度 + 是否是买点
- **系统型**（中场失控/边路反复被打穿/连续反击）：格局已变 → 不补仓，评估减仓时机
- 当前价格是否已经充分反映了进球影响，还是反应过度/不足` : ""}

## 比分情景树
列出接下来最可能的3个情景，每个情景给出：
- 触发条件（什么时候/什么情况下会发生）
- 对三标的价格的冲击方向和幅度（具体¢数）
- 对应的操作反应（提前设置的心理触发点）

## 持仓详细评估
逐笔分析当前持仓：
- 原始入场逻辑是否仍然成立（是/否/部分成立）
- 当前盈亏和价格走势
- 继续持有的理由 or 减仓/平仓的理由
- 具体的持有目标价或止损价
${isEndGame ? "**终场阶段重点**：识别哪些仓位应该止盈，保留最核心仓位。" : isLateGame ? "**时间衰减重点**：评估每笔仓位在剩余时间内的时间价值损耗。" : ""}

## 操作指令（具体可执行）
明确每一项操作（**粗体**标注）：
- **持有不动**：哪些仓位 + 目标价格 + 持有到什么条件改变
- **加仓**：标的 + YES/NO + 具体价格区间 + 单位数 + 触发条件
- **止盈卖出**：具体在X¢卖出Y%，Z¢再卖剩余
- **止损平仓**：触发条件 + 执行方式
${isEndGame ? "（终场阶段：禁止新开仓，所有操作只涉及现有仓位的管理）" : ""}

## 风险提示与应急预案
- 当前最大尾部风险（红牌/意外进球/天气变化等）
- 每种风险对各标的价格的冲击预估（¢数）
- 触发后的应急操作流程（不是情绪反应，是预先设好的计划）`;
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
- 晋级压力差异直接影响打法：必须赢的队更激进，已晋级的队可能轮换主力
- Elo差>150时强队明显占优，Elo差<80时结果不确定性显著上升
- 高海拔（>1500m）：不适应球队在60分钟后体能显著下滑，利于本地化球队
- 高温（>30°C室外）：利于轮换深度更厚的强队，不利于体能储备不足的弱队
- 室内恒温场馆：天气无影响，场地因素只剩海拔和球队旅途疲劳

【输出规范】
- ## 章节标题，**粗体**关键数字/价格/结论/操作指令，- 列表要点
- 给出明确价格区间（如"62–68¢"），不用模糊表达
- **必须完整输出所有章节**，不得因篇幅截断任何章节
- 每个章节都要有实质内容，不能仅用一句话敷衍
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
        max_tokens: 5000,
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
