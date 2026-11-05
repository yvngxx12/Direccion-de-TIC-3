// Panel de control del Indicador de Audiencia.
// Se comunica con el backend por REST (acciones) y Socket.IO (estado en tiempo real).

const $ = (id) => document.getElementById(id);
const socket = io();
const medidor = new Medidor($("medidor"));

let estado = null;
let historial = [];
let formulariosCargados = false;

// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------
async function api(ruta, datos) {
    const opciones = datos === undefined
        ? {}
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos) };
    const respuesta = await fetch(ruta, opciones);
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw new Error(cuerpo.error || `Error HTTP ${respuesta.status}`);
    return cuerpo;
}

let temporizadorToast = null;
function avisar(mensaje, esError = false) {
    const t = $("toast");
    t.textContent = mensaje;
    t.classList.toggle("error", esError);
    t.classList.remove("oculto");
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => t.classList.add("oculto"), esError ? 6000 : 2500);
}

// Ejecuta una acción mostrando el error si falla y deshabilitando el botón mientras tanto.
async function accion(boton, fn, exito) {
    if (boton) boton.disabled = true;
    try {
        const r = await fn();
        if (r && r.monitor) render(r);
        if (exito) avisar(exito);
    } catch (e) {
        avisar(e.message, true);
    } finally {
        if (boton) boton.disabled = false;
    }
}

function chip(id, clase, texto) {
    const c = $(id);
    c.className = `chip ${clase || ""}`;
    c.lastChild.textContent = texto;
}

const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("es-AR"));

// ------------------------------------------------------------------
// Render del estado
// ------------------------------------------------------------------
const NOMBRES_ESTADO = {
    detenido: ["", "Stream: detenido"],
    conectando: ["alerta", "Stream: conectando…"],
    en_vivo: ["ok", "Stream: en vivo"],
    offline: ["alerta", "Stream: offline"],
    reintentando: ["error", "Stream: reintentando"],
    error: ["error", "Stream: error"]
};

function render(e) {
    estado = e;
    const m = e.monitor;
    const lectura = m.ultimaLectura;

    const [clase, texto] = NOMBRES_ESTADO[m.estado] || ["", m.estado];
    chip("chipStream", clase, texto);
    chip("chipPlaca", e.servo.conectado ? "ok" : e.servo.tipo !== "ninguno" ? "error" : "", e.servo.conectado ? `Placa: ${e.servo.tipo === "http" ? "WiFi" : "USB"}` : "Placa: sin conectar");

    $("fuenteActual").textContent = m.fuente || "Sin fuente conectada";
    medidor.actualizarEscala(e.mapeo, (lectura && lectura.rango) || e.rango);

    if (lectura) {
        $("numViewers").textContent = lectura.viewers === null ? "—" : fmt(lectura.viewers);
        $("numAngulo").textContent = lectura.angulo === null ? "—" : `${lectura.angulo}°`;
        $("numPorcentaje").textContent = lectura.porcentaje === undefined ? "—" : `${lectura.porcentaje}%`;
        const t = lectura.tendencia;
        const elT = $("numTendencia");
        elT.className = t ? t.direccion : "";
        elT.textContent = t ? `${{ subiendo: "▲", bajando: "▼", estable: "■" }[t.direccion]} ${t.cambio > 0 ? "+" : ""}${t.cambio}%` : "—";
        $("tituloStream").textContent = [lectura.canal, lectura.titulo].filter(Boolean).join(" · ");
        if (!e.servo.calibrando && lectura.angulo !== null) medidor.fijarObjetivo(lectura.angulo);
    } else {
        for (const id of ["numViewers", "numAngulo", "numPorcentaje", "numTendencia"]) $(id).textContent = "—";
        $("numTendencia").className = "";
        $("tituloStream").textContent = "";
        if (!e.servo.calibrando) medidor.fijarObjetivo(e.servo.ultimoComando ? e.servo.ultimoComando.angle : 0);
    }

    const aviso = $("aviso");
    if (m.ultimoError) {
        aviso.textContent = m.ultimoError.mensaje;
        aviso.className = "aviso error";
    } else if (lectura && lectura.aviso) {
        aviso.textContent = lectura.aviso;
        aviso.className = "aviso";
    } else {
        aviso.className = "aviso oculto";
    }

    $("numPico").textContent = fmt(m.estadisticas.pico || null);
    $("estLecturas").textContent = fmt(m.estadisticas.lecturas);
    $("estErrores").textContent = fmt(m.estadisticas.errores);
    $("estLatApi").textContent = m.estadisticas.latenciaApiMs === null ? "—" : `${m.estadisticas.latenciaApiMs} ms`;
    $("estLatPlaca").textContent = e.servo.latenciaMs === null ? "—" : `${e.servo.latenciaMs} ms`;
    $("estIntervalo").textContent = `${(m.intervaloMs / 1000).toFixed(m.intervaloMs < 2000 ? 1 : 0)} s`;

    $("credEstado").textContent = `· API key ${e.credenciales.youtubeApiKey ? "✓" : "✗"} · Twitch ${e.credenciales.twitch ? "✓" : "✗"}`;

    const g = e.credenciales.google;
    $("bloqueGoogle").classList.toggle("ok", g.autenticado);
    $("googleEstado").textContent = !g.configurado
        ? "Faltan GOOGLE_CLIENT_ID / SECRET en backend/.env"
        : g.autenticado
            ? `Sesión iniciada${g.cuenta ? `: ${g.cuenta}` : ""}`
            : "Sin sesión: necesaria para leer YouTube sin API key";
    $("btnGoogle").classList.toggle("oculto", g.autenticado);
    $("btnGoogle").classList.toggle("deshabilitado", !g.configurado);
    $("btnGoogleSalir").classList.toggle("oculto", !g.autenticado);

    // Placa
    const s = e.servo;
    let detalle = s.descripcion;
    if (s.conectado) detalle += ` · ${s.enviados} comandos enviados`;
    if (s.ultimoError) detalle += ` · último error: ${s.ultimoError}`;
    $("placaDetalle").textContent = detalle;
    $("chkCalibrar").checked = s.calibrando;
    for (const b of document.querySelectorAll(".btn-angulo, #anguloManual")) b.disabled = !s.calibrando;

    // Escenarios del simulador
    const cont = $("escenarios");
    if (!cont.childElementCount) {
        for (const [clave, descripcion] of Object.entries(e.escenarios)) {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = clave[0].toUpperCase() + clave.slice(1);
            b.title = descripcion;
            b.dataset.escenario = clave;
            b.addEventListener("click", () => accion(b, () => api("/api/simulador", { escenario: clave, viewers: null, offline: false }), descripcion));
            cont.appendChild(b);
        }
    }
    for (const b of cont.children) {
        b.classList.toggle("activo", m.plataforma === "simulador" && m.escenario === b.dataset.escenario);
    }

    if (!formulariosCargados) cargarFormularios(e);
}

