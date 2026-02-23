/**
 * Netlify Function – Live data refresh endpoint
 * Calls the shared fetchAlertData() logic and returns fresh JSON.
 */

import { fetchAlertData } from '../../fetchData.js';

export default async () => {
    try {
        const data = await fetchAlertData();

        return new Response(JSON.stringify(data), {
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
            headers: { 'Content-Type': 'application/json' },
        });
    }
};
