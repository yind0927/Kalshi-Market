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
    "Chicago":     { stationId:"KORD", lat:41.9742, lon:-87.9073, tz:"America/Chicago"       },
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
  function kalshiToBucket(m) {
    const s = (m.subtitle || "").trim();
    let lowerBound = -Infinity, upperBound = Infinity, range, label;

    // ── Pattern 1: "76° or below" / "76°F or below" / "Below 76°"
    let g = s.match(/^(\d+)°\s*(?:F\s*)?or below$/i)
         || s.match(/^below\s+(\d+)°/i)
         || s.match(/^(?:less|lower)\s+than\s+(\d+)°/i)
         || s.match(/^under\s+(\d+)°/i);
    if (g) {
      const t = +g[1];
      upperBound = t + 1; lowerBound = -Infinity;
      range = `≤${t}°F`; label = `≤${t}`;
    }

    // ── Pattern 2: "85° or above" / "85°F or above" / "Above 85°"
    g = s.match(/^(\d+)°\s*(?:F\s*)?or above$/i)
     || s.match(/^above\s+(\d+)°/i)
     || s.match(/^(?:greater|higher)\s+than\s+(\d+)°/i)
     || s.match(/^over\s+(\d+)°/i);
    if (g && !range) {
      const t = +g[1];
      lowerBound = t; upperBound = Infinity;
      range = `≥${t}°F`; label = `≥${t}`;
    }

    // ── Pattern 3: "77° to 78°" / "77°F to 78°F" / "77-78°F" / "Between 77° and 78°"
    g = s.match(/^(\d+)°\s*(?:F\s*)?to\s*(\d+)°/i)
     || s.match(/^(\d+)\s*[-–]\s*(\d+)°/i)
     || s.match(/^between\s+(\d+)°\s*(?:F\s*)?and\s*(\d+)°/i);
    if (g && !range) {
      const lo = +g[1], hi = +g[2];
      lowerBound = lo; upperBound = hi + 1;
      range = `${lo}–${hi}°F`; label = `${lo}–${hi}`;
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
  function buildDistribution(modelData, buckets) {
    const vals = Object.values(modelData)
      .map(m => m.dailyMax)
      .filter(v => v != null && isFinite(v));

    if (vals.length === 0) return null;

    const mean = vals.reduce((a, b) => a + b) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const spread   = Math.sqrt(variance);

    // Irreducible forecast error for each station (~2°F typical for CONUS 12h)
    const irreducible = 2.0;
    const std = Math.sqrt(spread ** 2 + irreducible ** 2);

    return {
      mean:       +mean.toFixed(1),
      std:        +std.toFixed(2),
      spread:     +spread.toFixed(2),
      modelCount: vals.length,
      buckets: buckets.map(b => {
        const lo = b.lowerBound ?? -Infinity;
        const hi = b.upperBound ??  Infinity;
        const prob = normalCDF(hi === Infinity ? 999 : hi, mean, std)
                   - normalCDF(lo === -Infinity ? -999 : lo, mean, std);
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

    const [obsResult, modelsResult, kalshiResult] = await Promise.allSettled([
      fetchObservation(cfg.stationId),
      fetchModels(cityName),
      kalshiEventTicker ? fetchKalshi(kalshiEventTicker) : Promise.reject("no ticker"),
    ]);

    const observation = obsResult.status  === "fulfilled" ? obsResult.value  : null;
    const modelsData  = modelsResult.status === "fulfilled" ? modelsResult.value : null;
    const kalshi      = kalshiResult.status === "fulfilled" ? kalshiResult.value : null;

    // Build dynamic buckets from Kalshi subtitles when available.
    // These become the authoritative bucket structure — no more hardcoded
    // ranges in data.js per-city. Falls back to static buckets if Kalshi
    // is unavailable.
    const kalshiBuckets = (kalshi && kalshi.length > 0)
      ? kalshi.map(m => kalshiToBucket(m))
      : null;

    const effectiveBuckets = kalshiBuckets || buckets;
    const distribution = modelsData
      ? buildDistribution(modelsData.models, effectiveBuckets)
      : null;

    return {
      city: cityName,
      observation,
      obsError:    obsResult.status    === "rejected" ? String(obsResult.reason)    : null,
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
    fetchModels,
    buildDistribution,
    fetchKalshi,
    fetchCity,
  };

})();
