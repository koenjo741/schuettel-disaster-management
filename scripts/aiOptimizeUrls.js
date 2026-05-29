import fs from 'fs';
import path from 'path';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
    console.error('❌ Error: GITHUB_TOKEN environment variable is not set.');
    process.exit(1);
}

// Target hazards URLs list extracted from checkLinks.js and fetchData.js
const currentUrls = [
    { name: 'GeoSphere API (WeatherData)', url: 'https://dataset.api.hub.geosphere.at/v1/timeseries/historical/inca-v1-1h-1km/metadata' },
    { name: 'DanubeAlert Pegel (Flood)', url: 'https://danubealert.com/at/history/schwedenbrucke' },
    { name: 'Strahlenschutz IMIS (Radiation)', url: 'https://mb.strahlenschutz.gv.at/station/AT2002' },
    { name: 'Wien Luftgüte (Air Quality)', url: 'https://www.wien.gv.at/ma22-lgb/tb/tb-aktuell.htm' },
    { name: 'AT-Alert API', url: 'https://warnungen.at-alert.at/api/filteredAlerts' },
    { name: 'WHO Pandemic News', url: 'https://www.who.int/api/news/diseaseoutbreaknews?$top=15' },
    { name: 'MedUni Wien SVG (Influenza)', url: 'https://viro.meduniwien.ac.at/fileadmin/content/OE/virologie/dokumente/Virus_Epidemiogie/RespiratorischeViren/ATKarte.svg' },
    { name: 'EFFIS Current Situation (Copernicus / Forest-Fire)', url: 'https://forest-fire.emergency.copernicus.eu/apps/effis.csv/?c=1000000,6200000&z=5&t=sentinel2' },
    { name: 'Waldbrand-Datenbank (BOKU)', url: 'https://waldbrand.at/' },
    { name: 'NOAA Space Weather API', url: 'https://services.swpc.noaa.gov/products/noaa-scales.json' },
    { name: 'Wiener Netze Status (Power/Strom)', url: 'https://www.wienernetze.at/stromversorgung' },
    { name: 'GeoSphere SNOWGRID API (Snow)', url: 'https://dataset.api.hub.geosphere.at/v1/timeseries/historical/snowgrid_cl-v2-1d-1km?metadata=true' },
    { name: 'UWZ Unwetterzentrale (Severe Weather)', url: 'https://uwz.at/' },
    { name: 'GeoSphere Thunderstorm API (Gewitter)', url: 'https://warnungen.zamg.at/wsapp/api/getGewitterAuto' }
];

async function runOptimizationCheck() {
    console.log('🤖 AI URL Optimizer: Starting comparison with active Austrian/European resources...');

    const prompt = `You are a Senior Site Reliability Engineer and Disaster Mitigation Specialist for Vienna, Austria.
We run a local dashboard monitoring hazard levels for the area "Schüttelstraße 79 & 81, 1020 Wien".
Below is the list of our currently monitored URL endpoints, public maps, and APIs.

Your Task:
Analyze each URL. Research if there are:
1. Better, more stable official APIs or open-data endpoints for Vienna/Austria/Europe.
2. If any of our formats are legacy (e.g. ZAMG rebranded to GeoSphere Austria, is the endpoint optimal?).
3. Better European-level alternatives (e.g. Copernicus, EFAS, EURDEP) that fit Austrian local alerting.

Current Monitored Endpoints:
${JSON.stringify(currentUrls, null, 2)}

Output Requirements:
- Respond in German.
- Give a concise evaluation for each category (Wetter, Hochwasser, Strahlung, Luftgüte, AT-Alert, Infektionen, Waldbrand, Weltraumwetter, Stromausfall, Schnee, Unwetter, Gewitter).
- Highlight ONLY actual improvements or things to watch (e.g. planned api deprecations). If the current URL is optimal, state "Optimal".
- Output directly as HTML format suitable for an email body. Do not include markdown wraps like \`\`\`html or conversational filler.`;

    try {
        const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GITHUB_TOKEN}`
            },
            body: JSON.stringify({
                messages: [
                    { role: 'user', content: prompt }
                ],
                model: 'gpt-4o',
                temperature: 0.2
            })
        });

        if (!response.ok) {
            throw new Error(`GitHub Models API returned status ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const htmlReport = data.choices?.[0]?.message?.content || '<p>Keine Analyse empfangen.</p>';

        fs.writeFileSync('optimization_report.html', htmlReport, 'utf8');
        console.log('✅ AI Optimization report successfully written to: optimization_report.html');
    } catch (err) {
        console.error('❌ AI URL Optimizer failed:', err.message);
        process.exit(1);
    }
}

runOptimizationCheck();
