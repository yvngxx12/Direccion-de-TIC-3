// Lee los espectadores simultáneos (concurrentViewers) de un directo de YouTube
// usando la API oficial YouTube Data API v3.
//
//   videos.list   (1 unidad de cuota)   -> liveStreamingDetails.concurrentViewers
//   channels.list (1 unidad)            -> convertir @handle en channelId
//   search.list   (100 unidades)        -> buscar el directo activo de un canal
//
// La cuota gratuita es de 10.000 unidades por día. Con una consulta cada 15 s
// se gastan ~5.760 unidades en 24 h, así que alcanza de sobra para una jornada.

const { ErrorProveedor, pedirJson } = require("./http");

const BASE = "https://www.googleapis.com/youtube/v3";
const REBUSCAR_DIRECTO_MS = 5 * 60 * 1000; // si el canal no está en vivo, volver a buscar cada 5 min

class YouTubeProvider {

    constructor(fuente, { apiKey, auth = null, fetch: fetchFn, timeoutMs = 8000, ahora = Date.now } = {}) {
        this.plataforma = "youtube";
        this.fuente = fuente; // { tipo: "video" | "canal" | "handle", id }
        this.apiKey = apiKey || "";
        this.auth = auth; // GoogleAuth: se usa si no hay API key
        this.fetch = fetchFn || globalThis.fetch;
        this.timeoutMs = timeoutMs;
        this.ahora = ahora;

        this.videoId = fuente.tipo === "video" ? fuente.id : null;
        this.canalId = fuente.tipo === "canal" ? fuente.id : null;
        this.ultimaBusqueda = 0;
        this.info = { titulo: null, canal: null };
    }

    descripcion() {
        if (this.videoId) return `YouTube · video ${this.videoId}`;
        return `YouTube · canal ${this.fuente.id}`;
    }

    usaOAuth() {
        return !this.apiKey && Boolean(this.auth && this.auth.autenticado());
    }

    async llamar(recurso, parametros, reintento = true) {
        const oauth = this.usaOAuth();
        const qs = new URLSearchParams(oauth ? parametros : { ...parametros, key: this.apiKey });
        const init = oauth ? { headers: { Authorization: `Bearer ${await this.auth.obtenerAccessToken()}` } } : {};
        const { estado, ok, cuerpo } = await pedirJson(this.fetch, `${BASE}/${recurso}?${qs}`, init, this.timeoutMs);
        if (ok) return cuerpo;

        // Token vencido antes de tiempo: se renueva una vez y se repite la consulta.
        if (oauth && estado === 401 && reintento) {
            await this.auth.obtenerAccessToken({ forzar: true });
            return this.llamar(recurso, parametros, false);
        }

        const razon = cuerpo?.error?.errors?.[0]?.reason || "";
        const mensaje = cuerpo?.error?.message || `HTTP ${estado}`;
        if (razon === "quotaExceeded" || razon === "dailyLimitExceeded") {
            throw new ErrorProveedor("Se agotó la cuota diaria de la API de YouTube. Aumentá el intervalo o probá mañana.", "CUOTA", { estado });
        }
        if ((estado === 400 && /api key/i.test(mensaje)) || razon === "keyInvalid" || estado === 401) {
            throw new ErrorProveedor(
                oauth ? "Google rechazó la sesión. Volvé a iniciar sesión desde el panel." : "La YOUTUBE_API_KEY no es válida.",
                "AUTH",
                { reintentable: false, estado }
            );
        }
        if (estado === 403) {
            throw new ErrorProveedor(`YouTube rechazó la consulta: ${mensaje}`, "PERMISO", { reintentable: false, estado });
        }
        throw new ErrorProveedor(`Error de YouTube: ${mensaje}`, "HTTP", { estado });
    }

    async conectar() {
        if (!this.apiKey && !this.usaOAuth()) {
            throw new ErrorProveedor(
                "Para leer YouTube iniciá sesión con Google desde el panel (Credenciales de API) o cargá una YOUTUBE_API_KEY.",
                "AUTH",
                { reintentable: false }
            );
        }

        if (this.fuente.tipo === "handle") {
            const datos = await this.llamar("channels", { part: "id,snippet", forHandle: this.fuente.id });
            const canal = datos?.items?.[0];
            if (!canal) {
                throw new ErrorProveedor(`No existe el canal ${this.fuente.id}.`, "NO_ENCONTRADO", { reintentable: false });
            }
            this.canalId = canal.id;
            this.info.canal = canal.snippet?.title || this.fuente.id;
        }

        if (!this.videoId) {
            await this.buscarDirecto();
        }
        // Primera lectura para validar que el video existe.
        return this.leer();
    }

    async buscarDirecto() {
        this.ultimaBusqueda = this.ahora();
        const datos = await this.llamar("search", {
            part: "id",
            channelId: this.canalId,
            eventType: "live",
            type: "video",
            maxResults: "1"
        });
        this.videoId = datos?.items?.[0]?.id?.videoId || null;
        return this.videoId;
    }

    async leer() {
        if (!this.videoId) {
            if (this.ahora() - this.ultimaBusqueda >= REBUSCAR_DIRECTO_MS) {
                await this.buscarDirecto();
            }
            if (!this.videoId) {
                return { viewers: null, enVivo: false, ...this.info, aviso: "El canal no está transmitiendo en vivo." };
            }
        }

        const datos = await this.llamar("videos", { part: "liveStreamingDetails,snippet", id: this.videoId });
        const video = datos?.items?.[0];
        if (!video) {
            throw new ErrorProveedor(`No se encontró el video ${this.videoId}.`, "NO_ENCONTRADO", { reintentable: false });
        }

        this.info = {
            titulo: video.snippet?.title || null,
            canal: video.snippet?.channelTitle || this.info.canal
        };

        const detalles = video.liveStreamingDetails || {};
        const estado = video.snippet?.liveBroadcastContent; // "live" | "upcoming" | "none"

        if (estado === "live" && !detalles.actualEndTime) {
            if (detalles.concurrentViewers === undefined) {
                return { viewers: null, enVivo: true, ...this.info, aviso: "El directo oculta la cantidad de espectadores." };
            }
            return { viewers: Number(detalles.concurrentViewers), enVivo: true, ...this.info };
        }

        // El directo terminó o todavía no empezó.
        const aviso = estado === "upcoming" ? "El directo todavía no empezó." : "El directo terminó o no es un video en vivo.";
        if (this.fuente.tipo !== "video" && detalles.actualEndTime) {
            // Si seguimos a un canal, olvidamos el video terminado para buscar el próximo directo.
            this.videoId = null;
        }
        return { viewers: null, enVivo: false, ...this.info, aviso };
    }
}

module.exports = { YouTubeProvider };
