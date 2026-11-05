// Inicio de sesión con Google (OAuth 2.0) para leer YouTube sin API key.
// Usa las mismas credenciales (Client ID / Client Secret) que el Proyecto B.
//
// Flujo:
//   1. El panel abre /auth/google -> se redirige a la pantalla de Google.
//   2. Google vuelve a GOOGLE_REDIRECT_URI con un "code".
//   3. El code se cambia por un access_token (dura 1 h) y un refresh_token (permanente).
//   4. El refresh_token se guarda en backend/datos/google-tokens.json y se usa para
//      renovar el access_token solo, sin volver a iniciar sesión.
//
// Solo se pide permiso de lectura de YouTube (youtube.readonly).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ErrorProveedor, pedirJson } = require("../providers/http");

const URL_AUTORIZACION = "https://accounts.google.com/o/oauth2/v2/auth";
const URL_TOKEN = "https://oauth2.googleapis.com/token";
const ALCANCE = "https://www.googleapis.com/auth/youtube.readonly";
const MARGEN_MS = 60 * 1000; // renovar un minuto antes de que venza

class GoogleAuth {

    constructor({ clientId, clientSecret, redirectUri, archivoTokens = null, refreshToken = "", fetch: fetchFn, ahora = Date.now } = {}) {
        this.clientId = clientId || "";
        this.clientSecret = clientSecret || "";
        this.redirectUri = redirectUri || "";
        this.archivoTokens = archivoTokens;
        this.fetch = fetchFn || globalThis.fetch;
        this.ahora = ahora;
        this.tokens = { accessToken: null, venceEn: 0, refreshToken: refreshToken || null, cuenta: null };
        this.estadosPendientes = new Set();
        this.renovando = null;
        this.cargar();
    }

    configurado() {
        return Boolean(this.clientId && this.clientSecret && this.redirectUri);
    }

    autenticado() {
        return Boolean(this.tokens.refreshToken || (this.tokens.accessToken && this.ahora() < this.tokens.venceEn));
    }

    estado() {
        return {
            configurado: this.configurado(),
            autenticado: this.autenticado(),
            cuenta: this.tokens.cuenta,
            redirectUri: this.redirectUri
        };
    }

    cargar() {
        if (!this.archivoTokens || !fs.existsSync(this.archivoTokens)) return;
        try {
            const guardado = JSON.parse(fs.readFileSync(this.archivoTokens, "utf8"));
            this.tokens = { ...this.tokens, ...guardado };
        } catch {
            // archivo dañado: se ignora y habrá que iniciar sesión de nuevo
        }
    }

    guardar() {
        if (!this.archivoTokens) return;
        fs.mkdirSync(path.dirname(this.archivoTokens), { recursive: true });
        fs.writeFileSync(this.archivoTokens, JSON.stringify(this.tokens, null, 2));
    }

    // URL de la pantalla de Google. El "state" evita que otra página nos meta un code ajeno.
    urlAutorizacion() {
        if (!this.configurado()) {
            throw new Error("Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REDIRECT_URI en backend/.env.");
        }
        const state = crypto.randomBytes(16).toString("hex");
        this.estadosPendientes.add(state);
        const qs = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            response_type: "code",
            scope: ALCANCE,
            access_type: "offline",
            prompt: "consent", // asegura que Google entregue el refresh_token
            include_granted_scopes: "true",
            state
        });
        return `${URL_AUTORIZACION}?${qs}`;
    }

    async pedirToken(parametros) {
        const { ok, estado, cuerpo } = await pedirJson(this.fetch, URL_TOKEN, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...parametros }).toString()
        });
        if (!ok || !cuerpo?.access_token) {
            const motivo = cuerpo?.error_description || cuerpo?.error || `HTTP ${estado}`;
            const vencido = cuerpo?.error === "invalid_grant";
            throw new ErrorProveedor(
                vencido
                    ? "La sesión de Google venció o fue revocada. Volvé a iniciar sesión desde el panel."
                    : `Google rechazó la autenticación: ${motivo}`,
                "AUTH",
                { reintentable: false, estado }
            );
        }
        return cuerpo;
    }

    aplicarRespuesta(r) {
        this.tokens.accessToken = r.access_token;
        this.tokens.venceEn = this.ahora() + (Number(r.expires_in) || 3600) * 1000;
        if (r.refresh_token) this.tokens.refreshToken = r.refresh_token;
        this.guardar();
    }

    // Paso 3 del flujo: se llama desde la ruta de callback.
    async completarLogin({ code, state, error }) {
        if (error) throw new Error(`Google canceló el inicio de sesión: ${error}`);
        if (!state || !this.estadosPendientes.has(state)) {
            throw new Error("El inicio de sesión expiró o no salió de este panel. Probá de nuevo.");
        }
        this.estadosPendientes.delete(state);
        if (!code) throw new Error("Google no devolvió el código de autorización.");
        const r = await this.pedirToken({ code, redirect_uri: this.redirectUri, grant_type: "authorization_code" });
        this.aplicarRespuesta(r);
        await this.cargarCuenta();
        return this.estado();
    }

    // Nombre del canal de la cuenta, solo para mostrarlo en el panel.
    async cargarCuenta() {
        try {
            const { ok, cuerpo } = await pedirJson(
                this.fetch,
                "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
                { headers: { Authorization: `Bearer ${this.tokens.accessToken}` } }
            );
            this.tokens.cuenta = ok ? cuerpo?.items?.[0]?.snippet?.title || "Cuenta de Google" : "Cuenta de Google";
        } catch {
            this.tokens.cuenta = "Cuenta de Google";
        }
        this.guardar();
    }

    // Devuelve un access_token válido, renovándolo si hace falta.
    async obtenerAccessToken({ forzar = false } = {}) {
        if (!forzar && this.tokens.accessToken && this.ahora() < this.tokens.venceEn - MARGEN_MS) {
            return this.tokens.accessToken;
        }
        if (!this.tokens.refreshToken) {
            throw new ErrorProveedor("No hay sesión de Google. Iniciá sesión desde el panel.", "AUTH", { reintentable: false });
        }
        // Si varias consultas piden token a la vez, se renueva una sola vez.
        if (!this.renovando) {
            this.renovando = this.pedirToken({ refresh_token: this.tokens.refreshToken, grant_type: "refresh_token" })
                .then((r) => this.aplicarRespuesta(r))
                .catch((e) => {
                    if (e.codigo === "AUTH") {
                        this.tokens = { accessToken: null, venceEn: 0, refreshToken: null, cuenta: null };
                        this.guardar();
                    }
                    throw e;
                })
                .finally(() => (this.renovando = null));
        }
        await this.renovando;
        return this.tokens.accessToken;
    }

    cerrarSesion() {
        this.tokens = { accessToken: null, venceEn: 0, refreshToken: null, cuenta: null };
        if (this.archivoTokens && fs.existsSync(this.archivoTokens)) fs.unlinkSync(this.archivoTokens);
    }
}

module.exports = { GoogleAuth };
