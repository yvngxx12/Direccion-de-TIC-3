// Habla con la placa por cable USB (puerto serie), igual que el Proyecto A.
// Cada comando es una línea JSON terminada en "\n":
//   {"angle":90,"viewers":123,"trend":"up","live":true}
// La placa responde otra línea JSON: {"ok":true,"angle":88,"target":90}

const { EventEmitter } = require("events");

function cargarSerialPort() {
    try {
        return require("serialport");
    } catch {
        throw new Error("El paquete 'serialport' no está instalado. Ejecutá 'npm install' en la carpeta backend.");
    }
}

class ServoSerialDriver extends EventEmitter {

    constructor(puerto, { baudios = 115200, timeoutMs = 2500, SerialPortClase = null } = {}) {
        super();
        this.tipo = "serial";
        this.puerto = String(puerto || "").trim();
        this.baudios = Number(baudios) || 115200;
        this.timeoutMs = timeoutMs;
        this.SerialPortClase = SerialPortClase;
        this.port = null;
        this.buffer = "";
        this.ultimaRespuesta = null;
        this.esperando = [];
        if (!this.puerto) throw new Error("Falta el puerto serie (por ejemplo COM5).");
    }

    static async listarPuertos() {
        const { SerialPort } = cargarSerialPort();
        const puertos = await SerialPort.list();
        return puertos.map((p) => ({
            ruta: p.path,
            fabricante: p.manufacturer || "",
            // CH340 / CP210x son los chips USB típicos de la NodeMCU.
            probableESP: /ch340|cp210|silicon labs|wch/i.test(`${p.manufacturer} ${p.friendlyName || ""}`)
        }));
    }

    descripcion() {
        return `USB · ${this.puerto} @ ${this.baudios}`;
    }

    conectar() {
        const SerialPort = this.SerialPortClase || cargarSerialPort().SerialPort;
        return new Promise((resolve, reject) => {
            this.port = new SerialPort({ path: this.puerto, baudRate: this.baudios, autoOpen: false });
            this.port.on("data", (chunk) => this.recibir(chunk));
            this.port.on("close", () => this.emit("cerrado"));
            this.port.on("error", (e) => this.emit("error", e));
            this.port.open((error) => {
                if (error) {
                    const ocupado = /access denied|acceso denegado|busy/i.test(error.message);
                    return reject(new Error(
                        ocupado
                            ? `El puerto ${this.puerto} está ocupado. Cerrá el Monitor Serie del Arduino IDE.`
                            : `No se pudo abrir ${this.puerto}: ${error.message}`
                    ));
                }
                // La NodeMCU se reinicia al abrir el puerto: se da un momento antes de usarla.
                setTimeout(() => resolve({ status: "online", puerto: this.puerto }), 1500);
            });
        });
    }

    recibir(chunk) {
        this.buffer += chunk.toString("utf8");
        let fin;
        while ((fin = this.buffer.indexOf("\n")) >= 0) {
            const linea = this.buffer.slice(0, fin).trim();
            this.buffer = this.buffer.slice(fin + 1);
            if (!linea) continue;
            try {
                const datos = JSON.parse(linea);
                if (datos && datos.log !== undefined) {
                    this.emit("log", datos.ip ? `${datos.log} (${datos.ip})` : datos.log);
                    continue;
                }
                this.ultimaRespuesta = datos;
                const pendiente = this.esperando.shift();
                if (pendiente) pendiente(datos);
            } catch {
                this.emit("log", linea); // mensajes de depuración de la placa
            }
        }
    }

    enviar(comando) {
        if (!this.port || !this.port.isOpen) {
            return Promise.reject(new Error("El puerto serie no está abierto."));
        }
        return new Promise((resolve, reject) => {
            const temporizador = setTimeout(() => {
                const i = this.esperando.indexOf(resolver);
                if (i >= 0) this.esperando.splice(i, 1);
                // Sin respuesta no es fatal: la placa puede no contestar si está ocupada.
                resolve({ ok: true, sinRespuesta: true });
            }, this.timeoutMs);
            const resolver = (datos) => {
                clearTimeout(temporizador);
                resolve(datos);
            };
            this.esperando.push(resolver);
            this.port.write(`${JSON.stringify(comando)}\n`, (error) => {
                if (error) {
                    clearTimeout(temporizador);
                    reject(error);
                }
            });
        });
    }

    cerrar() {
        return new Promise((resolve) => {
            if (!this.port || !this.port.isOpen) return resolve();
            this.port.close(() => resolve());
        });
    }
}

module.exports = { ServoSerialDriver };
