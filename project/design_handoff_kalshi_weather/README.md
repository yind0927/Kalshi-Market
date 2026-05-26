# Handoff: Kalshi Weather Dashboard

## Overview

**Kalshi Weather** (气象市场) is an analytical web dashboard for traders monitoring the Kalshi prediction market platform's "daily-high temperature" contracts. It surfaces, for a curated set of US cities each day, the difference between the market-implied probability (Kalshi yes-price) and an in-house ensemble-weather-model probability — the **Edge** — and helps the user act on it.

There are two top-level views:

1. **Markets · 市场** — a list/grid overview of all tracked cities, sortable by edge, with filter chips and per-city KPI cards.
2. **Analysis · 深度分析** — a single-contract deep dive: probability distribution table, hourly observation chart, AI summary, suggested position, settlement-location map, data sources, and a risk disclaimer.

Plus a slide-in **Settings drawer** (right side) covering Account, Appearance, Units, Alerts, Trading preferences, Forecast Models, AI, and About.

## About the Design Files

The files in this bundle are **design references created in HTML/JSX** — high-fidelity prototypes showing intended look, layout, copy, and interaction behavior. **They are not production code to copy verbatim.** The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, Next.js, SwiftUI, etc.) using its established patterns, design tokens, component primitives, routing, and data-fetching layer. If no codebase / framework exists yet, pick the most appropriate stack for the project (React + TypeScript + a CSS solution like Tailwind or vanilla CSS modules is a sensible default) and implement the designs there.

The HTML prototype uses inline `<script type="text/babel">` for React — that is a prototyping convenience, not a recommended production approach.

## Fidelity

**High-fidelity (hifi).** All colors, typography, spacing, radii, shadows, and interaction states are intentional. The developer should reproduce the layout pixel-equivalent (within a few px of latitude) and match colors / type exactly. Refer to the "Design Tokens" section for raw values.

The mock data in `data.js` is illustrative; the real implementation should fetch from:
- Kalshi REST v2 — markets, prices, orderbook
- NOAA METAR / ASOS — hourly observations
- NWS NDFD — hourly forecasts
- GFS · ECMWF · HRRR · HWRF ensembles — model probability inputs

---

## Screens / Views

### 1. Top Bar (persistent across views)

- **Height**: 64px
- **Layout**: `display: flex; align-items: center; padding: 0 32px; gap: 32px;` with `position: sticky; top: 0; z-index: 10` and backdrop blur (`backdrop-filter: saturate(180%) blur(12px)`).
- **Components**:
  - **Brand** (left)
    - 32×32 rounded-square mark (radius 9px) with a **sky-blue gradient background** (`linear-gradient(135deg, oklch(0.55 0.18 248), oklch(0.66 0.16 232), oklch(0.76 0.13 220))`), an inset white highlight, and a small drop shadow. The same gradient is used in both light and dark themes for brand consistency.
    - Inside: a white **cloud icon** (SVG, single path: `M9.5 23.5h13a5 5 0 0 0 .8-9.94 6.5 6.5 0 0 0 -12.43 -1.4A4.75 4.75 0 0 0 9.5 23.5z`)
    - Wordmark: "Kalshi Weather" in **Unbounded** 500, 14px, letter-spacing -0.015em
    - Subtitle: "气象市场" in **Noto Sans SC** 400, 11px, separated by a vertical 1px border with 10px padding
  - **Tabs** (center-left)
    - Container: `background: var(--bg-2); padding: 4px; border-radius: 10px; border: 1px solid var(--border);`
    - Two tabs: "Markets · 市场" and "Analysis · 深度分析"
    - Each tab has an SVG icon + EN label + CN label (smaller, muted)
    - Active state: white surface background, 600 font-weight, shadow `0 0 0 1px var(--border-strong), 0 1px 2px rgba(20,20,30,0.06), 0 4px 12px -4px rgba(20,20,30,0.12)`
  - **Right cluster**
    - Theme-toggle icon button (sun / moon, 36×36, rounded 9px)
    - Settings (gear) icon button — opens drawer

