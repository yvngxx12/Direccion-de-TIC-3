const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { crearEmulador } = require("../tools/emulador-esp");
const { ControladorServo } = require("../src/hardware/ControladorServo");
const { ServoSerialDriver } = require("../src/hardware/ServoSerialDriver");
const { esperarHasta } = require("./helpers");

async function levantarEmulador(t) {
    const { server, estado } = crearEmulador({ silencioso: true });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => server.close(r)));
    return { ip: `127.0.0.1:${server.address().port}`, estado, server };
}

test("HTTP: conecta, envía ángulos y la aguja emulada se mueve suave", async (t) => {
    const emu = await levantarEmulador(t);
    const servo = new ControladorServo({ latidoMs: 0 });
    t.after(() => servo.desconectar());

    const estado = await servo.conectar({ tipo: "http", ip: `http://${emu.ip}/` });
    assert.equal(estado.conectado, true);
    assert.equal(estado.tipo, "http");

    await servo.mover({ angle: 120, viewers: 600, trend: "up", live: true });
    assert.equal(emu.estado.objetivo, 120);
    assert.equal(emu.estado.viewers, 600);
    // La aguja no salta: tarda ~1 s en recorrer 120° a 120°/s.
    assert.ok(emu.estado.angulo < 120);
    await esperarHasta(() => emu.estado.angulo === 120, { timeoutMs: 2500 });
    assert.ok(servo.estado().latenciaMs !== null);
});

test("HTTP: IP inválida da error claro y no queda conectado", async () => {
    const servo = new ControladorServo({ latidoMs: 0 });
    await assert.rejects(servo.conectar({ tipo: "http", ip: "127.0.0.1:1" }), /No se pudo conectar con la placa/);
    assert.equal(servo.estado().conectado, false);
    await assert.rejects(servo.conectar({ tipo: "bluetooth" }), /Tipo de conexión inválido/);
});

test("HTTP: si la placa se cae, se marca desconectada y se recupera sola", async (t) => {
    const emu = await levantarEmulador(t);
    const servo = new ControladorServo({ latidoMs: 0 });
    t.after(() => servo.desconectar());
    await servo.conectar({ tipo: "http", ip: emu.ip });

    const puerto = emu.server.address().port;
    await new Promise((r) => emu.server.close(r));
    emu.server.closeAllConnections?.();
    await servo.mover({ angle: 50 });
    assert.equal(servo.estado().conectado, false);
    assert.equal(servo.estado().errores, 1);

    // Vuelve la placa en el mismo puerto.
    await new Promise((r) => emu.server.listen(puerto, "127.0.0.1", r));
    await servo.mover({ angle: 60 });
    assert.equal(servo.estado().conectado, true);
    assert.equal(emu.estado.objetivo, 60);
});

test("latido: reenvía el último ángulo periódicamente", async (t) => {
    const emu = await levantarEmulador(t);
    const servo = new ControladorServo({ latidoMs: 40 });
    t.after(() => servo.desconectar());
    await servo.conectar({ tipo: "http", ip: emu.ip });
    await servo.mover({ angle: 33 });
    const antes = emu.estado.comandos.length;
    await esperarHasta(() => emu.estado.comandos.length >= antes + 3);
    assert.ok(emu.estado.comandos.slice(-3).every((c) => c.angle === 33));
});

test("calibración: bloquea al monitor y permite mover a mano", async (t) => {
    const emu = await levantarEmulador(t);
    const servo = new ControladorServo({ latidoMs: 0 });
    t.after(() => servo.desconectar());
    await servo.conectar({ tipo: "http", ip: emu.ip });
    servo.calibrando = true;
    await servo.mover({ angle: 100 });
    assert.equal(emu.estado.objetivo, 0, "el monitor no debe mover la aguja en calibración");
    await servo.probar(45);
    assert.equal(emu.estado.objetivo, 45);
    assert.throws(() => servo.probar(200), /entre 0 y 180/);
});

test("comandos simultáneos: se envía siempre el más reciente", async (t) => {
    const emu = await levantarEmulador(t);
    const servo = new ControladorServo({ latidoMs: 0 });
    t.after(() => servo.desconectar());
    await servo.conectar({ tipo: "http", ip: emu.ip });
    const inicio = emu.estado.comandos.length;
    await Promise.all([10, 20, 30, 40, 50].map((a) => servo.mover({ angle: a })));
    await esperarHasta(() => emu.estado.objetivo === 50);
    const recibidos = emu.estado.comandos.slice(inicio).map((c) => c.angle);
    assert.equal(recibidos[0], 10);
    assert.equal(recibidos.at(-1), 50);
    assert.ok(recibidos.length <= 3, `se esperaban como mucho 3 envíos, hubo ${recibidos.length}`);
});

// ------------------------------------------------------------ Serie (puerto simulado)

class SerialFalso extends EventEmitter {
    constructor({ path }) {
        super();
        this.path = path;
        this.isOpen = false;
        this.escrito = [];
        SerialFalso.ultimo = this;
    }
    open(cb) {
        if (this.path === "COM_OCUPADO") return cb(new Error("Opening COM_OCUPADO: Access denied"));
        this.isOpen = true;
        cb(null);
        // La placa saluda al arrancar
        setImmediate(() => this.emit("data", Buffer.from('{"log":"WiFi conectado","ip":"192.168.1.9"}\n')));
    }
    write(texto, cb) {
        this.escrito.push(texto);
        cb && cb(null);
        const comando = JSON.parse(texto);
        // Responde partido en dos pedazos, como pasa en un puerto serie real.
        const respuesta = `{"ok":true,"angle":${comando.angle},"target":${comando.angle}}\n`;
        setImmediate(() => {
            this.emit("data", Buffer.from(respuesta.slice(0, 7)));
            this.emit("data", Buffer.from(respuesta.slice(7)));
        });
    }
    close(cb) {
        this.isOpen = false;
        this.emit("close");
        cb && cb();
    }
}

test("Serie: envía líneas JSON y separa logs de respuestas", async (t) => {
    const servo = new ControladorServo({ latidoMs: 0 });
    const logs = [];
    servo.on("log", (l) => logs.push(l));
    t.after(() => servo.desconectar());

    await servo.conectar({ tipo: "serial", puerto: "COM7" }, { SerialPortClase: SerialFalso });
    await esperarHasta(() => logs.some((l) => l.includes("WiFi conectado (192.168.1.9)")));

    const r = await servo.mover({ angle: 77, viewers: 10, live: true });
    assert.deepEqual(r, { ok: true, angle: 77, target: 77 });
    assert.equal(SerialFalso.ultimo.escrito.at(-1), '{"angle":77,"viewers":10,"live":true}\n');
});

test("Serie: puerto ocupado da un mensaje útil", async () => {
    const servo = new ControladorServo({ latidoMs: 0 });
    await assert.rejects(
        servo.conectar({ tipo: "serial", puerto: "COM_OCUPADO" }, { SerialPortClase: SerialFalso }),
        /ocupado.*Monitor Serie/
    );
});

test("Serie: el paquete serialport está disponible para listar puertos", async () => {
    const puertos = await ServoSerialDriver.listarPuertos();
    assert.ok(Array.isArray(puertos));
});
