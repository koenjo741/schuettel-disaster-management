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
    heat: { yellow: 30, red: 35 },     // °C
    wind: { yellow: 60, red: 80 },     // km/h
    rain: { yellow: 15, red: 25 },     // mm/h
    flood: { yellow: 'VORWARNUNG', red: 'HOCHWASSER' },
};

// ── Helper: Derive alert level ────────────────────────────────────────────────
const alertLevel = (value, { yellow, red }) =>
    value >= red ? 'red' : value >= yellow ? 'yellow' : 'green';

// ── Flood: Mock/Dummy until eHYD Donaukanal station ID is confirmed ───────────
const fetchFloodLevel = () => ({
    level: 'NORMAL',   // Replace with: 'VORWARNUNG' | 'HOCHWASSER' when live
    pegelCm: 142,      // Mock gauge reading in cm
    source: 'mock',
});

const floodAlert = (floodData) => {
    if (floodData.level === THRESHOLDS.flood.red) return 'red';
    if (floodData.level === THRESHOLDS.flood.yellow) return 'yellow';
    return 'green';
};

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
            Promise.resolve(fetchFloodLevel()),
        ]);

        const heatLevel = alertLevel(weather.tempC ?? 0, THRESHOLDS.heat);
        const windLevel = alertLevel(weather.windKmH ?? 0, THRESHOLDS.wind);
        const rainLevel = alertLevel(weather.rainMmH ?? 0, THRESHOLDS.rain);
        const floodLevel = floodAlert(floodData);

        // Overall status = worst individual status
        const severityRank = { green: 0, yellow: 1, red: 2 };
        const overallLevel = [heatLevel, windLevel, rainLevel, floodLevel]
            .reduce((max, lvl) => severityRank[lvl] > severityRank[max] ? lvl : max, 'green');

        status = {
            fetchedAt: timestamp,
            overall: overallLevel,
            dataSource: 'GeoSphere Austria INCA (inca-v1-1h-1km)',
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
                    pegelCm: floodData.pegelCm,
                    floodStage: floodData.level,
                    source: floodData.source,
                    unit: 'cm',
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
