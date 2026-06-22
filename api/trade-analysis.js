"use strict";

const Anthropic = require("@anthropic-ai/sdk");

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
    subPhase,
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

  // Build multi-dimensional context section — never throws
  async function buildContextSection() {
    try {
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
    } catch { return ""; }
  }

  const H = matchInfo.home;
  const A = matchInfo.away;
  const eloDiff = Math.abs((H.elo || 0) - (A.elo || 0));
  const stronger = H.elo >= A.elo ? H.cn : A.cn;
  const weaker   = H.elo >= A.elo ? A.cn : H.cn;

  const contextSection = await buildContextSection().catch(() => "");

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
    if (!subPhase || subPhase === "core") {
      prompt += `
**格式**：全部用简洁子弹点，每点含具体¢数或单位数，不写解释段落。约600字。
${userInput ? `\n用户最新消息：${userInput}\n` : ""}
## 速览
- 实力：[Elo差结论，一句话]
- 晋级：[双方形势对打法影响，一句话]
- 场地/天气：[如无特殊因素略过]
- 首发风险：需赛前确认 **${H.cn}** / **${A.cn}** 进攻核心是否首发，如缺阵写一句调整方向

## 价格入场区间
**${stronger}胜Yes**
- 强买 ≤X¢ · 正常 X–Y¢ · 谨慎 Y–Z¢ · 不买 ≥Z¢

**平局Yes**
- 赛前买入：X–Y¢ · 0-0满25分钟目标卖出：X–Y¢
- 强制止损：任一队15分钟内进球 → 立即清仓

**${weaker}胜Yes**
- ≤X¢极小彩票仓 / 否则跳过

## 仓位结构（${capital}单位）
- 主方向：X–Y单位，入场 ≤Z¢
- 平局Yes：X–Y单位，入场 X–Y¢
- 现金：X–Y单位，留滚球

## 风控
- 主方向止盈：X¢卖Y% → Z¢卖剩余
- 平局止盈：X–Y¢分批清仓
- 最大止损：X单位 · 触发：[具体格局改变信号]`;
    } else {
      prompt += `
**格式**：简洁子弹点，每个时段给出具体信号和可执行操作，约600字。
${userInput ? `\n用户最新消息：${userInput}\n` : ""}
## 平局Yes时间价值策略
- 赛前入场：X–Y¢，持有逻辑：0-0每15分钟平局概率上升，价格预期+X¢
- 分批卖出：25分钟@X¢卖50% → 40分钟@X¢卖剩余
- 强制止损触发：[早进球/场面极不均衡/大幅落后] → 立即清仓

## 分时段情景手册
**0–15分钟（观察期）**
- 真实压制信号：禁区触球↑ + 角球领先 + 对方只能解围
- 压制明显且0-0 → [标的] 加X单位 ≤X¢
- 无压制/假性控球 → 按兵不动，等机会
- 任一队早进球 → 平局仓止损，根据性质操作主方向

**15–30分钟（加仓窗口）**
- 加仓条件：[信号] · 价格区间 X–Y¢ · 单位数
- 平局Yes第一批卖出触发：0-0满25分 + 价格达X¢

**进球后（两种性质）**
- ${stronger}进球（偶发型：定位球/折射）→ 价跌时 ≤X¢ 加X单位
- ${stronger}进球（系统型：中场失控）→ 持有，等第二球，不追
- ${weaker}进球 → 偶发：减仓50% · 系统：全平仓

**中场重定价**
- 0-0进中场：[价格区间 + 操作]
- ${stronger}领先：[价格区间 + 是否追]
- 落后：[评估是否偶发，决定减仓幅度]

**60分钟后**
- 仓位只减不加，75分钟起禁止任何新开仓
- 最后可接受条件：≤X¢ 极小仓（<5%资金）

## 止盈纪律
- 主方向：93¢+ 开始分批 → 96¢+ 大部分清仓
- 系统性止损信号（3个）：[格局已变的具体表现]
- 75分钟后绝对禁止：情绪追仓 / 加大仓位 / 信仰补仓`;
    }

  // ── Post-match ─────────────────────────────────────────────
  } else if (phase === "postmatch") {
    prompt += `
**格式**：简洁子弹点，直接评价，不写背景段落。总输出约500–600字。

## 交易总结
- 盈亏：X单位 · 评价：[运气/有优势决策/错误决策]
- 纪律评分：价格纪律X/10 · 仓位控制X/10 · 时间衰减意识X/10

## 逐笔复盘
[每笔交易一行]：标的 @ 入场价 → 出场价 · [偶发/系统/情绪仓] · 评价一句话

## 改进
- [3条下场直接可执行的改进点，针对本场具体失误]`;

  // ── In-play ─────────────────────────────────────────────
  } else {
    const periodName = {
      "0-25": "0–25分钟", "25-45": "25分钟至中场", ht: "中场休息",
      "45-70": "下半场45–70分钟", "70+": "70分钟至终场",
    }[phase] || phase;

    const min = currentScore?.minute || 0;
    const isLateGame = min >= 60;
    const isEndGame  = min >= 75;
    const hasGoal = currentScore && (currentScore.homeScore !== currentScore.awayScore);

    if (!subPhase || subPhase === "core") {
      prompt += `
当前时段：**${periodName}**${isEndGame ? " ⚠️ 终场：禁止新开仓" : isLateGame ? " ⚠️ 时间衰减：仓位只减不加" : ""}
**格式**：简洁子弹点，每点含具体¢数或操作，约500字。

## 局势判断
- 比分影响：[三个结果概率相对赛前如何变化，一句话]
- 控场：[真实压制/假性控球/均势] · 依据：[2–3个具体信号]
- 时间阶段：[建仓期/衰减期/锁利润期]
${hasGoal ? `- 进球性质：[偶发型/系统型] · 理由：[一句话]` : ""}

## 持仓评估
[每笔持仓一行]：标的 @ 入场价 → 现价 · [持有/止盈/止损] · 目标价X¢

## 操作指令
- **持有**：[哪些仓位] 目标价X¢
- **加仓**：[标的] ≤X¢ × Y单位 · 触发条件
- **止盈**：[标的] @X¢ 卖Y%
- **止损**：[触发条件] → 平仓
${isEndGame ? "- **禁止**：任何新开仓" : ""}`;
    } else {
      prompt += `
当前时段：**${periodName}**${isEndGame ? " ⚠️ 终场：禁止新开仓" : isLateGame ? " ⚠️ 时间衰减：仓位只减不加" : ""}
**格式**：简洁子弹点，每个情景给出具体触发条件和操作，约500字。

## 比分情景树
| 情景 | 触发条件 | 价格冲击 | 操作 |
|------|----------|----------|------|
| ${H.cn}再进一球 | [条件] | [标的]±X¢ | [操作] |
| ${A.cn}再进一球 | [条件] | [标的]±X¢ | [操作] |
| 被扳平 | [条件] | [价格变化] | [操作] |
| 红牌 | [主/客队，时段] | [影响方向] | [操作] |
| 点球 | [情况] | [影响] | [操作] |

## 风险预案
- 最大尾部风险：[事件] · 价格冲击：X¢
- 应急操作：[具体一句话，不是情绪反应]
- 时间提醒：${isEndGame ? "75分钟+ → 所有操作只涉及现有仓位" : isLateGame ? "60分钟+ → 仓位只减不加" : "60分钟后进入衰减期，提前设好止盈触发点"}`;
    }
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

  // Switch to SSE streaming mode
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sseWrite = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        sseWrite({ t: event.delta.text });
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    sseWrite({ error: e.message || "AI 分析失败" });
    res.end();
  }
};
