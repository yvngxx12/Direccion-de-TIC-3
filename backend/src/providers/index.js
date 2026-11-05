// Fábrica de proveedores: a partir de lo que se pegó en el panel crea el lector correcto.

const { parsearFuente } = require("../utils/parsearFuente");
const { YouTubeProvider } = require("./YouTubeProvider");
const { TwitchProvider } = require("./TwitchProvider");
const { SimuladorProvider, ESCENARIOS } = require("./SimuladorProvider");

function crearProveedor(entrada, { credenciales = {}, googleAuth = null, fetch, timeoutMs, escenario } = {}) {
    const fuente = parsearFuente(entrada);

    switch (fuente.plataforma) {
        case "youtube":
            return new YouTubeProvider(fuente, { apiKey: credenciales.youtubeApiKey, auth: googleAuth, fetch, timeoutMs });
        case "twitch":
            return new TwitchProvider(fuente, {
                clientId: credenciales.twitchClientId,
                clientSecret: credenciales.twitchClientSecret,
                fetch,
                timeoutMs
            });
        case "simulador":
            return new SimuladorProvider({ escenario: escenario || "estable" });
        default:
            throw new Error(`Plataforma no soportada: ${fuente.plataforma}`);
    }
}

module.exports = { crearProveedor, ESCENARIOS };