function cargarFormularios(e) {
    formulariosCargados = true;
    const f = $("formMapeo");
    for (const [clave, valor] of Object.entries(e.mapeo)) {
        const campo = f.elements[clave];
        if (!campo) continue;
        if (campo.type === "checkbox") campo.checked = valor;
        else campo.value = valor;
    }
    f.elements.intervaloS.value = Math.round(e.intervaloApiMs / 1000);
    $("salSuavizado").textContent = e.mapeo.suavizado;

    const fe = $("formEstilo");
    for (const [clave, valor] of Object.entries(e.estilo)) {
        const campo = fe.elements[clave];
        if (!campo) continue;
        if (campo.type === "checkbox") campo.checked = valor;
        else if (campo.type === "color") campo.value = /^#[0-9a-f]{6}$/i.test(valor) ? valor : "#ffffff";
        else campo.value = valor;
    }

    if (e.monitor.entrada && e.monitor.entrada !== "simulador") $("entradaStream").value = e.monitor.entrada;
    if (e.placaGuardada) {
        const tipo = e.placaGuardada.tipo;
        document.querySelector(`#formPlaca input[value="${tipo}"]`).checked = true;
        if (e.placaGuardada.ip) $("placaIp").value = e.placaGuardada.ip;
        cambiarTipoPlaca();
    }
}

