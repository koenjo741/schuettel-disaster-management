import { readFileSync, writeFileSync } from 'fs';
import { appendFileSync } from 'fs';

const HAZARD_NAMES_DE = {
    heat: 'Hitze / UV-Index',
    wind: 'Wind / Sturm',
    rain: 'Starkregen',
    flood: 'Hochwasser',
    radiation: 'Strahlung / Radioaktivität',
    airQuality: 'Luftqualität',
    earthquake: 'Erdbeben',
    atAlert: 'AT-Alert (Katastrophenwarnung)',
    pandemic: 'Pandemie / Seuchengefahr',
    fire: 'Waldbrandgefahr',
    space: 'Weltraumwetter / Sonnensturm',
    power: 'Stromausfall',
    gas: 'Gasausfall',
    water: 'Wasserversorgung',
    blackout: 'Netzfrequenz (Blackout-Gefahr)',
    traffic: 'Verkehrsbehinderung',
    snow: 'Schneefall / Schneelast',
    ice: 'Glatteis',
    uwz: 'Unwetterzentrale (UWZ)',
    thunderstorm: 'Gewitterwarnung'
};

const SEVERITY_LEVELS = {
    green: 0,
    yellow: 1,
    red: 2
};

function getEmoji(level) {
    if (level === 'red') return '🚨';
    if (level === 'yellow') return '⚠️';
    return '✅';
}

function getLevelText(level) {
    if (level === 'red') return 'KRITISCH (ROT)';
    if (level === 'yellow') return 'WARNUNG (GELB)';
    return 'Entwarnung (Grün)';
}

async function main() {
    console.log('--- Check Alerts script starting ---');
    let oldData = { hazards: {} };
    let newData = { hazards: {} };

    try {
        oldData = JSON.parse(readFileSync('public/alert_status_old.json', 'utf8'));
    } catch (e) {
        console.log('No old alert_status_old.json found, starting fresh.');
    }

    try {
        newData = JSON.parse(readFileSync('public/alert_status.json', 'utf8'));
    } catch (e) {
        console.error('CRITICAL: New alert_status.json could not be read!', e.message);
        process.exit(1);
    }

    const newWarnings = [];

    for (const [key, newHazard] of Object.entries(newData.hazards || {})) {
        const oldHazard = oldData.hazards?.[key] || { level: 'green' };
        
        const oldSeverity = SEVERITY_LEVELS[oldHazard.level] ?? 0;
        const newSeverity = SEVERITY_LEVELS[newHazard.level] ?? 0;

        // Trigger on any INCREASE in severity level
        if (newSeverity > oldSeverity) {
            newWarnings.push({
                key,
                name: HAZARD_NAMES_DE[key] || key,
                oldLevel: oldHazard.level,
                newLevel: newHazard.level,
                detail: newHazard
            });
        }
    }

    if (newWarnings.length === 0) {
        console.log('No new or escalated warnings detected.');
        if (process.env.GITHUB_OUTPUT) {
            appendFileSync(process.env.GITHUB_OUTPUT, 'send_email=false\n');
        }
        process.exit(0);
    }

    console.log(`Detected ${newWarnings.length} new/escalated warning(s)!`);

    // Prepare email content
    const dateStr = new Date(newData.fetchedAt || new Date()).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
    
    // Subject line lists the new alerts
    const alertSummaries = newWarnings.map(w => `${w.name} (${w.newLevel.toUpperCase()})`).join(', ');
    const subject = `⚠️ NEUE WARNUNG: ${alertSummaries}`;

    let emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
        <div style="background: linear-gradient(135deg, #e53e3e 0%, #b7791f 100%); padding: 24px; text-align: center; color: white;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">🚨 Neue Katastrophenwarnung</h1>
            <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">Schüttelstraße 79 & 81, 1020 Wien</p>
            <p style="margin: 4px 0 0 0; opacity: 0.8; font-size: 12px; font-style: italic;">Stand: ${dateStr} (Lokalzeit)</p>
        </div>
        <div style="padding: 24px; background-color: #4B0090;">
            <p style="font-size: 16px; line-height: 1.5; color: #ADEEC5; margin-top: 0;">
                Hallo Josef,<br/><br/>
                es wurden neue oder eskalierte Warnungen für deinen Standort in der Schüttelstraße festgestellt:
            </p>
            
            <hr style="border: 0; border-top: 1px solid rgba(173, 238, 197, 0.3); margin: 20px 0;"/>
    `;

    for (const w of newWarnings) {
        const valueStr = w.detail.value !== undefined ? `${w.detail.value} ${w.detail.unit || ''}`.trim() : '';
        const descStr = w.detail.message || w.detail.description || w.detail.condition || '';
        
        const headingLink = w.detail.sourceUrl 
            ? `<a href="${w.detail.sourceUrl}" style="color: inherit; text-decoration: underline;">${w.name} &mdash; ${getLevelText(w.newLevel)}</a>`
            : `${w.name} &mdash; ${getLevelText(w.newLevel)}`;

        emailHtml += `
            <div style="background-color: ${w.newLevel === 'red' ? '#fff5f5' : '#fffaf0'}; border-left: 4px solid ${w.newLevel === 'red' ? '#e53e3e' : '#dd6b20'}; padding: 16px; border-radius: 4px; margin-bottom: 20px;">
                <h3 style="margin: 0 0 8px 0; font-size: 18px; color: ${w.newLevel === 'red' ? '#c53030' : '#dd6b20'}; display: block;">
                    ${getEmoji(w.newLevel)} ${headingLink}
                </h3>
                <p style="margin: 0 0 6px 0; font-size: 14px; color: #4a5568;">
                    <strong>Status/Wert:</strong> <code style="background-color: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 3px; font-size: 13px;">${valueStr || descStr || 'Aktiv'}</code>
                </p>
                ${descStr && valueStr ? `<p style="margin: 0 0 6px 0; font-size: 14px; color: #4a5568;"><strong>Details:</strong> ${descStr}</p>` : ''}
                <p style="margin: 8px 0 0 0; font-size: 12px; color: #718096; font-style: italic;">
                    Quelle: ${w.detail.source || 'Automatische Messstation'}
                </p>
            </div>
        `;
    }

    emailHtml += `
            <hr style="border: 0; border-top: 1px solid rgba(173, 238, 197, 0.3); margin: 20px 0;"/>
            
            <div style="text-align: center; margin: 24px 0;">
                <a href="https://schuetteldm.netlify.app/" style="background-color: #2b6cb0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    Zum Live-Dashboard &rarr;
                </a>
            </div>
            
            <p style="font-size: 12px; color: rgba(173, 238, 197, 0.7); text-align: center; margin-bottom: 0;">
                Diese E-Mail wurde automatisch von deinem Schüttelstraße Disaster Guardian generiert.<br/>
                Host: github-actions[bot] | Repository: schuettel-disaster-management
            </p>
        </div>
    </div>
    `;

    writeFileSync('email_alert.html', emailHtml, 'utf8');
    console.log('Generated email_alert.html successfully.');

    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, 'send_email=true\n');
        // Escape subject line for GITHUB_OUTPUT to support special chars and quotes safely
        appendFileSync(process.env.GITHUB_OUTPUT, `subject=${subject}\n`);
    }
}

main().catch(err => {
    console.error('Fatal error in checkAlerts:', err);
    process.exit(1);
});
