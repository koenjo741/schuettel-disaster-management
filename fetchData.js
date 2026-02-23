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

// ── Helper: Retry logic ──────────────────────────────────────────────────────
async function withRetry(fn, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`Retry ${i + 1}/${retries} failed: ${err.message}. Waiting ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// GeoSphere Austria – INCA analysis (hourly, 1 km grid, near-realtime)
// Parameters: T2M = temperature 2 m, RR = precipitation sum 1h, UU/VV = wind components m/s
const buildGeoSphereUrl = (offsetHours = 1) => {
    const now = new Date();
    // offsetHours determines how far back we look.
    // INCA usually has ~1h lag, so default is 1h back.
    const start = new Date(now - (offsetHours + 1) * 60 * 60 * 1000);
    const end = new Date(now - offsetHours * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 19);

    const qs = new URLSearchParams({ start: fmt(start), end: fmt(end), lat_lon: `${LOCATION.lat},${LOCATION.lon}` });
    for (const p of ['T2M', 'RR', 'UU', 'VV']) qs.append('parameters', p);

    return `https://dataset.api.hub.geosphere.at/v1/timeseries/historical/inca-v1-1h-1km?${qs}`;
};

// ── Alert Thresholds ─────────────────────────────────────────────────────────
const THRESHOLDS = {
    heat: { yellow: 30, red: 35 },  // °C
    wind: { yellow: 60, red: 80 },  // km/h
    rain: { yellow: 15, red: 25 },  // mm/h
    flood: { yellow: 380, red: 432 },  // cm
    radiation: { yellow: 200, red: 300 },  // nSv/h
};

// ── Helper: Derive alert level ────────────────────────────────────────────────
const alertLevel = (value, { yellow, red }) =>
    value >= red ? 'red' : value >= yellow ? 'yellow' : 'green';

// ── Flood: danubealert.com HTML scraper ──────────────────────────────────────
async function fetchFloodData() {
    return withRetry(async () => {
        const res = await fetch('https://danubealert.com/at/history/schwedenbrucke', {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
        });
        if (!res.ok) throw new Error(`danubealert.com error: ${res.status}`);
        const html = await res.text();

        const pegelMatch = html.match(/erreichte der Pegel (\d+) cm/);
        const ldcMatch = html.match(/minimal akzeptabler Pegel \((\d+) cm\)/);
        const hdcMatch = html.match(/maximal akzeptabler Pegel \((\d+) cm\)/);

        if (!pegelMatch) throw new Error('danubealert.com: Pegel value not found in HTML');

        return {
            pegelCm: parseInt(pegelMatch[1], 10),
            ldc: ldcMatch ? parseInt(ldcMatch[1], 10) : 288,
            hdc: hdcMatch ? parseInt(hdcMatch[1], 10) : 432,
            source: 'danubealert.com (Schwedenbrücke / eHYD #207233)',
        };
    });
}

// ── Radiation: Strahlenschutz.gv.at HTML scraper ──────────────────────────────
async function fetchRadiationData() {
    return withRetry(async () => {
        const res = await fetch('https://mb.strahlenschutz.gv.at/station/AT2002', {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
        });
        if (!res.ok) throw new Error(`Strahlenschutz.gv.at error: ${res.status}`);
        const html = await res.text();

        const match = html.match(/AT2002[\s\S]{0,300}?<td>(\d+)<\/td>/);
        if (!match) throw new Error('Strahlenschutz.gv.at: AT2002 value not found');

        const tsMatch = html.match(/Stand: ([^<]+)</);

        return {
            nsvH: parseInt(match[1], 10),
            station: 'AT2002 Wien-Radetzkystraße',
            measuredAt: tsMatch?.[1]?.trim() ?? null,
            source: 'Strahlenschutz.gv.at (IMIS)',
        };
    });
}

