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
    // Donaukanal Schwedenbrücke cm gauge (Donau-Kommission official marks)
    flood: { yellow: 380, red: 432 },  // cm
    // Strahlung AT2002 Wien-Radetzkystrasse (Normalhintergrund Wien: ~60–100 nSv/h)
    // Österreichisches Strahlenschutz-Meldesystem (IMIS): erhöht ≥2×, kritisch ≥5× Hintergrund
    radiation: { yellow: 200, red: 300 },  // nSv/h
};

// ── Helper: Derive alert level ────────────────────────────────────────────────
const alertLevel = (value, { yellow, red }) =>
    value >= red ? 'red' : value >= yellow ? 'yellow' : 'green';

// ── Flood: danubealert.com HTML scraper (Schwedenbrücke cm gauge) ───────────────
// Scrapes the public page for real-time Pegel (cm), LDC and HDC values.
// No API key or authentication required.
async function fetchFloodData() {
    const res = await fetch('https://danubealert.com/at/history/schwedenbrucke', {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`danubealert.com error: ${res.status}`);
    const html = await res.text();

    // "erreichte der Pegel 280 cm"
    const pegelMatch = html.match(/erreichte der Pegel (\d+) cm/);
    // "minimal akzeptabler Pegel (288 cm)" / "maximal akzeptabler Pegel (432 cm)"
    const ldcMatch = html.match(/minimal akzeptabler Pegel \((\d+) cm\)/);
    const hdcMatch = html.match(/maximal akzeptabler Pegel \((\d+) cm\)/);

    if (!pegelMatch) throw new Error('danubealert.com: Pegel value not found in HTML');

    return {
        pegelCm: parseInt(pegelMatch[1], 10),
        ldc: ldcMatch ? parseInt(ldcMatch[1], 10) : 288,
        hdc: hdcMatch ? parseInt(hdcMatch[1], 10) : 432,
        source: 'danubealert.com (Schwedenbrücke / eHYD #207233)',
    };
}

// ── Radiation: Strahlenschutz.gv.at HTML scraper (Station AT2002, nSv/h) ────────
async function fetchRadiationData() {
    const res = await fetch('https://mb.strahlenschutz.gv.at/station/AT2002', {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`Strahlenschutz.gv.at error: ${res.status}`);
    const html = await res.text();

    // <td>AT2002</td> ... <td>66</td>  (value is 3rd cell in the row)
    const match = html.match(/AT2002[\s\S]{0,300}?<td>(\d+)<\/td>/);
    if (!match) throw new Error('Strahlenschutz.gv.at: AT2002 value not found');

    // Extract measurement timestamp from noscript block: "Stand: 22.02.2026 21:00 UTC"
    const tsMatch = html.match(/Stand: ([^<]+)</);

    return {
        nsvH: parseInt(match[1], 10),
        station: 'AT2002 Wien-Radetzkystraße',
        measuredAt: tsMatch?.[1]?.trim() ?? null,
        source: 'Strahlenschutz.gv.at (IMIS)',
    };
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
    let weather, floodData, radiationData, status;

    try {
        [weather, floodData, radiationData] = await Promise.all([
            fetchWeather(),
            fetchFloodData(),
            fetchRadiationData(),
        ]);

        const heatLevel = alertLevel(weather.tempC ?? 0, THRESHOLDS.heat);
        const windLevel = alertLevel(weather.windKmH ?? 0, THRESHOLDS.wind);
        const rainLevel = alertLevel(weather.rainMmH ?? 0, THRESHOLDS.rain);
        const floodLevel = alertLevel(floodData.pegelCm ?? 0, THRESHOLDS.flood);
        const radiationLevel = alertLevel(radiationData.nsvH ?? 0, THRESHOLDS.radiation);

        // Overall status = worst individual status
        const severityRank = { green: 0, yellow: 1, red: 2 };
        const overallLevel = [heatLevel, windLevel, rainLevel, floodLevel, radiationLevel]
            .reduce((max, lvl) => severityRank[lvl] > severityRank[max] ? lvl : max, 'green');

        status = {
            fetchedAt: timestamp,
            overall: overallLevel,
            dataSource: 'GeoSphere Austria INCA + danubealert.com + Strahlenschutz.gv.at',
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
                    value: floodData.pegelCm ?? null,
                    unit: 'cm',
                    thresholds: THRESHOLDS.flood,
                    ldc: floodData.ldc,
                    hdc: floodData.hdc,
                    source: floodData.source,
                    hzbnr: 207233,
                },
                radiation: {
                    level: radiationLevel,
                    value: radiationData.nsvH ?? null,
                    unit: 'nSv/h',
                    thresholds: THRESHOLDS.radiation,
                    station: radiationData.station,
                    measuredAt: radiationData.measuredAt,
                    source: radiationData.source,
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
