async function testFetch() {
    const url = 'https://www.wienerlinien.at/ogd_realtime/trafficInfoList';
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        console.log('Status:', res.status);
        if (res.ok) {
            const json = await res.json();
            const relevant = json.data.trafficInfos.filter(info => {
                const text = JSON.stringify(info);
                return text.includes('80A') || text.includes('Schüttelstraße') || text.includes('Stadionbrücke');
            });
            console.log('Relevant DisruptionsCount:', relevant.length);
            relevant.forEach(info => {
                console.log('---');
                console.log('Title:', info.title);
                console.log('Description:', info.description);
                console.log('Lines:', info.relatedLines);
            });
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

testFetch();