### 2. Markets View

- **Container**: `max-width: 1440px; margin: 0 auto; padding: 40px 32px 80px;`
- **Hero block**:
  - Grid `1fr auto`, items aligned to bottom
  - Eyebrow text (uppercase mono 11px, letter-spacing 0.08em) with a 16px-wide leading dash
  - H1: 40px Manrope 700, letter-spacing -0.03em, line-height 1.05. Title in EN, with a smaller (0.62×) muted subtitle below ("今日天气合约 · 共 8 个市场")
  - Sub-text: 15px ink-2, max-width 540px
  - Right side: "Updated <timestamp>" in mono 12px
- **KPI strip**: 4-column grid, 16px gap
  - Each card: surface bg, 1px border, radius 12px, padding 22px 24px
  - Label stacked: EN uppercase 11px (ink-3) + CN 13px 500 (ink-1)
  - Value: JetBrains Mono 32px 500, letter-spacing -0.03em
  - Footer line: mono 11.5px ink-3; for delta values use a `.kpi-delta.pos` pill (green) or `.neg` (red), padding 2px 7px, radius 4px
  - Cards: hover lifts 1px and gains shadow `0 1px 3px / 0 6px 18px -8px`
- **Section head**: 22px Manrope 600 + smaller muted CN em + sub-line; right-aligned filter chips ("All · 全部", "Top edge · 高偏差", "Watchlist · 自选")
  - Chips: 32px tall, radius 8px, white background, 1px border. Active = dark ink-1 background with surface text
- **Card grid**: 2-column, 16px gap. Each market card contains:
  - **Top row**: City name (22px 600 -0.02em) + small CN city (13px ink-3) on the left; an `EdgePill` on the right (large variant: 14px, 6px 10px padding, radius 7px, pos/neg/flat color)
  - **Contract id**: mono 11px ink-3, second line
  - **Temperature row**: two "Current 当前 / Forecast 预测" blocks, each with an 11px uppercase label and a 38px mono value with degree suffix; arrow → between; SVG sparkline (84×36) on the far right
  - **Mini distribution**: 5 vertical paired bars (market grey / model accent-blue) sized as a fraction of the row's max value. Peak bucket gets full-opacity model fill, others 0.55. Bucket labels (mono 9.5px) beneath each column
  - **Footer**: "Top bucket · 最佳区间" with the bucket range + market-vs-model summary; volume on right (e.g. "$184.3k"); a circular 32×32 arrow button (background dark on hover)
- Cards are clickable (anywhere) → navigates to Analysis tab pre-loaded with that market

### 3. Analysis View

- **Container**: same `.view` container (max-width 1440)
- **Breadcrumb / selector** (top): "Analysis · 深度分析 / Daily High /" then a styled `<select>` with all markets
- **Ana-hero card**: padding 32px, radius 18px, surface bg, with a faint accent radial gradient overlay (`::before` positioned top-right at -40%/-10%, ellipse gradient, z-index 0; direct children get position relative z-index 1 so they sit above it)
  - Eyebrow, H2 32px 700 ("New York Daily High"), CN inline (16px ink-3 400), sub-text (14px ink-2, max-width 540), tag row (5 small mono pills: airport, model consensus, conf %, volume, OI)
  - Right side: big "Max Edge · 最大偏差" stack — uppercase label 11px, then 56px mono value colored pos/neg, then small mono subtext
- **Row: ProbDistribution (1.6fr) + AISummary (1fr)**
  - ProbDistribution card has a header with title + legend (Market grey / Model blue swatches)
  - List rows are grid `100px 1fr 70px 70px 80px`, gap 18px. Bar pairs market-on-top (ink-4 grey) / model-on-bottom (accent), each 10px tall with 5px gap, rounded 3px. Right columns: market cents, model %, EdgePill
  - AISummary card has a soft accent-tinted background (`linear-gradient(180deg, var(--accent-soft), var(--surface) 80%)`), a small "AI Summary" header with icon and "Beta" tag, body text 14px line-height 1.7, footer with generated time and token count
