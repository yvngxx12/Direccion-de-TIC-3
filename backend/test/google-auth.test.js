const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require("../src/services/GoogleAuth");
const { YouTubeProvider } = require("../src/providers/YouTubeProvider");
const { crearFetchFalso, videoYouTube } = require("./helpers");

const BASE = { clientId: "id.apps.googleusercontent.com", clientSecret: "GOCSPX-x", redirectUri: "http://localhost:4000/auth/google/callback" };

function fetchGoogle({ refreshFalla = false } = {}) {
    let emitidos = 0;
    return crearFetchFalso([
        [/oauth2\.googleapis\.com\/token/, (u, init) => {
            const p = new URLSearchParams(init.body);
            if (p.get("grant_type") === "authorization_code") {
                if (p.get("code") !== "CODIGO_OK") return { estado: 400, cuerpo: { error: "invalid_grant" } };
                emitidos++;
                return { cuerpo: { access_token: `acc${emitidos}`, expires_in: 3600, refresh_token: "REFRESH" } };
            }
            if (refreshFalla) return { estado: 400, cuerpo: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
            emitidos++;
            return { cuerpo: { access_token: `acc${emitidos}`, expires_in: 3600 } };
        }],
        [/channels\?part=snippet&mine=true/, () => ({ cuerpo: { items: [{ snippet: { title: "Canal TIC" } }] } })]
    ]);
}

test("arma la URL de Google con permiso de solo lectura y refresh token", () => {
    const auth = new GoogleAuth({ ...BASE, fetch: fetchGoogle() });
    const url = new URL(auth.urlAutorizacion());
    assert.equal(url.hostname, "accounts.google.com");
    assert.equal(url.searchParams.get("client_id"), BASE.clientId);
    assert.equal(url.searchParams.get("redirect_uri"), BASE.redirectUri);
    assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.readonly");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.match(url.searchParams.get("state"), /^[0-9a-f]{32}$/);
    assert.throws(() => new GoogleAuth({}).urlAutorizacion(), /GOOGLE_CLIENT_ID/);
});

test("login completo: code -> tokens -> se guardan en disco", async () => {
    const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tic3-g-")), "tokens.json");
    const auth = new GoogleAuth({ ...BASE, archivoTokens: archivo, fetch: fetchGoogle() });
    const state = new URL(auth.urlAutorizacion()).searchParams.get("state");
    const estado = await auth.completarLogin({ code: "CODIGO_OK", state });
    assert.equal(estado.autenticado, true);
    assert.equal(estado.cuenta, "Canal TIC");
    assert.equal(await auth.obtenerAccessToken(), "acc1");

    // Un proceso nuevo recupera la sesión sin volver a iniciar sesión.
    const otra = new GoogleAuth({ ...BASE, archivoTokens: archivo, fetch: fetchGoogle() });
    assert.equal(otra.autenticado(), true);
    assert.equal(otra.tokens.refreshToken, "REFRESH");
});

test("rechaza un state desconocido o un login cancelado", async () => {
    const auth = new GoogleAuth({ ...BASE, fetch: fetchGoogle() });
    await assert.rejects(auth.completarLogin({ code: "CODIGO_OK", state: "inventado" }), /expiró/);
    await assert.rejects(auth.completarLogin({ error: "access_denied" }), /canceló/);
    const state = new URL(auth.urlAutorizacion()).searchParams.get("state");
    await assert.rejects(auth.completarLogin({ code: "MALO", state }), /venció o fue revocada/);
});

test("renueva el access token cuando vence, una sola vez aunque lo pidan varios", async () => {
    let ahora = 0;
    const fetch = fetchGoogle();
    const auth = new GoogleAuth({ ...BASE, refreshToken: "REFRESH", fetch, ahora: () => ahora });
    const tokens = await Promise.all([auth.obtenerAccessToken(), auth.obtenerAccessToken(), auth.obtenerAccessToken()]);
    assert.deepEqual(tokens, ["acc1", "acc1", "acc1"]);
    assert.equal(fetch.llamadas.length, 1);
    ahora += 30 * 60 * 1000;
    assert.equal(await auth.obtenerAccessToken(), "acc1"); // sigue vigente
    ahora += 30 * 60 * 1000;
    assert.equal(await auth.obtenerAccessToken(), "acc2"); // venció
});

test("refresh token revocado: borra la sesión y pide iniciar de nuevo", async () => {
    const auth = new GoogleAuth({ ...BASE, refreshToken: "REFRESH", fetch: fetchGoogle({ refreshFalla: true }) });
    await assert.rejects(auth.obtenerAccessToken(), (e) => e.codigo === "AUTH" && /Volvé a iniciar sesión/.test(e.message));
    assert.equal(auth.autenticado(), false);
});

test("YouTube usa el token de Google (Bearer) si no hay API key", async () => {
    const fetch = crearFetchFalso([
        [/oauth2\.googleapis\.com\/token/, () => ({ cuerpo: { access_token: "TOKEN_G", expires_in: 3600 } })],
        [/\/videos\?/, (u, init) => (init.headers && init.headers.Authorization === "Bearer TOKEN_G"
            ? { cuerpo: videoYouTube({ viewers: "321" }) }
            : { estado: 401, cuerpo: { error: { message: "Login Required" } } })]
    ]);
    const auth = new GoogleAuth({ ...BASE, refreshToken: "REFRESH", fetch });
    const p = new YouTubeProvider({ tipo: "video", id: "abcdefghijk" }, { auth, fetch });
    const r = await p.conectar();
    assert.equal(r.viewers, 321);
    const consulta = fetch.llamadas.find((l) => l.url.pathname.endsWith("/videos"));
    assert.equal(consulta.url.searchParams.get("key"), null, "no debe mandar key=");
});

test("YouTube con OAuth: si Google responde 401, renueva el token y reintenta", async () => {
    let emitidos = 0;
    const fetch = crearFetchFalso([
        [/oauth2\.googleapis\.com\/token/, () => ({ cuerpo: { access_token: `T${++emitidos}`, expires_in: 3600 } })],
        [/\/videos\?/, (u, init) => (init.headers.Authorization === "Bearer T2"
            ? { cuerpo: videoYouTube({ viewers: "10" }) }
            : { estado: 401, cuerpo: { error: { message: "Invalid Credentials" } } })]
    ]);
    const auth = new GoogleAuth({ ...BASE, refreshToken: "REFRESH", fetch });
    const r = await new YouTubeProvider({ tipo: "video", id: "abcdefghijk" }, { auth, fetch }).leer();
    assert.equal(r.viewers, 10);
    assert.equal(emitidos, 2);
});

test("YouTube sin key ni sesión explica las dos opciones", async () => {
    const auth = new GoogleAuth({ ...BASE, fetch: fetchGoogle() });
    const p = new YouTubeProvider({ tipo: "video", id: "abcdefghijk" }, { auth, fetch: fetchGoogle() });
    await assert.rejects(p.conectar(), /iniciá sesión con Google.*YOUTUBE_API_KEY/);
});
