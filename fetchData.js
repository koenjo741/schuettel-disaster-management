/**
 * fetchData.js – Disaster Management Data Fetcher
 * Fetches weather data from GeoSphere Austria API and evaluates alert levels
 * for Schüttelstraße 79 & 81, Vienna (Lat: 48.2092, Lon: 16.4050)
 */

import fetch from 'node-fetch';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Configuration ────────────────────────────────────────────────────────────
const LOCATION = { lat: 48.2092, lon: 16.4050 };
const OUTPUT_PATH = join('public', 'alert_status.json');

// GeoSphere Austria – INCA analysis (hourly, 1 km grid, near-realtime)
// Parameters: T2M = temperature 2 m, RR = precipitation sum 1h, UU/VV = wind components m/s
const buildGeoSphereUrl = () => {
    const now = new Date();
    const start = new Date(now - 2 * 60 * 60 * 1000); // 2 h back (INCA has ~1 h lag)
    const end = new Date(now - 60 * 60 * 1000);      // 1 h back
    const fmt = (d) => d.toISOString().slice(0, 19);  // YYYY-MM-DDTHH:MM:SS (no tz suffix)

    // INCA grid endpoints require lat_lon=lat,lon (comma-separated) and repeated parameters entries
    const qs = new URLSearchParams({ start: fmt(start), end: fmt(end), lat_lon: `${LOCATION.lat},${LOCATION.lon}` });
    for (const p of ['T2M', 'RR', 'UU', 'VV']) qs.append('parameters', p);

    return `https://dataset.api.hub.geosphere.at/v1/timeseries/historical/inca-v1-1h-1km?${qs}`;
};

// ── Alert Thresholds ─────────────────────────────────────────────────────────
const THRESHOLDS = {
    heat: { yellow: 30, red: 35 },  // °C
    wind: { yellow: 60, red: 80 },  // km/h
    rain: { yellow: 15, red: 25 },  // mm/h
    // River discharge thresholds for Donaukanal area (GloFAS model, m³/s)
    // Normal winter flow: ~1–5 m³/s; elevated: ≥150; critical: ≥500
    flood: { yellow: 150, red: 500 },  // m³/s
};

// ── Helper: Derive alert level ────────────────────────────────────────────────
const alertLevel = (value, { yellow, red }) =>
    value >= red ? 'red' : value >= yellow ? 'yellow' : 'green';

// ── Flood: Open-Meteo Flood API (GloFAS river discharge model) ────────────────
// Station reference: eHYD HZBNR 207233 Wien (Schwedenbrücke), Donaukanal
async function fetchFloodData() {
    const qs = new URLSearchParams({
        latitude: LOCATION.lat,
        longitude: LOCATION.lon,
        daily: 'river_discharge',
        forecast_days: '1',
        models: 'seamless_v4',
    });
    const res = await fetch(`https://flood-api.open-meteo.com/v1/flood?${qs}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Open-Meteo Flood API error: ${res.status}`);
    const json = await res.json();
    const discharge = json.daily?.river_discharge?.at(-1) ?? null; // m³/s
    return { discharge, source: 'Open-Meteo GloFAS (seamless_v4)' };
}

// ── Fetch GeoSphere Austria data ─────────────────────────────────────────────
async function fetchWeather() {
    const url = buildGeoSphereUrl();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!res.ok) throw new Error(`GeoSphere API error: ${res.status} ${res.statusText}`);

    const json = await res.json();
    const features = json.features ?? [];
    if (!features.length) throw new Error('No feature data returned from GeoSphere API');

    const params = features[0].properties.parameters;

    // Extract last available value for a parameter
    const last = (key) => (params[key]?.data ?? []).at(-1) ?? null;

    const uu = last('UU'); // wind eastward component  (m/s)
    const vv = last('VV'); // wind northward component (m/s)
    const windMs = uu != null && vv != null ? Math.sqrt(uu ** 2 + vv ** 2) : null;

    return {
        tempC: last('T2M'),                                       // °C
        rainMmH: last('RR'),                                        // mm/h (= kg/m² per hour)
        windKmH: windMs != null ? Math.round(windMs * 3.6) : null, // m/s → km/h
    };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const timestamp = new Date().toISOString();
    let weather, floodData, status;

    try {
        [weather, floodData] = await Promise.all([
            fetchWeather(),
            fetchFloodData(),
        ]);

        const heatLevel = alertLevel(weather.tempC ?? 0, THRESHOLDS.heat);
        const windLevel = alertLevel(weather.windKmH ?? 0, THRESHOLDS.wind);
        const rainLevel = alertLevel(weather.rainMmH ?? 0, THRESHOLDS.rain);
        const floodLevel = alertLevel(floodData.discharge ?? 0, THRESHOLDS.flood);

        // Overall status = worst individual status
        const severityRank = { green: 0, yellow: 1, red: 2 };
        const overallLevel = [heatLevel, windLevel, rainLevel, floodLevel]
            .reduce((max, lvl) => severityRank[lvl] > severityRank[max] ? lvl : max, 'green');

        status = {
            fetchedAt: timestamp,
            overall: overallLevel,
            dataSource: 'GeoSphere Austria INCA (inca-v1-1h-1km) + Open-Meteo GloFAS',
            location: { address: 'Schüttelstraße 79 & 81, 1020 Wien', ...LOCATION },
            hazards: {
                heat: {
                    level: heatLevel,
                    value: weather.tempC,
                    unit: '°C',
                    thresholds: THRESHOLDS.heat,
                },
                wind: {
                    level: windLevel,
                    value: weather.windKmH != null ? Math.round(weather.windKmH) : null,
                    unit: 'km/h',
                    thresholds: THRESHOLDS.wind,
                },
                rain: {
                    level: rainLevel,
                    value: weather.rainMmH,
                    unit: 'mm/h',
                    thresholds: THRESHOLDS.rain,
                },
                flood: {
                    level: floodLevel,
                    value: floodData.discharge != null ? +floodData.discharge.toFixed(2) : null,
                    unit: 'm³/s',
                    thresholds: THRESHOLDS.flood,
                    source: floodData.source,
                    hzbnr: 207233,  // eHYD Wien (Schwedenbrücke)
                },
            },
            error: null,
        };
    } catch (err) {
        console.error('Fetch failed:', err.message);
        status = {
            fetchedAt: timestamp,
            overall: 'unknown',
            error: err.message,
            hazards: {},
        };
    }

    mkdirSync('public', { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(status, null, 2), 'utf-8');
    console.log(`[${timestamp}] alert_status.json written → overall: ${status.overall}`);
}

main();
