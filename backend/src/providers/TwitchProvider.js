// Lee los espectadores de un canal de Twitch con la API oficial Helix.
// Necesita una aplicación registrada en https://dev.twitch.tv/console (Client ID + Client Secret).
// Se usa el flujo "client credentials" (token de aplicación, no hace falta iniciar sesión).

const { ErrorProveedor, pedirJson } = require("./http");

class TwitchProvider {

    constructor(fuente, { clientId, clientSecret, fetch: fetchFn, timeoutMs = 8000, ahora = Date.now } = {}) {
        this.plataforma = "twitch";
        this.fuente = fuente; // { tipo: "canal", id: login }
        this.clientId = clientId || "";
        this.clientSecret = clientSecret || "";
        this.fetch = fetchFn || globalThis.fetch;
        this.timeoutMs = timeoutMs;
        this.ahora = ahora;
        this.token = null;
        this.tokenVence = 0;
        this.info = { titulo: null, canal: fuente.id };
    }

    descripcion() {
        return `Twitch · ${this.fuente.id}`;
    }

    async obtenerToken() {
        const qs = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: "client_credentials"
        });
        const { ok, estado, cuerpo } = await pedirJson(
            this.fetch,
            `https://id.twitch.tv/oauth2/token?${qs}`,
            { method: "POST" },
            this.timeoutMs
        );
        if (!ok || !cuerpo?.access_token) {
            throw new ErrorProveedor("Twitch rechazó el Client ID / Client Secret.", "AUTH", { reintentable: false, estado });
        }
        this.token = cuerpo.access_token;
        // Renovar un minuto antes de que venza.
        this.tokenVence = this.ahora() + Math.max(0, (cuerpo.expires_in || 3600) - 60) * 1000;
    }

    async helix(recurso, parametros, reintento = true) {
        if (!this.token || this.ahora() >= this.tokenVence) {
            await this.obtenerToken();
        }
        const qs = new URLSearchParams(parametros);
        const { ok, estado, cuerpo } = await pedirJson(
            this.fetch,
            `https://api.twitch.tv/helix/${recurso}?${qs}`,
            { headers: { "Client-Id": this.clientId, Authorization: `Bearer ${this.token}` } },
            this.timeoutMs
        );
        if (estado === 401 && reintento) {
            this.token = null;
            return this.helix(recurso, parametros, false);
        }
        if (estado === 429) {
            throw new ErrorProveedor("Twitch limitó las consultas (429). Se reintentará más tarde.", "LIMITE", { estado });
        }
        if (!ok) {
            throw new ErrorProveedor(`Error de Twitch: ${cuerpo?.message || `HTTP ${estado}`}`, "HTTP", { estado });
        }
        return cuerpo;
    }

    async conectar() {
        if (!this.clientId || !this.clientSecret) {
            throw new ErrorProveedor(
                "Faltan TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET (creá una app en dev.twitch.tv/console).",
                "AUTH",
                { reintentable: false }
            );
        }
        const usuarios = await this.helix("users", { login: this.fuente.id });
        const usuario = usuarios?.data?.[0];
        if (!usuario) {
            throw new ErrorProveedor(`No existe el canal de Twitch "${this.fuente.id}".`, "NO_ENCONTRADO", { reintentable: false });
        }
        this.info.canal = usuario.display_name || this.fuente.id;
        return this.leer();
    }

    async leer() {
        const datos = await this.helix("streams", { user_login: this.fuente.id });
        const stream = datos?.data?.[0];
        if (!stream || stream.type !== "live") {
            return { viewers: null, enVivo: false, ...this.info, aviso: "El canal no está en vivo." };
        }
        this.info = { titulo: stream.title || null, canal: stream.user_name || this.info.canal };
        return { viewers: Number(stream.viewer_count) || 0, enVivo: true, ...this.info };
    }
}

module.exports = { TwitchProvider };
