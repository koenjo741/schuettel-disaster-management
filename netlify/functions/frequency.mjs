/**
 * Netlify Function – Live Netzfrequenz-Proxy
 * Ruft dat.netzfrequenzmessung.de direkt ab und gibt nur den Hz-Wert + Level zurück.
 * Wird alle 5 Sekunden vom Client für die Echtzeit-Anzeige gepollt.
 */

export default async () => {
    try {
        const res = await fetch('https://dat.netzfrequenzmessung.de:9080/frequenz.xml', {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        if (!res.ok) throw new Error(`Upstream error: ${res.status}`);

        const text = await res.text();
        const match = text.match(/<f>([^<]+)<\/f>/);
        if (!match) throw new Error('Invalid frequency data format');

        const hz = parseFloat(match[1]);
        if (isNaN(hz)) throw new Error('Invalid frequency value');

        let level = 'green';
        if (hz < 49.80 || hz > 50.20) level = 'red';
        else if (hz < 49.90 || hz > 50.10) level = 'yellow';

        return new Response(JSON.stringify({ hz, level }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
};
