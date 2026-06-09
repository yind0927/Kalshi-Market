/* ============================================================
 * Kalshi Weather — Live API Layer
 *
 * Sources:
 *   NWS      https://api.weather.gov  (free, no key, CORS OK)
 *   Open-Meteo https://open-meteo.com (free, no key, CORS OK)
 *   Kalshi   https://trading-api.kalshi.com (needs account; CORS
 *            may be restricted — falls back to mock gracefully)
 * ========================================================== */

window.KW_API = (() => {

  /* ── Station / city configuration ──────────────────────── */
  const CITIES = {
    "New York":    { stationId:"KNYC", lat:40.7789, lon:-73.9692, tz:"America/New_York"      },
    "Miami":       { stationId:"KMIA", lat:25.7959, lon:-80.2870, tz:"America/New_York"      },
    "Chicago":     { stationId:"KMDW", lat:41.7868, lon:-87.7522, tz:"America/Chicago"       },
    "Austin":      { stationId:"KAUS", lat:30.1945, lon:-97.6699, tz:"America/Chicago"       },
    "Dallas":      { stationId:"KDFW", lat:32.8998, lon:-97.0403, tz:"America/Chicago"       },
    "Los Angeles": { stationId:"KLAX", lat:33.9425, lon:-118.408, tz:"America/Los_Angeles"   },
  };

  // Open-Meteo NWP models (all use /v1/forecast, same variable names)
  const OM_MODELS = [
    { key: "HRRR", id: "gfs_hrrr"       },
    { key: "GFS",  id: "gfs_seamless"   },
  ];

  // Cache NWS gridpoint URLs — stable per lat/lon; stores { daily, hourly }
  const NWS_GRIDPOINT_CACHE = new Map();

  async function getNWSGridpointUrls(lat, lon) {
    const key = `${lat},${lon}`;
    if (NWS_GRIDPOINT_CACHE.has(key)) return NWS_GRIDPOINT_CACHE.get(key);
    const res = await fetch(
      `https://api.weather.gov/points/${lat},${lon}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`NWS points ${res.status}`);
    const data = await res.json();
    const urls = {
      daily:  data.properties?.forecast,
      hourly: data.properties?.forecastHourly,
    };
    if (!urls.daily) throw new Error("NWS: missing forecast URLs from /points/");
    NWS_GRIDPOINT_CACHE.set(key, urls);
    return urls;
  }

  /* ── Helpers ────────────────────────────────────────────── */
  const cToF = c  => c  != null ? +(c  * 9/5 + 32).toFixed(1) : null;
  const msToKt = s => s  != null ? +(s  * 1.94384).toFixed(1)  : null;

  // Error function approximation (Abramowitz & Stegun 7.1.26)
  function erf(x) {
    const s = x >= 0 ? 1 : -1, ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const p = ((((1.061405429*t - 1.453152027)*t + 1.421413741)*t
              - 0.284496736)*t + 0.254829592)*t;
    return s * (1 - p * Math.exp(-ax * ax));
  }
  function normalCDF(x, mu, sigma) {
    return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
  }

  /* ── 0. NWS Official Daily Forecast ────────────────────── */
  // NWS is not a single NWP model — it's a human-QC'd blend (NBM-based)
  // calibrated specifically for each ASOS station area.  For Kalshi it's
  // the most directly relevant forecast: same agency, same station domain.
  //
  // Uses the DAILY forecast endpoint (not hourly) so the temperature
  // matches weather.gov "High: XX°F" — the official forecaster-issued max
  // that Kalshi contracts reference at settlement.
  async function fetchNWSForecast(lat, lon, tz) {
    // Step 1: resolve gridpoint URLs (shared cache with hourly display fetch)
    const urls = await getNWSGridpointUrls(lat, lon);

    // Step 2: fetch daily forecast
    const fcRes = await fetch(urls.daily, { headers: { Accept: "application/json" } });
    if (!fcRes.ok) throw new Error(`NWS daily forecast ${fcRes.status}`);
    const fcData = await fcRes.json();

    const periods = fcData.properties?.periods;
    if (!periods?.length) throw new Error("NWS: empty forecast periods");

    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const toLocalDate = (isoStr) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(isoStr));

    // Find today's daytime period — official NWS daily high (same as weather.gov).
    // Falls back to next available daytime period if today's has already passed.
    const daytime =
      periods.find(p => p.isDaytime && toLocalDate(p.startTime) === todayStr) ||
      periods.find(p => p.isDaytime);

    if (!daytime) throw new Error("NWS: no daytime forecast period found");

    const temp = daytime.temperature;
    if (!isFinite(temp) || temp < -60 || temp > 140) {
      throw new Error(`NWS: implausible temperature ${temp}°F`);
    }

    return {
      dailyMax:    temp,
      peakHour:    null,   // daily product has no single peak hour
      windAtPeak:  null,
      cloudAtPeak: null,
      updatedAt:   new Date().toISOString(),
    };
  }

  /* ── 0b. NWS Hourly Forecast — for display list ────────── */
  // Returns today + tomorrow's hourly periods for the table view.
  // Peak calculation still uses the daily endpoint above.
  async function fetchNWSHourlyForecast(lat, lon, tz) {
    const urls = await getNWSGridpointUrls(lat, lon);
    const res = await fetch(urls.hourly, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NWS hourly forecast ${res.status}`);
    const data = await res.json();
    const periods = data.properties?.periods;
    if (!periods?.length) throw new Error("NWS: empty hourly periods");

    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(tomorrow);

    const toLocalDate = iso =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
    const toLocalHour = iso =>
      parseInt(new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", hour12: false,
      }).format(new Date(iso)), 10);

    return periods
      .filter(p => { const d = toLocalDate(p.startTime); return d === todayStr || d === tomorrowStr; })
      .slice(0, 48)
      .map(p => ({
        localDate:     toLocalDate(p.startTime),
        localHour:     toLocalHour(p.startTime),
        temp:          p.temperature,
        windSpeed:     p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
        isDaytime:     p.isDaytime,
      }));
  }

  /* ── 1. NWS Current Observation ────────────────────────── */
  async function fetchObservation(stationId) {
    const url = `https://api.weather.gov/stations/${stationId}/observations?limit=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);
    const data = await res.json();
    const p    = data.features[0]?.properties;
    if (!p) throw new Error("No NWS observation");

    // Wind direction → compass
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const compass = p.windDirection?.value != null
      ? dirs[Math.round(p.windDirection.value / 22.5) % 16] : "—";

    const windKt = msToKt(p.windSpeed?.value);
    const windMs = p.windSpeed?.value != null ? +p.windSpeed.value.toFixed(1) : null;

    // Wind speed → Beaufort-based category (Chinese)
    function windCategory(kt) {
      if (kt == null) return "—";
      if (kt < 1)  return "静风";
      if (kt < 4)  return "软风";
      if (kt < 7)  return "轻风";
      if (kt < 11) return "微风";
      if (kt < 17) return "和风";
      if (kt < 22) return "清风";
      if (kt < 28) return "强风";
      if (kt < 34) return "疾风";
      return "大风";
    }

    // Cloud layers → % coverage estimate + dominant code
    // METAR okta codes: SKC/CLR=0  FEW≈15%  SCT≈44%  BKN≈75%  OVC=100%
    const CLOUD_PCT = { SKC: 0, CLR: 0, CAVOK: 0, FEW: 15, SCT: 44, BKN: 75, OVC: 100 };
    const CLOUD_CN  = { SKC:"晴空", CLR:"晴空", CAVOK:"晴空", FEW:"少云", SCT:"疏云", BKN:"多云", OVC:"阴天" };
    let cloudCoverPct = null, cloudCode = null;
    if (p.cloudLayers?.length) {
      // Take the layer with highest coverage
      const topLayer = p.cloudLayers.reduce((mx, l) =>
        (CLOUD_PCT[l.amount] ?? 0) >= (CLOUD_PCT[mx.amount] ?? 0) ? l : mx,
        p.cloudLayers[0]
      );
      cloudCode     = topLayer.amount;
      cloudCoverPct = CLOUD_PCT[cloudCode] ?? null;
    } else if (Array.isArray(p.cloudLayers)) {
      // Empty array = station reports clear sky (CAVOK / SKC)
      cloudCode     = "SKC";
      cloudCoverPct = 0;
    }
    const cloudLabel = cloudCode ? (CLOUD_CN[cloudCode] || cloudCode) : "—";

    // Relative humidity from temperature + dewpoint (Magnus formula)
    const tempC = p.temperature?.value;
    const dewC  = p.dewpoint?.value;
    let humidity = null;
    if (tempC != null && dewC != null) {
      const es = Math.exp((17.625 * tempC) / (243.04 + tempC));
      const ea = Math.exp((17.625 * dewC)  / (243.04 + dewC));
      humidity = Math.round(Math.min(100, Math.max(0, 100 * ea / es)));
    }

    // Plain-text sky summary (for fallback display)
    const sky = p.cloudLayers?.map(l =>
      `${CLOUD_CN[l.amount] || l.amount}${l.base?.value != null
        ? " " + Math.round(l.base.value * 3.281) + "ft" : ""}`).join(" · ") || "—";

    return {
      temperature:   cToF(p.temperature?.value),
      dewpoint:      cToF(p.dewpoint?.value),
      humidity,                          // % RH (Magnus formula)
      windDirection: p.windDirection?.value,
      windCompass:   compass,
      windSpeed:     windKt,       // knots — used in wind correction (>10kt threshold)
      windSpeedMs:   windMs,       // m/s — displayed in obs strip
      windGust:      msToKt(p.windGust?.value),
      windGustMs:    p.windGust?.value != null ? +p.windGust.value.toFixed(1) : null,
      windCategory:  windCategory(windKt),
      cloudCoverPct,                     // 0–100 estimated %
      cloudCode,                         // METAR code: FEW/SCT/BKN/OVC
      cloudLabel,                        // Chinese label
      sky,
      rawMessage:    p.rawMessage,
      timestamp:     p.timestamp,
      source:        "NWS ASOS",
    };
  }

  /* ── 1b. NWS Hourly Observation History (last 24h) ──────── */
  async function fetchHourlyObs(stationId, tz) {
    // Fetch 80 raw obs: at 20-min METAR intervals this covers ~26h
    const url = `https://api.weather.gov/stations/${stationId}/observations?limit=80`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NWS hourly HTTP ${res.status}`);
    const data = await res.json();

    // Parse each observation; NWS returns newest-first → reverse to oldest-first
    const raw = data.features
      .map(f => {
        const p = f.properties;
        const tempF = cToF(p.temperature?.value);
        if (tempF == null || !p.timestamp) return null;

        // Get local hour using Intl
        let localHour = null;
        try {
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "numeric", minute: "numeric", hour12: false,
          });
          const parts = fmt.formatToParts(new Date(p.timestamp));
          const h = parseInt(parts.find(x => x.type === "hour")?.value   || "0");
          const m = parseInt(parts.find(x => x.type === "minute")?.value || "0");
          localHour = h + m / 60;
        } catch (_) {}

        return {
          timestamp: p.timestamp,
          localHour,
          temp:      tempF,
          windSpeed: msToKt(p.windSpeed?.value),
        };
      })
      .filter(Boolean)
      .reverse(); // oldest first

    if (raw.length === 0) return [];

    // Deduplicate: keep one reading per UTC hour bucket (closest to top of hour)
    // Prevents jagged lines from high-frequency METAR stations
    const hourMap = new Map();
    for (const obs of raw) {
      const bucket = Math.floor(new Date(obs.timestamp).getTime() / 3_600_000);
      const existing = hourMap.get(bucket);
      if (!existing) {
        hourMap.set(bucket, obs);
      } else {
        // Prefer reading closest to :00 min
        const newMins  = (obs.localHour ?? 0) % 1 * 60;
        const oldMins  = (existing.localHour ?? 0) % 1 * 60;
        const newDist  = Math.min(newMins, 60 - newMins);
        const oldDist  = Math.min(oldMins, 60 - oldMins);
        if (newDist < oldDist) hourMap.set(bucket, obs);
      }
    }

    const sorted = [...hourMap.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Cap to last 27 hours so NYC (hourly station × 80 = 80h!) doesn't over-extend
    if (sorted.length === 0) return [];
    const cutoff = new Date(sorted[sorted.length - 1].timestamp).getTime() - 27 * 3_600_000;
    return sorted.filter(obs => new Date(obs.timestamp).getTime() >= cutoff);
  }

  /* ── 2. Multi-Model Forecast (Open-Meteo NWP + NWS official) ── */
  async function fetchModels(city) {
    const cfg = CITIES[city];
    if (!cfg) throw new Error(`Unknown city: ${city}`);

    const results = {};
    const errs    = {};

    // Run all fetches in parallel: 3 Open-Meteo NWP models + NWS official forecast
    await Promise.allSettled([
      // ── Open-Meteo NWP models ──────────────────────────────
      ...OM_MODELS.map(async ({ key, id }) => {
        const params = new URLSearchParams({
          latitude:         cfg.lat,
          longitude:        cfg.lon,
          hourly:           "temperature_2m,windspeed_10m,winddirection_10m,cloudcover",
          models:           id,
          temperature_unit: "fahrenheit",
          windspeed_unit:   "kn",
          timezone:         cfg.tz,
          forecast_days:    1,
        });

        const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!res.ok) throw new Error(`OpenMeteo ${res.status}`);
        const data = await res.json();

        const times = data.hourly.time;
        const temps = data.hourly.temperature_2m;
        const winds = data.hourly.windspeed_10m;
        const wdirs = data.hourly.winddirection_10m;
        const cloud = data.hourly.cloudcover || [];

        // Build hourly array
        const hourly = times.map((t, i) => ({
          hour:    parseInt(t.slice(11, 13), 10),
          temp:    temps[i] != null ? +temps[i] : null,
          wind:    winds?.[i] != null ? +winds[i] : null,
          windDir: wdirs?.[i] ?? null,
          cloud:   cloud[i]  != null ? +cloud[i] : null,
        })).filter(h => isFinite(h.hour));

        if (hourly.length === 0) throw new Error(`Empty hourly array from ${id}`);

        // Peak window: 08:00–22:00 local. If model is coarse (6-hourly ECMWF)
        // and returns nulls inside that window, fall back to the full day.
        const inWindow   = hourly.filter(h => h.hour >= 8 && h.hour <= 22 && h.temp != null);
        const candidates = inWindow.length > 0
          ? inWindow
          : hourly.filter(h => h.temp != null);

        if (candidates.length === 0) throw new Error(`No valid temperature data from ${id}`);

        const peak = candidates.reduce((mx, h) => h.temp > mx.temp ? h : mx);

        // Sanity guard — reject fill-values / clearly broken responses
        if (!isFinite(peak.temp) || peak.temp < -60 || peak.temp > 140) {
          throw new Error(`Implausible temperature ${peak.temp}°F from ${id} — skipping`);
        }

        results[key] = {
          dailyMax:      +peak.temp.toFixed(1),
          peakHour:      peak.hour    ?? null,
          windAtPeak:    peak.wind    != null ? +peak.wind.toFixed(1)    : null,
          windDirAtPeak: peak.windDir != null ? Math.round(peak.windDir) : null,
          cloudAtPeak:   peak.cloud   != null ? +peak.cloud              : null,
          hourly,
          updatedAt:     new Date().toISOString(),
        };
      }).map((p, i) => p.catch(e => { errs[OM_MODELS[i].key] = e.message; })),

      // ── NWS official hourly forecast ───────────────────────
      fetchNWSForecast(cfg.lat, cfg.lon, cfg.tz)
        .then(d  => { results["NWS"] = d; })
        .catch(e => { errs["NWS"]    = e.message; }),
    ]);

    return { models: results, errors: errs };
  }

  /* ── 3a. Parse a Kalshi market subtitle → bucket bounds ──── */
  // Handles integer temps ("76°"), decimal temps ("68.5°"), and ticker-suffix fallback.
  function kalshiToBucket(m) {
    const s = (m.subtitle || "").trim();
    let lowerBound = -Infinity, upperBound = Infinity, range, label;
    const NUM = "(\\d+(?:\\.\\d+)?)"; // matches integers and decimals like 68.5

    // ── Pattern 1: "76° or below" / "76°F or below" / "Below 76°"
    let g = s.match(new RegExp(`^${NUM}°\\s*(?:F\\s*)?or below$`, "i"))
         || s.match(new RegExp(`^below\\s+${NUM}°`, "i"))
         || s.match(new RegExp(`^(?:less|lower)\\s+than\\s+${NUM}°`, "i"))
         || s.match(new RegExp(`^under\\s+${NUM}°`, "i"));
    if (g) {
      const t = parseFloat(g[1]);
      upperBound = Number.isInteger(t) ? t + 1 : Math.ceil(t);
      lowerBound = -Infinity;
      range = `≤${t}°F`; label = `≤${t}`;
    }

    // ── Pattern 2: "85° or above" / "85°F or above" / "Above 85°"
    g = s.match(new RegExp(`^${NUM}°\\s*(?:F\\s*)?or above$`, "i"))
     || s.match(new RegExp(`^above\\s+${NUM}°`, "i"))
     || s.match(new RegExp(`^(?:greater|higher)\\s+than\\s+${NUM}°`, "i"))
     || s.match(new RegExp(`^over\\s+${NUM}°`, "i"));
    if (g && !range) {
      const t = parseFloat(g[1]);
      lowerBound = t; upperBound = Infinity;
      range = `≥${t}°F`; label = `≥${t}`;
    }

    // ── Pattern 3: "77° to 78°" / "77°F to 78°F" / "77-78°F" / "Between 77° and 78°"
    g = s.match(new RegExp(`^${NUM}°\\s*(?:F\\s*)?to\\s*${NUM}°`, "i"))
     || s.match(new RegExp(`^${NUM}\\s*[-–]\\s*${NUM}°`, "i"))
     || s.match(new RegExp(`^between\\s+${NUM}°\\s*(?:F\\s*)?and\\s*${NUM}°`, "i"));
    if (g && !range) {
      const lo = parseFloat(g[1]), hi = parseFloat(g[2]);
      lowerBound = lo; upperBound = Number.isInteger(hi) ? hi + 1 : Math.ceil(hi);
      range = `${lo}–${hi}°F`; label = `${lo}–${hi}`;
    }

    // ── Fallback: parse ticker suffix (B{N.5} or T{N}) when subtitle is missing ──
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
        // Without cross-market context, assume upper tail (T{N} → ≥{N+1}°F)
        lowerBound = n + 1; range = `≥${n + 1}°F`; label = `≥${n + 1}`;
      }
    }

    return {
      range:      range || s || m.ticker,
      label:      label || s,
      lowerBound,
      upperBound,
      market:     m.mid  ?? 0,
      model:      0,
      yes_bid:    m.yes_bid  ?? null,
      yes_ask:    m.yes_ask  ?? null,
      status:     m.status   ?? null,
      result:     m.result   ?? null,
    };
  }

  /* ── 3. Probability Distribution from Ensemble ──────────── */
  // Equal weights — 3-model ensemble, normalized in buildDistribution
  const MODEL_WEIGHTS = { NWS: 1/3, HRRR: 1/3, GFS: 1/3 };

  // ── Station-specific bias: NWS ASOS station vs Open-Meteo grid ──
  // Each ASOS station has microclimate characteristics that cause systematic
  // offsets vs the nearest model grid point temperature.
  // Positive = station reads warmer than model; Negative = cooler.
  const STATION_BIAS = {
    "New York":    +1.5,   // KNYC Central Park: urban heat island, sheltered from sea breeze
    "Miami":       +0.5,   // KMIA: airport tarmac adds surface heat
    "Chicago":     -1.2,   // KMDW: persistent Lake Michigan cooling undermodeled by global grids
    "Austin":      +0.8,   // KAUS: dry heat amplification on concrete/asphalt
    "Dallas":      +0.5,   // KDFW: large airport surface urban heat
    "Los Angeles": -1.5,   // KLAX: marine layer persistence systematically undermodeled
  };

  // ── City-specific morning heating rates (°F/hour) ──────────────
  // How fast temperature rises from morning obs → afternoon peak
  // Affected by proximity to water, terrain, humidity
  const CITY_HEATING_RATE = {
    "New York":    1.10,   // moderate — urban, occasional sea breeze
    "Miami":       0.75,   // slow — high humidity slows sensible heating
    "Chicago":     0.90,   // moderate — lake moderates, but wind can spike
    "Austin":      1.25,   // fast — dry continental air, clear skies
    "Dallas":      1.20,   // fast — open plains, strong solar
    "Los Angeles": 0.65,   // slow — marine layer limits morning heating
  };

  // ── Onshore wind sector per city ──────────────────────────────
  // center = wind-FROM direction (degrees) that maximally suppresses peak.
  // maxCool = °F penalty at center (cosine roll-off to 0 at ±90° offset).
  const ONSHORE_SECTOR = {
    "New York":    { center: 112.5, maxCool: -4.5 },  // ESE — Atlantic sea breeze
    "Miami":       { center: 112.5, maxCool: -3.0 },  // ESE — Atlantic/Biscayne Bay
    "Chicago":     { center:  22.5, maxCool: -4.0 },  // NNE — Lake Michigan
    "Austin":      { center:   0,   maxCool: -2.0 },  // N — cold-front northers
    "Dallas":      { center:   0,   maxCool: -1.5 },  // N — open plains
    "Los Angeles": { center: 247.5, maxCool: -4.0 },  // WSW — Pacific marine layer
  };

  // ── Helper: get local hour from ISO timestamp + IANA timezone ──
  function getLocalHour(isoTimestamp, tz) {
    try {
      const d = new Date(isoTimestamp);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", minute: "numeric", hour12: false,
      });
      const parts = fmt.formatToParts(d);
      const h = parseInt(parts.find(p => p.type === "hour")?.value   || "0");
      const m = parseInt(parts.find(p => p.type === "minute")?.value || "0");
      return h + m / 60;
    } catch (_) { return null; }
  }

  // Local calendar date (YYYY-MM-DD) of an ISO timestamp in a given tz.
  // Used to keep "today's" running max from leaking in yesterday's high.
  function getLocalDate(isoTimestamp, tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(isoTimestamp));
    } catch (_) { return null; }
  }

  // Highest temperature actually observed SO FAR today (city-local calendar day).
  // The settled daily high can only be >= this value — it becomes a hard floor
  // on the probability distribution. Returns null if no same-day obs exist.
  function computeTodayMaxObs(hourlyObs, observation, tz) {
    const todayStr = getLocalDate(Date.now(), tz);
    if (!todayStr) return null;
    let max = null;
    const consider = (temp, ts) => {
      if (temp == null || !isFinite(temp) || !ts) return;
      if (getLocalDate(ts, tz) !== todayStr) return;   // only today's obs
      if (max == null || temp > max) max = temp;
    };
    if (Array.isArray(hourlyObs)) for (const o of hourlyObs) consider(o.temp, o.timestamp);
    if (observation) consider(observation.temperature, observation.timestamp);
    return max;
  }

  // ── Core distribution builder ───────────────────────────────────
  // options: { city, observation }
  //   city        — city name (for station bias + heating rate + onshore sector)
  //   observation — NWS ASOS obs object { temperature, dewpoint, windDirection, timestamp, ... }
  function buildDistribution(modelData, buckets, options = {}) {
    const { city, observation, todayMaxObs } = options;
    const cityCfg = city ? CITIES[city] : null;

    // Collect valid model values with their weights
    const entries = Object.entries(modelData)
      .map(([key, m]) => ({ key, val: m.dailyMax, w: MODEL_WEIGHTS[key] ?? 0.25 }))
      .filter(e => e.val != null && isFinite(e.val));

    if (entries.length === 0) return null;

    // Weighted mean + variance
    const totalW   = entries.reduce((s, e) => s + e.w, 0);
    const mean     = entries.reduce((s, e) => s + e.val * e.w, 0) / totalW;
    const variance = entries.reduce((s, e) => s + e.w * (e.val - mean) ** 2, 0) / totalW;
    const spread   = Math.sqrt(variance);
    const modelMin = Math.min(...entries.map(e => e.val));
    const modelMax = Math.max(...entries.map(e => e.val));

    // ── Wind speed (weighted mean at peak) ───────────────────────
    const windEs = entries
      .map(e => ({ w: e.w, v: modelData[e.key].windAtPeak }))
      .filter(e => e.v != null);
    const windW    = windEs.reduce((s, e) => s + e.w, 0);
    const windMean = windW > 0
      ? windEs.reduce((s, e) => s + e.v * e.w, 0) / windW : null;

    // ── Cloud cover (weighted mean at peak) ──────────────────────
    const cloudEs = entries
      .map(e => ({ w: e.w, v: modelData[e.key].cloudAtPeak }))
      .filter(e => e.v != null);
    const cloudW    = cloudEs.reduce((s, e) => s + e.w, 0);
    const cloudMean = cloudW > 0
      ? cloudEs.reduce((s, e) => s + e.v * e.w, 0) / cloudW : null;

    // ── Early: obs blend weight (needed before wind dir blending) ─
    let obsBlendWeight = 0, obsLocalH = null, remainingH = null;
    if (observation?.temperature != null && observation?.timestamp && cityCfg?.tz) {
      obsLocalH = getLocalHour(observation.timestamp, cityCfg.tz);
      if (obsLocalH != null) {
        remainingH = Math.max(0, 14.5 - obsLocalH);
        if (remainingH < 9) {
          obsBlendWeight = remainingH < 8
            ? Math.min(0.65, ((8 - remainingH) / 8) ** 1.4 * 0.65) : 0;
        }
      }
    }

    // ── Correction 1: Station bias ───────────────────────────────
    const stationCorr = city ? (STATION_BIAS[city] ?? 0) : 0;

    // ── Correction 2: Wind speed cooling ─────────────────────────
    // >10kt: each additional knot removes ~0.12°F from peak (surface mixing)
    const windCorr = windMean != null && windMean > 10
      ? Math.max(-2.0, -(windMean - 10) * 0.12) : 0;

    // ── Correction 3: Cloud cover ─────────────────────────────────
    // >25%: each additional 10% cloud removes ~0.30°F (reduced solar)
    const cloudCorr = cloudMean != null && cloudMean > 25
      ? Math.max(-2.5, -((cloudMean - 25) / 10) * 0.30) : 0;

    // ── Correction 4: Wind direction (sea breeze / marine intrusion) ──
    // Compute circular mean of model wind directions at peak, then blend with
    // current obs wind direction (obs gets more weight the closer we are to peak).
    const wdirEs = entries
      .map(e => ({ w: e.w, dir: modelData[e.key].windDirAtPeak }))
      .filter(e => e.dir != null);

    let wdirMeanModel = null;
    if (wdirEs.length > 0) {
      const wW = wdirEs.reduce((s, e) => s + e.w, 0);
      const sn = wdirEs.reduce((s, e) => s + (e.w/wW) * Math.sin(e.dir * Math.PI/180), 0);
      const cs = wdirEs.reduce((s, e) => s + (e.w/wW) * Math.cos(e.dir * Math.PI/180), 0);
      wdirMeanModel = ((Math.atan2(sn, cs) * 180/Math.PI) + 360) % 360;
    }

    const obsWindDeg = observation?.windDirection ?? null;
    let effectiveWindDir = wdirMeanModel;
    if (obsWindDeg != null) {
      if (wdirMeanModel != null && obsBlendWeight > 0) {
        // Circular blend: obs contributes up to 50% weight near peak
        const ow = Math.min(0.5, obsBlendWeight * 0.8);
        const mw = 1 - ow;
        const sBlend = ow * Math.sin(obsWindDeg * Math.PI/180) + mw * Math.sin(wdirMeanModel * Math.PI/180);
        const cBlend = ow * Math.cos(obsWindDeg * Math.PI/180) + mw * Math.cos(wdirMeanModel * Math.PI/180);
        effectiveWindDir = ((Math.atan2(sBlend, cBlend) * 180/Math.PI) + 360) % 360;
      } else if (wdirMeanModel == null) {
        effectiveWindDir = obsWindDeg;
      }
    }

    const windDirCorr = (() => {
      const cfg = city ? ONSHORE_SECTOR[city] : null;
      if (!cfg || effectiveWindDir == null) return 0;
      let diff = Math.abs(effectiveWindDir - cfg.center) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff >= 90) return 0;
      return +(cfg.maxCool * Math.cos((diff / 90) * (Math.PI / 2))).toFixed(2);
    })();

    // ── Correction 5: Dew point ───────────────────────────────────
    // Dry air → efficient sensible heating → peak higher.
    // Humid air → latent cooling / reduced sensible flux → peak lower.
    // Reference 50°F dewpoint = neutral; slope 0.055°F per degree of dryness/humidity.
    const dewCorr = (() => {
      const dp = observation?.dewpoint;  // °F from fetchObservation
      if (dp == null) return 0;
      return +(Math.min(1.0, Math.max(-1.5, (50 - dp) * 0.055))).toFixed(2);
    })();

    // ── Correction 6: Observation blending ───────────────────────
    // Real-time ASOS obs + heating-rate extrapolation constrains the ensemble.
    let obsCorr = 0, impliedPeak = null;
    if (obsBlendWeight > 0 && observation?.temperature != null && remainingH != null) {
      const cityRate    = city ? (CITY_HEATING_RATE[city] ?? 1.0) : 1.0;
      const cFactor     = cloudMean != null ? Math.max(0.3, 1 - cloudMean / 115) : 1.0;
      const wFactor     = windMean  != null && windMean > 12
        ? Math.max(0.65, 1 - (windMean - 12) / 45) : 1.0;
      const heatingRate = cityRate * cFactor * wFactor;
      impliedPeak = observation.temperature + remainingH * heatingRate;
      const preBlendMean = mean + stationCorr + windCorr + cloudCorr + windDirCorr + dewCorr;
      obsCorr = (impliedPeak - preBlendMean) * obsBlendWeight;
    }

    // ── Dynamic σ ────────────────────────────────────────────────
    // Base irreducible forecast error (lower when NWS human-QC present)
    let irreducible = entries.some(e => e.key === "NWS") ? 1.8 : 2.0;
    // Tighten when models agree tightly; widen on large spread
    if (spread < 0.5)      irreducible *= 0.85;
    else if (spread > 3.0) irreducible *= 1.15;
    // Widen when significant onshore flow (sea breeze timing is uncertain)
    if (windDirCorr < -2.0) irreducible = Math.min(irreducible * 1.25, 2.8);
    const std = Math.sqrt(spread ** 2 + irreducible ** 2);

    // ── Final adjusted distribution ──────────────────────────────
    const totalCorr    = stationCorr + windCorr + cloudCorr + windDirCorr + dewCorr + obsCorr;
    const adjustedMean = +(mean + totalCorr).toFixed(1);
    const adjustedStd  = +(std * (1 - obsBlendWeight * 0.40)).toFixed(2);

    return {
      mean:           +mean.toFixed(1),
      adjustedMean,
      adjustedStd,
      std:            +std.toFixed(2),
      spread:         +spread.toFixed(2),
      modelCount:     entries.length,
      modelMin:       +modelMin.toFixed(1),
      modelMax:       +modelMax.toFixed(1),
      weights:        Object.fromEntries(entries.map(e => [e.key, e.w])),
      windMean:       windMean        != null ? +windMean.toFixed(1)        : null,
      cloudMean:      cloudMean       != null ? +cloudMean.toFixed(1)       : null,
      windDirMean:    effectiveWindDir != null ? +effectiveWindDir.toFixed(0) : null,
      impliedPeak:    impliedPeak     != null ? +impliedPeak.toFixed(1)     : null,
      obsBlendWeight: +obsBlendWeight.toFixed(3),
      todayMaxObs:    (todayMaxObs != null && isFinite(todayMaxObs)) ? +todayMaxObs.toFixed(1) : null,
      corrections: {
        station:     +stationCorr.toFixed(2),
        wind:        +windCorr.toFixed(2),
        cloud:       +cloudCorr.toFixed(2),
        windDir:     +windDirCorr.toFixed(2),
        dew:         +dewCorr.toFixed(2),
        observation: +obsCorr.toFixed(2),
        total:       +totalCorr.toFixed(2),
      },
      buckets: (() => {
        // ── Max-so-far floor: the settled high can only be >= today's observed
        // max, so truncate the Gaussian below that floor and renormalize. This
        // is a logical certainty the raw bell curve ignores — it zeroes out
        // impossible low buckets late in the day. No-op early (floor not binding).
        const floor = (todayMaxObs != null && isFinite(todayMaxObs)) ? todayMaxObs : -Infinity;
        const raw = buckets.map(b => {
          const lo = b.lowerBound ?? -Infinity;
          const hi = b.upperBound ??  Infinity;
          const effLo = Math.max(lo, floor);                 // can't dip below the realized max
          const hiV   = hi    === Infinity ?  999 : hi;
          const loV   = effLo === -Infinity ? -999 : effLo;
          // CDF difference; clamps to 0 when the bucket is entirely below the floor
          const prob = Math.max(0,
            normalCDF(hiV, adjustedMean, adjustedStd) - normalCDF(loV, adjustedMean, adjustedStd));
          return { b, prob };
        });
        // Renormalize so probabilities sum to 1 (conditional on high >= floor,
        // which is certain). Buckets tile the line, so this is a true PMF.
        const sum = raw.reduce((s, r) => s + r.prob, 0);
        return raw.map(({ b, prob }) => ({
          ...b,
          modelProb: +((sum > 0 ? prob / sum : 0)).toFixed(4),
        }));
      })(),
    };
  }

  /* ── 4. Kalshi Market Prices (via server-side proxy) ────── */
  async function fetchKalshi(eventTicker) {
    // Routed through /api/kalshi (Vercel serverless) to avoid browser CORS.
    // Falls back gracefully if proxy not deployed or credentials missing.
    const url = `/api/kalshi?ticker=${encodeURIComponent(eventTicker)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Kalshi proxy ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.markets || [];
  }

  /* ── 5. Full City Fetch ──────────────────────────────────── */
  async function fetchCity(cityName, buckets, kalshiEventTicker) {
    const cfg = CITIES[cityName];
    if (!cfg) return { error: `No config for ${cityName}` };

    const [obsResult, modelsResult, kalshiResult, hourlyResult, nwsHourlyResult] = await Promise.allSettled([
      fetchObservation(cfg.stationId),
      fetchModels(cityName),
      kalshiEventTicker ? fetchKalshi(kalshiEventTicker) : Promise.reject("no ticker"),
      fetchHourlyObs(cfg.stationId, cfg.tz),
      fetchNWSHourlyForecast(cfg.lat, cfg.lon, cfg.tz),
    ]);

    const observation = obsResult.status      === "fulfilled" ? obsResult.value      : null;
    const modelsData  = modelsResult.status   === "fulfilled" ? modelsResult.value   : null;
    const kalshi      = kalshiResult.status   === "fulfilled" ? kalshiResult.value   : null;
    const hourlyObs   = hourlyResult.status   === "fulfilled" ? hourlyResult.value   : null;
    const nwsHourly   = nwsHourlyResult.status === "fulfilled" ? nwsHourlyResult.value : null;

    // Build dynamic buckets from Kalshi subtitles when available.
    // These become the authoritative bucket structure — no more hardcoded
    // ranges in data.js per-city. Falls back to static buckets if Kalshi
    // is unavailable.
    const kalshiBuckets = (kalshi && kalshi.length > 0)
      ? kalshi.map(m => kalshiToBucket(m))
      : null;

    const effectiveBuckets = kalshiBuckets || buckets;
    // Running max temperature observed so far today → hard floor on the distribution
    const todayMaxObs = computeTodayMaxObs(hourlyObs, observation, cfg.tz);
    const distribution = modelsData
      ? buildDistribution(modelsData.models, effectiveBuckets, {
          city: cityName,
          observation,
          todayMaxObs,
        })
      : null;

    return {
      city: cityName,
      observation,
      obsError:    obsResult.status    === "rejected" ? String(obsResult.reason)    : null,
      hourlyObs,
      hourlyError: hourlyResult.status === "rejected" ? String(hourlyResult.reason) : null,
      models:      modelsData?.models  ?? null,
      modelsErrors:modelsData?.errors  ?? null,
      modelsError: modelsResult.status === "rejected" ? String(modelsResult.reason) : null,
      distribution,
      kalshi,
      kalshiBuckets,
      kalshiError:     kalshiResult.status    === "rejected" ? String(kalshiResult.reason)    : null,
      nwsHourly,
      nwsHourlyError:  nwsHourlyResult.status === "rejected" ? String(nwsHourlyResult.reason) : null,
      fetchedAt:       new Date().toISOString(),
    };
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    CITIES,
    fetchObservation,
    fetchHourlyObs,
    fetchModels,
    buildDistribution,
    fetchKalshi,
    fetchCity,
  };

})();
