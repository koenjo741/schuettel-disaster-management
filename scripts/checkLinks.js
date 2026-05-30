import { fetchAlertData } from '../fetchData.js';

async function checkUrl(name, url) {
    if (!url) return { name, status: 'SKIPPED', ok: true };
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

        console.log(`Checking: ${name}...`);
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (res.ok) {
            console.log(`✅ OK: ${name} (${url})`);
            return { name, url, status: res.status, ok: true };
        } else {
            console.error(`❌ FAILED: ${name} (${url}) -> Status: ${res.status}`);
            return { name, url, status: res.status, ok: false };
        }
    } catch (err) {
        console.error(`❌ ERROR: ${name} (${url}) -> ${err.message}`);
        return { name, url, status: 'ERROR', ok: false, error: err.message };
    }
}

async function runHealthCheck() {
    console.log('--- Link Guardian: Health Check Starting (Sequential) ---');
    const data = await fetchAlertData();
    const hazards = data.hazards || {};

    const results = [];

    // Check all sourceUrls and extraLinks
    for (const [key, hazard] of Object.entries(hazards)) {
        if (hazard.sourceUrl) {
            results.push(await checkUrl(`Source link: ${key}`, hazard.sourceUrl));
        }
        if (hazard.extraLinks?.length) {
            for (const link of hazard.extraLinks) {
                if (link.url && link.url.includes('iqair.com')) {
                    console.log(`Skipping automated check for IQAir link (rate limits on GitHub runners): ${link.name}`);
                    continue;
                }
                results.push(await checkUrl(`Extra link: ${key} -> ${link.name}`, link.url));
            }
        }
    }

    // Static API endpoints check
    const apiEndpoints = [
        { name: 'GeoSphere API', url: 'https://dataset.api.hub.geosphere.at/v1/timeseries/historical/inca-v1-1h-1km/metadata' },
        { name: 'DanubeAlert Pegel', url: 'https://danubealert.com/at/history/schwedenbrucke' },
        { name: 'Strahlenschutz IMIS', url: 'https://mb.strahlenschutz.gv.at/station/AT2002' },
        { name: 'Wien Luftgüte', url: 'https://www.wien.gv.at/ma22-lgb/tb/tb-aktuell.htm' },
        { name: 'AT-Alert API', url: 'https://warnungen.at-alert.at/api/filteredAlerts' },
        { name: 'WHO Pandemic News', url: 'https://www.who.int/api/news/diseaseoutbreaknews?$top=15' },
        { name: 'MedUni Wien SVG', url: 'https://viro.meduniwien.ac.at/fileadmin/content/OE/virologie/dokumente/Virus_Epidemiogie/RespiratorischeViren/ATKarte.svg' },
        { name: 'EFFIS Current Situation (Copernicus)', url: 'https://forest-fire.emergency.copernicus.eu/apps/effis.csv/?c=1000000,6200000&z=5&t=sentinel2' },
        { name: 'NOAA Space Weather API', url: 'https://services.swpc.noaa.gov/products/noaa-scales.json' },
        { name: 'Wiener Netze Status (Power)', url: 'https://www.wienernetze.at/stromversorgung' },
        { name: 'GeoSphere SNOWGRID API', url: 'https://dataset.api.hub.geosphere.at/v1/timeseries/historical/snowgrid_cl-v2-1d-1km/metadata' },
        { name: 'UWZ (A-Gesamt)', url: 'https://uwz.at/' },
        { name: 'UWZ (Wien-Detail)', url: 'https://uwz.at/de/s/wien' },
        { name: 'GeoSphere Thunderstorm API', url: 'https://warnungen.zamg.at/wsapp/api/getGewitterAuto' }
    ];

    for (const endpoint of apiEndpoints) {
        results.push(await checkUrl(`API Endpoint: ${endpoint.name}`, endpoint.url));
    }

    const failed = results.filter(r => !r.ok);

    console.log('\n--- Summary ---');
    console.log(`Total Checks: ${results.length}`);
    console.log(`Success: ${results.length - failed.length}`);
    console.log(`Failed: ${failed.length}`);

    // If --json flag is passed, write structured results to a file
    const jsonIndex = process.argv.indexOf('--json');
    if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
        const fs = await import('fs');
        const outputPath = process.argv[jsonIndex + 1];
        const report = {
            timestamp: new Date().toISOString(),
            total: results.length,
            success: results.length - failed.length,
            failedCount: failed.length,
            failed: failed.map(f => ({ name: f.name, url: f.url, status: f.status, error: f.error || null })),
            all: results
        };
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
        console.log(`\n📄 Structured JSON report written to: ${outputPath}`);
    }

    if (failed.length > 0) {
        console.error('\n⚠️ BROKEN LINKS DETECTED. Action required.');
        process.exit(1);
    } else {
        console.log('\n🌟 All links are healthy.');
        process.exit(0);
    }
}

runHealthCheck();
