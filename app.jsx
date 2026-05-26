/* global React, ReactDOM */
const { useState, useMemo, useEffect } = React;
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
  "Miami":       [617, 365],
  "Chicago":     [470, 145],
  "Austin":      [382, 302],
  "Dallas":      [390, 273],
  "Los Angeles": [108, 268],
};

function USMap({ markets, focusId, onSelect, onHover, compact, immersive }) {
  const W = 720, H = 380;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`us-map ${compact ? "compact" : ""} ${immersive ? "immersive" : ""}`}>
      <defs>
        <filter id="usShadow" x="-5%" y="-5%" width="110%" height="115%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.05" />
        </filter>
        <filter id="markerGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {immersive && (
        <g className="map-grid">
          {[1, 2, 3, 4].map((i) => (
            <line key={`h${i}`} x1="0" x2={W} y1={(H * i) / 5} y2={(H * i) / 5} />
          ))}
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <line key={`v${i}`} y1="0" y2={H} x1={(W * i) / 8} x2={(W * i) / 8} />
          ))}
        </g>
      )}

      <path d={US_PATH} className="us-outline" filter="url(#usShadow)" />

      {markets.map((m, i) => {
        const coord = CITY_COORDS[m.city];
        if (!coord) return null;
        const [x, y] = coord;
        const maxE = maxEdgeBucket(m);
        const edge = maxE.model - maxE.market;
        const cls = edge > 0.02 ? "pos" : edge < -0.02 ? "neg" : "flat";
        const isFocus = m.id === focusId;
        const r = compact ? (isFocus ? 7 : 4) : 6 + Math.abs(edge) * (immersive ? 110 : 90);

        return (
          <g
            key={m.id}
            className={`map-marker ${cls} ${isFocus ? "focus" : ""} ${immersive ? "im" : ""}`}
            style={{
              cursor: onSelect ? "pointer" : "default",
              animationDelay: `${i * 80}ms`,
            }}
            onClick={() => onSelect && onSelect(m.id)}
            onMouseEnter={() => onHover && onHover(m)}
            onMouseLeave={() => onHover && onHover(null)}
          >
            {immersive && (
              <circle cx={x} cy={y} r={r + 14} className="glow" filter="url(#markerGlow)" />
            )}
            {!compact && (
              <circle cx={x} cy={y} r={r + 10} className="halo" />
            )}
            <circle cx={x} cy={y} r={r} className="dot" />
            <circle cx={x} cy={y} r={Math.max(1.5, r * 0.32)} className="dot-inner" />
            {(immersive || !compact) && (
              <text x={x} y={y - r - 9} className={`map-label ${isFocus ? "focus" : ""}`} textAnchor="middle">
                {m.city}
              </text>
            )}
            {compact && isFocus && (
              <circle cx={x} cy={y} r={r + 6} className="pulse-ring" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
 * Map Hero — Markets page
 * ───────────────────────────────────────────────────────── */
function MapHero({ markets, onOpen }) {
  const [hover, setHover] = useState(null);
  const topMarket = useMemo(() => {
    return [...markets].sort((a, b) => {
      const ae = Math.max(...a.buckets.map((x) => Math.abs(x.model - x.market)));
      const be = Math.max(...b.buckets.map((x) => Math.abs(x.model - x.market)));
      return be - ae;
    })[0];
  }, [markets]);

  const display = hover || topMarket;
  const maxE = maxEdgeBucket(display);
  const edge = maxE.model - maxE.market;

  return (
    <div className="map-card">
      <div className="map-card-head">
        <div>
          <div className="hero-eyebrow">Live Market Map</div>
          <h2 className="map-title">
            全美机会分布
            <em>气泡大小 = |Edge|，颜色 = 偏差方向</em>
          </h2>
        </div>
        <div className="map-card-actions">
          <button className="chip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            6 cities
          </button>
          <button className="chip">Heatmap</button>
        </div>
      </div>

      <div className="map-body">
        <div className="map-viz">
          <USMap markets={markets} focusId={display?.id}
            onSelect={onOpen}
            onHover={setHover} />

          <div className="map-legend">
            <div className="legend-title">EDGE 信号</div>
            <div className="legend-item"><span className="ld pos" /> Model &gt; Market <span className="m">YES 低估</span></div>
            <div className="legend-item"><span className="ld neg" /> Model &lt; Market <span className="m">NO 低估</span></div>
            <div className="legend-item"><span className="ld flat" /> Edge &lt; 2pp <span className="m">无明显机会</span></div>
            <div className="legend-foot">气泡半径 ∝ |Edge|</div>
          </div>
        </div>

        <div className="map-detail">
          <div className="map-detail-eyebrow">
            {hover ? "Hovering" : "Top opportunity"}
            <span className="map-detail-pulse" />
          </div>
          <div className="map-detail-city">
            {display.city} <span className="cn">{display.cnCity}</span>
          </div>
          <div className="map-detail-id">{display.id}</div>

          <div className="map-detail-stats">
            <div className="ms">
              <div className="l">Current</div>
              <div className="v">{display.currentObs}<span className="d">°F</span></div>
            </div>
            <div className="ms">
              <div className="l">Forecast</div>
              <div className="v">{display.forecastHigh}<span className="d">°F</span></div>
            </div>
            <div className="ms">
              <div className="l">Max Edge</div>
              <div className={`v ${edge > 0 ? "pos" : "neg"}`}>
                {edge > 0 ? "+" : "−"}{Math.abs(edge * 100).toFixed(1)}<span className="d">pp</span>
              </div>
            </div>
          </div>

          <div className="map-detail-bucket">
            <span className="bucket-tag">{maxE.range}</span>
            <span className="bucket-vs">
              market <strong>{Math.round(maxE.market * 100)}¢</strong> · model <strong>{Math.round(maxE.model * 100)}%</strong>
            </span>
          </div>

          <button className="map-detail-cta" onClick={() => onOpen(display.id)}>
            View deep analysis →
          </button>
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

function TonightPlaybook({ markets, bjtDec, openAnalysis }) {
  // overrides: { [market.id]: "act"|"watch"|"late"|"skip" }
  const [overrides, setOverrides] = useState({});
  const inWindow = isInWindow(bjtDec);

  const rows = markets.map((m) => {
    const maxE = maxEdgeBucket(m);
    const autoStatus = getPlaybookStatus(m, bjtDec);
    const status = overrides[m.id] || autoStatus;
    return { m, maxE, edge: maxE.model - maxE.market, status };
  });

  const setOverride = (id, key) => {
    setOverrides((prev) => ({ ...prev, [id]: key }));
  };

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

      {PB_GROUPS.map((g) => {
        const items = rows.filter((r) => r.status === g.key);
        if (!items.length) return null;
        return (
          <div className="pb-group" key={g.key}>
            <div className={`pb-group-head ${g.cls}`}>
              <span className="pb-dot" />
              <span>{g.label}</span>
              <span className="pb-group-en">{g.en}</span>
              <span className="pb-count">{items.length}</span>
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
function CityTimeline({ markets, bjtDec }) {
  const TL_S = 19, TL_E = 31, TL_SPAN = 12;
  const toX = (h) => ((normH(h) - TL_S) / TL_SPAN * 100).toFixed(2) + "%";
  const now = normH(bjtDec);
  const ticks = [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <div className="card tl-card">
      <div className="tl-card-head">
        <div>
          <h3>City Trading Timeline <em>城市交易时间轴</em></h3>
          <div className="sub">北京时间 (BJT) · 绿色 = 最佳入场窗口 · ▲ = 高温峰值</div>
        </div>
        <div className="tl-legend">
          <span><i className="tl-i entry" /> 入场窗口</span>
          <span><i className="tl-i model-upd" /> 12z模型</span>
        </div>
      </div>

      <div className="tl-wrap">
        {/* Trading window background */}
        <div
          className="tl-window-bg"
          style={{
            left: toX(19),
            width: `${((26 - 19) / TL_SPAN * 100).toFixed(2)}%`,
          }}
        />
        {/* 12z model update line */}
        <div className="tl-model-line" style={{ left: toX(23) }}>
          <div className="tl-model-label">12z GFS</div>
        </div>
        {/* Now line */}
        {now >= TL_S && now <= TL_E && (
          <div
            className="tl-now-line"
            style={{ left: `${((now - TL_S) / TL_SPAN * 100).toFixed(2)}%` }}
          >
            <div className="tl-now-label">NOW</div>
          </div>
        )}
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
          const peakN = normH(ps);
          const peakX = peakN <= TL_E ? `${((peakN - TL_S) / TL_SPAN * 100).toFixed(2)}%` : null;
          return (
            <div className="tl-row" key={m.id}>
              <div className="tl-row-label">
                <span className="tl-city">{m.city}</span>
                <span className="tl-cn">{m.cnCity}</span>
                <span className="tl-tz">{m.timezone}</span>
              </div>
              <div className="tl-track">
                <div
                  className={`tl-bar entry ${m.windowStatus}`}
                  style={{ left: toX(es), width: barW + "%" }}
                />
                {peakX && (
                  <div className="tl-peak-marker" style={{ left: peakX }}>
                    <svg width="9" height="9" viewBox="0 0 9 9">
                      <polygon points="4.5,0 9,9 0,9" fill="var(--ink-2)" />
                    </svg>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Top bar
 * ───────────────────────────────────────────────────────── */
function TopBar({ tab, setTab, theme, setTheme, openSettings, bjtDec, lastRefresh, liveCount }) {
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
              <span className="refresh-stamp" title={`Last refresh: ${lastRefresh.toLocaleTimeString()}`}>
                · 更新 {lastRefresh.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}
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
  const series = DATA.hourlySeries[market.city];
  const maxBucketVal = Math.max(...market.buckets.flatMap((b) => [b.market, b.model]));
  const wsInfo = windowStatusLabel(market, bjtDec);

  return (
    <div className="mkt-card" onClick={onOpen}>
      <div className="mkt-card-top">
        <div>
          <div className="mkt-card-title">
            {market.city} <span className="cn">{market.cnCity}</span>
          </div>
          <div className="mkt-card-id">{market.id} · {market.airport}</div>
          <div className="mkt-card-badges">
            <span className="tz-badge">{market.timezone}</span>
            <span className={`window-status-badge ${wsInfo.cls}`}>{wsInfo.text}</span>
          </div>
        </div>
        <EdgePill value={edge} large />
      </div>

      <div className="mkt-temp-row">
        <div className="mkt-temp-block">
          <div className="l">
            Current 当前
            {isLive && <span className="live-badge-sm" style={{ marginLeft: 4 }}>LIVE</span>}
          </div>
          <div className="v" style={isLive ? { color: "var(--pos)" } : {}}>
            {market.currentObs}<span className="deg">°F</span>
          </div>
        </div>
        <span className="mkt-temp-arrow">→</span>
        <div className="mkt-temp-block">
          <div className="l">Forecast 预测</div>
          <div className="v">{market.forecastHigh}<span className="deg">°F</span></div>
        </div>
        <div className="mkt-temp-spark">
          <Spark series={series} color="var(--accent)" w={84} h={36} />
        </div>
      </div>

      <div className="mkt-keyvar">
        <span className="kv-label">{market.keyVar.labelCN}</span>
        <span className={`kv-signal ${market.keyVar.signal}`} />
        <span className="kv-val">{market.keyVar.value}</span>
        <span className="kv-cn">{market.keyVar.valueCN}</span>
      </div>

      <div className="mkt-dist">
        {market.buckets.map((b, i) => {
          const isPeak = b === best;
          const heightPct = Math.max(8, (Math.max(b.market, b.model) / maxBucketVal) * 100);
          const innerMax = Math.max(b.market, b.model);
          return (
            <div className="mkt-dist-col" key={i}>
              <div className="mkt-dist-bar-wrap">
                <div
                  className={`mkt-dist-bar${isPeak ? " peak" : ""}`}
                  style={{ height: `${heightPct}%` }}
                >
                  <div className="fill-market" style={{ height: `${(b.market / innerMax) * 100}%` }} />
                  <div className="fill-model"  style={{ height: `${(b.model  / innerMax) * 100}%` }} />
                </div>
              </div>
              <div className="mkt-dist-label">{b.label}</div>
            </div>
          );
        })}
      </div>

      <div className="mkt-foot">
        <div className="mkt-edge-block">
          <div className="l">Top bucket · 最佳区间</div>
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
function kalshiToBucket(m) {
  const s = (m.subtitle || "").trim();
  let lowerBound = -Infinity, upperBound = Infinity, range, label;
  let g;
  // "76° or below" / "Below 76°" / "under 76°"
  g = s.match(/^(\d+)°\s*(?:F\s*)?or below$/i) || s.match(/^below\s+(\d+)°/i) || s.match(/^under\s+(\d+)°/i);
  if (g) { const t=+g[1]; upperBound=t+1; range=`≤${t}°F`; label=`≤${t}`; }
  // "85° or above" / "Above 85°" / "over 85°"
  g = s.match(/^(\d+)°\s*(?:F\s*)?or above$/i) || s.match(/^above\s+(\d+)°/i) || s.match(/^over\s+(\d+)°/i);
  if (g && !range) { const t=+g[1]; lowerBound=t; range=`≥${t}°F`; label=`≥${t}`; }
  // "77° to 78°" / "77-78°F" / "Between 77° and 78°"
  g = s.match(/^(\d+)°\s*(?:F\s*)?to\s*(\d+)°/i) || s.match(/^(\d+)\s*[-–]\s*(\d+)°/i) || s.match(/^between\s+(\d+)°.*?(\d+)°/i);
  if (g && !range) { const lo=+g[1],hi=+g[2]; lowerBound=lo; upperBound=hi+1; range=`${lo}–${hi}°F`; label=`${lo}–${hi}`; }
  return { range: range||s, label: label||s, lowerBound, upperBound,
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
    forecastConf: dist ? 0.5 + Math.min(0.45, 1/(dist.std+0.1)*0.45) : market.forecastConf,
    _liveObs:    !!(obs),
    _liveModel:  !!(dist),
    _liveKalshi: !!(live.kalshiBuckets?.length),
  };
}

function MarketsView({ openAnalysis, bjtDec, liveData }) {
  const [filter, setFilter] = useState("all");

  // Merge live data into markets for edge/temp calculations
  const markets = useMemo(() =>
    DATA.markets.map(m => liveMarket(m, liveData?.[m.id])),
    [liveData]
  );

  const filtered = useMemo(() => {
    let arr = [...markets];
    if (filter === "edge") arr = arr.filter((m) => totalAbsEdge(m) > 0.07);
    if (filter === "watch") arr = arr.slice(0, 4);
    if (filter === "edge") arr.sort((a, b) => totalAbsEdge(b) - totalAbsEdge(a));
    return arr;
  }, [filter, markets]);

  const avgEdge = markets.reduce((s, m) => s + totalAbsEdge(m), 0) / markets.length;
  const top = markets
    .map((m) => ({ m, e: Math.max(...m.buckets.map((b) => b.model - b.market)) }))
    .sort((a, b) => b.e - a.e)[0];
  const activeCount = DATA.markets.filter((m) => m.windowStatus === "active").length;
  const liveCount = DATA.markets.filter(m => liveData?.[m.id]?.observation).length;

  return (
    <div className="view" data-screen-label="markets">

      <MapHero markets={markets} onOpen={openAnalysis} />

      <TonightPlaybook markets={markets} bjtDec={bjtDec} openAnalysis={openAnalysis} />

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
        <div className="kpi">
          <div className="kpi-label">
            <span className="en">Active Cities</span>
            <span className="cn">活跃城市</span>
          </div>
          <div className="kpi-value">{activeCount}</div>
          <div className="kpi-foot">窗口内 · {DATA.markets.length - activeCount} 待入场</div>
        </div>
      </div>

      <CityTimeline markets={DATA.markets} bjtDec={bjtDec} />

      <div className="section-head">
        <div>
          <h2>
            市场一览 <em>Market Overview</em>
            {liveCount > 0 && <span className="live-badge-sm" style={{ marginLeft: 8 }}>LIVE</span>}
          </h2>
          <div className="section-sub">按模型预测概率与市场价格之差排序</div>
        </div>
        <div className="section-actions">
          <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All · 全部</button>
          <button className={`chip ${filter === "edge" ? "active" : ""}`} onClick={() => setFilter("edge")}>Top edge · 高偏差</button>
          <button className={`chip ${filter === "watch" ? "active" : ""}`} onClick={() => setFilter("watch")}>Watchlist · 自选</button>
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
        </li>
        {buckets.map((b, i) => {
          const e = b.model - b.market;
          const hasBidAsk = b.yes_bid != null && b.yes_ask != null;
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * Hourly chart (analysis)
 * ───────────────────────────────────────────────────────── */
function HourlyChart({ market }) {
  const series = DATA.hourlySeries[market.city];
  const W = 720, H = 220;
  const padL = 40, padR = 24, padT = 20, padB = 36;
  const allVals = series.filter((v) => v != null).concat([market.forecastHigh, market.forecastHigh - 4]);
  const minV = Math.floor(Math.min(...allVals) / 5) * 5;
  const maxV = Math.ceil(Math.max(...allVals) / 5) * 5;
  const yRange = maxV - minV;
  const xStep = (W - padL - padR) / (series.length - 1);
  const yFor = (v) => padT + (1 - (v - minV) / yRange) * (H - padT - padB);
  const xFor = (i) => padL + i * xStep;

  const obsPoints = series.map((v, i) => (v != null ? [xFor(i), yFor(v)] : null)).filter(Boolean);
  const obsPath = obsPoints.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const areaPath = obsPath + ` L${obsPoints[obsPoints.length - 1][0]} ${H - padB} L${obsPoints[0][0]} ${H - padB} Z`;

  const lastIdx = series.findLastIndex ? series.findLastIndex((v) => v != null) : series.reduce((acc, v, i) => (v != null ? i : acc), 0);
  const forecastIdx = 16;
  const fcPath = `M${xFor(lastIdx)} ${yFor(market.currentObs)} L${xFor(forecastIdx)} ${yFor(market.forecastHigh)}`;

  const ticks = [];
  for (let v = minV; v <= maxV; v += 5) ticks.push(v);

  const open = series[0];
  const sixHourIdx = Math.min(6, lastIdx);
  const delta = market.currentObs - (series[sixHourIdx] || series[0]);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Hourly Observation <em>小时观测</em></h3>
          <div className="sub">NOAA METAR · past 14h + ensemble forecast 预测延伸</div>
        </div>
      </div>

      <div className="obs-chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="obs-chart" preserveAspectRatio="none">
          <defs>
            <linearGradient id="obsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={yFor(t)} y2={yFor(t)} stroke="var(--border)" strokeWidth="1" />
              <text x={padL - 8} y={yFor(t) + 4} fontSize="10" textAnchor="end" fill="var(--ink-3)" fontFamily="var(--mono)">{t}°</text>
            </g>
          ))}
          {[0, 4, 8, 12, 16].map((i) => (
            <text key={i} x={xFor(i)} y={H - 10} fontSize="10" textAnchor="middle" fill="var(--ink-3)" fontFamily="var(--mono)">
              {String(i).padStart(2, "0")}:00
            </text>
          ))}
          <path d={areaPath} fill="url(#obsGrad)" />
          <path d={obsPath} fill="none" stroke="var(--ink-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d={fcPath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray="4 4" />
          <circle cx={xFor(lastIdx)} cy={yFor(market.currentObs)} r="5" fill="var(--surface)" stroke="var(--ink-1)" strokeWidth="2" />
          <circle cx={xFor(forecastIdx)} cy={yFor(market.forecastHigh)} r="5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
          <text x={xFor(forecastIdx) + 8} y={yFor(market.forecastHigh) + 4} fontSize="11" textAnchor="start" fill="var(--accent)" fontFamily="var(--mono)" fontWeight="500">
            预测 {market.forecastHigh}°F
          </text>
        </svg>
      </div>

      <div className="obs-stats">
        <div className="obs-stat">
          <div className="l">Open · 开盘</div>
          <div className="v">{open}°<span style={{ fontSize: 12, color: "var(--ink-3)" }}>F</span></div>
          <div className="vs">00:00 local</div>
        </div>
        <div className="obs-stat">
          <div className="l">Current · 当前</div>
          <div className="v">{market.currentObs}°<span style={{ fontSize: 12, color: "var(--ink-3)" }}>F</span></div>
          <div className="vs">as of {market.obsTime}</div>
        </div>
        <div className="obs-stat">
          <div className="l">Δ since 06:00</div>
          <div className="v pos">+{delta}°<span style={{ fontSize: 12, color: "var(--ink-3)" }}>F</span></div>
          <div className="vs">past 6 hours</div>
        </div>
        <div className="obs-stat">
          <div className="l">Forecast · 预测峰值</div>
          <div className="v" style={{ color: "var(--accent)" }}>{market.forecastHigh}°<span style={{ fontSize: 12, color: "var(--ink-3)" }}>F</span></div>
          <div className="vs">conf {Math.round(market.forecastConf * 100)}%</div>
        </div>
      </div>
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
          <div className="sub">Open-Meteo · GFS / ECMWF / HRRR / NAM · 日内最高温 08:00–22:00 本地时</div>
        </div>
        <div className="ens-head-right">
          {dist && (
            <span className="ens-mean-tag">
              均值 <strong>{dist.mean}°F</strong> ± {dist.std}°F
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
          <div className="obs-live-meta">
            <span>{obs.sky || "—"}</span>
            <span className="sep">·</span>
            <span>{obs.windCompass} {obs.windSpeed != null ? `${obs.windSpeed}kt` : ""}{obs.windGust ? ` G${obs.windGust}kt` : ""}</span>
            <span className="sep">·</span>
            <span>露点 {obs.dewpoint != null ? `${obs.dewpoint}°F` : "—"}</span>
          </div>
          <div className="obs-live-raw">{obs.source} · {obs.rawMessage || ""}</div>
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
          {keys.map(key => {
            const m = models[key];
            const diff = dist ? +(m.dailyMax - dist.mean).toFixed(1) : null;
            const cls  = diff == null ? "flat" : diff > 0.5 ? "pos" : diff < -0.5 ? "neg" : "flat";
            return (
              <div className="ens-model" key={key}>
                <div className="ens-model-name">{key}</div>
                <div className="ens-model-temp">{m.dailyMax}<span>°F</span></div>
                <div className="ens-model-peak">峰值 {String(m.peakHour).padStart(2,"0")}:00</div>
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
          模型扩散度 {dist.spread}°F · 加入不可约误差 2.0°F → σ = {dist.std}°F · {dist.modelCount} 模型参与集成
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
function AnalysisView({ marketId, setMarketId, bjtDec, liveData, onFetch, kalshiStatus }) {
  const market = DATA.markets.find((m) => m.id === marketId) || DATA.markets[0];
  const live   = liveData?.[market.id];

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

  // Auto-fetch when this market is opened for the first time
  useEffect(() => {
    if (!live && typeof window.KW_API !== "undefined") {
      onFetch(market);
    }
  }, [market.id]);

  return (
    <div className="view" data-screen-label="analysis">
      <div className="ana-selector">
        <span className="crumb">Analysis · 深度分析</span>
        <span className="sep">/</span>
        <span className="crumb">Daily High</span>
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
            <span className="ana-tag">{market.modelConsensus}</span>
            <span className="ana-tag">conf {Math.round(market.forecastConf * 100)}%</span>
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
        <AISummary market={market} edge={edge} maxE={maxE} />
      </div>

      <div style={{ height: 16 }} />
      <HourlyChart market={market} />

      <div style={{ height: 16 }} />
      <div className="ana-row-2">
        <SuggestedPosition market={market} edge={edge} maxE={maxE} />
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

function AISummary({ market, edge, maxE }) {
  return (
    <div className="card ai-card">
      <div className="ai-head">
        <div className="ai-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2z" />
          </svg>
        </div>
        <div>
          <h3 style={{ fontSize: 15, margin: 0 }}>AI Summary</h3>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>模型综合解读 · KW-Llm v0.4</div>
        </div>
        <span className="ai-tag">Beta</span>
      </div>
      <div className="ai-body">{market.aiSummary}</div>
      <div className="ai-meta">
        <span>Generated · {DATA.lastUpdated}</span>
        <span>tokens · 320 in / 142 out</span>
      </div>
    </div>
  );
}

function SuggestedPosition({ market, edge, maxE }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Suggested Position <em>建议仓位</em></h3>
          <div className="sub">基于最大绝对偏差区间生成 · Not investment advice</div>
        </div>
      </div>
      <div className="reco">
        <div className={`reco-icon ${edge > 0 ? "pos" : ""}`}>{edge > 0 ? "↑" : "↓"}</div>
        <div className="reco-body">
          <div className="t">
            {edge > 0 ? "Buy YES" : "Buy NO"} · {maxE.range} @ {fmtCents(edge > 0 ? maxE.market : 1 - maxE.market)}
          </div>
          <div className="s">
            模型概率 <strong style={{ color: "var(--ink-1)" }}>{fmtPct(maxE.model, 1)}</strong> · 市场定价 <strong style={{ color: "var(--ink-1)" }}>{fmtPct(maxE.market, 1)}</strong>
            <br />
            EV <strong style={{ color: "var(--pos)" }}>+{Math.abs(edge * 100).toFixed(1)}¢</strong> / 合约 · Kelly ~{(Math.abs(edge) * 4).toFixed(2)}× · liquidity ${fmtVolume(market.volume)}
          </div>
        </div>
        <button className="cta">
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
        <div className="row"><span className="k">Models</span><span className="v">GFS · ECMWF · HRRR · HWRF</span></div>
        <div className="row"><span className="k">AI</span><span className="v">KW-Llm v0.4 · 15m refresh</span></div>
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
function SettingsDrawer({ open, onClose, theme, setTheme }) {
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

    models: { GFS: true, ECMWF: true, HRRR: true, NAM: true, HWRF: false },
    refreshCadence: "15m",

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
              <PillToggle options={["GFS", "ECMWF", "HRRR", "NAM", "HWRF"]} value={s.models}
                onChange={(v) => update("models", v)} />
            </SettingsRowStack>
            <SettingsRow label="Refresh cadence" cn="刷新频率">
              <Segmented value={s.refreshCadence} onChange={(v) => update("refreshCadence", v)}
                options={[{ value: "5m", label: "5m" }, { value: "15m", label: "15m" }, { value: "1h", label: "1h" }]} />
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
  const [kalshiStatus, setKalshiStatus] = useState(null); // null | "ok" | "error" | "unconfigured"

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

  // Auto-fetch: full refresh every 5 min, Kalshi-only every 90 sec
  useEffect(() => {
    const runFetch = (kalshiOnly = false) => {
      if (typeof window.KW_API === "undefined") return;
      DATA.markets.forEach(m => {
        if (kalshiOnly) {
          // Lightweight: only re-fetch Kalshi prices (fast, cheap)
          if (!window.KW_API) return;
          fetch(`/api/kalshi?ticker=${encodeURIComponent(m.id)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (!data?.markets?.length) return;
              const newKalshi  = data.markets;
              const newBuckets = newKalshi.map(km => kalshiToBucket(km));
              setLiveData(prev => {
                const old = prev[m.id];
                if (!old) return prev;  // no base data yet, skip
                return { ...prev, [m.id]: {
                  ...old,
                  kalshi:        newKalshi,
                  kalshiBuckets: newBuckets,
                  fetchedAt:     data.fetchedAt,
                }};
              });
            })
            .catch(() => {});
        } else {
          fetchLiveForMarket(m);
        }
      });
    };

    const boot    = setTimeout(() => runFetch(false), 300);       // full fetch on start
    const fullRef = setInterval(() => runFetch(false), 5 * 60 * 1000);  // full every 5 min
    const fastRef = setInterval(() => runFetch(true),  90 * 1000);       // Kalshi only every 90 sec
    return () => { clearTimeout(boot); clearInterval(fullRef); clearInterval(fastRef); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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
        />
      )}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} setTheme={setTheme} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