- **Hourly chart card**: full width
  - SVG chart 720×220 viewBox, padL 40 / padR 24 / padT 20 / padB 36
  - Light grid lines (var(--border)), Y-axis temperature ticks every 5°F (mono 10px ink-3), X-axis hour labels at 0/4/8/12/16
  - Observed line: solid ink-1 2px width, with a subtle area gradient underneath (accent, 0.18 → 0)
  - Forecast line: dashed accent (4 4) extending from last observation to forecast peak
  - Endpoints: 5px circles, surface fill + 2px stroke. Forecast endpoint labeled "预测 <high>°F" in accent
  - Stats grid below: 4 columns (Open / Current / Δ since 06:00 / Forecast peak), borders, large mono values
- **Row: SuggestedPosition + LocationCard**
  - SuggestedPosition card: contains a `.reco` row (`grid: auto 1fr auto`) with a 42px rounded-square icon (↑ pos color or ↓), title line ("Buy YES · 80–84°F @ 46¢"), descriptive subtitle (model %, market %, EV +¢/contract, Kelly fraction, liquidity), and a primary CTA button "View on Kalshi" (dark ink-1 background, white text)
  - **LocationCard** — see "Map Components" below
- **DataSources** card: full width, kv-list rows showing data source + cadence (Markets / Obs / Forecast / Models / AI / Refresh)
- **Risk disclaimer**: warn-color soft background with a 3px left border in `var(--warn)`, body text 12.5px line-height 1.65

### 4. Settings Drawer (right slide-in)

- **Trigger**: gear icon in top bar
- **Overlay**: fixed, full-viewport, `background: color-mix(in oklab, var(--ink-1) 35%, transparent); backdrop-filter: blur(4px); z-index: 100`; fades in over 0.25s
- **Drawer**: fixed right, width 480px (full-viewport at ≤540px), z-index 101, transforms `translateX(100% → 0)` over 0.32s `cubic-bezier(0.4, 0, 0.2, 1)`, shadow `-20px 0 60px -20px rgba(0,0,0,0.2)`
- **Closes on**: Esc, overlay click, close button (32×32 with X icon), Cancel button, Done button
- **Structure**:
  - **Head** (`padding: 24px 28px 18px`): H2 20px 700 "Settings · 设置" (CN em is Noto Sans SC), sub-paragraph 12.5px ink-3 description, top-right close button. 1px border-bottom
  - **Body** (`overflow-y: auto; padding: 8px 0 24px`): 8 sections, each `padding: 20px 28px 4px`, separated by 1px border-top (except first)
  - **Foot** (`padding: 14px 28px`): "Auto-saved · 已自动保存" mono label on the left, Cancel + Done buttons on the right
- **Sections** (with icons + EN title + CN em + optional badge):
  1. **Account · 账户** [Pro badge]
     - Account card: 40×40 gradient avatar ("JZ"), name + email, plan pill ("Pro · 199/mo")
     - API row: green pulse dot + "Kalshi API · connected", masked key on right
  2. **Appearance · 外观**: Theme (Light/Dark/System segmented), Language (EN/中文/Auto), Density (Comfy/Compact)
  3. **Units · 单位**: Temperature (°F/°C), Time zone (Local/ET/UTC), Number format (US/EU)
  4. **Alerts · 提醒**: Edge threshold slider (1–20pp), Channels pill multi-toggle (Email/Webhook/Slack/SMS), Daily digest switch, Settlement reminder switch, Silent hours switch
  5. **Trading · 交易偏好**: Default size (number input), Min edge filter slider (0–15pp), Max positions (number input), Auto-suggest switch
  6. **Forecast Models · 预测模型**: Active ensembles (GFS/ECMWF/HRRR/NAM/HWRF) as pill toggles; Refresh cadence segmented (5m/15m/1h)
  7. **AI Assistant · AI 助手** [Beta badge]: AI summary switch, Verbosity segmented (Concise/Detailed)
  8. **About · 关于**: Version row (mono small), Status page link, Docs link, Anonymous telemetry switch