// ── Fetch GeoSphere Austria data ─────────────────────────────────────────────
async function fetchWeather() {
    // Attempt with increasing lag if data is missing
    for (let offset = 1; offset <= 3; offset++) {
        try {
            const data = await withRetry(async () => {
                const url = buildGeoSphereUrl(offset);
                const res = await fetch(url, { headers: { Accept: 'application/json' } });
                if (!res.ok) throw new Error(`GeoSphere API error: ${res.status}`);
                const json = await res.json();
                const features = json.features ?? [];
                if (!features.length) throw new Error('No feature data');
                return features[0].properties.parameters;
            });

            const last = (key) => (data[key]?.data ?? []).at(-1) ?? null;
            const uu = last('UU');
            const vv = last('VV');
            const windMs = uu != null && vv != null ? Math.sqrt(uu ** 2 + vv ** 2) : null;

            const result = {
                tempC: last('T2M'),
                rainMmH: last('RR'),
                windKmH: windMs != null ? Math.round(windMs * 3.6) : null,
            };

            // If we have at least temperature, we consider it valid
            if (result.tempC !== null) {
                if (offset > 1) console.log(`GeoSphere: Using data with ${offset}h offset as fallback.`);
                return result;
            }
        } catch (err) {
            if (offset === 3) throw err;
            console.warn(`GeoSphere: Failed at offset ${offset}h: ${err.message}. Trying next offset...`);
        }
    }
    throw new Error('GeoSphere API: No data found after trying multiple time windows');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const timestamp = new Date().toISOString();
    let weather, floodData, radiationData, status;

    console.log(`[${timestamp}] Starting data fetch...`);

    try {
        const results = await Promise.allSettled([
            fetchWeather(),
            fetchFloodData(),
            fetchRadiationData(),
        ]);

        weather = results[0].status === 'fulfilled' ? results[0].value : null;
        floodData = results[1].status === 'fulfilled' ? results[1].value : null;
        radiationData = results[2].status === 'fulfilled' ? results[2].value : null;

        if (!weather && !floodData && !radiationData) {
            throw new Error('All data sources failed.');
        }

        const heatLevel = weather ? alertLevel(weather.tempC ?? 0, THRESHOLDS.heat) : 'unknown';
        const windLevel = weather ? alertLevel(weather.windKmH ?? 0, THRESHOLDS.wind) : 'unknown';
        const rainLevel = weather ? alertLevel(weather.rainMmH ?? 0, THRESHOLDS.rain) : 'unknown';
        const floodLevel = floodData ? alertLevel(floodData.pegelCm ?? 0, THRESHOLDS.flood) : 'unknown';
        const radiationLevel = radiationData ? alertLevel(radiationData.nsvH ?? 0, THRESHOLDS.radiation) : 'unknown';

        const severityRank = { green: 0, yellow: 1, red: 2, unknown: -1 };
        const levels = [heatLevel, windLevel, rainLevel, floodLevel, radiationLevel];
        const overallLevel = levels.reduce((max, lvl) => severityRank[lvl] > severityRank[max] ? lvl : max, 'green');

        status = {
            fetchedAt: timestamp,
            overall: overallLevel,
            dataSource: 'GeoSphere Austria + danubealert.com + Strahlenschutz.gv.at',
            location: { address: 'Schüttelstraße 79 & 81, 1020 Wien', ...LOCATION },
            hazards: {
                heat: { level: heatLevel, value: weather?.tempC ?? null, unit: '°C', thresholds: THRESHOLDS.heat },
                wind: { level: windLevel, value: weather?.windKmH ?? null, unit: 'km/h', thresholds: THRESHOLDS.wind },
                rain: { level: rainLevel, value: weather?.rainMmH ?? null, unit: 'mm/h', thresholds: THRESHOLDS.rain },
                flood: {
                    level: floodLevel,
                    value: floodData?.pegelCm ?? null,
                    unit: 'cm',
                    thresholds: THRESHOLDS.flood,
                    source: floodData?.source ?? 'Offline',
                },
                radiation: {
                    level: radiationLevel,
                    value: radiationData?.nsvH ?? null,
                    unit: 'nSv/h',
                    thresholds: THRESHOLDS.radiation,
                    source: radiationData?.source ?? 'Offline',
                },
            },
            error: results.filter(r => r.status === 'rejected').map(r => r.reason.message).join('; ') || null,
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
