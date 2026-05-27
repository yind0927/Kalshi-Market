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

  const MODELS = [
    { key: "GFS",   id: "gfs_seamless"    },
    { key: "HRRR",  id: "hrrr_conus"      },
    { key: "ECMWF", id: "ecmwf_seamless"  },
    { key: "NAM",   id: "nam_conus"       },
  ];

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

  /* ── 1. NWS Current Observation ────────────────────────── */
  async function fetchObservation(stationId) {
    const url = `https://api.weather.gov/stations/${stationId}/observations?limit=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);
    const data = await res.json();
    const p    = data.features[0]?.properties;
    if (!p) throw new Error("No NWS observation");

    // Cloud layers → plain text sky condition
    const skyCode = { SKC:"晴空", FEW:"少云", SCT:"疏云", BKN:"多云", OVC:"阴天" };
    const sky = p.cloudLayers?.map(l =>
      `${skyCode[l.amount] || l.amount} ${l.base?.value != null
        ? Math.round(l.base.value * 3.281) + "ft" : ""}`).join(" · ") || "—";

    // Wind direction to compass
    const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const compass = p.windDirection?.value != null
      ? dirs[Math.round(p.windDirection.value / 22.5) % 16] : "—";

    return {
      temperature:  cToF(p.temperature?.value),
      dewpoint:     cToF(p.dewpoint?.value),
      windDirection: p.windDirection?.value,
      windCompass:   compass,
      windSpeed:    msToKt(p.windSpeed?.value),
      windGust:     msToKt(p.windGust?.value),
      sky,
      rawMessage:   p.rawMessage,
      timestamp:    p.timestamp,
      source:       "NWS ASOS",
    };
  }

  /* ── 1b. NWS Hourly Observation History (last 24h) ──────── */
  async function fetchHourlyObs(stationId, tz) {
    const url = `https://api.weather.gov/stations/${stationId}/observations?limit=28`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NWS hourly HTTP ${res.status}`);
    const data = await res.json();

    // Parse each observation; NWS returns newest-first → reverse to oldest-first
    const obs = data.features
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

    return obs;
  }

  /* ── 2. Open-Meteo Multi-Model Forecast ─────────────────── */
  async function fetchModels(city) {
    const cfg = CITIES[city];
    if (!cfg) throw new Error(`Unknown city: ${city}`);

    const results = {};
    const errs    = {};

    await Promise.allSettled(
      MODELS.map(async ({ key, id }) => {
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

        // Build hourly array; find daily max between 08:00–22:00
        const hourly = times.map((t, i) => ({
          hour:    parseInt(t.slice(11, 13)),
          temp:    temps[i],
          wind:    winds[i],
          windDir: wdirs[i],
          cloud:   cloud[i] ?? null,
        }));

        const peak = hourly
          .filter(h => h.hour >= 8 && h.hour <= 22 && h.temp != null)
          .reduce((mx, h) => h.temp > mx.temp ? h : mx, { temp: -999 });

        results[key] = {
          dailyMax:   +peak.temp.toFixed(1),
          peakHour:   peak.hour,
          windAtPeak: peak.wind ? +peak.wind.toFixed(1) : null,
          cloudAtPeak:peak.cloud,
          hourly,
          updatedAt:  new Date().toISOString(),
        };
      }).map((p, i) => p.catch(e => { errs[MODELS[i].key] = e.message; }))
    );

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
  // Model weights based on verified CONUS 12–24h RMSE performance:
  //   ECMWF 0.40 — consistently best global model (~1.8°F RMSE)
  //   HRRR  0.30 — best short-range, hourly updates   (~2.1°F RMSE)
  //   GFS   0.20 — reliable global model              (~2.4°F RMSE)
  //   NAM   0.10 — coarser resolution, least accurate (~2.9°F RMSE)
  const MODEL_WEIGHTS = { GFS: 0.20, HRRR: 0.30, ECMWF: 0.40, NAM: 0.10 };

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

  // ── Core distribution builder ───────────────────────────────────
  // options: { city, observation }
  //   city        — city name (for station bias + heating rate)
  //   observation — NWS ASOS obs object { temperature, timestamp, ... }
  function buildDistribution(modelData, buckets, options = {}) {
    const { city, observation } = options;

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

    // Irreducible forecast error (CONUS 12–24h)
    const hasECMWF    = entries.some(e => e.key === "ECMWF");
    const irreducible = hasECMWF ? 1.8 : 2.0;
    const std         = Math.sqrt(spread ** 2 + irreducible ** 2);

    const modelMin = Math.min(...entries.map(e => e.val));
    const modelMax = Math.max(...entries.map(e => e.val));

    // ── Correction 1: Station bias ──────────────────────────────
    const stationCorr = city ? (STATION_BIAS[city] ?? 0) : 0;

    // ── Correction 2: Wind cooling at peak hour ──────────────────
    // Wind increases surface mixing, limiting daytime maximum.
    // Above 10kt: each additional knot removes ~0.12°F from peak.
    const windEs = entries
      .map(e => ({ w: e.w, v: modelData[e.key].windAtPeak }))
      .filter(e => e.v != null);
    const windW    = windEs.reduce((s, e) => s + e.w, 0);
    const windMean = windW > 0
      ? windEs.reduce((s, e) => s + e.v * e.w, 0) / windW : null;
    const windCorr = windMean != null && windMean > 10
      ? Math.max(-2.0, -(windMean - 10) * 0.12) : 0;

    // ── Correction 3: Cloud cover at peak hour ───────────────────
    // Cloud blocks solar radiation, reducing daytime maximum.
    // Above 25%: each additional 10% cloud removes ~0.30°F from peak.
    const cloudEs = entries
      .map(e => ({ w: e.w, v: modelData[e.key].cloudAtPeak }))
      .filter(e => e.v != null);
    const cloudW    = cloudEs.reduce((s, e) => s + e.w, 0);
    const cloudMean = cloudW > 0
      ? cloudEs.reduce((s, e) => s + e.v * e.w, 0) / cloudW : null;
    const cloudCorr = cloudMean != null && cloudMean > 25
      ? Math.max(-2.5, -((cloudMean - 25) / 10) * 0.30) : 0;

    // ── Correction 4: Observation blending ──────────────────────
    // Use the current NWS ASOS temperature (which is the actual settlement
    // station reading) to constrain the forecast. The further we are from
    // peak, the less weight we give to the obs-implied estimate.
    let obsCorr = 0, obsBlendWeight = 0, impliedPeak = null;
    const cityCfg = city ? CITIES[city] : null;

    if (observation?.temperature != null && observation?.timestamp && cityCfg?.tz) {
      const obsLocalH = getLocalHour(observation.timestamp, cityCfg.tz);
      if (obsLocalH != null) {
        const PEAK_HOUR = 14.5;  // typical daily high ~2:30 PM local
        const remainingH = Math.max(0, PEAK_HOUR - obsLocalH);

        if (remainingH >= 0 && remainingH < 9) {
          // Heating rate: city base × cloud factor × wind factor
          const cityRate   = city ? (CITY_HEATING_RATE[city] ?? 1.0) : 1.0;
          const cFactor    = cloudMean != null ? Math.max(0.3, 1 - cloudMean / 115) : 1.0;
          const wFactor    = windMean  != null && windMean > 12
            ? Math.max(0.65, 1 - (windMean - 12) / 45) : 1.0;
          const heatingRate = cityRate * cFactor * wFactor;

          impliedPeak = observation.temperature + remainingH * heatingRate;

          // Blend weight: 0 at ≥8h out, rises smoothly to 0.65 near peak.
          // obs-model base before this correction is (mean + stationCorr + windCorr + cloudCorr)
          const preBlendMean = mean + stationCorr + windCorr + cloudCorr;
          obsBlendWeight = remainingH < 8
            ? Math.min(0.65, ((8 - remainingH) / 8) ** 1.4 * 0.65) : 0;
          obsCorr = (impliedPeak - preBlendMean) * obsBlendWeight;
        }
      }
    }

    // ── Final adjusted distribution ─────────────────────────────
    const totalCorr    = stationCorr + windCorr + cloudCorr + obsCorr;
    const adjustedMean = +(mean + totalCorr).toFixed(1);
    // Observation blending reduces uncertainty proportionally to blend weight
    const adjustedStd  = +(std * (1 - obsBlendWeight * 0.40)).toFixed(2);

    return {
      mean:          +mean.toFixed(1),
      adjustedMean,
      adjustedStd,
      std:           +std.toFixed(2),
      spread:        +spread.toFixed(2),
      modelCount:    entries.length,
      modelMin:      +modelMin.toFixed(1),
      modelMax:      +modelMax.toFixed(1),
      weights:       Object.fromEntries(entries.map(e => [e.key, e.w])),
      windMean:      windMean      != null ? +windMean.toFixed(1)  : null,
      cloudMean:     cloudMean     != null ? +cloudMean.toFixed(1) : null,
      impliedPeak:   impliedPeak   != null ? +impliedPeak.toFixed(1) : null,
      obsBlendWeight: +obsBlendWeight.toFixed(3),
      corrections: {
        station:      +stationCorr.toFixed(2),
        wind:         +windCorr.toFixed(2),
        cloud:        +cloudCorr.toFixed(2),
        observation:  +obsCorr.toFixed(2),
        total:        +totalCorr.toFixed(2),
      },
      buckets: buckets.map(b => {
        const lo = b.lowerBound ?? -Infinity;
        const hi = b.upperBound ??  Infinity;
        const prob = normalCDF(hi === Infinity ? 999 : hi, adjustedMean, adjustedStd)
                   - normalCDF(lo === -Infinity ? -999 : lo, adjustedMean, adjustedStd);
        return { ...b, modelProb: +prob.toFixed(4) };
      }),
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

    const [obsResult, modelsResult, kalshiResult, hourlyResult] = await Promise.allSettled([
      fetchObservation(cfg.stationId),
      fetchModels(cityName),
      kalshiEventTicker ? fetchKalshi(kalshiEventTicker) : Promise.reject("no ticker"),
      fetchHourlyObs(cfg.stationId, cfg.tz),
    ]);

    const observation = obsResult.status   === "fulfilled" ? obsResult.value   : null;
    const modelsData  = modelsResult.status === "fulfilled" ? modelsResult.value : null;
    const kalshi      = kalshiResult.status === "fulfilled" ? kalshiResult.value : null;
    const hourlyObs   = hourlyResult.status === "fulfilled" ? hourlyResult.value : null;

    // Build dynamic buckets from Kalshi subtitles when available.
    // These become the authoritative bucket structure — no more hardcoded
    // ranges in data.js per-city. Falls back to static buckets if Kalshi
    // is unavailable.
    const kalshiBuckets = (kalshi && kalshi.length > 0)
      ? kalshi.map(m => kalshiToBucket(m))
      : null;

    const effectiveBuckets = kalshiBuckets || buckets;
    const distribution = modelsData
      ? buildDistribution(modelsData.models, effectiveBuckets, {
          city: cityName,
          observation,
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
      kalshiBuckets,    // parsed bucket definitions (null if Kalshi unavailable)
      kalshiError: kalshiResult.status === "rejected" ? String(kalshiResult.reason) : null,
      fetchedAt:   new Date().toISOString(),
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
