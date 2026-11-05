// Interpreta lo que el usuario pega en el panel (URL de stream, ID, @canal...)
// y devuelve qué plataforma es y qué identificador usar.
//
// Ejemplos aceptados:
//   https://www.youtube.com/watch?v=VIDEOID11ch     -> youtube / video
//   https://youtu.be/VIDEOID11ch                    -> youtube / video
//   https://www.youtube.com/live/VIDEOID11ch        -> youtube / video
//   https://www.youtube.com/@MiCanal  (o /@MiCanal/live) -> youtube / handle
//   https://www.youtube.com/channel/UCxxxxxxxx      -> youtube / canal
//   VIDEOID11ch                                     -> youtube / video
//   @MiCanal                                        -> youtube / handle
//   https://www.twitch.tv/micanal  o  twitch:micanal -> twitch / canal
//   simulador                                       -> simulador

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_CANAL = /^UC[A-Za-z0-9_-]{22}$/;
const TWITCH_LOGIN = /^[A-Za-z0-9_]{3,25}$/;

function error(mensaje) {
    const e = new Error(mensaje);
    e.codigo = "FUENTE_INVALIDA";
    return e;
}

function parsearYouTube(url) {
    const partes = url.pathname.split("/").filter(Boolean);

    if (url.hostname === "youtu.be") {
        if (partes[0] && YT_ID.test(partes[0])) return { plataforma: "youtube", tipo: "video", id: partes[0] };
        throw error("Link de youtu.be sin ID de video válido.");
    }

    const v = url.searchParams.get("v");
    if (v && YT_ID.test(v)) return { plataforma: "youtube", tipo: "video", id: v };

    if (["live", "shorts", "embed", "v"].includes(partes[0]) && partes[1] && YT_ID.test(partes[1])) {
        return { plataforma: "youtube", tipo: "video", id: partes[1] };
    }
    if (partes[0] && partes[0].startsWith("@") && partes[0].length > 1) {
        return { plataforma: "youtube", tipo: "handle", id: decodeURIComponent(partes[0]) };
    }
    if (partes[0] === "channel" && partes[1] && YT_CANAL.test(partes[1])) {
        return { plataforma: "youtube", tipo: "canal", id: partes[1] };
    }
    throw error("No se reconoce el link de YouTube. Usá el link del video en vivo o del canal (@canal).");
}

function parsearTwitch(url) {
    const partes = url.pathname.split("/").filter(Boolean);
    const login = partes[0];
    if (login && TWITCH_LOGIN.test(login) && !["videos", "directory", "settings"].includes(login)) {
        return { plataforma: "twitch", tipo: "canal", id: login.toLowerCase() };
    }
    throw error("No se reconoce el link de Twitch. Usá https://www.twitch.tv/<canal>.");
}

function parsearFuente(entrada) {
    const texto = String(entrada || "").trim();
    if (!texto) throw error("Ingresá un link o ID de stream.");

    const minus = texto.toLowerCase();
    if (minus === "simulador" || minus === "simulacion" || minus === "demo") {
        return { plataforma: "simulador", tipo: "simulado", id: "simulador" };
    }

    // Prefijo explícito "plataforma:valor"
    const prefijo = texto.match(/^(youtube|yt|twitch):(.+)$/i);
    if (prefijo) {
        const plataforma = prefijo[1].toLowerCase();
        const valor = prefijo[2].trim();
        if (plataforma === "twitch") {
            if (!TWITCH_LOGIN.test(valor)) throw error("Nombre de canal de Twitch inválido.");
            return { plataforma: "twitch", tipo: "canal", id: valor.toLowerCase() };
        }
        return parsearFuente(valor.startsWith("@") || YT_ID.test(valor) || YT_CANAL.test(valor) ? valor : `@${valor}`);
    }

    if (YT_CANAL.test(texto)) return { plataforma: "youtube", tipo: "canal", id: texto };
    if (YT_ID.test(texto)) return { plataforma: "youtube", tipo: "video", id: texto };
    if (/^@[\w.\-]{2,}$/.test(texto)) return { plataforma: "youtube", tipo: "handle", id: texto };

    let url;
    try {
        url = new URL(/^https?:\/\//i.test(texto) ? texto : `https://${texto}`);
    } catch {
        throw error("No es un link válido.");
    }

    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtube.com" || host === "youtu.be") {
        if (host === "youtu.be") url.hostname = "youtu.be";
        return parsearYouTube(url);
    }
    if (host === "twitch.tv") return parsearTwitch(url);

    throw error("Plataforma no soportada. Por ahora: YouTube, Twitch o \"simulador\".");
}

module.exports = { parsearFuente };