// ------------------------------------------------------------------
// Gráfico del historial (canvas, sin librerías)
// ------------------------------------------------------------------
function dibujarGrafico() {
    const canvas = $("grafico");
    const dpr = window.devicePixelRatio || 1;
    const ancho = canvas.clientWidth;
    const alto = 160;
    if (canvas.width !== ancho * dpr) {
        canvas.width = ancho * dpr;
        canvas.height = alto * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ancho, alto);

    const datos = historial.slice(-120);
    ctx.strokeStyle = "#1c2538";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = 8 + (i * (alto - 24)) / 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(ancho, y);
        ctx.stroke();
    }
    if (datos.length < 2) {
        ctx.fillStyle = "#5b6886";
        ctx.font = "12px Segoe UI, sans-serif";
        ctx.fillText("Esperando lecturas…", 10, alto / 2);
        return;
    }

    const maxV = Math.max(10, ...datos.map((d) => d.viewers)) * 1.1;
    const x = (i) => (i / (datos.length - 1)) * (ancho - 4) + 2;
    const yV = (v) => 8 + (1 - v / maxV) * (alto - 24);
    const yA = (a) => 8 + (1 - a / 180) * (alto - 24);

    function linea(valor, y, color, relleno) {
        ctx.beginPath();
        datos.forEach((d, i) => (i ? ctx.lineTo(x(i), y(valor(d))) : ctx.moveTo(x(i), y(valor(d)))));
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.stroke();
        if (relleno) {
            ctx.lineTo(x(datos.length - 1), alto - 16);
            ctx.lineTo(x(0), alto - 16);
            ctx.closePath();
            const g = ctx.createLinearGradient(0, 0, 0, alto);
            g.addColorStop(0, "rgba(34, 211, 238, 0.25)");
            g.addColorStop(1, "rgba(34, 211, 238, 0)");
            ctx.fillStyle = g;
            ctx.fill();
        }
    }
    linea((d) => d.viewers, yV, "#22d3ee", true);
    linea((d) => d.angulo ?? 0, yA, "#a78bfa", false);

    ctx.fillStyle = "#5b6886";
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.fillText(`máx ${formatearViewers(maxV / 1.1)}`, 6, alto - 2);
}
window.addEventListener("resize", dibujarGrafico);

// ------------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------------
socket.on("connect", () => chip("chipSocket", "ok", "Servidor: conectado"));
socket.on("disconnect", () => chip("chipSocket", "error", "Servidor: desconectado"));
socket.on("estado", render);
socket.on("historial", (h) => {
    historial = h;
    dibujarGrafico();
});
socket.on("lectura", (l) => {
    if (l.enVivo && l.viewers !== null) {
        historial.push({ t: l.fecha, viewers: l.viewers, angulo: l.angulo });
        if (historial.length > 300) historial.shift();
        dibujarGrafico();
    }
    if (estado) render({ ...estado, monitor: { ...estado.monitor, ultimaLectura: l } });
});

function agregarLog(entrada) {
    const li = document.createElement("li");
    const hora = document.createElement("time");
    hora.textContent = new Date(entrada.fecha).toLocaleTimeString("es-AR");
    li.append(hora, entrada.mensaje);
    const log = $("log");
    log.prepend(li);
    while (log.childElementCount > 150) log.lastChild.remove();
}
socket.on("logs", (lista) => {
    $("log").innerHTML = "";
    lista.forEach(agregarLog);
});
socket.on("log", agregarLog);

// ------------------------------------------------------------------
// Acciones
// ------------------------------------------------------------------
$("formStream").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const entrada = $("entradaStream").value.trim();
    accion($("btnConectar"), () => api("/api/stream/conectar", { entrada }), "Conectado");
});
$("btnLeer").addEventListener("click", (ev) => accion(ev.currentTarget, () => api("/api/stream/leer", {})));
$("btnDetener").addEventListener("click", (ev) => accion(ev.currentTarget, () => api("/api/stream/detener", {}), "Monitoreo detenido"));

$("entradaStream").addEventListener("input", (ev) => {
    const v = ev.target.value.toLowerCase();
    let ayuda = "Ej.: https://www.youtube.com/watch?v=… · https://youtube.com/@canal · https://twitch.tv/canal";
    if (v.includes("twitch")) ayuda = "Twitch: se necesita Client ID y Secret (ver Credenciales).";
    else if (v.includes("youtu") || v.startsWith("@")) ayuda = "YouTube: iniciá sesión con Google (botón de abajo) o cargá una API key.";
    else if (v === "simulador") ayuda = "Simulador: no necesita internet ni credenciales.";
    $("ayudaEntrada").textContent = ayuda;
});

$("formCred").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const datos = {};
    if ($("credYoutube").value) datos.youtubeApiKey = $("credYoutube").value;
    if ($("credTwitchId").value) datos.twitchClientId = $("credTwitchId").value;
    if ($("credTwitchSecret").value) datos.twitchClientSecret = $("credTwitchSecret").value;
    accion(ev.submitter, () => api("/api/config/credenciales", datos), "Credenciales guardadas en memoria");
    ev.target.reset();
});

$("btnGoogleSalir").addEventListener("click", (ev) =>
    accion(ev.currentTarget, () => api("/api/auth/google/cerrar", {}), "Sesión de Google cerrada")
);

