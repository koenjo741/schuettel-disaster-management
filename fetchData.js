/**
 * fetchData.js – Disaster Management Data Fetcher
 * Fetches weather data from GeoSphere Austria API and evaluates alert levels
 * for Schüttelstraße 79 & 81, Vienna (Lat: 48.2092, Lon: 16.4050)
 *
 * Exports `fetchAlertData()` for use by Netlify Functions.
 * Also runs as a CLI script (writes JSON to disk) when executed directly.
 */

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

/**
 * Scrapes AT-Alert data from the Next.js HTML response if the JSON API is unavailable.
 * This extracts the 'initialAlerts' data from the self.__next_f.push scripts.
 */
function scrapeATAlertHTML(html) {
    const scripts = [];
    const regex = /self\.__next_f\.push\(\[1,"(.+?)"\]\)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        scripts.push(match[1]);
    }
    if (scripts.length === 0) return null;

    const fullData = scripts.join('').replace(/\\"/g, '"').replace(/\\n/g, '\n');
    const marker = '"initialAlerts":';
    const startIdx = fullData.indexOf(marker);
    if (startIdx === -1) return null;

    let braceCount = 0;
    let endIdx = -1;
    for (let i = startIdx + marker.length; i < fullData.length; i++) {
        if (fullData[i] === '{') braceCount++;
        else if (fullData[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
                endIdx = i + 1;
                break;
            }
        }
    }
    if (endIdx === -1) return null;

    try {
        const jsonData = JSON.parse(fullData.substring(startIdx + marker.length, endIdx));
        return jsonData.data || [];
    } catch (e) {
        console.warn('AT-Alert Scraper: Failed to parse data snippet:', e.message);
        return null;
    }
}

async function fetchJSON(url, options = {}, sourceName = 'API') {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`${sourceName} error: ${res.status}`);
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`${sourceName}: Expected JSON but received ${contentType || 'unknown content'}`);
    }
    return res.json();
}

// GeoSphere Austria – INCA analysis (hourly, 1 km grid, near-realtime)
const buildGeoSphereUrl = (offsetHours = 1, windowHours = 3) => {
    const now = new Date();
    const start = new Date(now - (offsetHours + windowHours) * 60 * 60 * 1000);
    const end = new Date(now - offsetHours * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 19);

    const qs = new URLSearchParams({ start: fmt(start), end: fmt(end), lat_lon: `${LOCATION.lat},${LOCATION.lon}` });
    for (const p of ['T2M', 'RR', 'UU', 'VV', 'RH2M', 'P0']) qs.append('parameters', p);

    return `https://dataset.api.hub.geosphere.at/v1/timeseries/historical/inca-v1-1h-1km?${qs}`;
};