- **Controls** (custom-built, see `app.jsx` for reference impls):
  - **Switch**: 38×22 pill, white thumb (18px), translates 16px when on; on-state background = `var(--accent)`
  - **Segmented**: pill row inside `var(--bg-2)` container, padding 3px gap 2px, active pill = surface with shadow
  - **Slider**: 4px track in `var(--border-strong)`, accent-bordered 16×16 thumb, plus a fixed-width mono value chip next to it
  - **PillToggle**: rounded-full pills, on-state = soft-accent background, accent border, accent-ink text

---

## Map Components

### LocationCard (Analysis view)

A small US outline (SVG, viewBox 720×380) with a single highlighted city marker for the currently selected market. Used inside an Analysis card with three info rows (Station / Region / Settles on).

- **Outline**: single SVG path (see `app.jsx`, `US_PATH` constant), fill `var(--bg-2)`, stroke `var(--border-strong)`, stroke-width 1.2, line-join round
- **City coordinates**: mapped manually in `CITY_COORDS` constant in `app.jsx`. (`Boston: [675,170]`, `New York: [645,198]`, `Philadelphia: [625,218]`, `Chicago: [470,145]`, `Denver: [275,200]`, `Austin: [385,315]`, `Miami: [617,365]`, `Los Angeles: [108,268]`)
- **Marker** (compact mode): 7px filled circle (accent), 2px surface stroke, plus a 13px no-fill pulse ring (`stroke: var(--accent)`, animated `ringPulse` 2s ease-out infinite — scale 1 → 1.6, opacity 0.7 → 0). Inner white 0.32× dot for highlight
- **Marker label**: city name above the dot in 10px (or 11px focus) Manrope 500/600, fill ink-2 (or accent-ink focus)
- **Card layout**: card-head with title + sub-line; body grid 1fr; map sits in a `var(--bg-2)` box with 12px padding and 10px radius; 3 info rows below with 32×32 icon squares + label/value

---

## Interactions & Behavior

