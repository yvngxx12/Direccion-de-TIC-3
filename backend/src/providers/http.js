// Utilidades HTTP compartidas por los proveedores de audiencia.
// Se usa el fetch nativo de Node 18+ (inyectable para los tests).

class ErrorProveedor extends Error {
    constructor(mensaje, codigo = "ERROR", { reintentable = true, estado = null } = {}) {
        super(mensaje);
        this.name = "ErrorProveedor";
        this.codigo = codigo;
        this.reintentable = reintentable;
        this.estado = estado;
    }
}

async function pedirJson(fetchFn, url, init = {}, timeoutMs = 8000) {
    let respuesta;
    try {
        respuesta = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        const porTiempo = e && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new ErrorProveedor(
            porTiempo ? `La API no respondió en ${timeoutMs / 1000} s.` : `Sin conexión con la API (${e.message}).`,
            porTiempo ? "TIMEOUT" : "RED"
        );
    }

    let cuerpo = null;
    const texto = await respuesta.text();
    if (texto) {
        try {
            cuerpo = JSON.parse(texto);
        } catch {
            cuerpo = { textoPlano: texto.slice(0, 200) };
        }
    }
    return { estado: respuesta.status, ok: respuesta.ok, cuerpo };
}

// Oculta claves/tokens antes de mostrar una URL en el log.
function ocultarSecretos(url) {
    return String(url).replace(/(key|client_secret|access_token)=[^&]+/gi, "$1=***");
}

module.exports = { ErrorProveedor, pedirJson, ocultarSecretos };