// ── Alert Thresholds ─────────────────────────────────────────────────────────
const THRESHOLDS = {
    heat: { yellow: 30, red: 35 },
    uv: { yellow: 6, red: 8 },
    wind: { yellow: 60, red: 80 },
    rain: { yellow: 15, red: 25 },
    flood: { yellow: 380, red: 432 },
    radiation: { yellow: 200, red: 300 },
    airQuality: { yellow: 25, red: 50 },  // PM10 µg/m³ (EU 24h limit: 50)
    airQualityIndex: { yellow: 3, red: 5 }, // Wiener Luftgüteindex (1-6)
    earthquake: { yellow: 3.0, red: 4.5 }, // Magnitude (Richter)
    fire: { yellow: 3, red: 4 },           // WBI Index (1-5)
    space: { yellow: 5, red: 7 },          // Kp-Index (0-9)
    power: { yellow: 2, red: 2 },          // Status level (1: OK, 2: Outage)
    water: { yellow: 2, red: 2 },          // Status level (1: OK, 2: Outage)
    gas: { yellow: 2, red: 2 },            // Status level (1: OK, 2: Outage)
    snow: { yellow: 0.03, red: 0.10 },     // Snow depth in meters
};

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
        const trendMatch = html.match(/Trend des Wasserpegels in den letzten 7 Tagen:\s*([^\s<]+)/);

        if (!pegelMatch) throw new Error('danubealert.com: Pegel value not found in HTML');

        return {
            pegelCm: parseInt(pegelMatch[1], 10),
            ldc: ldcMatch ? parseInt(ldcMatch[1], 10) : 288,
            hdc: hdcMatch ? parseInt(hdcMatch[1], 10) : 432,
            trend: trendMatch ? trendMatch[1].trim() : null,
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

// ── Air Quality: Wien.gv.at Luftgütebericht scraper ─────────────────────────
async function fetchAirQualityData() {
    return withRetry(async () => {
        const res = await fetch('https://www.wien.gv.at/ma22-lgb/tb/tb-aktuell.htm', {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
        });
        if (!res.ok) throw new Error(`Wien Luftgütebericht error: ${res.status}`);
        const html = await res.text();

        // Parse WIEN - MAXIMUM row for PM10 and PM2.5 values
        // Format: "WIEN - MAXIMUM | ... | ... | ... | pm10 | pm25 | ..."
        const maxMatch = html.match(/WIEN\s*-\s*MAXIMUM\s*\|([^\n]+)/);
        if (!maxMatch) throw new Error('Wien Luftgütebericht: WIEN-MAXIMUM row not found');

        const maxParts = maxMatch[1].split('|').map(s => s.trim());
        // Column layout: NO2 | O3 | B | PM10 | PM2.5 | SO2/CO | CO/MW8
        // Index:           0  |  1 | 2 |  3   |   4   |   5    |   6
        const pm10 = parseFloat(maxParts[3]) || null;
        const pm25 = parseFloat(maxParts[4]) || null;

        // Parse Luftgüteindex (overall)
        // Look for the overall index statement at the top
        const overallIdxMatch = html.match(/Die aktuelle Belastung heute um \d+ Uhr:\s*Index\s*(\d)/i);
        let luftIndex = null;
        if (overallIdxMatch) {
            luftIndex = parseInt(overallIdxMatch[1], 10);
        } else {
            // Fallback: Parse WIEN - INDEX row and take maximum value if available
            const idxMatch = html.match(/WIEN\s*-\s*INDEX\s*\|([^\n]+)/);
            if (idxMatch) {
                const digits = idxMatch[1].match(/\d/g);
                if (digits) {
                    luftIndex = Math.max(...digits.map(d => parseInt(d, 10)));
                }
            }
        }

        if (pm10 === null && pm25 === null) {
            throw new Error('Wien Luftgütebericht: No PM values found in MAXIMUM row');
        }

        return {
            pm10,
            pm25,
            luftIndex,
            source: 'Wien.gv.at Luftgütebericht (MA 22)',
        };
    });
}

// ── Earthquake: ZAMG FDSN + EMSC fallback ────────────────────────────────────
const haversineKm = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function parseQuakeText(text) {
    return text
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .map((line) => {
            const cols = line.split('|').map((c) => c.trim());
            // FDSN text format: EventID|Time|Lat|Lon|Depth|...|Magnitude|...
            const lat = parseFloat(cols[2]);
            const lon = parseFloat(cols[3]);
            return {
                id: cols[0],
                time: cols[1],
                lat,
                lon,
                depthKm: parseFloat(cols[4]) || null,
                magnitude: parseFloat(cols[10]) || 0,
                distanceKm: Math.round(haversineKm(LOCATION.lat, LOCATION.lon, lat, lon)),
            };
        })
        .filter((q) => !isNaN(q.magnitude));
}

async function fetchEarthquakeData() {
    const now = new Date();
    const yesterday = new Date(now - 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 19);

    const bbox = 'minlat=47.2&maxlat=49.2&minlon=14.9&maxlon=18.1';
    const params = `${bbox}&minmag=0.5&starttime=${fmt(yesterday)}&endtime=${fmt(now)}&format=text&orderby=magnitude`;

    const sources = [
        { name: 'ZAMG/GeoSphere', url: `https://geoweb.zamg.ac.at/fdsnws/event/1/query?${params}` },
        { name: 'EMSC', url: `https://www.seismicportal.eu/fdsnws/event/1/query?${params}` },
    ];

    for (const { name, url } of sources) {
        try {
            const res = await withRetry(async () => {
                const r = await fetch(url, { headers: { Accept: 'text/plain' } });
                if (r.status === 204 || r.status === 404) return null; // no events found
                if (!r.ok) throw new Error(`${name} error: ${r.status}`);
                return r;
            });

            if (!res) {
                // No seismic events – that's good news
                return { magnitude: 0, distanceKm: null, depthKm: null, time: null, source: `${name} (keine Ereignisse)` };
            }

            const text = await res.text();
            const quakes = parseQuakeText(text);

            if (!quakes.length) {
                return { magnitude: 0, distanceKm: null, depthKm: null, time: null, source: `${name} (keine Ereignisse)` };
            }

            // Strongest quake first (already sorted by API, but ensure)
            quakes.sort((a, b) => b.magnitude - a.magnitude);
            const strongest = quakes[0];

            return {
                magnitude: strongest.magnitude,
                distanceKm: strongest.distanceKm,
                depthKm: strongest.depthKm,
                time: strongest.time,
                eventCount: quakes.length,
                source: `${name} FDSN`,
            };
        } catch (err) {
            console.warn(`Earthquake ${name}: ${err.message}. Trying next source...`);
        }
    }
    throw new Error('All earthquake data sources failed');
}

// ── AT-Alert: Official Austrian Cell Broadcast warnings ──────────────────────
function pointInPolygon(lat, lon, polygon) {
    // Ray-casting algorithm
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [yi, xi] = polygon[i];
        const [yj, xj] = polygon[j];
        if ((yi > lon) !== (yj > lon) && lat < ((xj - xi) * (lon - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

const AT_ALERT_LEVEL_MAP = {
    Extreme: 'red',
    Severe: 'red',
    Moderate: 'yellow',
    Minor: 'yellow',
    MonthlyTest: 'green',
};

// ── Fire: Waldbrandindex (WBI) & NASA FIRMS Hotspots ────────────────────────
function calculateWBI(temp, humidity, windKmH, rainMm) {
    // Simplified Waldbrandindex (WBI) logic inspired by BOKU/ZAMG
    // returns 1 (low) to 5 (extreme)
    if (temp === null || humidity === null) return 1;

    let score = 0;
    if (temp > 20) score += 1;
    if (temp > 25) score += 1;
    if (temp > 30) score += 1;

    if (humidity < 50) score += 1;
    if (humidity < 35) score += 1;
    if (humidity < 25) score += 1;

    if (windKmH > 20) score += 1;
    if (windKmH > 40) score += 1;

    if (rainMm > 0.5) score -= 2;
    if (rainMm > 5) score -= 5;

    const index = Math.max(1, Math.min(5, Math.floor(score / 2) + 1));
    return index;
}

async function fetchFireData() {
    const NASA_KEY = process.env.NASA_FIRMS_KEY || '1433f5fc2df52ddc1c7c17d45445e2dd';

    // Bounding Box approx 20km around 1020 Wien
    const area = [
        LOCATION.lon - 0.2, // minLon
        LOCATION.lat - 0.15, // minLat
        LOCATION.lon + 0.2, // maxLon
        LOCATION.lat + 0.15  // maxLat
    ].join(',');

    const sources = [
        { name: 'NASA FIRMS (VIIRS SNPP)', url: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_KEY}/VIIRS_SNPP_NRT/${area}/1` },
        { name: 'NASA FIRMS (MODIS)', url: `https://firms.modaps.eosdis.nasa.gov/api/country/csv/${NASA_KEY}/MODIS_NRT/AUT/1` }
    ];

    if (NASA_KEY === 'YOUR_NASA_MAP_KEY') {
        return { activeHotspots: 0, source: 'NASA (Key fehlt)', alert: false };
    }

    try {
        // We only check VIIRS for high-res local monitoring
        const res = await withRetry(async () => {
            const r = await fetch(sources[0].url);
            if (!r.ok) throw new Error(`NASA API error: ${r.status}`);
            return r;
        });
        const csv = await res.text();
        const lines = csv.trim().split('\n');
        const hotspots = lines.length - 1; // Subtract header

        return {
            activeHotspots: hotspots > 0 ? hotspots : 0,
            source: 'NASA FIRMS Satelliten-Monitoring',
            alert: hotspots > 0
        };
    } catch (err) {
        console.warn(`NASA FIRMS failed: ${err.message}`);
        return { activeHotspots: 0, source: 'NASA (Offline)', alert: false };
    }
}

async function fetchSnowData() {
    return withRetry(async () => {
        const now = new Date();
        const fmt = (d) => d.toISOString().slice(0, 19);
        const q = new URLSearchParams({
            start: fmt(new Date(now - 2 * 60 * 60 * 1000)), // Query last 2h to be safe
            end: fmt(now),
            lat_lon: `${LOCATION.lat},${LOCATION.lon}`,
            parameters: 'snow_depth'
        });
        const url = `https://dataset.api.hub.geosphere.at/v1/timeseries/historical/snowgrid_cl-v2-1d-1km?${q}`;
        const data = await fetchJSON(url, {}, 'GeoSphere SNOWGRID');
        const depth = data.features?.[0]?.properties?.parameters?.snow_depth?.data?.at(-1) ?? 0;

        return {
            value: depth,
            unit: 'm',
            source: 'GeoSphere Austria (SNOWGRID)',
            sourceUrl: 'https://www.geosphere.at/'
        };
    });
}

async function fetchSpaceWeatherData() {
    return withRetry(async () => {
        // Fetch both NOAA Scales and Planetary K-index in parallel
        const [scalesRes, kpRes] = await Promise.allSettled([
            fetchJSON('https://services.swpc.noaa.gov/products/noaa-scales.json', {}, 'NOAA Scales'),
            fetchJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', {}, 'NOAA K-Index')
        ]);

        let g = 0, s = 0, r = 0;
        if (scalesRes.status === 'fulfilled') {
            const data = scalesRes.value;
            const current = data['0'] || {};
            g = parseInt(current.G?.Scale) || 0;
            s = parseInt(current.S?.Scale) || 0;
            r = parseInt(current.R?.Scale) || 0;
        }

        let kp = 0;
        if (kpRes.status === 'fulfilled') {
            const data = kpRes.value;
            // K-index JSON format: [["time_tag","Kp",...], ["2024-02-24...", "2.33", ...]]
            // Latest value is the last element
            const latest = data.at(-1);
            if (latest && latest[1]) {
                kp = parseFloat(latest[1]);
            }
        }

        // The alert level is primarily driven by Kp (G-scale equivalent)
        // Kp 5 = G1, Kp 6 = G2, Kp 7 = G3, Kp 8 = G4, Kp 9 = G5
        const maxScaleLevel = Math.max(g, s, r);

        return {
            value: kp,
            unit: 'Kp',
            level: kp, // We return kp as value, alertLevel evaluator will use it
            scales: { g, s, r },
            source: 'NOAA Space Weather Prediction Center',
            sourceUrl: 'https://www.swpc.noaa.gov/'
        };
    });
}

async function fetchUVData() {
    return withRetry(async () => {
        const url = `https://currentuvindex.com/api/v1/uvi?latitude=${LOCATION.lat}&longitude=${LOCATION.lon}`;
        const data = await fetchJSON(url, {}, 'CurrentUVIndex');
        return {
            uvi: data.now?.uvi ?? null,
            source: 'currentuvindex.com (NOAA Data)',
            sourceUrl: 'https://currentuvindex.com/'
        };
    });
}

async function fetchPowerOutageData() {
    return withRetry(async () => {
        const url = 'https://www.wienernetze.at/stromversorgung';
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`Wiener Netze error: ${res.status}`);
        const html = await res.text();

        // Target phrase for normal operation
        const okPhrase = 'Derzeit sind alle Kundinnen und Kunden im Versorgungsgebiet der Wiener Netze versorgt.';
        const isOk = html.includes(okPhrase);

        return {
            status: isOk ? 1 : 2,
            message: isOk ? 'Normalbetrieb' : 'Störung / Ausfall gemeldet',
            source: 'Wiener Netze Statusseite',
            sourceUrl: url
        };
    });
}

async function fetchGasStatus() {
    return withRetry(async () => {
        const url = 'https://www.wienernetze.at/stoerungen';
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
        if (!res.ok) throw new Error(`Wiener Netze (Stoerungen) error: ${res.status}`);
        const html = await res.text();

        // Check for specific gas disruption indicators that are likely to be present in HTML
        // We look for active markers. If none found, assume Normalbetrieb.
        const disruptionMarkers = ['aktuelles Gasgebrechen', 'Gasversorgung unterbrochen', 'Gasaustritt gemeldet'];
        const hasSpecificDisruption = disruptionMarkers.some(kw => html.includes(kw));

        return {
            status: hasSpecificDisruption ? 2 : 1,
            message: hasSpecificDisruption ? 'Störung gemeldet' : 'Normalbetrieb',
            source: 'Wiener Netze (Erdgas)',
            sourceUrl: 'https://www.wienernetze.at/gas' // More informative landing page
        };
    });
}

async function fetchWaterStatus() {
    try {
        return await withRetry(async () => {
            // MA 31 main page as primary because disruption page is often 500
            const url = 'https://www.wien.gv.at/wasser/versorgung/index.html';
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

            const disruptionUrl = 'https://www.wien.gv.at/kontakte/ma31/stoerungen.html';

            if (!res.ok) {
                // Main page down, try disruption page
                const resFallback = await fetch(disruptionUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (!resFallback.ok) throw new Error(`Status: ${resFallback.status}`);
                const html = await resFallback.text();

                const hasDisruption = ['Rohrbruch', 'Wasserrohrbruch', 'Versorgung unterbrochen', 'Großgebrechen'].some(kw => html.includes(kw));
                return {
                    status: hasDisruption ? 2 : 1,
                    message: hasDisruption ? 'Störung gemeldet' : 'Normalbetrieb',
                    source: 'Wiener Wasser (MA 31)',
                    sourceUrl: 'https://www.wien.gv.at/kontakt/ma31'
                };
            }

            const html = await res.text();
            // Check for major disruption news on main page
            const hasDisruption = ['Rohrbruch', 'Wasserrohrbruch', 'Großgebrechen'].some(kw => html.includes(kw));

            return {
                status: hasDisruption ? 2 : 1,
                message: hasDisruption ? 'Einschränkungen möglich' : 'Normalbetrieb',
                source: 'Wiener Wasser (MA 31)',
                sourceUrl: 'https://www.wien.gv.at/kontakt/ma31'
            };
        });
    } catch (err) {
        return {
            status: 0, // Green / Unknown
            message: 'Information aktuell eingeschränkt erreichbar',
            source: 'Wiener Wasser (MA 31)',
            sourceUrl: 'https://www.wien.gv.at/kontakt/ma31'
        };
    }
}

async function fetchBlackoutStatus() {
    return withRetry(async () => {
        const url = 'https://www.netzfrequenz.info/json/act.json';
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`Netzfrequenz check failed: ${res.status}`);

        const data = await res.json();
        const frequency = parseFloat(data);
        if (isNaN(frequency)) throw new Error('Invalid frequency data');

        let status = 1; // Green
        let message = 'Normalbetrieb';

        // Official thresholds for UCTE (Continental Europe)
        // 49.90 - 50.10: Normal
        // < 49.90 or > 50.10: Disturbance
        // < 49.80 or > 50.20: Major Disturbance
        if (frequency < 49.80 || frequency > 50.20) {
            status = 3; // Red
            message = 'Kritische Abweichung!';
        } else if (frequency < 49.90 || frequency > 50.10) {
            status = 2; // Yellow
            message = 'Erhöhte Netzbelastung';
        }

        return {
            status,
            value: frequency,
            unit: 'Hz',
            message,
            source: 'Netzfrequenz.info (UCTE)',
            sourceUrl: 'https://gridradar.net/de/netzfrequenz'
        };
    });
}

async function fetchTrafficStatus() {
    return withRetry(async () => {
        const url = 'https://www.wienerlinien.at/ogd_realtime/trafficInfoList';
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`WL Traffic check failed: ${res.status}`);

        const json = await res.json();
        const trafficInfos = json.data?.trafficInfos ?? [];

        // Logical proxy: Line 80A, 1, 77A disruptions in 1020/Schüttelstraße area
        const relevantLines = ['80A', '1', '77A'];
        const areaKeywords = ['Schüttelstraße', 'Stadionbrücke', 'Prater', 'Ausstellungsstraße', 'Engerthstraße'];

        const disruptions = trafficInfos.filter(info => {
            const text = JSON.stringify(info).toLowerCase();
            const lines = info.relatedLines ?? [];
            const hasLine = lines.some(l => relevantLines.includes(l));
            const hasArea = areaKeywords.some(kw => text.includes(kw.toLowerCase()));
            return hasLine || hasArea;
        });

        let status = 1;
        let message = 'Freie Zufahrt';

        if (disruptions.length > 0) {
            // Sort by severity: Sperre > Bauarbeiten
            const critical = disruptions.find(d =>
                d.title.toLowerCase().includes('sperre') ||
                d.description.toLowerCase().includes('gesperrt')
            );

            if (critical) {
                status = 3;
                message = critical.title;
            } else {
                status = 2;
                message = disruptions[0].title;
            }
        }

        return {
            status,
            value: status,
            unit: 'Status',
            message,
            source: 'Wiener Linien & Google',
            sourceUrl: 'https://www.google.com/maps/@48.2092,16.4050,15z/data=!5m1!1e1', // Traffic layer
            extraLinks: [
                { name: 'WL Betriebsinfo', url: 'https://www.wienerlinien.at/betriebsinfo' },
                { name: 'Baustellen Wien', url: 'https://www.wien.gv.at/verkehr/baustellen/' }
            ]
        };
    });
}

async function fetchATAlertData() {
    return withRetry(async () => {
        const today = new Date().toISOString().slice(0, 10);
        const url = `https://warnungen.at-alert.at/api/filteredAlerts?from=${today}&to=${today}&limit=100&offset=0`;
        const userAgent = 'Mozilla/5.0';

        let rawAlerts = [];
        try {
            const data = await fetchJSON(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent } }, 'AT-Alert API');
            rawAlerts = data.alerts ?? [];
        } catch (err) {
            // Fallback: If the API returns HTML (e.g. 404 or redirect), try scraping the main page
            if (err.message.includes('Expected JSON but received text/html') || err.message.includes('Unexpected token')) {
                try {
                    // Use AbortController for timeout
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                    const res = await fetch('https://warnungen.at-alert.at/de', {
                        headers: { 'User-Agent': userAgent },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (res.ok) {
                        const html = await res.text();
                        const scraped = scrapeATAlertHTML(html);
                        if (scraped) {
                            rawAlerts = scraped;
                        } else {
                            throw err; // Re-throw original if scraper found no data markers
                        }
                    } else {
                        throw err;
                    }
                } catch (fallbackErr) {
                    throw err; // Always prioritize original API error if fallback also fails
                }
            } else {
                throw err;
            }
        }

        const now = new Date();
        const activeAlerts = rawAlerts
            .filter((a) => a.alert_level !== 'MonthlyTest')
            .filter((a) => new Date(a.info_expires) > now)
            .filter((a) => {
                // Check if any polygon covers our location
                if (!a.polygons?.length) return true; // No polygon = nationwide
                return a.polygons.some((poly) => pointInPolygon(LOCATION.lat, LOCATION.lon, poly));
            });

        if (!activeAlerts.length) {
            return { active: false, count: 0, level: 'green', alerts: [], source: 'AT-Alert (keine Warnungen)' };
        }

        // Use highest severity alert
        const severityOrder = ['Extreme', 'Severe', 'Moderate', 'Minor'];
        activeAlerts.sort((a, b) => severityOrder.indexOf(a.alert_level) - severityOrder.indexOf(b.alert_level));
        const top = activeAlerts[0];

        return {
            active: true,
            count: activeAlerts.length,
            level: AT_ALERT_LEVEL_MAP[top.alert_level] ?? 'yellow',
            title: top.title ?? top.info_area_description ?? 'Warnung',
            description: top.description ?? top.info_description ?? null,
            alertLevel: top.alert_level,
            expires: top.info_expires,
            sender: top.sender,
            source: 'AT-Alert (HTML Scraper Fallback)',
        };
    });
}

// ── Pandemic & Influenza: WHO DON + MedUni Wien Map ──────────────────────────
async function fetchPandemicData() {
    return withRetry(async () => {
        // 1. Fetch WHO News
        const whoUrl = 'https://www.who.int/api/news/diseaseoutbreaknews?$top=15';
        const medUniUrl = 'https://viro.meduniwien.ac.at/fileadmin/content/OE/virologie/dokumente/Virus_Epidemiogie/RespiratorischeViren/ATKarte.svg';

        const [whoRes, medUniRes] = await Promise.allSettled([
            fetch(whoUrl, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }),
            fetch(medUniUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

        let whoData = null;
        if (whoRes.status === 'fulfilled' && whoRes.value.ok) {
            const contentType = whoRes.value.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                whoData = await whoRes.value.json();
            } else {
                console.warn('WHO API: Expected JSON but received', contentType);
            }
        }

        let influenzaLevel = 'green';
        let influenzaSource = '';
        const medUniDetailUrl = 'https://viro.meduniwien.ac.at/forschung/virus-epidemiologie-2/ueberwachung-der-zirkulation-respiratorischer-viren-in-oesterreich/influenza-diagnostisches-influenza-netzwerk-oesterreich-dinoe/';

        if (medUniRes.status === 'fulfilled' && medUniRes.value.ok) {
            const svg = await medUniRes.value.text();

            const wienMatch = svg.match(/class="Wien"[^>]*fill="([^"]+)"/);
            const noeMatch = svg.match(/class="Niederösterreich"[^>]*fill="([^"]+)"/);
            const hasAnyRed = svg.includes('fill="red"') || svg.includes('fill="#ff0000"');

            const wienColor = wienMatch?.[1]?.toLowerCase() ?? '';
            const noeColor = noeMatch?.[1]?.toLowerCase() ?? '';

            if (wienColor.includes('red') || noeColor.includes('red') || hasAnyRed) {
                influenzaLevel = 'red';
            } else if (wienColor.includes('orange') || noeColor.includes('orange') || wienColor.includes('yellow') || noeColor.includes('yellow')) {
                influenzaLevel = 'yellow';
            }
            influenzaSource = 'MedUni Wien Map';
        }

        // 2. Evaluate WHO Relevance
        const alerts = whoData?.value ?? [];
        const now = new Date();
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        const relevantAlerts = alerts
            .filter((a) => new Date(a.PublicationDateAndTime) > thirtyDaysAgo)
            .map((a) => {
                const text = `${a.Title} ${a.Summary ?? ''}`.toLowerCase();
                let score = 0;
                if (text.includes('austria') || text.includes('österreich') || text.includes('vienna') || text.includes('wien')) score = 100;
                else if (/germany|deutschland|slovakia|slovakei|czech|tschechien|hungary|ungarn|slovenia|slowenien|italy|italien|switzerland|schweiz/.test(text)) score = 50;
                else if (text.includes('europe') || text.includes('global') || text.includes('pandemic')) score = 25;
                return { ...a, relevanceScore: score };
            })
            .filter((a) => a.relevanceScore > 0)
            .sort((a, b) => b.relevanceScore - a.relevanceScore);

        const topWho = relevantAlerts[0];
        let whoLevel = 'green';
        if (topWho) {
            whoLevel = topWho.relevanceScore === 100 ? 'red' : 'yellow';
            if (topWho.relevanceScore === 25 && !/mpox|influenza|h5n1|cholera|ebola/.test(topWho.Title.toLowerCase())) whoLevel = 'green';
        }

        // 3. Combine Results
        const severityRank = { red: 3, yellow: 2, green: 1, unknown: 0 };
        const finalLevel = severityRank[whoLevel] >= severityRank[influenzaLevel] ? whoLevel : influenzaLevel;

        const infoParts = [];
        const details = [];

        if (topWho) {
            infoParts.push(`WHO: ${topWho.Title}`);
            details.push({
                name: topWho.Title,
                url: topWho.Url ? (topWho.Url.startsWith('http') ? topWho.Url : `https://www.who.int${topWho.Url}`) : 'https://www.who.int/emergencies/disease-outbreak-news'
            });
        }

        if (influenzaLevel !== 'green') {
            infoParts.push(`Influenza: ${influenzaLevel === 'red' ? 'Welle' : 'Aktivität'} (MedUni)`);
            details.push({
                name: 'Influenza',
                url: medUniDetailUrl
            });
        }

        return {
            active: finalLevel !== 'green',
            level: finalLevel,
            title: infoParts[0] ?? (influenzaLevel !== 'green' ? 'Influenza-Warnung' : 'Keine aktuellen Meldungen'),
            summary: infoParts.slice(1).join(' | ') || (topWho?.Summary ? topWho.Summary.replace(/<\/?[^>]+(>|$)/g, "").substring(0, 150) + '...' : null),
            details: details,
            source: `WHO DON${influenzaSource ? ' + ' + influenzaSource : ''}`,
            date: topWho?.PublicationDateAndTime ?? now.toISOString(),
        };
    });
}

// ── Fetch GeoSphere Austria data ─────────────────────────────────────────────
async function fetchWeather() {
    for (let offset = 1; offset <= 3; offset++) {
        try {
            const data = await withRetry(async () => {
                const url = buildGeoSphereUrl(offset);
                const json = await fetchJSON(url, { headers: { Accept: 'application/json' } }, 'GeoSphere API');
                const features = json.features ?? [];
                if (!features.length) throw new Error('No feature data');
                return features[0].properties.parameters;
            });

            const last = (key) => (data[key]?.data ?? []).at(-1) ?? null;
            const uu = last('UU');
            const vv = last('VV');
            const windMs = uu != null && vv != null ? Math.sqrt(uu ** 2 + vv ** 2) : null;

            const pData = data['P0']?.data ?? [];
            const pressureHpa = pData.at(-1) != null ? pData.at(-1) / 100 : null;
            let pressureTrend = '→';
            if (pData.length >= 2) {
                const curr = pData.at(-1);
                const prev = pData.at(-2);
                if (curr > prev) pressureTrend = '↑';
                else if (curr < prev) pressureTrend = '↓';
            }

            const result = {
                tempC: last('T2M'),
                rainMmH: last('RR'),
                windKmH: windMs != null ? Math.round(windMs * 3.6) : null,
                humidity: last('RH2M'),
                pressureHpa,
                pressureTrend
            };

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
async function fetchUWZWarnings() {
    return withRetry(async () => {
        const [mainRes, wienRes] = await Promise.all([
            fetch('https://uwz.at/'),
            fetch('https://uwz.at/de/s/wien')
        ]);

        if (!mainRes.ok || !wienRes.ok) throw new Error('UWZ fetch failed');

        const mainHtml = await mainRes.text();
        const wienHtml = await wienRes.text();

        // Helper to extract level from sidebar HTML
        const extractLevel = (html, regionName) => {
            // Find the region name, then look for the next indicator class
            const escapedName = regionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp(`${escapedName}[^>]*[\\s\\S]*?indicator--([a-z]+)`, 'i');
            const match = html.match(regex);
            return match ? match[1] : 'no';
        };

        const wienLevelRaw = extractLevel(mainHtml, 'Wien');
        const leoLevelRaw = extractLevel(wienHtml, 'Leopoldstadt');

        const mapLevel = (raw) => {
            if (raw === 'no') return 'green';
            if (raw === 'forewarn' || raw === 'moderate') return 'yellow';
            if (raw === 'heavy' || raw === 'extreme') return 'red';
            return 'green';
        };

        const mapText = (raw) => {
            const texts = { no: 'Keine Warnung', forewarn: 'Vorwarnung', moderate: 'Unwetter', heavy: 'Starkes Unwetter', extreme: 'Sehr starkes Unwetter' };
            return texts[raw] || 'Unbekannt';
        };

        return {
            wien: { level: mapLevel(wienLevelRaw), text: mapText(wienLevelRaw) },
            leopoldstadt: { level: mapLevel(leoLevelRaw), text: mapText(leoLevelRaw) },
            source: 'Österreichische Unwetterzentrale (UWZ)',
            sourceUrl: 'https://uwz.at/'
        };
    });
}
async function fetchThunderstormData() {
    return withRetry(async () => {
        const data = await fetchJSON('https://warnungen.zamg.at/wsapp/api/getGewitterAuto', {}, 'Thunderstorm API');

        // Vienna municipalities start with 9 (90101 to 92301)
        const wienFeatures = (data.features || []).filter(f =>
            f.properties?.gemeindenr?.toString().startsWith('9')
        );

        const maxIntensity = wienFeatures.reduce((max, f) =>
            Math.max(max, f.properties.intensitaet || 0), 0
        );

        const levels = ['green', 'yellow', 'red']; // 0: green, 1: yellow, 2+: red
        const level = levels[Math.min(maxIntensity, 2)];
        const messages = ['Keine Gewitterzellen', 'Moderate Gewitteraktivität', 'Starke Gewitterzellen / Hagelgefahr!', 'Extreme Gewitterzellen / HAGEL-ALARM!'];
        const message = messages[Math.min(maxIntensity, 3)];

        return {
            level,
            intensity: maxIntensity,
            message,
            count: wienFeatures.length,
            source: 'GeoSphere Austria (ZAMG)',
            sourceUrl: 'https://warnungen.zamg.at/wsapp/de/gewitter/heute/',
            extraLinks: [
                { name: 'Hagelradar', url: 'https://warnungen.zamg.at/wsapp/de/hagel/heute/' }
            ]
        };
    });
}

// ── Core: Fetch all alert data and return status object ─────────────────────
export async function fetchAlertData() {
    const timestamp = new Date().toISOString();
    const severityRank = { green: 0, yellow: 1, red: 2, unknown: -1 };

    console.log(`[${timestamp}] Starting data fetch...`);

    try {
        const results = await Promise.allSettled([
            fetchWeather(),
            fetchFloodData(),
            fetchRadiationData(),
            fetchAirQualityData(),
            fetchEarthquakeData(),
            fetchATAlertData(),
            fetchPandemicData(),
            fetchFireData(),
            fetchSpaceWeatherData(),
            fetchPowerOutageData(),
            fetchGasStatus(),
            fetchWaterStatus(),
            fetchBlackoutStatus(),
            fetchTrafficStatus(),
            fetchSnowData(),
            fetchUWZWarnings(),
            fetchThunderstormData(),
            fetchUVData(),
        ]);

        const sourceNames = ['Weather/GeoSphere', 'Flood/DanubeAlert', 'Radiation/IMIS', 'AirQuality/MA22', 'Earthquake/GeoSphere', 'AT-Alert', 'Pandemic/WHO', 'Fire/NASA', 'SpaceWeather/NOAA', 'Power/WienerNetze', 'Gas/WienerNetze', 'Water/MA31', 'Blackout/Netzfrequenz', 'Traffic/VPI', 'Snow/SNOWGRID', 'UWZ', 'Thunderstorm/ZAMG', 'UVIndex'];

        const errors = results
            .map((r, i) => r.status === 'rejected' ? `${sourceNames[i]}: ${r.reason.message}` : null)
            .filter(Boolean);

        const weather = results[0].status === 'fulfilled' ? results[0].value : null;
        const floodData = results[1].status === 'fulfilled' ? results[1].value : null;
        const radiationData = results[2].status === 'fulfilled' ? results[2].value : null;
        const airQualityData = results[3].status === 'fulfilled' ? results[3].value : null;
        const earthquakeData = results[4].status === 'fulfilled' ? results[4].value : null;
        const atAlertData = results[5].status === 'fulfilled' ? results[5].value : null;
        const pandemicData = results[6].status === 'fulfilled' ? results[6].value : null;
        const fireData = results[7].status === 'fulfilled' ? results[7].value : null;
        const spaceData = results[8].status === 'fulfilled' ? results[8].value : null;
        const powerData = results[9].status === 'fulfilled' ? results[9].value : { level: 'unknown' };
        const gasData = results[10].status === 'fulfilled' ? results[10].value : { level: 'unknown' };
        const waterData = results[11].status === 'fulfilled' ? results[11].value : { level: 'unknown' };
        const blackoutData = results[12].status === 'fulfilled' ? results[12].value : { level: 'unknown' };
        const trafficData = results[13].status === 'fulfilled' ? results[13].value : { level: 'unknown' };
        const snowData = results[14].status === 'fulfilled' ? results[14].value : { level: 'unknown' };
        const uwzData = results[15].status === 'fulfilled' ? results[15].value : { level: 'unknown' };
        const thunderData = results[16].status === 'fulfilled' ? results[16].value : { level: 'unknown' };
        const uvData = results[17].status === 'fulfilled' ? results[17].value : { level: 'unknown' };

        if (!weather && !floodData && !radiationData && !airQualityData && !earthquakeData && !atAlertData && !pandemicData && !fireData && !spaceData && !powerData && !snowData && !uwzData && !thunderData && !uvData) {
            throw new Error('All data sources failed.');
        }

        const heatTempLevel = weather ? alertLevel(weather.tempC ?? 0, THRESHOLDS.heat) : 'unknown';
        const uvIndexLevel = uvData ? alertLevel(uvData.uvi ?? 0, THRESHOLDS.uv) : 'unknown';
        const heatLevel = severityRank[heatTempLevel] > severityRank[uvIndexLevel] ? heatTempLevel : uvIndexLevel;

        const windLevel = weather ? alertLevel(weather.windKmH ?? 0, THRESHOLDS.wind) : 'unknown';
        const rainLevel = weather ? alertLevel(weather.rainMmH ?? 0, THRESHOLDS.rain) : 'unknown';
        const floodLevel = floodData ? alertLevel(floodData.pegelCm ?? 0, THRESHOLDS.flood) : 'unknown';
        const radiationLevel = radiationData ? alertLevel(radiationData.nsvH ?? 0, THRESHOLDS.radiation) : 'unknown';
        const airQualityLevel = (() => {
            if (!airQualityData) return 'unknown';
            const pmLevel = alertLevel(airQualityData.pm10 ?? 0, THRESHOLDS.airQuality);
            const idxLevel = airQualityData.luftIndex ? alertLevel(airQualityData.luftIndex, THRESHOLDS.airQualityIndex) : 'green';
            return severityRank[pmLevel] > severityRank[idxLevel] ? pmLevel : idxLevel;
        })();
        const earthquakeLevel = earthquakeData ? alertLevel(earthquakeData.magnitude ?? 0, THRESHOLDS.earthquake) : 'unknown';
        const atAlertLevel = atAlertData?.level ?? 'unknown';
        const pandemicLevel = pandemicData?.level ?? 'unknown';

        const wbi = weather ? calculateWBI(weather.tempC, weather.humidity, weather.windKmH, weather.rainMmH) : 1;
        let fireLevel = alertLevel(wbi, THRESHOLDS.fire);
        if (fireData?.alert) fireLevel = 'red'; // Upgrade to red if NASA detects hotspot

        const spaceLevel = spaceData ? alertLevel(spaceData.level, THRESHOLDS.space) : 'unknown';
        const powerLevel = powerData ? alertLevel(powerData.status, THRESHOLDS.power) : 'unknown';
        const gasLevel = gasData ? alertLevel(gasData.status, THRESHOLDS.gas) : 'unknown';
        const waterLevel = waterData ? alertLevel(waterData.status, THRESHOLDS.water) : 'unknown';
        const blackoutLevel = blackoutData?.status ? (blackoutData.status === 3 ? 'red' : (blackoutData.status === 2 ? 'yellow' : 'green')) : 'unknown';

        // Winterdienst Logic: Combination of depth, temp and rain
        let snowLevel = 'green';
        if (snowData) {
            const depth = snowData.value;
            const temp = weather?.tempC ?? 10;
            const rain = weather?.rainMmH ?? 0;

            if (depth >= THRESHOLDS.snow.red || (rain > 2 && temp < 1.0)) snowLevel = 'red';
            else if (depth >= THRESHOLDS.snow.yellow || (rain > 0 && temp < 1.5)) snowLevel = 'yellow';
        }

        // Ice (Glatteis) Logic
        let iceLevel = 'green';
        let iceMessage = 'Sicher';
        const temp = weather?.tempC ?? 10;
        const rain = weather?.rainMmH ?? 0;
        const hum = weather?.humidity ?? 50;

        if (temp <= 0 && rain > 0) {
            iceLevel = 'red';
            iceMessage = 'Gefrierender Regen! ⚠️';
        } else if (temp < 1.5 && (rain > 0 || (temp < 0 && hum > 85))) {
            iceLevel = 'yellow';
            iceMessage = temp < 0 ? 'Überfrierende Nässe / Reif' : 'Glatteisgefahr möglich';
        }

        // UWZ Logic
        const uwzLevel = uwzData ? (severityRank[uwzData.wien.level] > severityRank[uwzData.leopoldstadt.level] ? uwzData.wien.level : uwzData.leopoldstadt.level) : 'green';
        const thunderLevel = thunderData?.level ?? 'green';
        const trafficLevel = trafficData?.status ? (trafficData.status === 3 ? 'red' : (trafficData.status === 2 ? 'yellow' : 'green')) : 'unknown';

        const levels = [heatLevel, windLevel, rainLevel, floodLevel, radiationLevel, airQualityLevel, earthquakeLevel, atAlertLevel, pandemicLevel, fireLevel, spaceLevel, powerLevel, gasLevel, waterLevel, blackoutLevel, trafficLevel, snowLevel, iceLevel, uwzLevel, thunderLevel];
        const overallLevel = levels.reduce((max, lvl) => severityRank[lvl] > severityRank[max] ? lvl : max, 'green');

        return {
            fetchedAt: timestamp,
            overall: overallLevel,
            dataSource: 'GeoSphere Austria + danubealert.com + Strahlenschutz.gv.at + Wien.gv.at Luftgütebericht + ZAMG/EMSC Erdbebendienst + AT-Alert + WHO DON + NASA FIRMS + Netzfrequenz.info',
            location: { address: 'Schüttelstraße 79 & 81, 1020 Wien', ...LOCATION },
            hazards: {
                heat: {
                    level: heatLevel,
                    value: weather?.tempC ?? null,
                    unit: '°C',
                    uvi: uvData?.uvi ?? null,
                    thresholds: THRESHOLDS.heat,
                    uvThresholds: THRESHOLDS.uv,
                    sourceUrl: 'https://warnungen.zamg.at/',
                    extraLinks: [
                        { name: 'UV-Index (UV-Messnetz)', url: 'https://www.uv-index.at/station/?site=Wien&prod=uve' }
                    ]
                },
                wind: {
                    level: windLevel,
                    value: weather?.windKmH ?? null,
                    unit: 'km/h',
                    humidity: weather?.humidity ?? null,
                    thresholds: THRESHOLDS.wind,
                    sourceUrl: 'https://warnungen.zamg.at/'
                },
                rain: {
                    level: rainLevel,
                    value: weather?.rainMmH ?? null,
                    unit: 'mm/h',
                    thresholds: THRESHOLDS.rain,
                    sourceUrl: 'https://warnungen.zamg.at/'
                },
                flood: {
                    level: floodLevel,
                    value: floodData?.pegelCm ?? null,
                    unit: 'cm',
                    trend: floodData?.trend ?? null,
                    thresholds: THRESHOLDS.flood,
                    source: floodData?.source ?? 'Offline',
                    sourceUrl: 'https://danubealert.com/at/history/schwedenbrucke',
                    extraLinks: [
                        { name: 'EFAS (European Flood Awareness)', url: 'https://www.copernicus.eu/en/european-flood-awareness-system' },
                        { name: 'ERCC (Emergency Response Coordination)', url: 'https://erccportal.jrc.ec.europa.eu/' }
                    ]
                },
                radiation: {
                    level: radiationLevel,
                    value: radiationData?.nsvH ?? null,
                    unit: 'nSv/h',
                    thresholds: THRESHOLDS.radiation,
                    source: radiationData?.source ?? 'Offline',
                    sourceUrl: 'https://mb.strahlenschutz.gv.at/station/AT2002'
                },
                airQuality: {
                    level: airQualityLevel,
                    value: airQualityData?.pm10 ?? null,
                    unit: 'µg/m³',
                    thresholds: THRESHOLDS.airQuality,
                    pm25: airQualityData?.pm25 ?? null,
                    luftIndex: airQualityData?.luftIndex ?? null,
                    source: airQualityData?.source ?? 'Offline',
                    sourceUrl: 'https://www.wien.gv.at/ma22-lgb/tb/tb-aktuell.htm'
                },
                earthquake: {
                    level: earthquakeLevel,
                    value: earthquakeData?.magnitude ?? null,
                    unit: 'M',
                    thresholds: THRESHOLDS.earthquake,
                    distanceKm: earthquakeData?.distanceKm ?? null,
                    depthKm: earthquakeData?.depthKm ?? null,
                    time: earthquakeData?.time ?? null,
                    eventCount: earthquakeData?.eventCount ?? 0,
                    source: earthquakeData?.source ?? 'Offline',
                    sourceUrl: 'https://www.emsc-csem.org/Earthquake/'
                },
                atAlert: {
                    level: atAlertLevel,
                    value: atAlertData?.active ? atAlertData.count : 0,
                    unit: 'Warnungen',
                    title: atAlertData?.title ?? null,
                    description: atAlertData?.description ?? null,
                    alertLevel: atAlertData?.alertLevel ?? null,
                    expires: atAlertData?.expires ?? null,
                    sender: atAlertData?.sender ?? null,
                    source: atAlertData?.source ?? 'Offline',
                    sourceUrl: 'https://warnungen.at-alert.at'
                },
                pandemic: {
                    level: pandemicLevel,
                    value: pandemicData?.active ? 1 : 0,
                    unit: 'Aktiv',
                    title: pandemicData?.title ?? null,
                    summary: pandemicData?.summary ?? null,
                    details: pandemicData?.details ?? [],
                    date: pandemicData?.date ?? null,
                    source: pandemicData?.source ?? 'Offline',
                    sourceUrl: 'https://viro.meduniwien.ac.at/forschung/virus-epidemiologie-2/ueberwachung-der-zirkulation-respiratorischer-viren-in-oesterreich/influenza-diagnostisches-influenza-netzwerk-oesterreich-dinoe/'
                },
                fire: {
                    level: fireLevel,
                    value: wbi,
                    unit: 'WBI',
                    thresholds: THRESHOLDS.fire,
                    hotspots: fireData?.activeHotspots ?? 0,
                    source: fireData?.source ?? 'Offline',
                    sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@16.4,48.2,12.0z',
                    extraLinks: [
                        { name: 'EFFIS (Copernicus)', url: 'https://effis.jrc.ec.europa.at/' },
                        { name: 'Waldbrand-Datenbank (BOKU)', url: 'https://waldbrand.at/' }
                    ]
                },
                space: {
                    level: spaceLevel,
                    value: spaceData?.level ?? 0,
                    unit: 'Scale',
                    thresholds: THRESHOLDS.space,
                    scales: spaceData?.scales ?? { g: 0, s: 0, r: 0 },
                    source: spaceData?.source ?? 'Offline',
                    sourceUrl: spaceData?.sourceUrl ?? 'https://www.swpc.noaa.gov/',
                    extraLinks: [
                        { name: 'ESA Space Weather Network', url: 'https://swe.ssa.esa.int/' }
                    ]
                },
                power: {
                    level: powerLevel,
                    value: powerData?.status ?? 0,
                    unit: 'Status',
                    thresholds: THRESHOLDS.power,
                    message: powerData?.message ?? 'Unbekannt',
                    source: powerData?.source ?? 'Offline',
                    sourceUrl: powerData?.sourceUrl ?? 'https://www.wienernetze.at/stromversorgung',
                },
                gas: {
                    level: gasLevel,
                    value: gasData?.status ?? 0,
                    unit: 'Status',
                    thresholds: THRESHOLDS.gas,
                    message: gasData?.message ?? 'Unbekannt',
                    source: gasData?.source ?? 'Offline',
                    sourceUrl: gasData?.sourceUrl ?? 'https://www.wienernetze.at/gas',
                },
                water: {
                    level: waterLevel,
                    value: waterData?.status ?? 0,
                    unit: 'Status',
                    thresholds: THRESHOLDS.water,
                    message: waterData?.message ?? 'Unbekannt',
                    source: waterData?.source ?? 'Wiener Wasser (MA 31)',
                    sourceUrl: waterData?.sourceUrl ?? 'https://www.wien.gv.at/kontakt/ma31',
                },
                blackout: {
                    level: blackoutLevel,
                    value: blackoutData?.value ?? 50.000,
                    unit: 'Hz',
                    thresholds: { yellow: '±100mHz', red: '±200mHz' },
                    message: blackoutData?.message ?? 'Normalbetrieb',
                    source: blackoutData?.source ?? 'Offline',
                    sourceUrl: blackoutData?.sourceUrl ?? 'https://gridradar.net/de/netzfrequenz',
                },
                traffic: {
                    level: trafficLevel,
                    value: trafficData?.status ?? 1,
                    unit: 'Status',
                    message: trafficData?.message ?? 'Unbekannt',
                    source: trafficData?.source ?? 'Offline',
                    sourceUrl: trafficData?.sourceUrl ?? 'https://www.google.com/maps/@48.2092,16.4050,15z/data=!5m1!1e1',
                    extraLinks: trafficData?.extraLinks ?? []
                },
                snow: {
                    level: snowLevel,
                    value: Math.round((snowData?.value ?? 0) * 100), // Convert to cm for UI
                    unit: 'cm',
                    thresholds: { yellow: THRESHOLDS.snow.yellow * 100, red: THRESHOLDS.snow.red * 100 },
                    condition: snowLevel === 'red' ? 'Schneechaos / Räumpflicht!' : (snowLevel === 'yellow' ? 'Schneefall / Räumung empfohlen' : 'Kein relevanter Schnee'),
                    source: snowData?.source ?? 'Offline',
                    sourceUrl: snowData?.sourceUrl ?? 'https://www.geosphere.at/',
                },
                ice: {
                    level: iceLevel,
                    value: iceMessage,
                    unit: '',
                    thresholds: { yellow: 'Risk', red: 'Gefahr' },
                    source: 'GeoSphere Rohdaten-Analyse',
                    sourceUrl: 'https://www.geosphere.at/',
                },
                uwz: {
                    level: uwzLevel,
                    value: severityRank[uwzData?.wien.level] > severityRank[uwzData?.leopoldstadt.level] ? uwzData.wien.text : (uwzData?.leopoldstadt.text ?? 'Keine Warnung'),
                    district: uwzData?.leopoldstadt.text ?? 'Keine Warnung',
                    city: uwzData?.wien.text ?? 'Keine Warnung',
                    pressureHpa: weather?.pressureHpa ?? null,
                    pressureTrend: weather?.pressureTrend ?? '→',
                    source: uwzData?.source ?? 'Offline',
                    sourceUrl: uwzData?.sourceUrl ?? 'https://uwz.at/'
                },
                thunderstorm: {
                    level: thunderLevel,
                    value: thunderData?.message ?? 'Keine Zellen',
                    intensity: thunderData?.intensity ?? 0,
                    source: thunderData?.source ?? 'ZAMG',
                    sourceUrl: thunderData?.sourceUrl ?? 'https://warnungen.zamg.at/wsapp/de/gewitter/heute/',
                    extraLinks: thunderData?.extraLinks ?? []
                }
            },
            error: errors.length > 0 ? errors.join('; ') : null,
        };
    } catch (err) {
        console.error('Fetch failed:', err.message);
        return {
            fetchedAt: timestamp,
            overall: 'unknown',
            error: err.message,
            hazards: {},
        };
    }
}

// ── CLI entry point (for GitHub Actions) ─────────────────────────────────────
const isDirectRun = process.argv[1]?.endsWith('fetchData.js');
if (isDirectRun) {
    const status = await fetchAlertData();
    mkdirSync('public', { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(status, null, 2), 'utf-8');
    console.log(`[${status.fetchedAt}] ${OUTPUT_PATH} written → overall: ${status.overall}`);
}
