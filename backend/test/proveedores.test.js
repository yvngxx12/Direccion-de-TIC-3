const test = require("node:test");
const assert = require("node:assert/strict");
const { crearFetchFalso, videoYouTube } = require("./helpers");
const { YouTubeProvider } = require("../src/providers/YouTubeProvider");
const { TwitchProvider } = require("../src/providers/TwitchProvider");
const { SimuladorProvider } = require("../src/providers/SimuladorProvider");
const { crearProveedor } = require("../src/providers");

const VIDEO = { tipo: "video", id: "abcdefghijk" };

// ---------------------------------------------------------------- YouTube

test("YouTube: lee concurrentViewers de un directo", async () => {
    const fetch = crearFetchFalso([[/\/videos\?/, () => ({ cuerpo: videoYouTube({ viewers: "4321" }) })]]);
    const p = new YouTubeProvider(VIDEO, { apiKey: "CLAVE", fetch });
    const r = await p.conectar();
    assert.equal(r.viewers, 4321);
    assert.equal(r.enVivo, true);
    assert.equal(r.canal, "Canal TIC");
    const url = fetch.llamadas[0].url;
    assert.equal(url.searchParams.get("id"), "abcdefghijk");
    assert.equal(url.searchParams.get("key"), "CLAVE");
    assert.match(url.searchParams.get("part"), /liveStreamingDetails/);
});

test("YouTube: sin API key da un error no reintentable", async () => {
    const p = new YouTubeProvider(VIDEO, { apiKey: "", fetch: crearFetchFalso([]) });
    await assert.rejects(p.conectar(), (e) => e.codigo === "AUTH" && e.reintentable === false);
});

test("YouTube: API key inválida y cuota agotada se distinguen", async () => {
    const claveMala = crearFetchFalso([[/videos/, () => ({
        estado: 400,
        cuerpo: { error: { message: "API key not valid. Please pass a valid API key.", errors: [{ reason: "badRequest" }] } }
    })]]);
    await assert.rejects(new YouTubeProvider(VIDEO, { apiKey: "x", fetch: claveMala }).leer(), (e) => e.codigo === "AUTH" && !e.reintentable);

    const sinCuota = crearFetchFalso([[/videos/, () => ({
        estado: 403,
        cuerpo: { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }
    })]]);
    await assert.rejects(new YouTubeProvider(VIDEO, { apiKey: "x", fetch: sinCuota }).leer(), (e) => e.codigo === "CUOTA" && e.reintentable);
});

test("YouTube: directo terminado, programado u oculto", async () => {
    const casos = [
        [videoYouTube({ estado: "none", fin: "2026-11-05T13:00:00Z" }), false, /terminó/],
        [videoYouTube({ estado: "upcoming", viewers: null }), false, /todavía no empezó/],
        [videoYouTube({ viewers: null }), true, /oculta/]
    ];
    for (const [cuerpo, enVivo, aviso] of casos) {
        const p = new YouTubeProvider(VIDEO, { apiKey: "x", fetch: crearFetchFalso([[/videos/, () => ({ cuerpo })]]) });
        const r = await p.leer();
        assert.equal(r.viewers, null);
        assert.equal(r.enVivo, enVivo);
        assert.match(r.aviso, aviso);
    }
});

test("YouTube: video inexistente es un error definitivo", async () => {
    const p = new YouTubeProvider(VIDEO, { apiKey: "x", fetch: crearFetchFalso([[/videos/, () => ({ cuerpo: { items: [] } })]]) });
    await assert.rejects(p.leer(), (e) => e.codigo === "NO_ENCONTRADO" && !e.reintentable);
});

test("YouTube: @handle -> canal -> directo activo", async () => {
    const fetch = crearFetchFalso([
        [/\/channels\?/, () => ({ cuerpo: { items: [{ id: "UC1234567890123456789012", snippet: { title: "Ministerio" } }] } })],
        [/\/search\?/, () => ({ cuerpo: { items: [{ id: { videoId: "VIDEO_DEL_D" } }] } })],
        [/\/videos\?/, () => ({ cuerpo: videoYouTube({ id: "VIDEO_DEL_D", viewers: "77" }) })]
    ]);
    const p = new YouTubeProvider({ tipo: "handle", id: "@Ministerio" }, { apiKey: "x", fetch });
    const r = await p.conectar();
    assert.equal(r.viewers, 77);
    assert.equal(fetch.llamadas[0].url.searchParams.get("forHandle"), "@Ministerio");
    assert.equal(fetch.llamadas[1].url.searchParams.get("eventType"), "live");
    assert.equal(fetch.llamadas[1].url.searchParams.get("channelId"), "UC1234567890123456789012");
    assert.equal(fetch.llamadas[2].url.searchParams.get("id"), "VIDEO_DEL_D");
});

test("YouTube: canal sin directo no gasta cuota de búsqueda en cada lectura", async () => {
    let ahora = 0;
    const fetch = crearFetchFalso([[/\/search\?/, () => ({ cuerpo: { items: [] } })]]);
    const p = new YouTubeProvider({ tipo: "canal", id: "UC1234567890123456789012" }, { apiKey: "x", fetch, ahora: () => ahora });
    const r = await p.conectar();
    assert.equal(r.enVivo, false);
    await p.leer();
    await p.leer();
    assert.equal(fetch.llamadas.length, 1, "no debería volver a buscar antes de 5 minutos");
    ahora += 5 * 60 * 1000;
    await p.leer();
    assert.equal(fetch.llamadas.length, 2);
});