- **Tab switching**: `tab` state stored in App. Clicking a tab swaps the entire view (no router needed for the prototype, but real impl should use the project's router)
- **Theme toggle**: `theme` state cycles between `light` ↔ `dark` (Settings drawer also exposes `system`, which resolves at mount from `window.matchMedia('(prefers-color-scheme: dark)')`). Effect writes `data-theme` attribute on `<html>`; CSS reads it via `[data-theme="dark"]` selectors that override the base custom-property tokens.
- **Market-card click** → `openAnalysis(marketId)` which sets `marketId` + `tab='analysis'` + smooth-scrolls to top
- **Analysis market selector** (`<select>`): switches the loaded contract in place
- **Settings drawer**: Esc closes, overlay click closes; all settings persist to local React state in the prototype — real impl should persist to user profile / localStorage
- **Hover states**:
  - Cards: `transform: translateY(-1px); box-shadow: var(--shadow-md);` over 0.2s
  - Buttons: subtle background lightening; primary buttons lift 1px
- **EdgePill**: shows `↑` / `↓` / `·` glyph based on sign, then absolute value with 1 decimal point and `pp` suffix. Color is green (pos) for edge > 1.5pp, red (neg) for edge < -1.5pp, neutral grey (flat) otherwise

---

## State Management

For the real implementation, expect these top-level pieces of state:

| State | Type | Description |
| --- | --- | --- |
| `tab` | `"markets" \| "analysis"` | Active top-level view |
| `theme` | `"light" \| "dark" \| "system"` | Visual theme |
| `marketId` | `string` | Selected contract for Analysis view |
| `settingsOpen` | `boolean` | Drawer open/closed |
| `settings` | `object` | All values from the Settings drawer (see Sections list) |
| `filter` (Markets) | `"all" \| "edge" \| "watch"` | Filter chip |
| `markets` | `Market[]` | List loaded from Kalshi |
| `observations` | `{[city]: number[]}` | Hourly METAR series |
| `aiSummaries` | `{[marketId]: string}` | LLM-generated text, refreshed every 15min |

Each market record (see `data.js` for the full shape):
```ts
type Market = {
  id: string;          // "KXHIGHNY-26MAY25"
  city: string;        // English city name
  cnCity: string;      // Chinese city name
  airport: string;     // "KNYC · Central Park"
  date: string;
  currentObs: number;  // °F
  obsTime: string;
  forecastHigh: number;
  forecastConf: number;
  modelConsensus: string;  // "GFS · ECMWF · HRRR"
  buckets: { range: string; label: string; market: number; model: number }[];
  volume: number;
  openInterest: number;
  aiSummary: string;
};
```

Polling cadence (per `Data Sources` section): markets 5s, observations 60s, forecasts 15m, model probabilities 15m, AI summaries 15m.

---

## Design Tokens

All tokens are declared as CSS custom properties on `:root` (light) and `[data-theme="dark"]` (dark). Use OKLCH for new values to keep the harmonic palette consistent.

### Colors — Light theme

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `oklch(0.985 0.003 250)` | Page background |
| `--bg-2` | `oklch(0.965 0.004 250)` | Secondary background (slight tint) |
| `--surface` | `#ffffff` | Card / panel surface |
| `--surface-2` | `oklch(0.985 0.004 250)` | Elevated surface |
| `--border` | `oklch(0.92 0.005 250)` | Default 1px borders |
| `--border-strong` | `oklch(0.84 0.008 250)` | Emphasized borders / dividers |
| `--ink-1` | `oklch(0.18 0.012 250)` | Primary text |
| `--ink-2` | `oklch(0.42 0.010 250)` | Secondary text |
| `--ink-3` | `oklch(0.60 0.008 250)` | Tertiary / muted text |
| `--ink-4` | `oklch(0.75 0.006 250)` | Very muted / placeholder |
| `--accent` | `oklch(0.55 0.16 255)` | Primary accent (blue) |
| `--accent-soft` | `oklch(0.94 0.04 255)` | Accent background tint |
| `--accent-ink` | `oklch(0.40 0.18 255)` | Accent text |
| `--pos` | `oklch(0.56 0.14 150)` | Positive edge / gain |
| `--pos-soft` | `oklch(0.95 0.05 150)` | Pos pill background |
| `--neg` | `oklch(0.58 0.20 27)` | Negative edge / loss |
| `--neg-soft` | `oklch(0.95 0.05 27)` | Neg pill background |
| `--warn` | `oklch(0.70 0.13 75)` | Warning accent (risk card) |
| `--warn-soft` | `oklch(0.95 0.05 75)` | Warn background |

### Colors — Dark theme

| Token | Value |
| --- | --- |
| `--bg` | `oklch(0.15 0.012 255)` |
| `--bg-2` | `oklch(0.18 0.013 255)` |
| `--surface` | `oklch(0.20 0.014 255)` |
| `--surface-2` | `oklch(0.22 0.014 255)` |
| `--border` | `oklch(0.28 0.014 255)` |
| `--border-strong` | `oklch(0.36 0.014 255)` |
| `--ink-1` | `oklch(0.97 0.006 255)` |
| `--ink-2` | `oklch(0.78 0.010 255)` |
| `--ink-3` | `oklch(0.58 0.012 255)` |
| `--ink-4` | `oklch(0.40 0.012 255)` |
| `--accent` | `oklch(0.72 0.16 255)` |
| `--accent-soft` | `oklch(0.32 0.10 255)` |
| `--accent-ink` | `oklch(0.82 0.16 255)` |
| `--pos` | `oklch(0.74 0.16 150)` |
| `--pos-soft` | `oklch(0.30 0.08 150)` |
| `--neg` | `oklch(0.72 0.18 27)` |
| `--neg-soft` | `oklch(0.32 0.08 27)` |
| `--warn` | `oklch(0.78 0.13 75)` |
| `--warn-soft` | `oklch(0.32 0.08 75)` |

### Typography

| Token | Family | Notes |
| --- | --- | --- |
| `--sans` | `"Manrope", "Noto Sans SC", system-ui, sans-serif` | UI default; CJK falls through to Noto Sans SC via unicode-range |
| `--mono` | `"JetBrains Mono", ui-monospace, monospace` | All numeric data (cents, %, pp, temps, times, IDs) |
| Brand wordmark | `"Unbounded"`, 500 weight, -0.015em tracking | Logo only |
| Chinese | `"Noto Sans SC"`, 400/500/600 | Used directly for CN em labels |

Scale:
- Body: 14px / 1.5 / -0.005em
- Hero H1: 40px / 1.05 / -0.03em / 700
- Section H2: 22px / -0.02em / 600
- Card H3: 16px / -0.015em / 600
- KPI value: 32px mono / -0.03em / 500
- Eyebrow uppercase: 11px mono / 0.08em letter-spacing

### Spacing / radii / shadows

| Token | Value |
| --- | --- |
| `--radius-sm` | `6px` |
| `--radius` | `12px` |
| `--radius-lg` | `18px` |
| `--shadow-sm` | `0 1px 2px oklch(0.20 0.02 250 / 0.04)` |
| `--shadow-md` | `0 1px 3px oklch(0.20 0.02 250 / 0.05), 0 6px 18px -8px oklch(0.20 0.02 250 / 0.10)` |

Standard spacing scale used inline: 4 / 6 / 8 / 12 / 14 / 16 / 18 / 20 / 22 / 24 / 28 / 32 / 40 / 48 px.

---

## Assets

- **Fonts** (Google Fonts): Manrope (400/500/600/700/800), Unbounded (500/600/700), Space Grotesk (loaded but only used as brand fallback), Noto Sans SC (400/500/600), JetBrains Mono (400/500/600).
- **Logo mark**: vector cloud, single SVG path — no raster image needed. Background gradient is a CSS `linear-gradient` (see Top Bar / Brand notes).
- **Icons**: All icons are inline SVG strokes (no icon font, no library). 2px stroke, currentColor. The patterns used (search glass, bell, gear, cloud, sun, moon, arrows, etc.) come from common Lucide / Heroicons equivalents and can be substituted with the codebase's icon library 1:1.
- **US outline path**: hand-simplified continental US in viewBox 720×380. Lives as the `US_PATH` constant in `app.jsx` — consider extracting to a small `map-data.ts` module.
- **No image assets** are required for the design itself.

---

## Files in this bundle

| File | What it is |
| --- | --- |
| `index.html` | Page shell, font imports, mounts React via Babel-standalone |
| `app.jsx` | All UI components (TopBar, MarketsView, AnalysisView, USMap, MapHero, LocationCard, SettingsDrawer + form controls, App) |
| `data.js` | Mock data — markets, hourly series, AI summaries |
| `styles.css` | All design tokens + styles (light + dark themes) |
| `tweaks-panel.jsx` | (Unused in the final design but kept for reference) |

The HTML prototype is self-contained — open `index.html` in a browser to view the live design. Use it side-by-side with the README when implementing.

---

## Notes for implementation

- **Don't reproduce Kalshi's own branded UI** — Kalshi Weather is an independent third-party analytical tool. Use the brand-mark / palette in this design, not Kalshi's.
- **`MapHero` component** is defined in `app.jsx` but **not currently used** on the Markets page (it was iterated on and removed). The component and the related `.map-card / .map-body / .map-detail` CSS can be deleted in the production codebase if a markets-level map view is not in scope. The `LocationCard` (Analysis view) IS in use and depends on the same `USMap` component + `US_PATH` / `CITY_COORDS` constants.
- The user's email-domain in the prototype's Account section ("jamie.zhang@email.com") is placeholder — pull real account data from the auth provider.
- The "Risk Disclosure" copy is intentional — keep it visible on every Analysis view per regulatory best practice.
- Accessibility:
  - Drawer close on Esc is implemented; ensure focus-trapping in production
  - Tabs should use `role="tablist"` / `role="tab"` / `aria-selected`
  - All icon-only buttons should carry an `aria-label` (the prototype includes `title=` attributes that should become `aria-label` in production)
  - Color contrast is AA at all sizes used; verify after substituting your design system's tokens
