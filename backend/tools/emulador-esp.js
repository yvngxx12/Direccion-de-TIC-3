// Emulador de la NodeMCU ESP8266 con el servo. Responde la misma API HTTP que el firmware
// (GET /status, POST /servo) y simula el movimiento suave de la aguja.
// Sirve para probar todo el sistema sin la placa física.
//
//   npm run emulador                -> http://127.0.0.1:4310
//   npm run emulador -- 4311        -> otro puerto
//
// Después, en el panel: Placa -> WiFi -> IP "127.0.0.1:4310" -> Conectar.

const http = require("http");

const GRADOS_POR_SEGUNDO = 120; // velocidad de la aguja (igual que el firmware)
const TIMEOUT_SIN_LATIDO_MS = 30000;

function crearEmulador({ silencioso = false } = {}) {
    const estado = {
        angulo: 0,
        objetivo: 0,
        viewers: 0,
        tendencia: "flat",
        enVivo: false,
        comandos: [],
        ultimoComando: Date.now(),
        inicio: Date.now()
    };

    const tick = setInterval(() => {
        const paso = GRADOS_POR_SEGUNDO / 50;
        const diferencia = estado.objetivo - estado.angulo;
        if (Math.abs(diferencia) <= paso) estado.angulo = estado.objetivo;
        else estado.angulo += Math.sign(diferencia) * paso;
        // Igual que el firmware: sin noticias del backend, la aguja vuelve a 0.
        if (Date.now() - estado.ultimoComando > TIMEOUT_SIN_LATIDO_MS) {
            estado.objetivo = 0;
            estado.enVivo = false;
        }
    }, 20);
    tick.unref();

    function json(res, codigo, datos) {
        res.writeHead(codigo, { "Content-Type": "application/json" });
        res.end(JSON.stringify(datos));
    }

    function status() {
        return {
            status: "online",
            device: "Emulador ESP8266 + Servo",
            angle: Math.round(estado.angulo),
            target: estado.objetivo,
            viewers: estado.viewers,
            trend: estado.tendencia,
            live: estado.enVivo,
            uptime: Math.round((Date.now() - estado.inicio) / 1000)
        };
    }

    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/status") return json(res, 200, status());

        if (req.method === "POST" && req.url === "/servo") {
            let cuerpo = "";
            req.on("data", (c) => (cuerpo += c));
            req.on("end", () => {
                let comando;
                try {
                    comando = JSON.parse(cuerpo);
                } catch {
                    return json(res, 400, { ok: false, error: "JSON inválido" });
                }
                const angulo = Number(comando.angle);
                if (!Number.isFinite(angulo)) return json(res, 400, { ok: false, error: "Falta angle" });
                estado.objetivo = Math.min(180, Math.max(0, Math.round(angulo)));
                estado.viewers = Number(comando.viewers) || 0;
                estado.tendencia = comando.trend || "flat";
                estado.enVivo = comando.live !== false;
                estado.ultimoComando = Date.now();
                estado.comandos.push({ ...comando, recibido: Date.now() });
                if (estado.comandos.length > 500) estado.comandos.shift();
                if (!silencioso) console.log(`Servo -> ${estado.objetivo}° (${estado.viewers} espectadores, ${estado.tendencia})`);
                return json(res, 200, { ok: true, angle: Math.round(estado.angulo), target: estado.objetivo });
            });
            return;
        }
        json(res, 404, { error: "Ruta no encontrada" });
    });

    server.on("close", () => clearInterval(tick));
    return { server, estado };
}

if (require.main === module) {
    const puerto = Number(process.argv[2]) || 4310;
    const { server } = crearEmulador();
    server.listen(puerto, "127.0.0.1", () => {
        console.log(`Emulador de la placa escuchando en http://127.0.0.1:${puerto}`);
        console.log(`En el panel usá: WiFi -> IP 127.0.0.1:${puerto}`);
    });
}

module.exports = { crearEmulador };