test("YouTube: timeout y caída de red son reintentables", async () => {
    const caida = crearFetchFalso([[/videos/, () => new TypeError("fetch failed")]]);
    await assert.rejects(new YouTubeProvider(VIDEO, { apiKey: "x", fetch: caida }).leer(), (e) => e.codigo === "RED" && e.reintentable);

    const lento = (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
    const p = new YouTubeProvider(VIDEO, { apiKey: "x", fetch: lento, timeoutMs: 50 });
    await assert.rejects(p.leer(), (e) => e.codigo === "TIMEOUT" && e.reintentable);
});

// ---------------------------------------------------------------- Twitch

function fetchTwitch({ enVivo = true, viewers = 950, tokenFalla = false, expirarPrimerToken = false } = {}) {
    let tokens = 0;
    let rechazado = false;
    return crearFetchFalso([
        [/id\.twitch\.tv\/oauth2\/token/, () => {
            tokens++;
            return tokenFalla ? { estado: 403, cuerpo: { message: "invalid client" } } : { cuerpo: { access_token: `tok${tokens}`, expires_in: 5000 } };
        }],
        [/helix\/users/, () => ({ cuerpo: { data: [{ id: "1", login: "canal", display_name: "Canal" }] } })],
        [/helix\/streams/, (u, init) => {
            if (expirarPrimerToken && !rechazado && init.headers.Authorization === "Bearer tok1") {
                rechazado = true;
                return { estado: 401, cuerpo: { message: "Invalid OAuth token" } };
            }
            return { cuerpo: { data: enVivo ? [{ type: "live", viewer_count: viewers, title: "Jugando", user_name: "Canal" }] : [] } };
        }]
    ]);
}

test("Twitch: obtiene token y lee viewer_count", async () => {
    const fetch = fetchTwitch({ viewers: 950 });
    const p = new TwitchProvider({ tipo: "canal", id: "canal" }, { clientId: "id", clientSecret: "secreto", fetch });
    const r = await p.conectar();
    assert.equal(r.viewers, 950);
    assert.equal(r.titulo, "Jugando");
    const streams = fetch.llamadas.find((l) => l.url.pathname.includes("streams"));
    assert.equal(streams.init.headers["Client-Id"], "id");
    assert.equal(streams.init.headers.Authorization, "Bearer tok1");
});

test("Twitch: canal offline", async () => {
    const p = new TwitchProvider({ tipo: "canal", id: "canal" }, { clientId: "id", clientSecret: "s", fetch: fetchTwitch({ enVivo: false }) });
    const r = await p.conectar();
    assert.equal(r.enVivo, false);
    assert.equal(r.viewers, null);
});

test("Twitch: renueva el token si vence (401)", async () => {
    const fetch = fetchTwitch({ expirarPrimerToken: true });
    const p = new TwitchProvider({ tipo: "canal", id: "canal" }, { clientId: "id", clientSecret: "s", fetch });
    const r = await p.leer();
    assert.equal(r.viewers, 950);
    assert.equal(fetch.llamadas.filter((l) => l.url.hostname === "id.twitch.tv").length, 2);
});

test("Twitch: credenciales faltantes o rechazadas", async () => {
    await assert.rejects(new TwitchProvider({ tipo: "canal", id: "c" }, { fetch: fetchTwitch() }).conectar(), (e) => e.codigo === "AUTH");
    const p = new TwitchProvider({ tipo: "canal", id: "c" }, { clientId: "a", clientSecret: "b", fetch: fetchTwitch({ tokenFalla: true }) });
    await assert.rejects(p.conectar(), (e) => e.codigo === "AUTH" && !e.reintentable);
});

// ---------------------------------------------------------------- Simulador

test("Simulador: cada escenario produce valores válidos", async () => {
    for (const escenario of ["estable", "subida", "bajada", "pico", "ola", "caos"]) {
        let semilla = 1;
        const aleatorio = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647);
        const s = new SimuladorProvider({ escenario, aleatorio });
        for (let i = 0; i < 50; i++) {
            const r = await s.leer();
            assert.ok(Number.isInteger(r.viewers) && r.viewers >= 0, `${escenario} paso ${i}: ${r.viewers}`);
        }
    }
});

test("Simulador: subida sube, bajada baja, pico salta", async () => {
    const fijo = () => 0.5; // sin ruido
    const sube = new SimuladorProvider({ escenario: "subida", aleatorio: fijo });
    const a = (await sube.leer()).viewers;
    for (let i = 0; i < 10; i++) await sube.leer();
    assert.ok((await sube.leer()).viewers > a * 1.4);

    const baja = new SimuladorProvider({ escenario: "bajada", aleatorio: fijo });
    for (let i = 0; i < 10; i++) await baja.leer();
    assert.ok((await baja.leer()).viewers < 200);

    const pico = new SimuladorProvider({ escenario: "pico", aleatorio: fijo, viewersIniciales: 100 });
    const valores = [];
    for (let i = 0; i < 12; i++) valores.push((await pico.leer()).viewers);
    assert.equal(valores[9], 300); // paso 10: x3
});

test("Simulador: valor fijo manual y modo offline", async () => {
    const s = new SimuladorProvider();
    s.fijar(1234);
    assert.equal((await s.leer()).viewers, 1234);
    assert.equal((await s.leer()).viewers, 1234);
    s.ponerOffline(true);
    assert.equal((await s.leer()).enVivo, false);
    assert.throws(() => s.cambiarEscenario("inexistente"), /Escenario desconocido/);
});

test("crearProveedor elige la clase según el link", () => {
    const cred = { youtubeApiKey: "k", twitchClientId: "i", twitchClientSecret: "s" };
    assert.equal(crearProveedor("https://youtu.be/abcdefghijk", { credenciales: cred }).plataforma, "youtube");
    assert.equal(crearProveedor("https://twitch.tv/canal", { credenciales: cred }).plataforma, "twitch");
    assert.equal(crearProveedor("simulador", { escenario: "pico" }).escenario, "pico");
});
