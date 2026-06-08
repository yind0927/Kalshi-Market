/* global React, ReactDOM */
const { useState, useMemo, useEffect, useRef, useCallback } = React;
const DATA = window.KW_DATA;

/* ─────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────── */
const fmtPct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const fmtCents = (v) => `${Math.round(v * 100)}¢`;
const fmtVolume = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);

const maxEdgeBucket = (m) =>
  m.buckets.reduce((a, b) =>
    Math.abs(b.model - b.market) > Math.abs(a.model - a.market) ? b : a
  );
const bestBucket = (m) => m.buckets.reduce((a, b) => (b.model > a.model ? b : a));
const totalAbsEdge = (m) =>
  m.buckets.reduce((s, b) => s + Math.abs(b.model - b.market), 0) / 2;

/* ─────────────────────────────────────────────────────────
 * BJT / Timing helpers
 * ───────────────────────────────────────────────────────── */
function getCurrentBJTDecimal() {
  const now = new Date();
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  return (utcDecimal + 8) % 24;
}

function formatBJTDisplay(dec) {
  const h = Math.floor(dec < 0 ? dec + 24 : dec) % 24;
  const m = Math.floor(((dec % 1) + 1) % 1 * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normH(h) { return h < 7 ? h + 24 : h; } // normalize for timeline math

function isInWindow(bjtDec) { return bjtDec >= 19 || bjtDec < 2; }

/* ─────────────────────────────────────────────────────────
 * City-specific weather factor configs
 * onshoreMin/Max: wind direction sector (degrees) that indicates
 * onshore (sea/lake) flow causing cooling effect
 * ───────────────────────────────────────────────────────── */
const CITY_WEATHER_CFG = {
  "New York":    { waterFeature: "海风",  onshoreMin: 120, onshoreMax: 260, minKt: 5 },
  "Miami":       { waterFeature: "海风",  onshoreMin: 45,  onshoreMax: 180, minKt: 4 },
  "Chicago":     { waterFeature: "湖风",  onshoreMin: 20,  onshoreMax: 140, minKt: 4 },
  "Los Angeles": { waterFeature: "海雾",  onshoreMin: 210, onshoreMax: 330, minKt: 3 },
  "Austin":      { waterFeature: null },
  "Dallas":      { waterFeature: null },
};

/* Compute real-time weather risk factors from live observation + distribution.
 * Uses already-calculated corrections (no extra math) and returns up to 3
 * factors sorted by temperature impact magnitude. */
function computeLiveFactors(market, liveEntry) {
  const obs  = liveEntry?.observation;
  const dist = liveEntry?.distribution;
  if (!obs && !dist) return null;

  const cfg = CITY_WEATHER_CFG[market.city] || {};
  const factors = [];

  // ── 1. Onshore flow (sea / lake breeze) ──────────────────
  if (cfg.waterFeature && obs?.windDirection != null) {
    const wd = obs.windDirection;
    const isOnshore = cfg.onshoreMin <= cfg.onshoreMax
      ? wd >= cfg.onshoreMin && wd <= cfg.onshoreMax
      : wd >= cfg.onshoreMin || wd <= cfg.onshoreMax;
    const active   = isOnshore && (obs.windSpeed ?? 0) >= cfg.minKt;
    const corr     = dist?.corrections?.windDir ?? 0;
    const speedStr = obs.windSpeed != null ? `${Math.round(obs.windSpeed)}kt` : "—";
    factors.push({
      labelCN: cfg.waterFeature,
      signal:  active ? "cool" : "neutral",
      value:   `${obs.windCompass ?? "—"} ${speedStr}`,
      valueCN: active ? "已到达" : "未到达",
      detail:  Math.abs(corr) > 0.15 ? `${corr > 0 ? "+" : ""}${corr.toFixed(1)}°` : null,
      impact:  Math.abs(corr),
    });
  }

  // ── 2. Inland wind speed (Austin / Dallas) ────────────────
  if (!cfg.waterFeature && obs?.windSpeed != null) {
    const corr = dist?.corrections?.wind ?? 0;
    const cat  = obs.windCategory ?? (obs.windSpeed > 15 ? "强风" : obs.windSpeed > 8 ? "有风" : "微风");
    factors.push({
      labelCN: "风速",
      signal:  obs.windSpeed > 15 ? "cool" : obs.windSpeed < 5 ? "hot" : "neutral",
      value:   `${obs.windCompass ?? "—"} ${Math.round(obs.windSpeed)}kt`,
      valueCN: cat,
      detail:  Math.abs(corr) > 0.15 ? `${corr > 0 ? "+" : ""}${corr.toFixed(1)}°` : null,
      impact:  Math.abs(corr),
    });
  }

  // ── 3. Cloud cover ────────────────────────────────────────
  if (obs?.cloudCoverPct != null) {
    const corr = dist?.corrections?.cloud ?? 0;
    factors.push({
      labelCN: "云量",
      signal:  obs.cloudCoverPct > 60 ? "cool" : obs.cloudCoverPct < 15 ? "hot" : "neutral",
      value:   `${obs.cloudLabel} · ${obs.cloudCoverPct}%`,
      valueCN: obs.cloudLabel,
      detail:  Math.abs(corr) > 0.15 ? `${corr > 0 ? "+" : ""}${corr.toFixed(1)}°` : null,
      impact:  Math.abs(corr),
    });
  }

  // ── 4. Dew point / humidity ───────────────────────────────
  if (obs?.dewpoint != null) {
    const corr = dist?.corrections?.dew ?? 0;
    if (Math.abs(corr) > 0.2 || obs.dewpoint > 62) {
      const label = obs.dewpoint > 65 ? "高湿" : obs.dewpoint > 55 ? "适中" : "干燥";
      factors.push({
        labelCN: "露点",
        signal:  obs.dewpoint > 65 ? "cool" : obs.dewpoint < 35 ? "hot" : "neutral",
        value:   `${obs.dewpoint.toFixed(0)}°F · ${Math.round(obs.humidity ?? 0)}%RH`,
        valueCN: label,
        detail:  Math.abs(corr) > 0.15 ? `${corr > 0 ? "+" : ""}${corr.toFixed(1)}°` : null,
        impact:  Math.abs(corr),
      });
    }
  }

  // ── 5. Model spread (uncertainty signal) ─────────────────
  if (dist?.spread != null) {
    const high = dist.spread > 3.5;
    factors.push({
      labelCN: "预测分歧",
      signal:  high ? "warn" : "neutral",
      value:   `±${(dist.spread / 2).toFixed(1)}°F`,
      valueCN: high ? "高不确定" : "模型一致",
      detail:  null,
      impact:  high ? 1.5 : 0,
    });
  }

  // Sort by impact and return top 3
  return factors
    .sort((a, b) => (b.impact || 0) - (a.impact || 0))
    .slice(0, 3);
}

function getPlaybookStatus(market, bjtDec) {
  // Conservative default: everything is "late" unless edge is negligible.
  // Manual overrides in TonightPlaybook let the user reclassify.
  const maxE = maxEdgeBucket(market);
  const edgePP = Math.abs(maxE.model - maxE.market) * 100;
  if (edgePP < 4) return "skip";
  return "late";
}

function windowStatusLabel(market, bjtDec) {
  const now = normH(bjtDec);
  const [es, ee] = market.entryWindowBJT;
  const [ps] = market.peakTimeBJT;
  if (now >= es && now < ee) return { text: "入场窗口 ✓", cls: "active" };
  if (now < es) {
    const hh = Math.floor(es % 24);
    return { text: `${String(hh).padStart(2, "0")}:00 入场`, cls: "pre" };
  }
  return { text: `峰值前 ${(ps - now).toFixed(1)}h`, cls: "post" };
}

/* ─────────────────────────────────────────────────────────
 * Reusable
 * ───────────────────────────────────────────────────────── */
function EdgePill({ value, large }) {
  const cls = value > 0.015 ? "pos" : value < -0.015 ? "neg" : "flat";
  const sign = value > 0 ? "↑" : value < 0 ? "↓" : "·";
  return (
    <span className={`edge-pill ${cls}${large ? " lg" : ""}`}>
      <span>{sign}</span>
      {(Math.abs(value) * 100).toFixed(1)}pp
    </span>
  );
}

/* ─────────────────────────────────────────────────────────
 * US Map data — simplified continental outline + city coords
 * Viewbox 720×380
 * ───────────────────────────────────────────────────────── */
const US_PATH = "M 90 95 L 180 82 L 300 78 L 420 80 L 490 95 L 560 105 L 615 100 L 680 110 L 710 130 L 685 155 L 665 185 L 655 215 L 640 245 L 620 280 L 610 310 L 615 335 L 635 355 L 632 380 L 605 375 L 600 358 L 575 348 L 510 350 L 450 360 L 380 375 L 320 358 L 260 340 L 200 315 L 130 295 L 95 270 L 75 235 L 60 195 L 65 155 L 75 120 Z";

const CITY_COORDS = {
  "New York":    [645, 198],
  "Miami":       [617, 348],
  "Chicago":     [470, 145],
  "Austin":      [365, 308],
  "Dallas":      [400, 268],
  "Los Angeles": [108, 268],
};

function USMap({ markets, focusId, onSelect, onHover, compact, immersive }) {
  const W = 720, H = 380;
  const R = compact ? 6 : 17; // badge radius — smaller for minimalist feel

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`us-map${compact ? " compact" : ""}${immersive ? " immersive" : ""}`}
      style={{ overflow: "visible" }}
    >
      <defs>
        <pattern id="mdGrid" x="0" y="0" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="16" cy="16" r="0.85" className="md-dot" />
        </pattern>
        <filter id="badgeFocus" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="usShadow2" x="-5%" y="-5%" width="110%" height="115%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.04" />
        </filter>
        <clipPath id="usClipA"><path d={US_PATH} /></clipPath>
      </defs>

      {/* Shift all content up so the US shape is vertically centered in the box.
          US path top ≈ y78, bottom ≈ y378 → 300px content in 380px canvas → shift -40px */}
      <g transform="translate(0, -40)">

      {/* Dot grid — canvas */}
      {!compact && <rect width={W} height={H} fill="url(#mdGrid)" className="md-grid-bg" />}
      {/* Denser dot grid clipped to US landmass */}
      {!compact && <rect width={W} height={H} fill="url(#mdGrid)" clipPath="url(#usClipA)" className="md-grid-land" />}

      {/* Ghost US outline */}
      <path d={US_PATH} className="us-ghost" filter={compact ? undefined : "url(#usShadow2)"} />

      {/* City badges */}
      {markets.map((m, i) => {
        const coord = CITY_COORDS[m.city];
        if (!coord) return null;
        const [x, y] = coord;
        const maxE = maxEdgeBucket(m);
        const edge = maxE.model - maxE.market;
        const cls  = edge > 0.02 ? "pos" : edge < -0.02 ? "neg" : "flat";
        const isFocus = m.id === focusId;
        const temp = m.forecastHigh ?? m.currentObs ?? "--";
        const strokeW = compact ? 1.2 : Math.min(5, 0.8 + Math.abs(edge) * 34);
        // Dallas label above badge to avoid Austin overlap
        const labelY = m.city === "Dallas" ? y - R - 5 : y + R + 13;

        return (
          <g
            key={m.id}
            className={`badge-marker ${cls}${isFocus ? " focus" : ""}`}
            style={{ cursor: onSelect ? "pointer" : "default", animationDelay: `${i * 55}ms` }}
            onClick={() => onSelect?.(m.id)}
            onMouseEnter={() => onHover?.(m)}
            onMouseLeave={() => onHover?.(null)}
          >
            {/* Focus bloom */}
            {isFocus && !compact && (
              <circle cx={x} cy={y} r={R + strokeW / 2 + 8}
                className={`badge-bloom ${cls}`} filter="url(#badgeFocus)" />
            )}

            {/* Semi-transparent badge background */}
            <circle cx={x} cy={y} r={R} className="badge-bg" />

            {/* Edge ring — variable stroke-width encodes edge magnitude */}
            <circle cx={x} cy={y} r={R}
              className={`badge-ring ${cls}`}
              strokeWidth={strokeW}
              fill="none"
            />

            {!compact && (
              <>
                {/* Temperature — hero number */}
                <text
                  x={x} y={y + 1}
                  className="badge-temp"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {temp}
                </text>
                {/* Degree mark */}
                <text
                  x={x + (String(temp).length > 2 ? 10 : 7)}
                  y={y - 6}
                  className="badge-deg"
                  textAnchor="start"
                >
                  °
                </text>
                {/* City name — Dallas above badge, others below */}
                <text
                  x={x} y={labelY}
                  className={`badge-name${isFocus ? " focus" : ""}`}
                  textAnchor="middle"
                >
                  {m.cnCity} {m.city}
                </text>
              </>
            )}

            {/* Compact: tiny pulse for focus */}
            {compact && isFocus && (
              <circle cx={x} cy={y} r={R + 5} className="pulse-ring" />
            )}
          </g>
        );
      })}

      </g>{/* end translate group */}
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
 * Map Hero — Markets page (极简数据艺术 redesign)
 * ───────────────────────────────────────────────────────── */
function MapHero({ markets, onOpen }) {
  const [hover, setHover] = useState(null);

  const sorted = useMemo(() =>
    [...markets].sort((a, b) => {
      const ae = Math.max(...a.buckets.map(x => Math.abs(x.model - x.market)));
      const be = Math.max(...b.buckets.map(x => Math.abs(x.model - x.market)));
      return be - ae;
    }), [markets]);

  const active = hover || sorted[0];
  const maxE   = maxEdgeBucket(active);
  const edge   = maxE.model - maxE.market;
  const edgeCls = edge > 0.02 ? "pos" : edge < -0.02 ? "neg" : "flat";

  return (
    <div className="mapm-card">
      {/* Header: title left, active city quick-read right */}
      <div className="mapm-head">
        <div>
          <div className="hero-eyebrow">Market Map · 机会分布</div>
          <h2 className="mapm-title">气象市场概要</h2>
        </div>

        <div className="mapm-active">
          <div className="mapm-active-top">
            <span className="mapm-active-city">{active.city}</span>
            <span className="mapm-active-cn">{active.cnCity}</span>
            <EdgePill value={edge} />
          </div>
          <div className="mapm-active-bot">
            <span className="mapm-active-temp">
              {active.currentObs}° → <strong>{active.forecastHigh}°F</strong>
            </span>
            <span className="mapm-active-bucket">{maxE.range}</span>
            <button className="mapm-active-cta" onClick={() => onOpen(active.id)}>
              分析 →
            </button>
          </div>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="mapm-canvas">
        <USMap
          markets={markets}
          focusId={active?.id}
          onSelect={onOpen}
          onHover={setHover}
        />
      </div>

      {/* City chips + legend hint */}
      <div className="mapm-footer">
        <div className="mapm-chips">
          {sorted.map(m => {
            const me = maxEdgeBucket(m);
            const e  = me.model - me.market;
            const cls = e > 0.02 ? "pos" : e < -0.02 ? "neg" : "flat";
            return (
              <button
                key={m.id}
                className={`mapm-chip ${cls}${active.id === m.id ? " active" : ""}`}
                onClick={() => onOpen(m.id)}
                onMouseEnter={() => setHover(m)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="mapm-chip-city">{m.cnCity}</span>
                <span className="mapm-chip-en">{m.city}</span>
                <span className="mapm-chip-temp">{m.forecastHigh ?? m.currentObs}°</span>
                <span className="mapm-chip-edge">{e > 0 ? "+" : ""}{(e * 100).toFixed(0)}pp</span>
              </button>
            );
          })}
        </div>
        <div className="mapm-legend">
          <span className="mapm-leg-item"><span className="mapm-leg-ring pos" />YES</span>
          <span className="mapm-leg-item"><span className="mapm-leg-ring neg" />NO</span>
          <span className="mapm-leg-hint">环宽∝Edge</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Location Card — Analysis page
 * ───────────────────────────────────────────────────────── */
function LocationCard({ market }) {
  return (
    <div className="card location-card">
      <div className="card-head">
        <div>
          <h3>Settlement Location <em>结算地理位置</em></h3>
          <div className="sub">合约按 NOAA 在该机场观测值结算</div>
        </div>
      </div>

      <div className="location-body">
        <USMap markets={[market]} focusId={market.id} compact />

        <div className="location-info">
          <div className="loc-row">
            <span className="loc-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
              </svg>
            </span>
            <div>
              <div className="loc-l">Station · 观测站点</div>
              <div className="loc-v">{market.airport}</div>
            </div>
          </div>
          <div className="loc-row">
            <span className="loc-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" />
              </svg>
            </span>
            <div>
              <div className="loc-l">Region · 地区</div>
              <div className="loc-v">{market.city}, {regionCode(market.city)} · United States</div>
            </div>
          </div>
          <div className="loc-row">
            <span className="loc-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
            <div>
              <div className="loc-l">Settles on · 结算时间</div>
              <div className="loc-v">{market.date} · 23:59 {market.timezone}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function regionCode(city) {
  return {
    "New York": "NY",
    "Chicago": "IL",
    "Austin": "TX",
    "Dallas": "TX",
    "Miami": "FL",
    "Los Angeles": "CA",
  }[city] || "";
}

function Spark({ series, color = "var(--ink-3)", w = 72, h = 30 }) {
  const valid = series.filter((v) => v != null);
  if (valid.length < 2) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = Math.max(1, max - min);
  const step = w / (series.length - 1);
  const pts = series
    .map((v, i) => (v == null ? null : `${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 4) - 2).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
 * Tonight's Playbook
 * ───────────────────────────────────────────────────────── */
const PB_GROUPS = [
  { key: "act",   label: "立即入场", en: "Act Now",     cls: "pos"    },
  { key: "watch", label: "关注观望", en: "Watch",       cls: "warn"   },
  { key: "late",  label: "稍后入场", en: "Enter Later", cls: "accent" },
  { key: "skip",  label: "今日跳过", en: "Skip",        cls: "flat"   },
];

function TonightPlaybook({ markets, bjtDec, openAnalysis, pbFilter, setPbFilter, overrides, setOverride }) {
  const inWindow = isInWindow(bjtDec);

  const rows = markets.map((m) => {
    const maxE = maxEdgeBucket(m);
    const autoStatus = getPlaybookStatus(m, bjtDec);
    const status = overrides[m.id] || autoStatus;
    return { m, maxE, edge: maxE.model - maxE.market, status };
  });

  return (
    <div className="card playbook-card">
      <div className="playbook-head">
        <div>
          <div className="hero-eyebrow">Tonight's Playbook · 今晚操作板</div>
          <h2>当前交易建议</h2>
        </div>
        <div className="pb-time">
          <div className="pb-bjt">
            {formatBJTDisplay(bjtDec)} <span className="bjt-unit">BJT</span>
          </div>
          <div className={`window-badge ${inWindow ? "active" : ""}`}>
            {inWindow ? <><span className="wd" />主力窗口</> : "窗口外"}
          </div>
        </div>
      </div>

      {pbFilter && (
        <div className="pb-filter-bar">
          <span>已筛选: {PB_GROUPS.find(g => g.key === pbFilter)?.label}</span>
          <button className="pb-filter-clear" onClick={() => setPbFilter(null)}>× 清除筛选</button>
        </div>
      )}

      {PB_GROUPS.map((g) => {
        const items = rows.filter((r) => r.status === g.key);
        if (!items.length) return null;
        const isActive = pbFilter === g.key;
        return (
          <div className="pb-group" key={g.key}>
            <div
              className={`pb-group-head ${g.cls}${isActive ? " pb-group-head-active" : ""}`}
              onClick={() => setPbFilter(isActive ? null : g.key)}
              title="点击筛选下方卡片"
            >
              <span className="pb-dot" />
              <span>{g.label}</span>
              <span className="pb-group-en">{g.en}</span>
              <span className="pb-filter-hint">{isActive ? "↑ 已筛选" : "点击筛选 ↓"}</span>
            </div>
            {items.map(({ m, maxE, edge, status }) => {
              const ws = windowStatusLabel(m, bjtDec);
              return (
                <div className="pb-city-row" key={m.id}>
                  {/* City name — click to open analysis */}
                  <div className="pb-city-name" onClick={() => openAnalysis(m.id)}>
                    {m.city} <span className="cn">{m.cnCity}</span>
                  </div>
                  <div className="pb-bucket">{maxE.range}</div>
                  <div className="pb-nums">
                    <span className="pb-market">{Math.round(maxE.market * 100)}¢</span>
                    <span className="pb-sep">vs</span>
                    <span className="pb-model">{Math.round(maxE.model * 100)}%</span>
                  </div>
                  <EdgePill value={edge} />
                  <div className="pb-meta">{ws.text}</div>

                  {/* Manual tag selector — stops click from propagating to row */}
                  <div className="pb-tag-selector" onClick={(e) => e.stopPropagation()}>
                    {PB_GROUPS.map((opt) => (
                      <button
                        key={opt.key}
                        className={`pb-tag-btn ${opt.key}${status === opt.key ? " active" : ""}`}
                        onClick={() => setOverride(m.id, opt.key)}
                        title={opt.label}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="pb-arrow" onClick={() => openAnalysis(m.id)}>→</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * City Timeline
 * ───────────────────────────────────────────────────────── */
function CityTimeline({ markets, bjtDec, liveData }) {
  const TL_S = 19, TL_E = 31, TL_SPAN = 12;
  const toX = (h) => ((normH(h) - TL_S) / TL_SPAN * 100).toFixed(2) + "%";
  const now = normH(bjtDec);

  // Compute today's NWS peak hour in BJT from live hourly data.
  // Falls back to null so caller uses static peakTimeBJT estimate.
  const getLivePeak = (m) => {
    const hourly = liveData?.[m.id]?.nwsHourly;
    if (!hourly?.length) return null;
    const tz = window.KW_API?.CITIES?.[m.city]?.tz || "America/New_York";
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const today = hourly.filter(h => h.localDate === todayStr && h.isDaytime !== false);
    if (!today.length) return null;
    const peak = today.reduce((mx, h) => h.temp > mx.temp ? h : mx);
    return { bjtH: peak.localHour - m.bjtOffset, temp: peak.temp };
  };

  // NWS forecast freshness across all cities
  const nwsLoaded = markets.filter(m => liveData?.[m.id]?.models?.NWS?.dailyMax != null).length;
  const lastFetchISO = markets.reduce((latest, m) => {
    const t = liveData?.[m.id]?.fetchedAt;
    return (t && t > latest) ? t : latest;
  }, "");
  const lastFetchBJT = lastFetchISO
    ? new Date(lastFetchISO).toLocaleTimeString("zh-CN",
        { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })
    : null;

  // NWS has TWO forecast update cycles per day.
  // ① Pre-dawn (overnight model run): 03:00-05:00 local — happens BEFORE the trading window
  //    ET BJT ~15:00 | CT BJT ~16:00 | PT BJT ~18:00  (off-screen left of timeline)
  // ② Midday (12Z model run): 10:00-12:00 local — the KEY event WITHIN the trading window
  //    ET BJT ~22:00 | CT BJT ~23:00 | PT BJT ~01:00  ← rendered as solid markers below
  //
  // The pre-dawn update is already factored in by the time window opens.
  // The midday update is when market pricing most often lags the new NWS data.
  const nwsUpdateLines = [
    // Pre-dawn (before window — shown faded at left if in range)
    { bjtH: 15.5, label: "NWS↑", kind: "predawn", title: "NY·Miami NWS 凌晨更新 ~03:30 ET = BJT 15:30 · 此时窗口未开，市场定价基于此预报" },
    { bjtH: 16.5, label: "NWS↑", kind: "predawn", title: "Chicago·Austin·Dallas NWS 凌晨更新 ~03:30 CT = BJT 16:30" },
    { bjtH: 18.5, label: "NWS↑", kind: "predawn", title: "LA NWS 凌晨更新 ~03:30 PT = BJT 18:30 · 窗口刚开时已更新" },
    // Midday (12Z-based — within trading window, most tradeable)
    { bjtH: 22,   label: "NWS↺ET", kind: "midday", title: "NY·Miami NWS 午前更新 ~10:00 ET = BJT 22:00 · 12Z模型融合 · 最关键入场信号" },
    { bjtH: 23,   label: "NWS↺CT", kind: "midday", title: "Chicago·Austin·Dallas NWS 午前更新 ~10:00 CT = BJT 23:00 · 12Z模型融合" },
    { bjtH: 25,   label: "NWS↺PT", kind: "midday", title: "LA NWS 午前更新 ~10:00 PT = BJT 01:00 · 12Z模型融合" },
  ];

  const ticks = [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <div className="card tl-card">
      <div className="tl-card-head">
        <div>
          <h3>City Trading Timeline <em>城市交易时间轴</em></h3>
          <div className="sub">北京时间 (BJT) · 绿色 = 入场窗口 · ▲ = 高温峰值 (红=NWS实时 · 灰=估算) · 虚线 = NWS凌晨更新 · 实线 = NWS午前更新 (最关键)</div>
        </div>
        <div className="tl-legend">
          <span><i className="tl-i entry" /> 入场窗口</span>
          <span
            className={`tl-model-badge ${nwsLoaded > 0 ? "updated" : "pending"}`}
            title={`NWS 官方预报 — Kalshi 结算参考。每日两次更新：凌晨03-05时本地(BJT 15-19)和午前10-12时本地(BJT 22-01)。午前更新是最关键的入场信号。${lastFetchBJT ? `最近拉取 BJT ${lastFetchBJT}` : "尚未加载"}`}
          >
            <i className="tl-i model-upd" />
            NWS 预报
            {nwsLoaded > 0
              ? <span className="tl-model-status ok">{nwsLoaded}/{markets.length} 已加载 ✓{lastFetchBJT ? ` · ${lastFetchBJT}` : ""}</span>
              : <span className="tl-model-status wait">点击城市 ↻ 加载</span>}
          </span>
        </div>
      </div>

      <div className="tl-wrap">
        <div className="tl-inner-scroll">
        {/* Now line */}
        {now >= TL_S && now <= TL_E && (
          <div
            className="tl-now-line"
            style={{ left: `${((now - TL_S) / TL_SPAN * 100).toFixed(2)}%` }}
          >
            <div className="tl-now-label">NOW</div>
          </div>
        )}
        {/* NWS forecast update markers — pre-dawn (dashed/faded) and midday (solid/key) */}
        {nwsUpdateLines.map((m, i) => {
          const hn = normH(m.bjtH);
          if (hn < TL_S || hn > TL_E) return null;
          const x = ((hn - TL_S) / TL_SPAN * 100).toFixed(2) + "%";
          return (
            <div
              key={i}
              className={`tl-nws-line ${m.kind}`}
              style={{ left: x }}
              title={m.title}
            >
              <span className="tl-nws-line-label">{m.label}</span>
            </div>
          );
        })}
        {/* Hour axis */}
        <div className="tl-axis">
          {ticks.map((h) => {
            const hn = normH(h);
            if (hn < TL_S || hn > TL_E) return null;
            return (
              <div
                key={h}
                className="tl-tick"
                style={{ left: `${((hn - TL_S) / TL_SPAN * 100).toFixed(2)}%` }}
              >
                <span>{String(h).padStart(2, "0")}:00</span>
              </div>
            );
          })}
        </div>
        {/* City rows */}
        {markets.map((m) => {
          const [es, ee] = m.entryWindowBJT;
          const [ps] = m.peakTimeBJT;
          const eeClamp = Math.min(ee, TL_E);
          const esN = normH(es);
          const eeN = normH(eeClamp);
          const barW = ((eeN - esN) / TL_SPAN * 100).toFixed(2);
          const livePeak = getLivePeak(m);
          const peakBJT = livePeak ? normH(livePeak.bjtH) : normH(ps);
          const peakX = peakBJT <= TL_E ? `${((peakBJT - TL_S) / TL_SPAN * 100).toFixed(2)}%` : null;
          const wsInfo = windowStatusLabel(m, bjtDec);
          const nwsHigh = liveData?.[m.id]?.models?.NWS?.dailyMax;
          const mktHigh = maxEdgeBucket(m);
          const nwsEdge = nwsHigh != null ? nwsHigh - (mktHigh.market * 100 + (m.forecastHigh ?? 0)) / 2 : null;
          return (
            <div className="tl-row" key={m.id}>
              <div className="tl-row-label">
                <span className="tl-city">{m.city}</span>
                <span className="tl-cn">{m.cnCity}</span>
                <span className="tl-tz">{m.timezone}</span>
                {nwsHigh != null && (
                  <span className="tl-nws-tag" title={`NWS 官方预报高温 — Kalshi 结算参考`}>
                    {nwsHigh}°
                  </span>
                )}
              </div>
              <div className="tl-track-outer">
                <div className="tl-track">
                  <div
                    className={`tl-bar entry ${wsInfo.cls}`}
                    style={{ left: toX(es), width: barW + "%" }}
                  />
                </div>
                {peakX && (
                  <div
                    className={`tl-peak-marker${livePeak ? " live" : ""}`}
                    style={{ left: peakX }}
                    title={livePeak ? `NWS 实时峰值 ${livePeak.temp}°F` : `预测峰值 (静态估算)`}
                  >
                    <svg width="9" height="9" viewBox="0 0 9 9">
                      <polygon points="4.5,0 9,9 0,9"
                        fill={livePeak ? "var(--neg)" : "var(--ink-3)"} />
                    </svg>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Top bar
 * ───────────────────────────────────────────────────────── */
function TopBar({ tab, setTab, theme, setTheme, openSettings, bjtDec, lastRefresh, liveCount, refreshCadence }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-label="Kalshi Weather logo">
          <svg viewBox="0 0 32 32" width="22" height="22" fill="currentColor">
            <path d="M9.5 23.5h13a5 5 0 0 0 .8-9.94 6.5 6.5 0 0 0 -12.43 -1.4A4.75 4.75 0 0 0 9.5 23.5z" />
          </svg>
        </div>
        <span className="brand-name">Kalshi Weather <em>气象市场</em></span>
      </div>

      <div className="tabs" role="tablist">
        <button className={`tab ${tab === "markets" ? "active" : ""}`} onClick={() => setTab("markets")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
          </svg>
          Markets <span className="cn">市场</span>
        </button>
        <button className={`tab ${tab === "analysis" ? "active" : ""}`} onClick={() => setTab("analysis")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="m7 14 4-4 4 4 5-7" />
          </svg>
          Analysis <span className="cn">深度分析</span>
        </button>
      </div>

      <div className="topbar-right">
        <div className="bjt-clock">
          <div className="bjt-time">{formatBJTDisplay(bjtDec)}</div>
          <div className="bjt-label">
            BJT 北京时间
            {lastRefresh && (
              <span className="refresh-stamp" title={`Kalshi refresh: every ${refreshCadence}`}>
                · 更新 {lastRefresh.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})} · ⟳{refreshCadence}
              </span>
            )}
          </div>
        </div>
        {liveCount > 0 && (
          <div className="live-count-badge">
            <span className="wd" />{liveCount} LIVE
          </div>
        )}
        <div className={`window-badge ${isInWindow(bjtDec) ? "active" : ""}`}>
          {isInWindow(bjtDec) ? (
            <><span className="wd" />主力窗口</>
          ) : (
            "窗口外"
          )}
        </div>
        <div className="divider-v" />
        <button
          className="icon-btn"
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
        <button className="icon-btn" title="Settings" onClick={openSettings}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────
 * Market card
 * ───────────────────────────────────────────────────────── */
function MarketCard({ market, onOpen, bjtDec, isLive }) {
  const maxE = maxEdgeBucket(market);
  const edge = maxE.model - maxE.market;
  const best = bestBucket(market);
  // Prefer live NWS hourly obs temps; fall back to static seed data
  const liveHourly = market._liveEntry?.hourlyObs;
  const series = liveHourly && liveHourly.length >= 2
    ? liveHourly.map(h => h.temp)
    : (DATA.hourlySeries[market.city] || []);
  const maxBucketVal = Math.max(...market.buckets.flatMap((b) => [b.market, b.model]));
  const wsInfo = windowStatusLabel(market, bjtDec);
  const edgeCls = edge > 0.015 ? "pos" : edge < -0.015 ? "neg" : "flat";

  return (
    <div className="mkt-card" onClick={onOpen}>

      {/* ── Zone 1: Market Identity + Edge Hero ── */}
      <div className="mkt-z1">
        <div className="mkt-city-block">
          <div className="mkt-card-title">
            {market.city} <span className="cn">{market.cnCity}</span>
          </div>
          <div className="mkt-card-id">{market.id} · {market.airport}</div>
          <div className="mkt-card-badges">
            <span className="tz-badge">{market.timezone}</span>
            <span className={`window-status-badge ${wsInfo.cls}`}>{wsInfo.text}</span>
          </div>
        </div>
        <div className={`mkt-edge-hero ${edgeCls}`}>
          <div className="mkt-edge-hero-num">
            <span className="mkt-edge-sign">{edge > 0.015 ? "↑" : edge < -0.015 ? "↓" : "·"}</span>
            {(Math.abs(edge) * 100).toFixed(1)}
            <span className="mkt-edge-unit">pp</span>
          </div>
          <div className="mkt-edge-hero-lbl">Max Edge</div>
        </div>
      </div>

      {/* ── Zone 2: Temperature (compact inline) ── */}
      <div className="mkt-z2">
        {/* Row 1: numbers + sparkline */}
        <div className="mkt-z2-main">
          <div className="mkt-temp-pair">
            <div className="mkt-temp-obs">
              <span className="mkt-temp-val obs">{market.currentObs}<span className="deg">°</span></span>
              {isLive && <span className="live-dot-inline" />}
            </div>
            <span className="mkt-temp-arrow-sm">→</span>
            <div className="mkt-temp-fct">
              <span className="mkt-temp-val fct">{market.forecastHigh}<span className="deg">°F</span></span>
              {market._liveModel && <span className="live-dot-inline accent" />}
            </div>
            {market._liveModel && market.forecastMin != null && (
              <span className="mkt-range-tag">{market.forecastMin}–{market.forecastMax}°F</span>
            )}
          </div>
          <div className="mkt-temp-spark">
            <Spark series={series} color="var(--accent)" w={80} h={32} />
          </div>
        </div>
        {/* Row 2: labels */}
        <div className="mkt-temp-labels">
          <span>当前{isLive ? " · 实时" : ""}</span>
          <span className="mkt-temp-labels-sep" />
          <span>NWS 预报{market._liveModel ? " · 实时" : ""}</span>
        </div>
      </div>

      {/* ── Weather factors (real-time or static fallback) ── */}
      {(() => {
        const lf = computeLiveFactors(market, market._liveEntry);
        const rows = lf || [{ ...market.keyVar, impact: 0 }];
        return (
          <div className="mkt-factors">
            {rows.map((f, i) => (
              <div className="mkt-factor" key={i}>
                <span className={`kv-signal ${f.signal}`} />
                <span className="kv-label">{f.labelCN}</span>
                <span className="kv-val">{f.value}</span>
                {f.detail && <span className="kv-detail">{f.detail}</span>}
                {!lf && f.valueCN && <span className="kv-cn">{f.valueCN}</span>}
              </div>
            ))}
            {lf && (
              <div className="mkt-factors-src">实时 NWS · 修正值 = 温度影响</div>
            )}
          </div>
        );
      })()}

      {/* ── Zone 3: Probability Distribution ── */}
      <div className="mkt-dist">
        {market.buckets.map((b, i) => {
          const isPeak = b === best;
          const heightPct = Math.max(8, (Math.max(b.market, b.model) / maxBucketVal) * 100);
          const innerMax = Math.max(b.market, b.model);
          return (
            <div className="mkt-dist-col" key={i}>
              <div className="mkt-dist-bar-wrap">
                <div className={`mkt-dist-bar${isPeak ? " peak" : ""}`} style={{ height: `${heightPct}%` }}>
                  <div className="fill-market" style={{ height: `${(b.market / innerMax) * 100}%` }} />
                  <div className="fill-model"  style={{ height: `${(b.model  / innerMax) * 100}%` }} />
                </div>
              </div>
              <div className="mkt-dist-label">{b.label}</div>
            </div>
          );
        })}
      </div>

      {/* ── Footer: best bucket + volume + CTA ── */}
      <div className="mkt-foot">
        <div className="mkt-edge-block">
          <div className="l">最佳区间</div>
          <div className="v">
            <span className="range mono">{maxE.range}</span>
            <span style={{ color: "var(--ink-3)", fontSize: 11 }}>· {fmtCents(maxE.market)} vs {fmtPct(maxE.model)}</span>
          </div>
        </div>
        <span className="mkt-foot-meta">${fmtVolume(market.volume)}</span>
        <button className="mkt-foot-cta" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Markets view
 * ───────────────────────────────────────────────────────── */
/* ── Client-side subtitle parser (mirrors api.js kalshiToBucket) ── */
// Handles decimal temps (68.5°) and ticker-suffix fallback for cities without subtitles.
function kalshiToBucket(m) {
  const s = (m.subtitle || "").trim();
  let lowerBound = -Infinity, upperBound = Infinity, range, label;
  const NUM = "(\\d+(?:\\.\\d+)?)"; // matches 76 or 68.5
  let g;
  // "76° or below" / "Below 76°" / "under 76°"
  g = s.match(new RegExp(`^${NUM}°\\s*(?:F\\s*)?or below$`, "i"))
   || s.match(new RegExp(`^below\\s+${NUM}°`, "i"))
   || s.match(new RegExp(`^under\\s+${NUM}°`, "i"));
  if (g) {
    const t = parseFloat(g[1]);
    upperBound = Number.isInteger(t) ? t + 1 : Math.ceil(t);
    range = `≤${t}°F`; label = `≤${t}`;
  }
  // "85° or above" / "Above 85°" / "over 85°"
  g = s.match(new RegExp(`^${NUM}°\\s*(?:F\\s*)?or above$`, "i"))
   || s.match(new RegExp(`^above\\s+${NUM}°`, "i"))
   || s.match(new RegExp(`^over\\s+${NUM}°`, "i"));
  if (g && !range) {
    const t = parseFloat(g[1]);
    lowerBound = t; range = `≥${t}°F`; label = `≥${t}`;
  }
  // "77° to 78°" / "77-78°F" / "Between 77° and 78°"
  g = s.match(new RegExp(`^${NUM}°\\s*(?:F\\s*)?to\\s*${NUM}°`, "i"))
   || s.match(new RegExp(`^${NUM}\\s*[-–]\\s*${NUM}°`, "i"))
   || s.match(new RegExp(`^between\\s+${NUM}°.*?${NUM}°`, "i"));
  if (g && !range) {
    const lo = parseFloat(g[1]), hi = parseFloat(g[2]);
    lowerBound = lo; upperBound = Number.isInteger(hi) ? hi + 1 : Math.ceil(hi);
    range = `${lo}–${hi}°F`; label = `${lo}–${hi}`;
  }
  // Ticker-suffix fallback: B{N.5} or T{N} when subtitle is missing (e.g. LA, Dallas)
  if (!range && !s) {
    const suffix = (m.ticker || "").split("-").pop();
    const bm = suffix.match(/^B(\d+(?:\.\d+)?)$/);
    const tm = suffix.match(/^T(\d+(?:\.\d+)?)$/);
    if (bm) {
      const n = parseFloat(bm[1]);
      const lo = Math.floor(n), hi = Math.ceil(n);
      if (lo === hi) { upperBound = lo + 1; range = `≤${lo}°F`; label = `≤${lo}`; }
      else { lowerBound = lo; upperBound = hi + 1; range = `${lo}–${hi}°F`; label = `${lo}–${hi}`; }
    } else if (tm) {
      const n = parseFloat(tm[1]);
      lowerBound = n + 1; range = `≥${n + 1}°F`; label = `≥${n + 1}`;
    }
  }
  return { range: range||s||m.ticker, label: label||s, lowerBound, upperBound,
           market: m.mid??0, model:0, yes_bid: m.yes_bid??null, yes_ask: m.yes_ask??null,
           status: m.status??null, result: m.result??null };
}

// Merge all live data into a market object (used everywhere in UI)
function liveMarket(market, live) {
  if (!live) return market;
  const dist   = live.distribution;
  const obs    = live.observation;

  // Use Kalshi-derived buckets when available (authoritative structure)
  // Falls back to static data.js buckets
  const baseBuckets = live.kalshiBuckets || market.buckets;

  const buckets = baseBuckets.map((b, i) => {
    const lp = dist?.buckets?.[i]?.modelProb;
    return {
      ...b,
      model: lp != null ? lp : (b.model || 0),
    };
  });

  return {
    ...market,
    buckets,
    currentObs:   obs?.temperature ?? market.currentObs,
    forecastHigh: dist?.mean        ?? market.forecastHigh,
    forecastMin:  dist?.modelMin    ?? null,
    forecastMax:  dist?.modelMax    ?? null,
    forecastConf: dist ? 0.5 + Math.min(0.45, 1/(dist.std+0.1)*0.45) : market.forecastConf,
    _liveObs:    !!(obs),
    _liveModel:  !!(dist),
    _liveKalshi: !!(live.kalshiBuckets?.length),
    _liveEntry:  live,   // raw entry for factor computation
  };
}

function MarketsView({ openAnalysis, bjtDec, liveData }) {
  const [filter, setFilter] = useState("all");
  const [pbFilter, setPbFilter] = useState(null); // playbook group key e.g. "act"|"watch"|"late"|"skip"
  const [pbOverrides, setPbOverrides] = useState({}); // lifted from TonightPlaybook

  const setPbOverride = useCallback((id, key) => {
    setPbOverrides(prev => ({ ...prev, [id]: key }));
  }, []);

  // Merge live data into markets for edge/temp calculations
  const markets = useMemo(() =>
    DATA.markets.map(m => liveMarket(m, liveData?.[m.id])),
    [liveData]
  );

  // Effective playbook status including manual overrides
  const pbStatus = useCallback((m) => pbOverrides[m.id] || getPlaybookStatus(m, bjtDec), [pbOverrides, bjtDec]);

  const filtered = useMemo(() => {
    let arr = [...markets];
    if (pbFilter) {
      arr = arr.filter(m => pbStatus(m) === pbFilter);
    } else {
      if (filter === "edge") arr = arr.filter((m) => totalAbsEdge(m) > 0.07);
      if (filter === "watch") arr = arr.slice(0, 4);
      if (filter === "edge") arr.sort((a, b) => totalAbsEdge(b) - totalAbsEdge(a));
    }
    return arr;
  }, [filter, pbFilter, markets, pbStatus]);

  const avgEdge = markets.reduce((s, m) => s + totalAbsEdge(m), 0) / markets.length;
  const top = markets
    .map((m) => ({ m, e: Math.max(...m.buckets.map((b) => b.model - b.market)) }))
    .sort((a, b) => b.e - a.e)[0];
  const windowActiveCount = markets.filter(m => {
    const [es, ee] = m.entryWindowBJT;
    const now = normH(bjtDec);
    return now >= normH(es) && now < normH(ee);
  }).length;
  const pbGroupCount = pbFilter ? markets.filter(m => pbStatus(m) === pbFilter).length : null;
  const activeCount = pbGroupCount ?? windowActiveCount;
  const activePbGroup = pbFilter ? PB_GROUPS.find(g => g.key === pbFilter) : null;
  const liveCount = DATA.markets.filter(m => liveData?.[m.id]?.observation).length;

  return (
    <div className="view" data-screen-label="markets">

      <MapHero markets={markets} onOpen={openAnalysis} />

      <TonightPlaybook markets={markets} bjtDec={bjtDec} openAnalysis={openAnalysis}
        pbFilter={pbFilter} setPbFilter={setPbFilter}
        overrides={pbOverrides} setOverride={setPbOverride} />

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">
            <span className="en">Markets Tracked</span>
            <span className="cn">跟踪市场</span>
          </div>
          <div className="kpi-value">{DATA.markets.length}</div>
          <div className="kpi-foot">
            {liveCount > 0
              ? <span className="kpi-delta pos">↑ {liveCount} LIVE</span>
              : "6 US cities · daily high"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">
            <span className="en">Avg Edge Magnitude</span>
            <span className="cn">平均偏差</span>
          </div>
          <div className="kpi-value">{(avgEdge * 100).toFixed(1)}<span className="small">%</span></div>
          <div className="kpi-foot">
            {liveCount > 0 ? <span className="kpi-delta pos">实时模型计算</span> : <span className="kpi-delta pos">↑ 1.2pp vs 7d avg</span>}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">
            <span className="en">Top Opportunity</span>
            <span className="cn">最大机会</span>
          </div>
          <div className="kpi-value" style={{ color: "var(--pos)" }}>+{(top.e * 100).toFixed(1)}<span className="small">pp</span></div>
          <div className="kpi-foot">{top.m.city} · {top.m.cnCity}</div>
        </div>
        <div className="kpi" style={activePbGroup ? { outline: "1.5px solid var(--accent)", borderRadius: 10 } : {}}>
          <div className="kpi-label">
            <span className="en">{activePbGroup ? activePbGroup.en : "Active Cities"}</span>
            <span className="cn">{activePbGroup ? activePbGroup.label : "活跃城市"}</span>
          </div>
          <div className="kpi-value" style={activePbGroup ? { color: "var(--accent)" } : {}}>{activeCount}</div>
          <div className="kpi-foot">
            {activePbGroup
              ? <span className="kpi-delta" style={{ color: "var(--accent)" }}>操作板筛选 · {markets.length - activeCount} 其他</span>
              : `窗口内 · ${markets.length - windowActiveCount} 待入场`}
          </div>
        </div>
      </div>

      <CityTimeline markets={markets} bjtDec={bjtDec} liveData={liveData} />

      <div className="section-head">
        <div>
          <h2>
            市场总结 <em>Market Summary</em>
            {liveCount > 0 && <span className="live-badge-sm" style={{ marginLeft: 8 }}>LIVE</span>}
            {pbFilter && <span className="live-badge-sm" style={{ marginLeft: 8, background: "var(--warn-soft)", color: "var(--warn)" }}>筛选中</span>}
          </h2>
          <div className="section-sub">
            {pbFilter
              ? `来自操作板筛选: ${PB_GROUPS.find(g => g.key === pbFilter)?.label} · ${filtered.length} 个城市`
              : "按模型预测概率与市场价格之差排序"}
          </div>
        </div>
        <div className="section-actions">
          {pbFilter
            ? <button className="chip active" onClick={() => setPbFilter(null)}>× 清除操作板筛选</button>
            : <>
              <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>全部</button>
              <button className={`chip ${filter === "edge" ? "active" : ""}`} onClick={() => setFilter("edge")}>偏差</button>
            </>
          }
        </div>
      </div>

      <div className="card-grid">
        {filtered.map((m) => (
          <MarketCard key={m.id} market={m} bjtDec={bjtDec} onOpen={() => openAnalysis(m.id)}
            isLive={!!(liveData?.[m.id]?.observation)} />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Probability distribution (analysis)
 * ───────────────────────────────────────────────────────── */
function ProbDistribution({ market, live, kalshiStatus }) {
  // kalshiBuckets (from live) = parsed from Kalshi subtitles → authoritative
  // Fallback to market.buckets (static data.js) when Kalshi unavailable
  const isLiveModel  = !!(live?.distribution?.buckets);
  const isLiveKalshi = !!(live?.kalshiBuckets?.length);

  const baseBuckets = live?.kalshiBuckets || market.buckets;
  const buckets = baseBuckets.map((b, i) => {
    const lp = live?.distribution?.buckets?.[i]?.modelProb;
    return {
      ...b,
      model:   lp != null ? lp : (b.model || 0),
      // market/yes_bid/yes_ask already set correctly in kalshiBuckets
    };
  });
  const maxV = Math.max(...buckets.flatMap((b) => [b.market || 0, b.model || 0])) || 1;

  // Kalshi connection status indicator
  const kalshiErr = live?.kalshiError;
  const kalshiBadge = isLiveKalshi
    ? <span className="kalshi-badge ok">✓ Kalshi LIVE</span>
    : kalshiErr
      ? <span className="kalshi-badge err" title={kalshiErr}>✗ Kalshi 失败</span>
      : kalshiStatus === "ok"
        ? <span className="kalshi-badge pending">⏳ Kalshi 连接中…</span>
        : kalshiStatus === "unconfigured"
          ? <span className="kalshi-badge warn">⚠ Kalshi Key 未配置</span>
          : kalshiStatus === "error"
            ? <span className="kalshi-badge err">✗ 代理 404</span>
            : null;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Probability Distribution <em>概率分布</em></h3>
          <div className="sub">
            Kalshi 市场价格 vs 模型预测概率 · 单位 % / ¢
            {kalshiBadge && <>&ensp;{kalshiBadge}</>}
          </div>
        </div>
        <div className="legend">
          <span><i className="market" />
            {isLiveKalshi
              ? <><span className="live-badge-sm" style={{background:"var(--ink-4)",color:"var(--bg-1)"}}>LIVE</span> Market</>
              : "Market 市场"}
          </span>
          <span><i className="model" />
            {isLiveModel
              ? <><span className="live-badge-sm">LIVE</span> Model</>
              : "Model 模型"}
          </span>
        </div>
      </div>

      <ul className="prob-list">
        <li className="prob-row head">
          <div>Range</div>
          <div>Distribution</div>
          <div className="num head">Market {isLiveKalshi ? "↻" : ""}</div>
          <div className="num head">Model {isLiveModel ? "↻" : ""}</div>
          <div className="num head">Edge</div>
          <div className="num head">Signal</div>
        </li>
        {buckets.map((b, i) => {
          const e = b.model - b.market;
          const hasBidAsk = b.yes_bid != null && b.yes_ask != null;
          // Bid-ask aware net edge (after transaction cost of spread)
          // Buy YES: pay ask; profit if model > ask
          // Buy NO:  pay (1-bid); profit if (1-model) > (1-bid) → bid > model
          const netYes = hasBidAsk ? +(b.model - b.yes_ask).toFixed(4)  : null;
          const netNo  = hasBidAsk ? +(b.yes_bid - b.model).toFixed(4)  : null;
          const MIN_NET = 0.03; // minimum actionable net edge (3pp after spread)
          let signal = null;
          if (b.result) {
            signal = b.result === "yes"
              ? <span className="sig-settled yes">✓ YES</span>
              : <span className="sig-settled no">✗ NO</span>;
          } else if (netYes != null && netYes > MIN_NET) {
            signal = <span className="sig-buy yes">↑ YES +{Math.round(netYes*100)}¢</span>;
          } else if (netNo != null && netNo > MIN_NET) {
            signal = <span className="sig-buy no">↓ NO +{Math.round(netNo*100)}¢</span>;
          } else if (hasBidAsk) {
            signal = <span className="sig-pass">— 观望</span>;
          }
          return (
            <li className="prob-row" key={i}>
              <div className="range">{b.range}</div>
              <div className="prob-bars">
                <div className="prob-bar market">
                  <div className="fill" style={{ width: `${(b.market / maxV) * 100}%` }} />
                </div>
                <div className="prob-bar model">
                  <div className="fill" style={{ width: `${(b.model / maxV) * 100}%` }} />
                </div>
              </div>
              <div className="num" title={hasBidAsk ? `Bid ${Math.round(b.yes_bid*100)}¢ / Ask ${Math.round(b.yes_ask*100)}¢` : undefined}>
                {b.result === "yes"
                  ? <span style={{color:"var(--pos)",fontWeight:700}}>✓ YES</span>
                  : b.result === "no"
                    ? <span style={{color:"var(--ink-4)"}}>✗ NO</span>
                    : fmtCents(b.market)}
                {!b.result && hasBidAsk && <span className="bid-ask">{Math.round(b.yes_bid*100)}–{Math.round(b.yes_ask*100)}</span>}
                {b.status === "settled" && !b.result && <span className="bid-ask">settled</span>}
              </div>
              <div className="num">{fmtPct(b.model)}</div>
              <div className="num"><EdgePill value={e} /></div>
              <div className="num">{signal}</div>
            </li>
          );
        })}
      </ul>
      {isLiveKalshi && isLiveModel && (
        <div className="prob-signal-note">
          Signal = 模型概率 vs Kalshi 买卖价差后净优势 ≥3pp 触发 · 价差内为观望
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Hourly Forecast List — NWS official hourly values
 * ───────────────────────────────────────────────────────── */
function HourlyList({ market, live }) {
  const nwsHourly = live?.nwsHourly;
  const tz = window.KW_API?.CITIES?.[market.city]?.tz || "America/New_York";

  if (!nwsHourly?.length) {
    return (
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Hourly Forecast <em>逐小时预报</em></h3>
            <div className="sub">NWS 官方逐小时预报</div>
          </div>
        </div>
        <div className="ens-empty">
          {live?.nwsHourlyError
            ? <span className="err">加载失败: {live.nwsHourlyError}</span>
            : <span>点击 ↻ 加载实时数据</span>}
        </div>
      </div>
    );
  }

  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const nowLocalHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()), 10
  );

  // Peak = highest temp in today's hours (falls back to full list)
  const todayHours = nwsHourly.filter(h => h.localDate === todayStr);
  const peakHours  = todayHours.length > 0 ? todayHours : nwsHourly;
  const peak       = peakHours.reduce((mx, h) => h.temp > mx.temp ? h : mx);

  const allTemps = nwsHourly.map(h => h.temp);
  const minTemp  = Math.min(...allTemps);
  const maxTemp  = Math.max(...allTemps);

  const tempColor = (t) => {
    if (t >= 95) return "#d32f2f";
    if (t >= 85) return "#f44336";
    if (t >= 75) return "#ff9800";
    if (t >= 65) return "#ffc107";
    if (t >= 55) return "#66bb6a";
    return "#42a5f5";
  };

  // Group by localDate
  const grouped = nwsHourly.reduce((acc, h) => {
    (acc[h.localDate] = acc[h.localDate] || []).push(h);
    return acc;
  }, {});

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>
            Hourly Forecast <em>逐小时预报</em>
            <span className="live-badge-sm" style={{ marginLeft: 8 }}>LIVE</span>
          </h3>
          <div className="sub">
            NWS 官方逐小时预报 · 今日峰值 <strong>{peak.temp}°F</strong> @ {String(peak.localHour).padStart(2,"0")}:00
          </div>
        </div>
        <div className="hl-legend">
          <span className="hl-legend-item"><span className="hl-now-dot" /> 当前</span>
          <span className="hl-legend-item" style={{color:"var(--neg)"}}>■ 峰值</span>
        </div>
      </div>

      <div className="hourly-list">
        <div className="hourly-list-head">
          <span>时间</span>
          <span>温度</span>
          <span></span>
          <span>风向风速</span>
          <span>天气</span>
        </div>

        {Object.entries(grouped).map(([date, hours]) => (
          <div key={date} className="hourly-group">
            <div className="hourly-date-label">
              {date === todayStr ? "今天 Today" : "明天 Tomorrow"}
            </div>
            {hours.map((h, i) => {
              const isCurrent = date === todayStr && h.localHour === nowLocalHour;
              const isPeak    = h === peak;
              const barW = Math.max(4, (h.temp - minTemp) / Math.max(1, maxTemp - minTemp) * 100);
              return (
                <div key={i} className={`hourly-row${isCurrent ? " is-current" : ""}${isPeak ? " is-peak" : ""}${!h.isDaytime ? " is-night" : ""}`}>
                  <div className="hl-time">
                    {String(h.localHour).padStart(2,"0")}:00
                    {isCurrent && <span className="hl-now-dot" />}
                  </div>
                  <div className="hl-temp" style={isPeak ? { color: "var(--neg)", fontWeight: 700 } : {}}>
                    {h.temp}°F
                    {isPeak && <span className="hl-peak-badge">峰值</span>}
                  </div>
                  <div className="hl-bar-wrap">
                    <div className="hl-bar-fill" style={{ width: `${barW}%`, background: tempColor(h.temp) }} />
                  </div>
                  <div className="hl-wind">{h.windDirection} {h.windSpeed}</div>
                  <div className="hl-cond">{h.shortForecast}</div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Correction row helper
 * ───────────────────────────────────────────────────────── */
function windDirLabel(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function CorrRow({ label, sublabel, value, note }) {
  const cls = value > 0.05 ? "pos" : value < -0.05 ? "neg" : "flat";
  return (
    <div className="corr-row">
      <div className="corr-label">
        <span>{label}</span>
        <span className="corr-sub">{sublabel}</span>
      </div>
      <div className={`corr-val ${cls}`}>
        {value > 0 ? "+" : ""}{value.toFixed(2)}°F
      </div>
      <div className="corr-note">{note}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Live Model Ensemble Panel
 * ───────────────────────────────────────────────────────── */
function ModelEnsemblePanel({ live, market, onRefresh }) {
  const loading = live?.status === "loading";
  const models  = live?.models || {};
  const dist    = live?.distribution;
  const obs     = live?.observation;
  const keys    = Object.keys(models);

  return (
    <div className="card ens-card">
      <div className="card-head">
        <div>
          <h3>Live Model Ensemble <em>实时模型集合</em></h3>
          <div className="sub">NWS官方预报 × HRRR × GFS · 三模型加权集合 · 日内最高温 08:00–22:00 本地时</div>
        </div>
        <div className="ens-head-right">
          {dist && (
            <span className="ens-mean-tag">
              加权修正后 <strong>{dist.adjustedMean}°F</strong> ± {dist.adjustedStd}°F
              <span className="ens-model-count"> · {keys.length}/3 模型</span>
            </span>
          )}
          <button className={`ens-refresh-btn ${loading ? "spin" : ""}`}
            onClick={onRefresh} title="Refresh live data" disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Live Observation Strip */}
      {obs && (
        <div className="obs-live-strip">
          <div className="obs-live-temp">
            <span className="live-badge-sm">LIVE</span>
            {obs.temperature != null ? `${obs.temperature}°F` : "—"}
          </div>
          <div className="obs-live-stats">
            <div className="obs-stat">
              <span className="obs-stat-label">湿度</span>
              <span className="obs-stat-val">{obs.humidity != null ? `${obs.humidity}%` : "—"}</span>
            </div>
            <div className="obs-stat">
              <span className="obs-stat-label">风速</span>
              <span className="obs-stat-val">{obs.windCompass} {obs.windSpeedMs != null ? `${obs.windSpeedMs}m/s` : "—"}{obs.windGustMs ? ` G${obs.windGustMs}` : ""}</span>
              <span className="obs-stat-sub">{obs.windCategory || "—"}</span>
            </div>
            <div className="obs-stat">
              <span className="obs-stat-label">天气</span>
              <span className="obs-stat-val">{obs.cloudLabel || obs.sky || "—"}</span>
            </div>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="ens-loading">
          {[1,2,3,4].map(i => <div key={i} className="ens-skel" />)}
        </div>
      )}

      {/* Model cards */}
      {!loading && keys.length > 0 && (
        <div className="ens-grid">
          {/* Consensus card — weighted + corrected ensemble mean */}
          {dist && (
            <div className="ens-model ens-consensus">
              <div className="ens-model-name">集合 ENSEMBLE</div>
              <div className="ens-model-temp">{dist.adjustedMean}<span>°F</span></div>
              <div className="ens-model-peak">σ ±{dist.adjustedStd}°F</div>
              <div className="ens-model-diff flat">
                {dist.modelMin}–{dist.modelMax}°F 区间
              </div>
            </div>
          )}
          {keys.map(key => {
            const m = models[key];
            const diff = dist ? +(m.dailyMax - dist.adjustedMean).toFixed(1) : null;
            const cls  = diff == null ? "flat" : diff > 0.5 ? "pos" : diff < -0.5 ? "neg" : "flat";
            return (
              <div className="ens-model" key={key}>
                <div className="ens-model-name">{key}</div>
                <div className="ens-model-temp">{m.dailyMax}<span>°F</span></div>
                <div className="ens-model-peak">{m.peakHour != null ? `峰值 ${String(m.peakHour).padStart(2,"0")}:00` : "峰值 —"}</div>
                {diff != null && (
                  <div className={`ens-model-diff ${cls}`}>
                    {diff > 0 ? "+" : ""}{diff}°
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* No data / error */}
      {!loading && keys.length === 0 && (
        <div className="ens-empty">
          {live?.modelsError
            ? <span className="err">模型错误: {live.modelsError}</span>
            : <span>点击 ↻ 加载实时模型数据</span>}
        </div>
      )}

      {dist && (
        <div className="ens-note">
          均权均值 {dist.mean}°F → 修正后 {dist.adjustedMean}°F（NWS · HRRR · GFS 各 ⅓ 权重，共 {dist.modelCount}/3 模型）· 区间 {dist.modelMin}–{dist.modelMax}°F · σ {dist.adjustedStd}°F
          {dist.windDirMean != null && ` · 风向 ${windDirLabel(dist.windDirMean)} ${dist.windDirMean}°`}
          {dist.corrections.dew != null && dist.corrections.dew !== 0 && ` · 露点修正 ${dist.corrections.dew > 0 ? "+" : ""}${dist.corrections.dew}°F`}
        </div>
      )}

      {dist?.corrections && (
        <div className="corr-panel">
          <div className="corr-title">修正层 <em>Correction Stack</em></div>
          <div className="corr-grid">
            <CorrRow label="站点偏差" sublabel="NWS ASOS 微气候" value={dist.corrections.station}
              note={dist.corrections.station > 0 ? "城市热岛↑" : "湖/海冷却↓"} />
            {dist.windMean != null && (
              <CorrRow label="峰时风速" sublabel={`${dist.windMean}kt 模型加权均值`} value={dist.corrections.wind}
                note={dist.corrections.wind < 0 ? `>${10}kt 混合冷却` : "≤10kt 无修正"} />
            )}
            {dist.cloudMean != null && (
              <CorrRow label="峰时云量" sublabel={`云覆盖 ${dist.cloudMean}%`} value={dist.corrections.cloud}
                note={dist.corrections.cloud < 0 ? "太阳辐射遮挡↓" : "≤25% 无修正"} />
            )}
            {dist.windDirMean != null && (
              <CorrRow label="风向修正" sublabel={`${windDirLabel(dist.windDirMean)} ${dist.windDirMean}° 实效风向`}
                value={dist.corrections.windDir}
                note={dist.corrections.windDir < -0.5 ? "偏海向 海风入侵↓" : dist.corrections.windDir < -0.1 ? "轻度偏海↓" : "离岸/中性"} />
            )}
            {dist.corrections.dew != null && dist.corrections.dew !== 0 && (
              <CorrRow label="露点修正" sublabel="感热效率 vs 参考露点50°F"
                value={dist.corrections.dew}
                note={dist.corrections.dew > 0.1 ? "干燥 感热升温快↑" : dist.corrections.dew < -0.1 ? "潮湿 抑制峰温↓" : "接近中性"} />
            )}
            {dist.impliedPeak != null && (
              <CorrRow label="观测融合" sublabel={`NWS → 隐含峰值 ${dist.impliedPeak}°F (权重 ${Math.round(dist.obsBlendWeight*100)}%)`}
                value={dist.corrections.observation} note="实测锚定约束" />
            )}
            <div className="corr-total">
              <span>总修正</span>
              <span className={dist.corrections.total > 0 ? "pos" : dist.corrections.total < 0 ? "neg" : ""}>
                {dist.corrections.total > 0 ? "+" : ""}{dist.corrections.total}°F
              </span>
              <span style={{color:"var(--ink-3)"}}>
                {dist.mean}°F → <strong style={{color:"var(--accent)"}}>{dist.adjustedMean}°F</strong>
                &ensp;σ {dist.std}°F → <strong>{dist.adjustedStd}°F</strong>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * API Status Row
 * ───────────────────────────────────────────────────────── */
function ApiStatusRow({ live }) {
  if (!live || live.status === "loading") return null;

  const nwsSt    = live.observation ? "ok"   : live.obsError    ? "err"  : "idle";
  const modelSt  = live.models && Object.keys(live.models).length > 0 ? "ok" : live.modelsError ? "err" : "idle";
  const kalshiSt = live.kalshi ? "ok" : "warn";

  const stamp = live.fetchedAt
    ? new Date(live.fetchedAt).toLocaleTimeString("zh-CN",
        { timeZone:"Asia/Shanghai", hour12:false, hour:"2-digit", minute:"2-digit", second:"2-digit" }) + " BJT"
    : "";

  const dots = [
    { st: nwsSt,   label:"NWS ASOS",   detail: live.obsError },
    { st: modelSt, label:"Open-Meteo", detail: live.modelsError },
    { st: kalshiSt,label:"Kalshi",     detail: kalshiSt === "warn" ? "CORS限制—使用模拟价格" : null },
  ];

  return (
    <div className="api-status-row">
      {dots.map(({ st, label, detail }) => (
        <span key={label} className={`api-dot-item ${st}`} title={detail || ""}>
          <span className="api-dot" />
          {label}
          {st === "ok"   && <span className="api-tag live">LIVE</span>}
          {st === "warn" && <span className="api-tag mock">MOCK</span>}
          {st === "err"  && <span className="api-tag err">ERR</span>}
          {st === "idle" && <span className="api-tag idle">—</span>}
        </span>
      ))}
      {stamp && <span className="api-stamp">更新: {stamp}</span>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Analysis view
 * ───────────────────────────────────────────────────────── */
// ── AI Summary fetch helper (module-level) ─────────────────
async function doFetchAISummary(live) {
  const res = await fetch("/api/ai-summary", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      city:         live.city,
      distribution: live.distribution,
      observation:  live.observation,
      models:       live.models,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function AnalysisView({ marketId, setMarketId, bjtDec, liveData, onFetch, kalshiStatus, onBack }) {
  const market = DATA.markets.find((m) => m.id === marketId) || DATA.markets[0];
  const live   = liveData?.[market.id];

  // AI summary state: null | { loading } | { summary, model, tokens, generatedAt } | { error }
  const [aiData, setAiData] = useState(null);

  // Use live Kalshi buckets (authoritative ranges + prices) when available,
  // fall back to static data.js buckets
  const effectiveBuckets = live?.kalshiBuckets || market.buckets;

  // Overlay live model probs onto effective buckets for edge calculation
  const liveBuckets = effectiveBuckets.map((b, i) => {
    const lp = live?.distribution?.buckets?.[i]?.modelProb;
    return { ...b, model: lp != null ? lp : b.model };
  });
  const maxE = liveBuckets.reduce((a, b) => Math.abs(b.model - b.market) > Math.abs(a.model - a.market) ? b : a);
  const edge = maxE.model - maxE.market;

  // Live volume / OI summed across all Kalshi buckets
  const liveVolume = live?.kalshi?.reduce((s, m) => s + (m.volume || 0), 0) || market.volume;
  const liveOI     = live?.kalshi?.reduce((s, m) => s + (m.openInterest || 0), 0) || market.openInterest;
  const isLiveKalshi = !!(live?.kalshiBuckets?.length);

  // Live observation temperature (falls back to mock)
  const liveTemp = live?.observation?.temperature;
  const currentTemp = liveTemp != null ? liveTemp : market.currentObs;
  const isLiveObs = liveTemp != null;

  // Auto-fetch market data when this city is opened for the first time
  useEffect(() => {
    if (!live && typeof window.KW_API !== "undefined") {
      onFetch(market);
    }
    setAiData(null); // reset AI when city changes
  }, [market.id]);

  const handleRefreshAI = () => {
    if (!live?.distribution) return;
    setAiData({ loading: true });
    doFetchAISummary(live)
      .then(data => setAiData(data))
      .catch(e  => setAiData({ error: e.message }));
  };

  return (
    <div className="view" data-screen-label="analysis">
      <div className="ana-selector">
        <button className="ana-back-btn" onClick={onBack} title="返回市场列表">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          返回
        </button>
        <span className="sep">/</span>
        <span className="crumb">Analysis · 深度分析</span>
        <span className="sep">/</span>
        <select value={market.id} onChange={(e) => setMarketId(e.target.value)}>
          {DATA.markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.city} · {m.cnCity} ({m.id})
            </option>
          ))}
        </select>
      </div>

      <div className="ana-hero">
        <div>
          <div className="hero-eyebrow">
            {market.id} · {market.date}
          </div>
          <h2 className="ana-hero-title">
            {market.city} Daily High
            <span className="cn">{market.cnCity} · 当日最高气温</span>
          </h2>
          <div className="ana-hero-sub">
            合约将按 NOAA 在 {market.airport.split("·")[0].trim()} 站点公布的当日官方观测最高温结算。
          </div>
          <div className="ana-hero-tags">
            <span className="ana-tag">{market.airport}</span>
            <span className="ana-tag">{market.timezone} · {market.tzLabel}</span>
            <span className="ana-tag">{
              live?.models
                ? Object.keys(live.models).join(" · ")
                : market.modelConsensus
            }</span>
            <span className="ana-tag"
              title="σ = 集合预测标准差。约68%概率最高温在 均值±σ 范围内。σ越小 = 模型越一致 = 预测越可信。">
              {live?.distribution?.adjustedStd
                ? `σ ±${live.distribution.adjustedStd}°F`
                : `conf ${Math.round(market.forecastConf * 100)}%`}
            </span>
            <span className={`ana-tag${isLiveKalshi ? " live-tag" : ""}`}>
              {isLiveKalshi && <span className="live-badge-sm" style={{marginRight:4}}>LIVE</span>}
              vol ${fmtVolume(liveVolume)}
            </span>
            <span className={`ana-tag${isLiveKalshi ? " live-tag" : ""}`}>
              {isLiveKalshi && <span className="live-badge-sm" style={{marginRight:4}}>LIVE</span>}
              OI ${fmtVolume(liveOI)}
            </span>
          </div>
        </div>

        <div className="ana-hero-right">
          <div className="ana-hero-obs">
            <div className="l">
              Current Obs · 当前观测
              {isLiveObs && <span className="live-badge-sm" style={{ marginLeft: 6 }}>LIVE</span>}
            </div>
            <div className={`v ${isLiveObs ? "live-val" : ""}`}>
              {currentTemp}<span style={{ fontSize: 22 }}>°F</span>
            </div>
            <div className="vsub">{isLiveObs ? live.observation.source : market.obsTime}</div>
          </div>
          <div className="ana-hero-edge">
            <div className="l">Max Edge · 最大偏差</div>
            <div className={`v ${edge > 0 ? "pos" : "neg"}`}>
              {edge > 0 ? "+" : "−"}{Math.abs(edge * 100).toFixed(1)}<span style={{ fontSize: 22 }}>pp</span>
            </div>
            <div className="vsub">{maxE.range} · model {fmtPct(maxE.model)} vs market {fmtCents(maxE.market)}</div>
          </div>
        </div>
      </div>

      <ApiStatusRow live={live} />

      <div style={{ height: 16 }} />
      <ModelEnsemblePanel live={live} market={market} onRefresh={() => onFetch(market)} />

      <div style={{ height: 16 }} />
      <div className="ana-row-3-2">
        <ProbDistribution market={market} live={live} kalshiStatus={kalshiStatus} />
        <AISummary market={market} aiData={aiData} onRefreshAI={handleRefreshAI} hasDistribution={!!live?.distribution} />
      </div>

      <div style={{ height: 16 }} />
      <HourlyList market={market} live={live} />

      <div style={{ height: 16 }} />
      <div className="ana-row-2">
        <SuggestedPosition market={market} live={live} edge={edge} maxE={maxE} />
        <LocationCard market={market} />
      </div>

      <div style={{ height: 16 }} />
      <DataSources />

      <div style={{ height: 16 }} />
      <div className="risk-card">
        <strong>Risk Disclosure · 风险提示</strong>
        Kalshi Weather 是一个分析工具，不构成任何投资建议。所显示的概率为模型输出，可能与实际结果存在显著差异；
        prediction-market 合约可能损失全部本金，天气观测值可能被 NOAA / NWS 修订。在交易前请在 Kalshi.com 上确认合约规格、结算规则与手续费，并自行承担合规责任。
      </div>
    </div>
  );
}

function AISummary({ market, aiData, onRefreshAI, hasDistribution }) {
  const isLoading = aiData?.loading;
  const hasLive   = !!(aiData?.summary);
  const hasError  = !!(aiData?.error);
  const isEmpty   = !isLoading && !hasLive && !hasError;

  const genTime = aiData?.generatedAt
    ? new Date(aiData.generatedAt).toLocaleTimeString("zh-CN", {
        timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit",
      }) + " BJT"
    : null;

  const summaryLines = hasLive
    ? aiData.summary.split('\n').filter(l => l.trim())
    : [];

  return (
    <div className="card ai-card">
      {/* Header row */}
      <div className="ai-head">
        <div className="ai-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z" />
          </svg>
        </div>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>AI 市场分析</h3>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {hasLive
              ? `Claude Haiku · ${aiData.tokens?.input}+${aiData.tokens?.output} tokens`
              : isLoading ? "Claude Haiku 分析中…"
              : "Claude Haiku · 点击生成实时分析"}
          </div>
        </div>
        {hasLive && (
          <span className="ai-tag live-tag" style={{ marginLeft: "auto" }}>
            <span className="live-badge-sm" style={{marginRight:3}}>LIVE</span>AI
          </span>
        )}
        {hasLive && (
          <button
            className={`ens-refresh-btn ${isLoading ? "spin" : ""}`}
            onClick={onRefreshAI} disabled={isLoading}
            title="重新生成"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="ai-generating">
          <span className="ai-spinner" />
          Claude 正在分析市场数据，约 1–2 秒…
        </div>
      )}

      {/* Error */}
      {hasError && (
        <div style={{ fontSize: 13, color: "var(--neg)", marginBottom: 12 }}>
          生成失败：{aiData.error}
          <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>
            请确认 Vercel 已配置 ANTHROPIC_API_KEY。
          </div>
          <button className="ai-generate-btn" onClick={onRefreshAI}
            style={{ marginTop: 12, fontSize: 13, padding: "8px 18px" }}>
            重试
          </button>
        </div>
      )}

      {/* Result */}
      {hasLive && !isLoading && (
        <div className="ai-body">
          {summaryLines.length > 1
            ? summaryLines.map((line, i) => <div key={i} className="ai-line">{line}</div>)
            : aiData.summary}
        </div>
      )}

      {/* Empty state — Generate CTA */}
      {isEmpty && (
        <div className="ai-generate-cta">
          <button
            className="ai-generate-btn"
            onClick={onRefreshAI}
            disabled={!hasDistribution}
            title={hasDistribution ? "生成 AI 分析" : "请先加载市场数据"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z" />
            </svg>
            生成 AI 分析
          </button>
          <div className="ai-generate-sub">
            {hasDistribution
              ? "基于实时模型数据 · Claude Haiku · 约 1–2 秒"
              : "请先点击右上角刷新按钮加载市场数据"}
          </div>
        </div>
      )}

      {/* Footer meta */}
      {genTime && (
        <div className="ai-meta">
          <span>生成于 {genTime}</span>
          <span>{aiData.tokens?.input}+{aiData.tokens?.output} tokens</span>
        </div>
      )}
    </div>
  );
}

function SuggestedPosition({ market, live, edge, maxE }) {
  // Prefer bid-ask-aware net edge over raw mid-price edge
  const effectiveBuckets = live?.kalshiBuckets || market.buckets;
  const liveBuckets = effectiveBuckets.map((b, i) => {
    const lp = live?.distribution?.buckets?.[i]?.modelProb;
    return { ...b, model: lp != null ? lp : b.model };
  });

  const MIN_NET = 0.03;
  // Find best actionable bucket (highest net edge after spread)
  let bestBuy = null;
  for (const b of liveBuckets) {
    if (b.result) continue;
    const hasBidAsk = b.yes_bid != null && b.yes_ask != null;
    const netYes = hasBidAsk ? b.model - b.yes_ask : null;
    const netNo  = hasBidAsk ? b.yes_bid - b.model : null;
    const bestNet = Math.max(netYes ?? -Infinity, netNo ?? -Infinity);
    if (bestNet > MIN_NET) {
      if (!bestBuy || bestNet > bestBuy.netEdge) {
        const isYes = netYes >= (netNo ?? -Infinity);
        bestBuy = {
          bucket: b,
          isYes,
          netEdge: isYes ? netYes : netNo,
          entryPrice: isYes ? b.yes_ask : (1 - b.yes_bid),
          grossEdge: isYes ? (b.model - b.market) : (b.market - b.model),
        };
      }
    }
  }

  // Fall back to raw mid-price edge if no bid-ask data
  const useFallback = !bestBuy;
  const displayBucket = bestBuy ? bestBuy.bucket : maxE;
  const displayEdge   = bestBuy ? bestBuy.netEdge : Math.abs(edge);
  const isYes         = bestBuy ? bestBuy.isYes : edge > 0;
  const entryPrice    = bestBuy ? bestBuy.entryPrice
    : (isYes ? displayBucket.market : 1 - displayBucket.market);

  // Kelly fraction: f = edge / (1 - entryPrice) for YES, edge / entryPrice for NO
  const kelly = isYes
    ? (displayEdge / Math.max(0.01, 1 - entryPrice)).toFixed(2)
    : (displayEdge / Math.max(0.01, entryPrice)).toFixed(2);

  // Adjusted mean for display
  const adjMean = live?.distribution?.adjustedMean;
  const corrTotal = live?.distribution?.corrections?.total;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Suggested Position <em>建议仓位</em></h3>
          <div className="sub">
            {useFallback ? "基于中间价偏差" : "基于买卖价差后净优势"} · Not investment advice
          </div>
        </div>
      </div>
      <div className="reco">
        <div className={`reco-icon ${isYes ? "pos" : "neg"}`}>{isYes ? "↑" : "↓"}</div>
        <div className="reco-body">
          <div className="t">
            {isYes ? "Buy YES" : "Buy NO"} · {displayBucket.range}
            &ensp;@ {fmtCents(entryPrice)}
          </div>
          <div className="s">
            模型概率 <strong style={{ color: "var(--accent)" }}>{fmtPct(displayBucket.model, 1)}</strong>
            {adjMean != null && corrTotal != null && Math.abs(corrTotal) > 0.1 && (
              <> · 修正后均值 <strong>{adjMean}°F</strong>（{corrTotal > 0 ? "+" : ""}{corrTotal}°F）</>
            )}
            <br />
            净优势 <strong style={{ color: "var(--pos)" }}>+{Math.round(displayEdge * 100)}¢</strong>/合约
            &ensp;· Kelly ~{kelly}×
            &ensp;· 流动性 ${fmtVolume(live?.kalshi?.reduce((s, m) => s + (m.volume || 0), 0) || market.volume)}
            {!useFallback && <> · <span style={{color:"var(--ink-3)",fontSize:10}}>价差后净值</span></>}
          </div>
        </div>
        <button className="cta" onClick={() => window.open(`https://kalshi.com/markets/${displayBucket.ticker?.split("-")[0]?.toLowerCase() || ""}`, "_blank")}>
          View on Kalshi
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17 17 7M7 7h10v10" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function DataSources() {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Data Sources <em>数据来源</em></h3>
          <div className="sub">实时数据 + 集成更新频率</div>
        </div>
      </div>
      <div className="kv-list">
        <div className="row"><span className="k">Markets</span><span className="v">Kalshi REST v2 · every 5s</span></div>
        <div className="row"><span className="k">Obs</span><span className="v">NOAA METAR / ASOS · 60s</span></div>
        <div className="row"><span className="k">Forecast</span><span className="v">NWS NDFD hourly · 15m</span></div>
        <div className="row"><span className="k">Models</span><span className="v">NWS官方 · HRRR · GFS</span></div>
        <div className="row"><span className="k">AI</span><span className="v">KW-Llm v0.4</span></div>
        <div className="row"><span className="k">Refresh</span><span className="v">{DATA.lastUpdated}</span></div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Settings drawer — controls
 * ───────────────────────────────────────────────────────── */
function Switch({ value, onChange }) {
  return (
    <button className={`switch ${value ? "on" : ""}`} onClick={() => onChange(!value)} aria-pressed={value} />
  );
}

function Segmented({ value, onChange, options, full }) {
  return (
    <div className={`segmented ${full ? "full" : ""}`}>
      {options.map((o) => {
        const v = typeof o === "object" ? o.value : o;
        const l = typeof o === "object" ? o.label : o;
        return (
          <button key={v} className={value === v ? "active" : ""} onClick={() => onChange(v)}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

function Slider({ value, onChange, min, max, step = 1, unit = "" }) {
  return (
    <div className="slider-row">
      <input type="range" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-val">{value}{unit}</span>
    </div>
  );
}

function PillToggle({ options, value, onChange }) {
  return (
    <div className="pill-group">
      {options.map((o) => (
        <button
          key={o}
          className={`pill-toggle ${value[o] ? "on" : ""}`}
          onClick={() => onChange({ ...value, [o]: !value[o] })}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function SettingsRow({ label, cn, desc, children }) {
  return (
    <div className="setting-row">
      <div className="setting-l">
        <div className="setting-label">{label}{cn && <span className="cn">· {cn}</span>}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="setting-r">{children}</div>
    </div>
  );
}

function SettingsRowStack({ label, cn, desc, children }) {
  return (
    <div className="setting-row-stack">
      <div className="setting-l">
        <div className="setting-label">{label}{cn && <span className="cn">· {cn}</span>}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SectionHead({ icon, title, cn, badge }) {
  return (
    <div className="settings-section-head">
      <div className="icon">{icon}</div>
      <h3>{title}<em>{cn}</em></h3>
      {badge && <span className="badge">{badge}</span>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Settings drawer
 * ───────────────────────────────────────────────────────── */
function SettingsDrawer({ open, onClose, theme, setTheme, refreshCadence, setRefreshCadence }) {
  const [s, setS] = useState({
    language: "auto",
    density: "comfortable",
    tempUnit: "F",
    timezone: "local",
    numberFormat: "us",

    edgeAlertThreshold: 5,
    channels: { Email: true, Webhook: false, Slack: false, SMS: false },
    dailyDigest: true,
    settleReminder: true,
    silentHours: false,

    defaultSize: 250,
    minEdgeFilter: 3,
    maxPositions: 5,
    autoSuggest: true,

    models: { NWS: true, HRRR: true, GFS: true },

    aiSummary: true,
    aiVerbosity: "concise",

    telemetry: true,
  });

  const update = (key, val) => setS((prev) => ({ ...prev, [key]: val }));

  return (
    <>
      <div className={`settings-overlay ${open ? "open" : ""}`} onClick={onClose} />
      <aside className={`settings-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="settings-head">
          <div>
            <h2>Settings <em>设置</em></h2>
            <p>个性化定制你的数据视图、提醒规则和模型偏好</p>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="settings-body">

          {/* Account */}
          <div className="settings-section">
            <SectionHead title="Account" cn="账户" badge="Pro"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 22v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></svg>} />
            <div className="account-card">
              <div className="account-avatar">JZ</div>
              <div className="account-info">
                <div className="name">Jamie Zhang</div>
                <div className="email">jamie.zhang@email.com</div>
              </div>
              <span className="account-plan">Pro · 199/mo</span>
            </div>
            <div className="api-row">
              <div className="l">
                <span className="live-dot" />
                Kalshi API <span style={{ color: "var(--ink-1)", fontFamily: "var(--mono)" }}>· connected</span>
              </div>
              <span className="v">key …a3f4</span>
            </div>
          </div>

          {/* Appearance */}
          <div className="settings-section">
            <SectionHead title="Appearance" cn="外观"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v3M12 20v3M4 12H1M23 12h-3M5.6 5.6 3.5 3.5M20.5 20.5l-2.1-2.1M5.6 18.4l-2.1 2.1M20.5 3.5l-2.1 2.1"/></svg>} />
            <SettingsRow label="Theme" cn="主题"
              desc="界面浅色或深色，跟随系统也可">
              <Segmented value={theme} onChange={setTheme}
                options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }]} />
            </SettingsRow>
            <SettingsRow label="Language" cn="语言">
              <Segmented value={s.language} onChange={(v) => update("language", v)}
                options={[{ value: "en", label: "EN" }, { value: "zh", label: "中文" }, { value: "auto", label: "Auto" }]} />
            </SettingsRow>
            <SettingsRow label="Density" cn="密度">
              <Segmented value={s.density} onChange={(v) => update("density", v)}
                options={[{ value: "comfortable", label: "Comfy" }, { value: "compact", label: "Compact" }]} />
            </SettingsRow>
          </div>

          {/* Units */}
          <div className="settings-section">
            <SectionHead title="Units" cn="单位"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 14V4a2 2 0 1 0-4 0v10a4 4 0 1 0 4 0z"/></svg>} />
            <SettingsRow label="Temperature" cn="温度">
              <Segmented value={s.tempUnit} onChange={(v) => update("tempUnit", v)}
                options={[{ value: "F", label: "°F" }, { value: "C", label: "°C" }]} />
            </SettingsRow>
            <SettingsRow label="Time zone" cn="时区">
              <Segmented value={s.timezone} onChange={(v) => update("timezone", v)}
                options={[{ value: "local", label: "Local" }, { value: "et", label: "ET" }, { value: "utc", label: "UTC" }]} />
            </SettingsRow>
            <SettingsRow label="Number format" cn="数字格式">
              <Segmented value={s.numberFormat} onChange={(v) => update("numberFormat", v)}
                options={[{ value: "us", label: "1,234.5" }, { value: "eu", label: "1.234,5" }]} />
            </SettingsRow>
          </div>

          {/* Alerts */}
          <div className="settings-section">
            <SectionHead title="Alerts" cn="提醒"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>} />
            <SettingsRowStack label="Edge alert threshold" cn="偏差提醒阈值"
              desc="当某个 bucket 的模型概率与市场价格差超过此值时通知你">
              <Slider value={s.edgeAlertThreshold} onChange={(v) => update("edgeAlertThreshold", v)}
                min={1} max={20} step={1} unit="pp" />
            </SettingsRowStack>
            <SettingsRowStack label="Channels" cn="通知渠道">
              <PillToggle options={["Email", "Webhook", "Slack", "SMS"]} value={s.channels}
                onChange={(v) => update("channels", v)} />
            </SettingsRowStack>
            <SettingsRow label="Daily digest" cn="每日摘要"
              desc="每天 17:30 ET 发送当日机会复盘">
              <Switch value={s.dailyDigest} onChange={(v) => update("dailyDigest", v)} />
            </SettingsRow>
            <SettingsRow label="Settlement reminder" cn="结算提醒">
              <Switch value={s.settleReminder} onChange={(v) => update("settleReminder", v)} />
            </SettingsRow>
            <SettingsRow label="Silent hours" cn="勿扰时段"
              desc="22:00 – 07:00 不推送非紧急通知">
              <Switch value={s.silentHours} onChange={(v) => update("silentHours", v)} />
            </SettingsRow>
          </div>

          {/* Trading */}
          <div className="settings-section">
            <SectionHead title="Trading" cn="交易偏好"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17 9 11l4 4 8-8"/><path d="M14 7h7v7"/></svg>} />
            <SettingsRow label="Default size" cn="默认仓位"
              desc="USD per contract set">
              <input type="number" className="setting-input" value={s.defaultSize}
                onChange={(e) => update("defaultSize", Number(e.target.value))} />
            </SettingsRow>
            <SettingsRowStack label="Min edge filter" cn="过滤阈值"
              desc="低于此值的机会不会出现在 Markets 列表">
              <Slider value={s.minEdgeFilter} onChange={(v) => update("minEdgeFilter", v)}
                min={0} max={15} step={1} unit="pp" />
            </SettingsRowStack>
            <SettingsRow label="Max open positions" cn="最大同时持仓数">
              <input type="number" className="setting-input" value={s.maxPositions}
                onChange={(e) => update("maxPositions", Number(e.target.value))} />
            </SettingsRow>
            <SettingsRow label="Auto-suggest position" cn="自动建议仓位"
              desc="在 Analysis 页根据 Kelly 公式建议">
              <Switch value={s.autoSuggest} onChange={(v) => update("autoSuggest", v)} />
            </SettingsRow>
          </div>

          {/* Models */}
          <div className="settings-section">
            <SectionHead title="Forecast Models" cn="预测模型"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/><path d="M3 12h6M15 12h6M12 3v6M12 15v6"/></svg>} />
            <SettingsRowStack label="Active ensembles" cn="集成模型"
              desc="选择参与概率融合的天气模型">
              <PillToggle options={["NWS", "HRRR", "GFS"]} value={s.models}
                onChange={(v) => update("models", v)} />
            </SettingsRowStack>
            <SettingsRow label="Kalshi refresh" cn="行情刷新" desc="Kalshi 实时价格轮询频率 · 越快越及时但消耗更多 API 配额">
              <Segmented value={refreshCadence} onChange={(v) => setRefreshCadence(v)}
                options={[{ value: "30s", label: "30s" }, { value: "60s", label: "60s" }, { value: "2m", label: "2m" }, { value: "5m", label: "5m" }]} />
            </SettingsRow>
          </div>

          {/* AI */}
          <div className="settings-section">
            <SectionHead title="AI Assistant" cn="AI 助手" badge="Beta"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z"/></svg>} />
            <SettingsRow label="AI summary" cn="AI 分析总结"
              desc="在 Analysis 页面显示模型生成的解读">
              <Switch value={s.aiSummary} onChange={(v) => update("aiSummary", v)} />
            </SettingsRow>
            <SettingsRow label="Verbosity" cn="详细程度">
              <Segmented value={s.aiVerbosity} onChange={(v) => update("aiVerbosity", v)}
                options={[{ value: "concise", label: "Concise" }, { value: "detailed", label: "Detailed" }]} />
            </SettingsRow>
          </div>

          {/* About */}
          <div className="settings-section">
            <SectionHead title="About" cn="关于"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>} />
            <SettingsRow label="Version" cn="版本">
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>v0.5.0 · build 1200</span>
            </SettingsRow>
            <SettingsRow label="Status page" cn="服务状态">
              <a href="#" style={{ fontSize: 12, color: "var(--accent-ink)", textDecoration: "none" }}>status.kw.io ↗</a>
            </SettingsRow>
            <SettingsRow label="Documentation" cn="使用文档">
              <a href="#" style={{ fontSize: 12, color: "var(--accent-ink)", textDecoration: "none" }}>docs.kw.io ↗</a>
            </SettingsRow>
            <SettingsRow label="Anonymous telemetry" cn="匿名遥测"
              desc="帮助我们改进产品体验，不收集任何个人信息">
              <Switch value={s.telemetry} onChange={(v) => update("telemetry", v)} />
            </SettingsRow>
          </div>
        </div>

        <div className="settings-foot">
          <span className="v">Auto-saved · 已自动保存</span>
          <div className="actions">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </aside>
    </>
  );
}

/* ─────────────────────────────────────────────────────────
 * Bottom Tab Bar
 * ───────────────────────────────────────────────────────── */
function BottomTabBar({ tab, setTab, bjtDec, marketCity }) {
  const inWindow = isInWindow(bjtDec);
  return (
    <nav className="bottom-tab-bar">
      <button className={`btab${tab === "markets" ? " active" : ""}`} onClick={() => setTab("markets")}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
        </svg>
        <span>市场</span>
      </button>
      <div className="btab-center-pill">
        <div className={`btab-window${inWindow ? " active" : ""}`}>
          {inWindow ? <><span className="wd" />交易中</> : "窗口外"}
        </div>
      </div>
      <button className={`btab${tab === "analysis" ? " active" : ""}`} onClick={() => setTab("analysis")}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 3v18h18" /><path d="m7 14 4-4 4 4 5-7" />
        </svg>
        <span>{tab === "analysis" && marketCity ? marketCity : "分析"}</span>
      </button>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────
 * App
 * ───────────────────────────────────────────────────────── */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "tab": "markets"
}/*EDITMODE-END*/;

function App() {
  const [tab, setTab] = useState(TWEAK_DEFAULTS.tab);
  const [theme, setTheme] = useState(TWEAK_DEFAULTS.theme);
  const [marketId, setMarketId] = useState(DATA.markets[0].id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bjtDec, setBjtDec] = useState(getCurrentBJTDecimal());
  const [liveData, setLiveData] = useState({});
  const [lastRefresh, setLastRefresh] = useState(null);
  const [kalshiStatus, setKalshiStatus] = useState(null);
  const [refreshCadence, setRefreshCadence] = useState("30s"); // lifted from SettingsDrawer

  // Check Kalshi credential status once on mount
  useEffect(() => {
    fetch("/api/kalshi-status")
      .then(r => r.json())
      .then(d => setKalshiStatus(d.ready ? "ok" : "unconfigured"))
      .catch(() => setKalshiStatus("error"));
  }, []);

  useEffect(() => {
    const t = setInterval(() => setBjtDec(getCurrentBJTDecimal()), 30000);
    return () => clearInterval(t);
  }, []);

  const fetchLiveForMarket = async (market) => {
    const id = market.id;
    if (!window.KW_API) return;
    setLiveData(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), status: "loading" },
    }));
    try {
      const result = await window.KW_API.fetchCity(market.city, market.buckets, id);
      setLiveData(prev => ({ ...prev, [id]: { status: "loaded", ...result } }));
      setLastRefresh(new Date());
    } catch (e) {
      setLiveData(prev => ({ ...prev, [id]: { status: "error", error: String(e) } }));
    }
  };

  // Auto-fetch: full refresh every 5 min, Kalshi-only per user cadence setting
  const CADENCE_MS = { "30s": 30000, "60s": 60000, "2m": 120000, "5m": 300000 };
  const kalshiMs = CADENCE_MS[refreshCadence] ?? 30000;

  useEffect(() => {
    const runFetch = (kalshiOnly = false) => {
      if (typeof window.KW_API === "undefined") return;
      DATA.markets.forEach(m => {
        if (kalshiOnly) {
          fetch(`/api/kalshi?ticker=${encodeURIComponent(m.id)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (!data?.markets?.length) return;
              const newKalshi  = data.markets;
              const newBuckets = newKalshi.map(km => kalshiToBucket(km));
              setLiveData(prev => {
                const old = prev[m.id];
                if (!old) return prev;
                return { ...prev, [m.id]: {
                  ...old,
                  kalshi:        newKalshi,
                  kalshiBuckets: newBuckets,
                  fetchedAt:     data.fetchedAt,
                }};
              });
              setLastRefresh(new Date());
            })
            .catch(() => {});
        } else {
          fetchLiveForMarket(m);
        }
      });
    };

    const boot    = setTimeout(() => runFetch(false), 300);
    const fullRef = setInterval(() => runFetch(false), 5 * 60 * 1000); // weather every 5 min
    const fastRef = setInterval(() => runFetch(true),  kalshiMs);       // Kalshi per cadence
    return () => { clearTimeout(boot); clearInterval(fullRef); clearInterval(fastRef); };
  }, [kalshiMs]); // re-run when cadence changes

  useEffect(() => {
    const t = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", t);
  }, [theme]);

  // Close drawer on escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setSettingsOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openAnalysis = (id) => {
    setMarketId(id);
    setTab("analysis");
    window.history.pushState({ view: "analysis", id }, "", window.location.href);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // On mount: build a history "floor" so back never closes/leaves the app.
  // replaceState marks the entry below us as the floor, then pushState
  // adds a clean working entry on top. popstate catches the floor and
  // re-pushes to keep the user inside the app.
  useEffect(() => {
    const url = window.location.href;
    window.history.replaceState({ view: "markets", floor: true }, "", url);
    window.history.pushState({ view: "markets" }, "", url);
  }, []);

  // Browser back/forward: read state, update view.
  // When back reaches the floor entry, re-push to stay in app.
  useEffect(() => {
    const onPop = (e) => {
      if (e.state?.view === "analysis") {
        setMarketId(e.state.id);
        setTab("analysis");
      } else {
        setTab("markets");
        if (e.state?.floor) {
          // Re-push so the user stays on markets instead of leaving the app
          window.history.pushState({ view: "markets" }, "", window.location.href);
        }
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const liveCount = DATA.markets.filter(m => liveData[m.id]?.observation).length;

  return (
    <div className="app">
      <TopBar
        tab={tab}
        setTab={setTab}
        theme={theme}
        setTheme={setTheme}
        openSettings={() => setSettingsOpen(true)}
        bjtDec={bjtDec}
        lastRefresh={lastRefresh}
        liveCount={liveCount}
        refreshCadence={refreshCadence}
      />
      {tab === "markets" ? (
        <MarketsView openAnalysis={openAnalysis} bjtDec={bjtDec} liveData={liveData} />
      ) : (
        <AnalysisView
          marketId={marketId}
          setMarketId={setMarketId}
          bjtDec={bjtDec}
          liveData={liveData}
          onFetch={fetchLiveForMarket}
          kalshiStatus={kalshiStatus}
          onBack={() => {
            // If we pushed a history entry when opening analysis, go back via
            // browser history so the URL and history stack stay in sync.
            // Fallback to direct state change if no app-pushed entry exists.
            if (window.history.state?.view === "analysis") {
              window.history.back();
            } else {
              setTab("markets");
            }
          }}
        />
      )}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} setTheme={setTheme}
        refreshCadence={refreshCadence} setRefreshCadence={setRefreshCadence} />
      <BottomTabBar
        tab={tab}
        setTab={setTab}
        bjtDec={bjtDec}
        marketCity={tab === "analysis" ? DATA.markets.find(m => m.id === marketId)?.cnCity : null}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