// Simulador manual
$("manualViewers").addEventListener("input", (ev) => ($("manualSalida").textContent = ev.target.value));
$("btnFijar").addEventListener("click", (ev) =>
    accion(ev.currentTarget, () => api("/api/simulador", { viewers: Number($("manualViewers").value), offline: false }))
);
$("btnSoltar").addEventListener("click", (ev) => accion(ev.currentTarget, () => api("/api/simulador", { viewers: null })));
$("btnOffline").addEventListener("click", (ev) => {
    const offline = estado && estado.monitor.estado !== "offline";
    accion(ev.currentTarget, () => api("/api/simulador", { offline }));
});

// Calibración del mapeo
$("formMapeo").elements.suavizado.addEventListener("input", (ev) => ($("salSuavizado").textContent = ev.target.value));
$("formMapeo").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    const mapeo = {
        modo: f.modo.value,
        sinSenal: f.sinSenal.value,
        viewersMin: Number(f.viewersMin.value),
        viewersMax: Number(f.viewersMax.value),
        anguloMin: Number(f.anguloMin.value),
        anguloMax: Number(f.anguloMax.value),
        suavizado: Number(f.suavizado.value),
        zonaMuerta: Number(f.zonaMuerta.value),
        invertir: f.invertir.checked
    };
    accion(ev.submitter, async () => {
        await api("/api/config/mapeo", mapeo);
        return api("/api/config/monitor", { intervaloMs: Number(f.intervaloS.value) * 1000 });
    }, "Calibración aplicada");
});

// Placa
function cambiarTipoPlaca() {
    const tipo = document.querySelector("#formPlaca input[name=tipo]:checked").value;
    document.querySelector(".solo-http").classList.toggle("oculto", tipo !== "http");
    document.querySelector(".solo-serial").classList.toggle("oculto", tipo !== "serial");
    if (tipo === "serial" && $("placaPuerto").options.length <= 1) buscarPuertos();
}
for (const r of document.querySelectorAll("#formPlaca input[name=tipo]")) r.addEventListener("change", cambiarTipoPlaca);

async function buscarPuertos() {
    try {
        const { puertos } = await api("/api/hardware/puertos");
        const sel = $("placaPuerto");
        sel.innerHTML = `<option value="">${puertos.length ? "Elegí un puerto…" : "No se encontraron puertos"}</option>`;
        for (const p of puertos) {
            const o = document.createElement("option");
            o.value = p.ruta;
            o.textContent = `${p.ruta} ${p.fabricante ? `· ${p.fabricante}` : ""}${p.probableESP ? " (NodeMCU?)" : ""}`;
            if (p.probableESP && !sel.value) o.selected = true;
            sel.appendChild(o);
        }
    } catch (e) {
        avisar(e.message, true);
    }
}
$("btnPuertos").addEventListener("click", buscarPuertos);

$("formPlaca").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const tipo = ev.target.elements.tipo.value;
    const datos = tipo === "http" ? { tipo, ip: $("placaIp").value } : { tipo, puerto: $("placaPuerto").value, baudios: 115200 };
    accion(ev.submitter, () => api("/api/hardware/conectar", datos), "Placa conectada");
});
$("btnDesconectarPlaca").addEventListener("click", (ev) => accion(ev.currentTarget, () => api("/api/hardware/desconectar", {})));

$("chkCalibrar").addEventListener("change", (ev) => accion(null, () => api("/api/hardware/calibracion", { activa: ev.target.checked })));

let temporizadorAngulo = null;
function moverManual(angulo) {
    $("anguloManual").value = angulo;
    $("anguloManualSalida").textContent = `${angulo}°`;
    medidor.fijarObjetivo(angulo);
    clearTimeout(temporizadorAngulo);
    temporizadorAngulo = setTimeout(() => accion(null, () => api("/api/hardware/probar", { angulo })), 80);
}
$("anguloManual").addEventListener("input", (ev) => moverManual(Number(ev.target.value)));
for (const b of document.querySelectorAll(".btn-angulo")) b.addEventListener("click", () => moverManual(Number(b.dataset.angulo)));

// Estilo del overlay
$("formEstilo").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = ev.target.elements;
    const datos = {
        titulo: f.titulo.value,
        escala: Number(f.escala.value),
        colorAcento: f.colorAcento.value,
        colorTexto: f.colorTexto.value,
        mostrarNumero: f.mostrarNumero.checked,
        mostrarTendencia: f.mostrarTendencia.checked
    };
    accion(ev.submitter, () => api("/api/config/estilo", datos), "Estilo aplicado al overlay");
});

const urlOverlay = `${location.origin}/overlay.html`;
$("urlOverlay").textContent = urlOverlay;
$("btnCopiar").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(urlOverlay);
        avisar("URL copiada");
    } catch {
        avisar("No se pudo copiar; seleccioná el texto a mano.", true);
    }
});

dibujarGrafico();
