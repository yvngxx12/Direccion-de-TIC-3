// Administra la conexión con la placa y decide cuándo mandarle comandos.
//
// - Solo un comando a la vez (si llega otro mientras se envía, se guarda el último).
// - "Latido": reenvía el último ángulo cada N segundos para que la placa sepa que
//   el backend sigue vivo (si deja de recibirlos, la placa lleva la aguja a 0).
// - Modo calibración: mientras está activo, la aguja obedece al panel y no a la audiencia.

const { EventEmitter } = require("events");
const { ServoHttpDriver } = require("./ServoHttpDriver");
const { ServoSerialDriver } = require("./ServoSerialDriver");

class ControladorServo extends EventEmitter {

    constructor({ latidoMs = 5000, fetch } = {}) {
        super();
        this.latidoMs = latidoMs;
        this.fetch = fetch;
        this.driver = null;
        this.conectado = false;
        this.ultimoComando = null;
        this.ultimaRespuesta = null;
        this.ultimoError = null;
        this.enviados = 0;
        this.errores = 0;
        this.latenciaMs = null;
        this.calibrando = false;
        this.enviando = false;
        this.pendiente = null;
        this.temporizadorLatido = null;
    }

    estado() {
        return {
            conectado: this.conectado,
            tipo: this.driver ? this.driver.tipo : "ninguno",
            descripcion: this.driver ? this.driver.descripcion() : "Sin placa (solo simulación en pantalla)",
            ultimoComando: this.ultimoComando,
            ultimaRespuesta: this.ultimaRespuesta,
            ultimoError: this.ultimoError,
            enviados: this.enviados,
            errores: this.errores,
            latenciaMs: this.latenciaMs,
            calibrando: this.calibrando
        };
    }

    async conectar({ tipo, ip, puerto, baudios } = {}, { SerialPortClase } = {}) {
        await this.desconectar();
        if (tipo === "http") {
            this.driver = new ServoHttpDriver(ip, { fetch: this.fetch });
        } else if (tipo === "serial") {
            this.driver = new ServoSerialDriver(puerto, { baudios, SerialPortClase });
            this.driver.on("log", (linea) => this.emit("log", `Placa: ${linea}`));
            this.driver.on("cerrado", () => {
                this.conectado = false;
                this.emit("log", "Se cerró el puerto serie.");
                this.emit("cambio");
            });
            this.driver.on("error", (e) => {
                this.ultimoError = e.message;
                this.emit("cambio");
            });
        } else {
            throw new Error('Tipo de conexión inválido. Usá "http" (WiFi) o "serial" (USB).');
        }

        try {
            this.ultimaRespuesta = await this.driver.conectar();
            this.conectado = true;
            this.ultimoError = null;
            this.emit("log", `Placa conectada (${this.driver.descripcion()}).`);
        } catch (e) {
            this.conectado = false;
            this.ultimoError = e.message;
            const descripcion = this.driver.descripcion();
            this.driver = null;
            this.emit("cambio");
            throw new Error(`No se pudo conectar con la placa (${descripcion}): ${e.message}`);
        }

        this.iniciarLatido();
        if (this.ultimoComando) await this.enviar(this.ultimoComando);
        this.emit("cambio");
        return this.estado();
    }

    async desconectar() {
        clearInterval(this.temporizadorLatido);
        this.temporizadorLatido = null;
        if (this.driver) {
            try {
                await this.driver.cerrar();
            } catch {
                // ignorar
            }
        }
        const habia = Boolean(this.driver);
        this.driver = null;
        this.conectado = false;
        if (habia) {
            this.emit("log", "Placa desconectada.");
            this.emit("cambio");
        }
    }

    iniciarLatido() {
        clearInterval(this.temporizadorLatido);
        if (!this.latidoMs) return;
        this.temporizadorLatido = setInterval(() => {
            if (this.ultimoComando && this.driver) this.enviar(this.ultimoComando, { latido: true });
        }, this.latidoMs);
        this.temporizadorLatido.unref?.();
    }

    // Comando que viene del monitor de audiencia. Se ignora durante la calibración.
    mover(comando) {
        if (this.calibrando) return Promise.resolve(null);
        return this.enviar(comando);
    }

    // Comando manual desde el panel (calibración / prueba).
    probar(angulo) {
        const a = Math.round(Number(angulo));
        if (!Number.isFinite(a) || a < 0 || a > 180) {
            throw new Error("El ángulo debe estar entre 0 y 180.");
        }
        return this.enviar({ ...(this.ultimoComando || {}), angle: a, manual: true });
    }

    async enviar(comando, { latido = false } = {}) {
        this.ultimoComando = comando;
        if (!this.driver) {
            if (!latido) this.emit("cambio");
            return null;
        }
        if (this.enviando) {
            this.pendiente = comando; // se manda el más reciente al terminar
            return null;
        }
        this.enviando = true;
        const inicio = Date.now();
        try {
            this.ultimaRespuesta = await this.driver.enviar(comando);
            this.latenciaMs = Date.now() - inicio;
            this.enviados++;
            if (!this.conectado) this.emit("log", "Se recuperó la conexión con la placa.");
            this.conectado = true;
            this.ultimoError = null;
        } catch (e) {
            this.errores++;
            if (this.conectado) this.emit("log", `Error enviando a la placa: ${e.message}`);
            this.conectado = false;
            this.ultimoError = e.message;
        } finally {
            this.enviando = false;
        }
        if (!latido) this.emit("cambio");

        if (this.pendiente) {
            const siguiente = this.pendiente;
            this.pendiente = null;
            return this.enviar(siguiente);
        }
        return this.ultimaRespuesta;
    }
}

module.exports = { ControladorServo };
