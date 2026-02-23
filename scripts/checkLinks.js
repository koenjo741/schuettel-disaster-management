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
            return { name, status: res.status, ok: true };
        } else {
            console.error(`❌ FAILED: ${name} (${url}) -> Status: ${res.status}`);
            return { name, status: res.status, ok: false };
        }
    } catch (err) {
        console.error(`❌ ERROR: ${name} (${url}) -> ${err.message}`);
        return { name, status: 'ERROR', ok: false, error: err.message };
    }
}

async function runHealthCheck() {
    console.log('--- Link Guardian: Health Check Starting (Sequential) ---');
    const data = await fetchAlertData();
    const hazards = data.hazards || {};

    const results = [];

    // Check all sourceUrls sequentially
    for (const [key, hazard] of Object.entries(hazards)) {
        if (hazard.sourceUrl) {
            results.push(await checkUrl(`Source link: ${key}`, hazard.sourceUrl));
        }
    }

    // Static API endpoints check
    const apiEndpoints = [
        { name: 'GeoSphere API', url: 'https://dataset.api.hub.geosphere.at/v1/timeseries/historical/inca-v1-1h-1km' },
        { name: 'DanubeAlert Pegel', url: 'https://danubealert.com/at/history/schwedenbrucke' },
        { name: 'Strahlenschutz IMIS', url: 'https://mb.strahlenschutz.gv.at/station/AT2002' },
        { name: 'Wien Luftgüte', url: 'https://www.wien.gv.at/ma22-lgb/tb/tb-aktuell.htm' },
        { name: 'AT-Alert API', url: 'https://warnungen.at-alert.at/api/filteredAlerts' },
        { name: 'WHO Pandemic News', url: 'https://www.who.int/api/news/diseaseoutbreaknews' },
        { name: 'MedUni Wien SVG', url: 'https://viro.meduniwien.ac.at/fileadmin/content/OE/virologie/dokumente/Virus_Epidemiogie/RespiratorischeViren/ATKarte.svg' }
    ];

    for (const endpoint of apiEndpoints) {
        results.push(await checkUrl(`API Endpoint: ${endpoint.name}`, endpoint.url));
    }

    const failed = results.filter(r => !r.ok);

    console.log('\n--- Summary ---');
    console.log(`Total Checks: ${results.length}`);
    console.log(`Success: ${results.length - failed.length}`);
    console.log(`Failed: ${failed.length}`);

    if (failed.length > 0) {
        console.error('\n⚠️ BROKEN LINKS DETECTED. Action required.');
        process.exit(1);
    } else {
        console.log('\n🌟 All links are healthy.');
        process.exit(0);
    }
}

runHealthCheck();
