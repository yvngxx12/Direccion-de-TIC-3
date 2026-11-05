// Prueba de punta a punta: backend real + emulador de la placa + API de YouTube simulada.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { crearApp } = require("../src/app");
const { crearConfig } = require("../src/config");
const { crearEmulador } = require("../tools/emulador-esp");
const { crearFetchFalso, videoYouTube, esperarHasta } = require("./helpers");

async function levantar(t, { fetchApis, archivoAjustes = null } = {}) {
    const emu = crearEmulador({ silencioso: true });
    await new Promise((r) => emu.server.listen(0, "127.0.0.1", r));
    const ipPlaca = `127.0.0.1:${emu.server.address().port}`;

    const config = crearConfig({});
    config.credenciales.youtubeApiKey = "CLAVE_TEST";
    config.monitor.intervaloMs = 2000;
    config.monitor.intervaloSimuladorMs = 50;
    config.hardware.latidoMs = 0;

    // Las llamadas a la placa usan el fetch real; las de YouTube, el falso.
    const fetchMixto = (url, init) =>
        String(url).includes("googleapis.com") || String(url).includes("twitch.tv") ? fetchApis(url, init) : fetch(url, init);

    const sistema = crearApp(config, { fetch: fetchMixto, silencioso: true, archivoAjustes });
    await new Promise((r) => sistema.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${sistema.server.address().port}`;

    t.after(async () => {
        await sistema.cerrar();
        await new Promise((r) => emu.server.close(r));
    });

    async function api(ruta, datos) {
        const r = await fetch(base + ruta, datos === undefined ? {} : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(datos)
        });
        return { estado: r.status, cuerpo: await r.json() };
    }
    return { sistema, emu, ipPlaca, api, base };
}

test("sirve el panel y el overlay", async (t) => {
    const { base } = await levantar(t, { fetchApis: crearFetchFalso([]) });
    for (const ruta of ["/", "/overlay.html", "/panel.js", "/gauge.js", "/socket.io/socket.io.js"]) {
        const r = await fetch(base + ruta);
        assert.equal(r.status, 200, ruta);
    }
});

test("flujo completo con YouTube: link -> API -> ángulo -> placa", async (t) => {
    let viewers = "250";
    const fetchApis = crearFetchFalso([[/\/videos\?/, () => ({ cuerpo: videoYouTube({ viewers }) })]]);
    const { api, emu, ipPlaca } = await levantar(t, { fetchApis });

    let r = await api("/api/hardware/conectar", { tipo: "http", ip: ipPlaca });
    assert.equal(r.estado, 200);
    assert.equal(r.cuerpo.servo.conectado, true);

    r = await api("/api/config/mapeo", { viewersMin: 0, viewersMax: 1000, suavizado: 1, zonaMuerta: 0 });
    assert.equal(r.estado, 200);

    r = await api("/api/stream/conectar", { entrada: "https://www.youtube.com/watch?v=abcdefghijk" });
    assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.monitor.estado, "en_vivo");
    assert.equal(r.cuerpo.monitor.ultimaLectura.viewers, 250);
    assert.equal(r.cuerpo.monitor.ultimaLectura.angulo, 45);
    assert.equal(emu.estado.objetivo, 45);
    assert.equal(emu.estado.viewers, 250);

    viewers = "750";
    r = await api("/api/stream/leer", {});
    assert.equal(r.cuerpo.monitor.ultimaLectura.angulo, 135);
    assert.equal(emu.estado.objetivo, 135);

    // Recalibrar mueve la aguja al instante con la nueva escala
    r = await api("/api/config/mapeo", { viewersMax: 750 });
    assert.equal(emu.estado.objetivo, 180);

    r = await api("/api/stream/detener", {});
    assert.equal(r.cuerpo.monitor.estado, "detenido");
    assert.equal(emu.estado.objetivo, 0);
});

test("errores de la API llegan al panel con mensaje claro", async (t) => {
    const fetchApis = crearFetchFalso([[/videos/, () => ({
        estado: 400,
        cuerpo: { error: { message: "API key not valid.", errors: [{ reason: "badRequest" }] } }
    })]]);
    const { api } = await levantar(t, { fetchApis });

    let r = await api("/api/stream/conectar", { entrada: "https://youtu.be/abcdefghijk" });
    assert.equal(r.estado, 400);
    assert.match(r.cuerpo.error, /YOUTUBE_API_KEY no es válida/);

    r = await api("/api/stream/conectar", { entrada: "https://vimeo.com/1" });
    assert.equal(r.estado, 400);
    assert.match(r.cuerpo.error, /no soportada/);

    r = await api("/api/config/mapeo", { anguloMax: 500 });
    assert.equal(r.estado, 400);

    r = await api("/api/hardware/probar", { angulo: 90 });
    assert.equal(r.estado, 400);
    assert.match(r.cuerpo.error, /modo calibración/);
});

test("simulador + emulador: la aguja sigue al escenario en tiempo real", async (t) => {
    const { api, emu, ipPlaca, sistema } = await levantar(t, { fetchApis: crearFetchFalso([]) });
    await api("/api/hardware/conectar", { tipo: "http", ip: ipPlaca });
    await api("/api/config/mapeo", { viewersMax: 2000, suavizado: 1, zonaMuerta: 0 });

    let r = await api("/api/simulador", { escenario: "subida" });
    assert.equal(r.estado, 200);
    assert.equal(r.cuerpo.monitor.plataforma, "simulador");

    await esperarHasta(() => sistema.monitor.estadisticas.lecturas >= 10);
    const h = sistema.monitor.historial;
    assert.ok(h.at(-1).viewers > h[0].viewers, "en 'subida' la audiencia debería crecer");
    assert.ok(emu.estado.objetivo > 0);

    // Valor fijo manual
    r = await api("/api/simulador", { viewers: 1000 });
    assert.equal(r.cuerpo.monitor.ultimaLectura.viewers, 1000);
    await esperarHasta(() => emu.estado.objetivo === 90);

    // Offline -> aguja al mínimo y estado offline
    r = await api("/api/simulador", { offline: true });
    assert.equal(r.cuerpo.monitor.estado, "offline");
    await esperarHasta(() => emu.estado.objetivo === 0 && emu.estado.enVivo === false);
});

test("si falla el cambio de fuente, la aguja baja y no queda un número viejo", async (t) => {
    const fetchApis = crearFetchFalso([[/videos/, () => ({ cuerpo: { items: [] } })]]);
    const { api, emu, ipPlaca } = await levantar(t, { fetchApis });
    await api("/api/hardware/conectar", { tipo: "http", ip: ipPlaca });
    await api("/api/simulador", { viewers: 900 });
    assert.ok(emu.estado.objetivo > 100);

    const r = await api("/api/stream/conectar", { entrada: "https://youtu.be/abcdefghijk" });
    assert.equal(r.estado, 400);
    assert.match(r.cuerpo.error, /No se encontró el video/);
    const { cuerpo } = await api("/api/estado");
    assert.equal(cuerpo.monitor.estado, "error");
    assert.equal(cuerpo.monitor.ultimaLectura, null);
    assert.equal(emu.estado.objetivo, 0);
});

test("modo calibración desde la API", async (t) => {
    const { api, emu, ipPlaca } = await levantar(t, { fetchApis: crearFetchFalso([]) });
    await api("/api/hardware/conectar", { tipo: "http", ip: ipPlaca });
    let r = await api("/api/hardware/calibracion", { activa: true });
    assert.equal(r.cuerpo.servo.calibrando, true);
    r = await api("/api/hardware/probar", { angulo: 170 });
    assert.equal(r.estado, 200);
    assert.equal(emu.estado.objetivo, 170);
    r = await api("/api/hardware/calibracion", { activa: false });
    assert.equal(r.cuerpo.servo.calibrando, false);
});

test("estilo del overlay y credenciales", async (t) => {
    const { api } = await levantar(t, { fetchApis: crearFetchFalso([]) });
    let r = await api("/api/config/estilo", { colorAcento: "#ff0000", titulo: "VIEWERS", escala: 1.5, mostrarNumero: false, inventado: 1 });
    assert.equal(r.cuerpo.estilo.colorAcento, "#ff0000");
    assert.equal(r.cuerpo.estilo.escala, 1.5);
    assert.equal(r.cuerpo.estilo.mostrarNumero, false);
    assert.equal(r.cuerpo.estilo.inventado, undefined);
    r = await api("/api/config/estilo", { escala: 10 });
    assert.equal(r.estado, 400);

    r = await api("/api/config/credenciales", { twitchClientId: "a", twitchClientSecret: "b" });
    assert.equal(r.cuerpo.credenciales.twitch, true);
    // Nunca se devuelven las claves al navegador
    assert.ok(!JSON.stringify(r.cuerpo).includes("CLAVE_TEST"));
});

test("login de Google por el panel: receptor temporal en el puerto de retorno", async (t) => {
    const fetchApis = crearFetchFalso([
        [/oauth2\.googleapis\.com\/token/, () => ({ cuerpo: { access_token: "ACC", expires_in: 3600, refresh_token: "REF" } })],
        [/mine=true/, () => ({ cuerpo: { items: [{ snippet: { title: "Canal TIC" } }] } })],
        [/\/videos\?/, (u, init) => ({ cuerpo: videoYouTube({ viewers: init.headers?.Authorization === "Bearer ACC" ? "555" : "0" }) })]
    ]);
    // Puerto libre para simular el "localhost:4000" registrado en Google.
    const libre = await new Promise((r) => {
        const s = require("net").createServer().listen(0, () => {
            const p = s.address().port;
            s.close(() => r(p));
        });
    });
    const emu = crearEmulador({ silencioso: true });
    const config = crearConfig({
        GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "GOCSPX-x",
        GOOGLE_REDIRECT_URI: `http://localhost:${libre}/auth/google/callback`
    });
    config.credenciales.youtubeApiKey = "";
    config.hardware.latidoMs = 0;
    const fetchMixto = (url, init) => (/google/.test(String(url)) ? fetchApis(url, init) : fetch(url, init));
    const sistema = crearApp(config, { fetch: fetchMixto, silencioso: true });
    await new Promise((r) => sistema.server.listen(0, "127.0.0.1", r));
    t.after(async () => {
        await sistema.cerrar();
        emu.server.close();
    });
    const base = `http://127.0.0.1:${sistema.server.address().port}`;

    // 1. El botón del panel redirige a Google.
    const r1 = await fetch(`${base}/auth/google`, { redirect: "manual" });
    assert.equal(r1.status, 302);
    const google = new URL(r1.headers.get("location"));
    assert.equal(google.hostname, "accounts.google.com");

    // 2. Google vuelve al puerto registrado (receptor temporal).
    const r2 = await fetch(`http://localhost:${libre}/auth/google/callback?code=X&state=${google.searchParams.get("state")}`);
    assert.equal(r2.status, 200);
    assert.match(await r2.text(), /Sesión de Google iniciada/);

    let estado = await (await fetch(`${base}/api/estado`)).json();
    assert.equal(estado.credenciales.google.autenticado, true);
    assert.equal(estado.credenciales.google.cuenta, "Canal TIC");

    // 3. Con la sesión, un directo de YouTube se lee sin API key.
    const r3 = await fetch(`${base}/api/stream/conectar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entrada: "https://youtu.be/abcdefghijk" })
    });
    estado = await r3.json();
    assert.equal(estado.monitor.ultimaLectura.viewers, 555);

    // El receptor temporal se cerró al terminar.
    await assert.rejects(fetch(`http://localhost:${libre}/auth/google/callback`));
});

test("los ajustes de calibración se guardan y se recuperan al reiniciar", async (t) => {
    const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tic3-")), "ajustes.json");
    const primero = await levantar(t, { fetchApis: crearFetchFalso([]), archivoAjustes: archivo });
    await primero.api("/api/config/mapeo", { anguloMin: 15, anguloMax: 165, modo: "logaritmico" });
    await primero.api("/api/config/estilo", { titulo: "AUDIENCIA" });

    const segundo = await levantar(t, { fetchApis: crearFetchFalso([]), archivoAjustes: archivo });
    const { cuerpo } = await segundo.api("/api/estado");
    assert.equal(cuerpo.mapeo.anguloMin, 15);
    assert.equal(cuerpo.mapeo.modo, "logaritmico");
    assert.equal(cuerpo.estilo.titulo, "AUDIENCIA");
});
