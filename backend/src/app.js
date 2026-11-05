// Arma el sistema completo (API REST + Socket.IO + monitor + servo).
// Se separa de server.js para poder levantarlo en los tests con otra configuración.

const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const { MapeadorAudiencia } = require("./core/MapeadorAudiencia");
const { MonitorAudiencia } = require("./core/MonitorAudiencia");
const { ControladorServo } = require("./hardware/ControladorServo");
const { ServoSerialDriver } = require("./hardware/ServoSerialDriver");
const { crearProveedor, ESCENARIOS } = require("./providers");
const { GoogleAuth } = require("./services/GoogleAuth");

const MAX_LOGS = 150;
const CARPETA_PUBLICA = path.join(__dirname, "../../public");

function crearApp(config, { fetch, archivoAjustes = null, archivoTokens = null, silencioso = false } = {}) {
    const credenciales = { ...config.credenciales };
    const estilo = { ...config.estilo };
    const googleAuth = new GoogleAuth({
        clientId: credenciales.googleClientId,
        clientSecret: credenciales.googleClientSecret,
        redirectUri: credenciales.googleRedirectUri,
        refreshToken: credenciales.googleRefreshToken,
        archivoTokens,
        fetch
    });

    // Ajustes guardados de una sesión anterior (calibración, estilo, intervalo, placa).
    let guardado = {};
    if (archivoAjustes && fs.existsSync(archivoAjustes)) {
        try {
            guardado = JSON.parse(fs.readFileSync(archivoAjustes, "utf8"));
        } catch {
            guardado = {};
        }
    }

    const mapeador = new MapeadorAudiencia({ ...config.mapeo, ...(guardado.mapeo || {}) });
    Object.assign(estilo, guardado.estilo || {});
    const servo = new ControladorServo({ latidoMs: config.hardware.latidoMs, fetch });
    const monitor = new MonitorAudiencia({
        mapeador,
        servo,
        monitor: { ...config.monitor, ...(guardado.monitor || {}) },
        crearProveedor: (entrada, extra) =>
            crearProveedor(entrada, { credenciales, googleAuth, fetch, timeoutMs: config.monitor.timeoutMs, ...extra })
    });
    let ultimaPlaca = guardado.hardware || null;

    function guardarAjustes() {
        if (!archivoAjustes) return;
        const datos = {
            mapeo: mapeador.opciones,
            estilo,
            monitor: { intervaloMs: monitor.opciones.intervaloMs, intervaloSimuladorMs: monitor.opciones.intervaloSimuladorMs },
            hardware: ultimaPlaca
        };
        try {
            fs.mkdirSync(path.dirname(archivoAjustes), { recursive: true });
            fs.writeFileSync(archivoAjustes, JSON.stringify(datos, null, 2));
        } catch (e) {
            registrar(`No se pudieron guardar los ajustes: ${e.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Logs y difusión de estado
    // ------------------------------------------------------------------
    const logs = [];
    function registrar(mensaje) {
        const entrada = { fecha: new Date().toISOString(), mensaje };
        logs.push(entrada);
        if (logs.length > MAX_LOGS) logs.shift();
        if (!silencioso) console.log(`[${entrada.fecha.slice(11, 19)}] ${mensaje}`);
        io.emit("log", entrada);
    }

    function estadoCompleto() {
        return {
            monitor: monitor.estado(),
            servo: servo.estado(),
            mapeo: mapeador.opciones,
            rango: mapeador.rangoActual(),
            intervaloApiMs: monitor.opciones.intervaloMs,
            estilo,
            credenciales: {
                youtube: Boolean(credenciales.youtubeApiKey) || googleAuth.autenticado(),
                youtubeApiKey: Boolean(credenciales.youtubeApiKey),
                google: googleAuth.estado(),
                twitch: Boolean(credenciales.twitchClientId && credenciales.twitchClientSecret)
            },
            escenarios: ESCENARIOS,
            placaGuardada: ultimaPlaca
        };
    }

    let difusionPendiente = false;
    function difundirEstado() {
        if (difusionPendiente) return;
        difusionPendiente = true;
        setImmediate(() => {
            difusionPendiente = false;
            io.emit("estado", estadoCompleto());
        });
    }

    // ------------------------------------------------------------------
    // Servidor HTTP
    // ------------------------------------------------------------------
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { cors: { origin: "*" } });

    app.use(express.json({ limit: "50kb" }));
    app.use(express.static(CARPETA_PUBLICA));

    monitor.on("log", registrar);
    monitor.on("cambio", difundirEstado);
    monitor.on("lectura", (lectura) => io.emit("lectura", lectura));
    monitor.on("reinicio", () => io.emit("historial", []));
    servo.on("log", registrar);
    servo.on("cambio", difundirEstado);

    // Envuelve un handler async y devuelve 400 con el mensaje si falla.
    const ruta = (fn) => async (req, res) => {
        try {
            const resultado = await fn(req.body || {}, req);
            res.json(resultado === undefined ? estadoCompleto() : resultado);
        } catch (e) {
            res.status(400).json({ error: e.message, codigo: e.codigo || "ERROR" });
        }
    };

    app.get("/api/estado", ruta(() => estadoCompleto()));
    app.get("/api/historial", ruta(() => ({ historial: monitor.historial })));
    app.get("/api/logs", ruta(() => ({ logs })));

    // --- Stream ---
    app.post("/api/stream/conectar", ruta(async ({ entrada, escenario }) => {
        await monitor.conectar(entrada, { escenario });
    }));
    app.post("/api/stream/detener", ruta(async () => {
        await monitor.detener();
    }));
    app.post("/api/stream/leer", ruta(async () => {
        if (!monitor.proveedor) throw new Error("No hay ningún stream conectado.");
        await monitor.leerAhora();
    }));

    // --- Simulador ---
    app.post("/api/simulador", ruta(async ({ escenario, viewers, offline }) => {
        let proveedor = monitor.proveedor;
        if (!proveedor || proveedor.plataforma !== "simulador") {
            await monitor.conectar("simulador", { escenario: escenario || "estable" });
            proveedor = monitor.proveedor;
        } else if (escenario) {
            proveedor.cambiarEscenario(escenario);
            registrar(`Escenario del simulador: ${escenario}`);
        }
        if (viewers !== undefined) {
            proveedor.fijar(viewers);
            registrar(viewers === null ? "Simulador vuelve al escenario automático." : `Simulador fijado en ${proveedor.fijado} espectadores.`);
        }
        if (offline !== undefined) {
            proveedor.ponerOffline(Boolean(offline));
            registrar(offline ? "Simulador: stream offline." : "Simulador: stream en vivo.");
        }
        await monitor.leerAhora();
    }));

    // --- Configuración ---
    app.post("/api/config/mapeo", ruta((cambios) => {
        mapeador.configurar(cambios);
        registrar(`Calibración actualizada: ${JSON.stringify(cambios)}`);
        guardarAjustes();
        return monitor.reaplicarCalibracion().then(() => undefined);
    }));
    app.post("/api/config/monitor", ruta((cambios) => {
        monitor.configurar(cambios);
        guardarAjustes();
        difundirEstado();
    }));
    app.post("/api/config/estilo", ruta((cambios) => {
        const permitidos = Object.keys(config.estilo);
        for (const [clave, valor] of Object.entries(cambios)) {
            if (!permitidos.includes(clave)) continue;
            if (clave === "escala") {
                const n = Number(valor);
                if (!Number.isFinite(n) || n < 0.3 || n > 3) throw new Error("La escala debe estar entre 0.3 y 3.");
                estilo.escala = n;
            } else if (typeof config.estilo[clave] === "boolean") {
                estilo[clave] = valor === true || valor === "true";
            } else {
                estilo[clave] = String(valor).slice(0, 60);
            }
        }
        guardarAjustes();
        io.emit("estilo", estilo);
        difundirEstado();
    }));
    app.post("/api/config/credenciales", ruta(({ youtubeApiKey, twitchClientId, twitchClientSecret }) => {
        if (typeof youtubeApiKey === "string") credenciales.youtubeApiKey = youtubeApiKey.trim();
        if (typeof twitchClientId === "string") credenciales.twitchClientId = twitchClientId.trim();
        if (typeof twitchClientSecret === "string") credenciales.twitchClientSecret = twitchClientSecret.trim();
        registrar("Credenciales actualizadas (solo en memoria; para que queden guardadas usá backend/.env).");
        difundirEstado();
    }));

    // --- Inicio de sesión con Google (OAuth 2.0) ---
    // Google solo vuelve a la URL registrada en la consola (GOOGLE_REDIRECT_URI).
    // Si esa URL apunta a otro puerto local (p. ej. 4000, el del Proyecto B), se abre un
    // receptor temporal en ese puerto solo durante el inicio de sesión.
    let receptorTemporal = null;

    function paginaResultado(res, ok, mensaje) {
        const panel = `http://localhost:${server.address().port}/`;
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Google</title>
<meta http-equiv="refresh" content="${ok ? 2 : 8};url=${panel}">
<body style="font-family:Segoe UI,sans-serif;background:#0b0f17;color:#e6ebf5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:520px;padding:16px"><h2>${ok ? "Sesión de Google iniciada" : "No se pudo iniciar sesión"}</h2>
<p style="color:#94a0b8">${mensaje.replace(/[<>&]/g, "")}</p><p><a style="color:#22d3ee" href="${panel}">Volver al panel</a></p></div></body></html>`);
    }

    async function manejarCallback(query, res) {
        try {
            const estadoGoogle = await googleAuth.completarLogin({ code: query.code, state: query.state, error: query.error });
            registrar(`Sesión de Google iniciada (${estadoGoogle.cuenta}).`);
            difundirEstado();
            paginaResultado(res, true, "Ya podés conectar un directo de YouTube desde el panel.");
        } catch (e) {
            registrar(`Error al iniciar sesión con Google: ${e.message}`);
            paginaResultado(res, false, e.message);
        }
    }

    function cerrarReceptor() {
        if (!receptorTemporal) return;
        clearTimeout(receptorTemporal.vencimiento);
        receptorTemporal.servidor.close();
        receptorTemporal = null;
    }

    async function prepararReceptor() {
        const destino = new URL(googleAuth.redirectUri);
        const local = ["localhost", "127.0.0.1"].includes(destino.hostname);
        const puerto = Number(destino.port || 80);
        if (!local || puerto === server.address().port || receptorTemporal) return;

        const servidor = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${puerto}`);
            if (url.pathname !== destino.pathname) {
                res.writeHead(404).end();
                return;
            }
            manejarCallback(Object.fromEntries(url.searchParams), res).finally(cerrarReceptor);
        });
        await new Promise((resolve, reject) => {
            servidor.once("error", (e) => reject(e.code === "EADDRINUSE"
                ? new Error(`El puerto ${puerto} está ocupado (¿está corriendo el Proyecto B?). Cerralo e intentá de nuevo.`)
                : e));
            servidor.listen(puerto, resolve);
        });
        receptorTemporal = { servidor, vencimiento: setTimeout(cerrarReceptor, 5 * 60 * 1000) };
        receptorTemporal.vencimiento.unref?.();
    }

    app.get("/auth/google", async (req, res) => {
        try {
            const url = googleAuth.urlAutorizacion();
            await prepararReceptor();
            res.redirect(url);
        } catch (e) {
            paginaResultado(res, false, e.message);
        }
    });
    app.get(new URL(config.credenciales.googleRedirectUri).pathname, (req, res) => manejarCallback(req.query, res));
    app.post("/api/auth/google/cerrar", ruta(() => {
        googleAuth.cerrarSesion();
        registrar("Sesión de Google cerrada.");
        difundirEstado();
    }));

    // --- Hardware ---
    app.get("/api/hardware/puertos", ruta(async () => ({ puertos: await ServoSerialDriver.listarPuertos() })));
    app.post("/api/hardware/conectar", ruta(async (datos) => {
        await servo.conectar(datos);
        ultimaPlaca = { tipo: datos.tipo, ip: datos.ip, puerto: datos.puerto, baudios: datos.baudios };
        guardarAjustes();
    }));
    app.post("/api/hardware/desconectar", ruta(async () => {
        await servo.desconectar();
    }));
    app.post("/api/hardware/calibracion", ruta(async ({ activa }) => {
        servo.calibrando = Boolean(activa);
        registrar(servo.calibrando ? "Modo calibración ACTIVADO: la aguja obedece al panel." : "Modo calibración desactivado.");
        if (!servo.calibrando && monitor.ultimaLectura && monitor.ultimaLectura.angulo !== null) {
            await servo.mover({ ...servo.ultimoComando, angle: monitor.ultimaLectura.angulo, manual: false });
        }
        difundirEstado();
    }));
    app.post("/api/hardware/probar", ruta(async ({ angulo }) => {
        if (!servo.calibrando) throw new Error("Activá el modo calibración para mover la aguja a mano.");
        await servo.probar(angulo);
    }));

    io.on("connection", (socket) => {
        socket.emit("estado", estadoCompleto());
        socket.emit("historial", monitor.historial);
        socket.emit("logs", logs);
    });

    async function cerrar() {
        cerrarReceptor();
        monitor.detener({ silencioso: true });
        await servo.desconectar();
        io.close();
        await new Promise((resolve) => server.close(() => resolve()));
    }

    return { app, server, io, monitor, servo, mapeador, googleAuth, estadoCompleto, registrar, cerrar, ultimaPlaca: () => ultimaPlaca };
}

module.exports = { crearApp };
