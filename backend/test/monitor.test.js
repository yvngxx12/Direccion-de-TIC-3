const test = require("node:test");
const assert = require("node:assert/strict");
const { MonitorAudiencia } = require("../src/core/MonitorAudiencia");
const { MapeadorAudiencia } = require("../src/core/MapeadorAudiencia");
const { ErrorProveedor } = require("../src/providers/http");
const { esperarHasta } = require("./helpers");

// Proveedor falso que devuelve una secuencia de resultados (números, "offline" o errores).
function proveedorGuion(guion) {
    let i = 0;
    const siguiente = async () => {
        const paso = guion[Math.min(i++, guion.length - 1)];
        if (paso instanceof Error) throw paso;
        if (paso === "offline") return { viewers: null, enVivo: false, aviso: "offline" };
        return { viewers: paso, enVivo: true, titulo: "t", canal: "c" };
    };
    return { plataforma: "falso", descripcion: () => "falso", conectar: siguiente, leer: siguiente, get lecturas() { return i; } };
}

function servoFalso() {
    const comandos = [];
    return { comandos, mover: async (c) => comandos.push(c) };
}

function crearMonitor(proveedor, opciones = {}) {
    const servo = servoFalso();
    const monitor = new MonitorAudiencia({
        mapeador: new MapeadorAudiencia({ suavizado: 1, zonaMuerta: 0 }),
        servo,
        monitor: { intervaloMs: 30, intervaloSimuladorMs: 30, maxBackoffMs: 200, ...opciones },
        crearProveedor: () => proveedor
    });
    return { monitor, servo };
}

test("lee periódicamente y mueve el servo en cada cambio", async (t) => {
    const p = proveedorGuion([0, 500, 1000]);
    const { monitor, servo } = crearMonitor(p);
    t.after(() => monitor.detener({ silencioso: true }));
    await monitor.conectar("x");
    await esperarHasta(() => servo.comandos.length >= 3);
    assert.deepEqual(servo.comandos.slice(0, 3).map((c) => c.angle), [0, 90, 180]);
    assert.equal(servo.comandos[1].live, true);
    assert.equal(servo.comandos[1].viewers, 500);
    assert.equal(servo.comandos[2].trend, "up");
    assert.equal(monitor.estado().estado, "en_vivo");
    assert.equal(monitor.estadisticas.pico, 1000);
});

test("ante errores reintentables aplica backoff y se recupera solo", async (t) => {
    const fallo = () => new ErrorProveedor("caída", "RED");
    const p = proveedorGuion([500, fallo(), fallo(), fallo(), 700]);
    const { monitor, servo } = crearMonitor(p);
    t.after(() => monitor.detener({ silencioso: true }));
    const estados = [];
    monitor.on("cambio", () => estados.push(monitor.estadoActual));

    await monitor.conectar("x");
    await esperarHasta(() => monitor.ultimaLectura && monitor.ultimaLectura.viewers === 700, { timeoutMs: 4000 });
    assert.ok(estados.includes("reintentando"));
    assert.equal(monitor.estado().estado, "en_vivo");
    assert.equal(monitor.estadisticas.errores, 3);
    // Al empezar a fallar, la aguja fue a "sin señal" (0°) y después volvió.
    const angulos = servo.comandos.map((c) => c.angle);
    assert.deepEqual([angulos[0], angulos[1]], [90, 0]);
    assert.equal(servo.comandos[1].live, false);
    assert.equal(angulos.at(-1), 126);
});

test("la espera entre reintentos crece y respeta el máximo", () => {
    const { monitor } = crearMonitor(proveedorGuion([1]), { intervaloMs: 1000, maxBackoffMs: 5000 });
    monitor.proveedor = { plataforma: "falso" };
    const esperas = [1, 2, 3, 4, 5].map((n) => {
        monitor.erroresSeguidos = n;
        return monitor.esperaBackoff();
    });
    assert.deepEqual(esperas, [1000, 2000, 4000, 5000, 5000]);
    monitor.proveedor = null;
});

test("un error definitivo detiene el monitoreo", async () => {
    const p = proveedorGuion([new ErrorProveedor("API key inválida", "AUTH", { reintentable: false })]);
    const { monitor } = crearMonitor(p);
    await assert.rejects(monitor.conectar("x"), /API key inválida/);
    assert.equal(monitor.estado().estado, "error");
    assert.equal(monitor.estado().ultimoError.codigo, "AUTH");
    assert.equal(monitor.proveedor, null);
});

test("stream offline lleva la aguja al mínimo y sigue consultando", async (t) => {
    const p = proveedorGuion([800, "offline", "offline", 400]);
    const { monitor, servo } = crearMonitor(p);
    t.after(() => monitor.detener({ silencioso: true }));
    await monitor.conectar("x");
    await esperarHasta(() => monitor.ultimaLectura && monitor.ultimaLectura.viewers === 400);
    assert.deepEqual(servo.comandos.map((c) => c.angle), [144, 0, 72]);
});

test("cambiar de stream invalida lecturas viejas", async () => {
    let resolverLento;
    const lento = {
        plataforma: "falso",
        descripcion: () => "lento",
        conectar: () => new Promise((r) => (resolverLento = r)),
        leer: async () => ({ viewers: 1, enVivo: true })
    };
    const rapido = proveedorGuion([1000]);
    const fuentes = [lento, rapido];
    const servo = servoFalso();
    const monitor = new MonitorAudiencia({
        mapeador: new MapeadorAudiencia({ suavizado: 1, zonaMuerta: 0 }),
        servo,
        monitor: { intervaloMs: 10000, intervaloSimuladorMs: 10000, maxBackoffMs: 10000 },
        crearProveedor: () => fuentes.shift()
    });
    const primera = monitor.conectar("lento");
    await monitor.conectar("rapido");
    resolverLento({ viewers: 0, enVivo: true }); // llega tarde: debe ignorarse
    await primera;
    assert.equal(monitor.ultimaLectura.viewers, 1000);
    assert.deepEqual(servo.comandos.map((c) => c.angle), [180]);
    monitor.detener({ silencioso: true });
});

test("detener lleva la aguja a sin señal y frena el bucle", async () => {
    const p = proveedorGuion([500]);
    const { monitor, servo } = crearMonitor(p);
    await monitor.conectar("x");
    monitor.detener();
    const lecturas = p.lecturas;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(p.lecturas, lecturas, "no debe seguir leyendo");
    assert.equal(monitor.estado().estado, "detenido");
    assert.equal(servo.comandos.at(-1).angle, 0);
});

test("valida el intervalo de consulta", () => {
    const { monitor } = crearMonitor(proveedorGuion([1]));
    assert.throws(() => monitor.configurar({ intervaloMs: 100 }), /al menos 2000/);
    monitor.configurar({ intervaloMs: 20000 });
    assert.equal(monitor.opciones.intervaloMs, 20000);
});
