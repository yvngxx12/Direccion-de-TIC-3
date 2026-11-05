// Configuración general del Indicador de Audiencia (Proyecto C).
// Todo lo que está acá se puede cambiar en caliente desde el panel web.

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

function numero(valor, porDefecto) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : porDefecto;
}

function crearConfig(env = process.env) {
    return {
        puerto: numero(env.PORT, 4300),

        credenciales: {
            youtubeApiKey: env.YOUTUBE_API_KEY || "",
            // OAuth 2.0 (mismas credenciales que el Proyecto B). Alternativa a la API key.
            googleClientId: env.GOOGLE_CLIENT_ID || "",
            googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
            googleRedirectUri: env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback",
            googleRefreshToken: env.GOOGLE_REFRESH_TOKEN || "",
            twitchClientId: env.TWITCH_CLIENT_ID || "",
            twitchClientSecret: env.TWITCH_CLIENT_SECRET || ""
        },

        // Cada cuánto se consulta la cantidad de espectadores.
        // YouTube: cada consulta cuesta 1 unidad de cuota (10.000 por día) => 15 s es seguro.
        monitor: {
            intervaloMs: numero(env.INTERVALO_MS, 15000),
            intervaloSimuladorMs: numero(env.INTERVALO_SIMULADOR_MS, 1000),
            maxBackoffMs: 60000,
            timeoutMs: 8000
        },

        // Cómo se traduce la cantidad de espectadores a un ángulo del servo.
        mapeo: {
            modo: env.MAPEO_MODO || "lineal",      // "lineal" | "logaritmico" | "auto"
            viewersMin: numero(env.VIEWERS_MIN, 0),
            viewersMax: numero(env.VIEWERS_MAX, 1000),
            anguloMin: numero(env.ANGULO_MIN, 0),
            anguloMax: numero(env.ANGULO_MAX, 180),
            invertir: env.INVERTIR === "true",
            suavizado: numero(env.SUAVIZADO, 0.5), // 1 = sin suavizado, 0.1 = muy suave
            zonaMuerta: numero(env.ZONA_MUERTA, 2), // grados mínimos para mover el servo
            sinSenal: env.SIN_SENAL || "minimo"     // "minimo" | "mantener"
        },

        hardware: {
            tipo: env.HARDWARE_TIPO || "ninguno",   // "ninguno" | "http" | "serial"
            ip: env.ESP8266_IP || "",
            puertoSerie: env.PUERTO_SERIE || "",
            baudios: numero(env.BAUDIOS, 115200),
            latidoMs: 5000 // reenvío periódico para que la placa sepa que el backend sigue vivo
        },

        // Estilo del overlay de OBS (editable desde el panel).
        estilo: {
            colorAcento: "#22d3ee",
            colorFondo: "rgba(10, 14, 22, 0.72)",
            colorTexto: "#ffffff",
            titulo: "ESPECTADORES",
            mostrarNumero: true,
            mostrarTendencia: true,
            escala: 1
        }
    };
}

module.exports = { crearConfig };
