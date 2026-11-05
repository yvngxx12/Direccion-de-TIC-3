// Utilidades para los tests: un fetch falso que responde según la URL,
// y registra las llamadas para poder verificarlas.

function crearFetchFalso(rutas) {
    const llamadas = [];
    async function fetchFalso(url, init = {}) {
        const u = new URL(url);
        llamadas.push({ url: u, init });
        for (const [patron, manejador] of rutas) {
            if (patron.test(u.href)) {
                const r = await manejador(u, init, llamadas.length);
                if (r instanceof Error) throw r;
                const { estado = 200, cuerpo = {} } = r;
                return new Response(JSON.stringify(cuerpo), {
                    status: estado,
                    headers: { "Content-Type": "application/json" }
                });
            }
        }
        return new Response(JSON.stringify({ error: { message: "ruta no simulada" } }), { status: 404 });
    }
    fetchFalso.llamadas = llamadas;
    return fetchFalso;
}

// Respuesta típica de videos.list para un directo.
function videoYouTube({ id = "abcdefghijk", viewers = "1234", estado = "live", fin = null, titulo = "Directo de prueba" } = {}) {
    const detalles = { actualStartTime: "2026-11-05T12:00:00Z" };
    if (viewers !== null) detalles.concurrentViewers = viewers;
    if (fin) detalles.actualEndTime = fin;
    return {
        kind: "youtube#videoListResponse",
        items: [{
            id,
            snippet: { title: titulo, channelTitle: "Canal TIC", liveBroadcastContent: estado },
            liveStreamingDetails: detalles
        }]
    };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarHasta(condicion, { timeoutMs = 3000, cadaMs = 20 } = {}) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
        if (await condicion()) return true;
        await esperar(cadaMs);
    }
    throw new Error("Se agotó el tiempo esperando la condición.");
}

module.exports = { crearFetchFalso, videoYouTube, esperar, esperarHasta };
