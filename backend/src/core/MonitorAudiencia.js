// Bucle principal: consulta la audiencia cada N segundos, la convierte en ángulo
// y mueve el servo. También maneja errores de API y desconexiones:
//
//   - Error reintentable (red, timeout, cuota, 5xx): espera creciente (backoff exponencial)
//     hasta un máximo, y la aguja va a la posición "sin señal".
//   - Error no reintentable (API key inválida, canal inexistente): se detiene y avisa.
//   - Stream offline: se sigue consultando con el intervalo normal.

const { EventEmitter } = require("events");

const MAX_HISTORIAL = 300;
const TENDENCIA_A_PLACA = { subiendo: "up", bajando: "down", estable: "flat" };

class MonitorAudiencia extends EventEmitter {

    constructor({ mapeador, servo, monitor, crearProveedor }) {
        super();
        this.mapeador = mapeador;
        this.servo = servo;
        this.opciones = { ...monitor };
        this.crearProveedor = crearProveedor;

        this.proveedor = null;
        this.entrada = null;
        this.estadoActual = "detenido";
        this.ultimaLectura = null;
        this.ultimoError = null;
        this.erroresSeguidos = 0;
        this.historial = [];
        this.estadisticas = this.estadisticasVacias();
        this.temporizador = null;
        this.generacion = 0; // invalida ciclos viejos cuando se cambia de stream
    }

    estadisticasVacias() {
        return { lecturas: 0, errores: 0, pico: 0, latenciaApiMs: null, desde: null };
    }

    intervaloActual() {
        return this.proveedor && this.proveedor.plataforma === "simulador"
            ? this.opciones.intervaloSimuladorMs
            : this.opciones.intervaloMs;
    }

    configurar({ intervaloMs, intervaloSimuladorMs } = {}) {
        if (intervaloMs !== undefined) {
            const n = Number(intervaloMs);
            if (!Number.isFinite(n) || n < 2000) throw new Error("El intervalo debe ser de al menos 2000 ms.");
            this.opciones.intervaloMs = n;
        }
        if (intervaloSimuladorMs !== undefined) {
            const n = Number(intervaloSimuladorMs);
            if (!Number.isFinite(n) || n < 200) throw new Error("El intervalo del simulador debe ser de al menos 200 ms.");
            this.opciones.intervaloSimuladorMs = n;
        }
        if (this.proveedor && this.temporizador) this.programar(this.intervaloActual());
        return this.opciones;
    }

    estado() {
        return {
            estado: this.estadoActual,
            fuente: this.proveedor ? this.proveedor.descripcion() : null,
            plataforma: this.proveedor ? this.proveedor.plataforma : null,
            entrada: this.entrada,
            escenario: this.proveedor && this.proveedor.escenario ? this.proveedor.escenario : null,
            intervaloMs: this.intervaloActual(),
            ultimaLectura: this.ultimaLectura,
            ultimoError: this.ultimoError,
            erroresSeguidos: this.erroresSeguidos,
            estadisticas: this.estadisticas
        };
    }

    cambiarEstado(nuevo) {
        if (this.estadoActual !== nuevo) {
            this.estadoActual = nuevo;
            this.emit("log", `Estado: ${nuevo}`);
        }
        this.emit("cambio");
    }

    // Conecta a un stream nuevo. Lanza Error si la primera lectura falla de forma definitiva.
    async conectar(entrada, opcionesProveedor = {}) {
        this.detener({ silencioso: true });
        const generacion = ++this.generacion;

        const proveedor = this.crearProveedor(entrada, opcionesProveedor);
        this.proveedor = proveedor;
        this.entrada = entrada;
        this.ultimaLectura = null;
        this.ultimoError = null;
        this.erroresSeguidos = 0;
        this.historial = [];
        this.estadisticas = { ...this.estadisticasVacias(), desde: new Date().toISOString() };
        this.mapeador.reiniciar();
        this.emit("reinicio");
        this.cambiarEstado("conectando");
        this.emit("log", `Conectando a ${proveedor.descripcion()}...`);

        try {
            const inicio = Date.now();
            const lectura = await proveedor.conectar();
            if (generacion !== this.generacion) return this.estado();
            this.estadisticas.latenciaApiMs = Date.now() - inicio;
            await this.procesarLectura(lectura);
        } catch (e) {
            if (generacion !== this.generacion) return this.estado();
            if (e.reintentable === false) {
                this.proveedor = null;
                this.ultimoError = { mensaje: e.message, codigo: e.codigo || "ERROR" };
                this.emit("log", `No se pudo conectar: ${e.message}`);
                await this.irASinSenal();
                this.cambiarEstado("error");
                throw e;
            }
            await this.registrarError(e);
        }

        if (generacion === this.generacion && this.proveedor) {
            this.programar(this.erroresSeguidos ? this.esperaBackoff() : this.intervaloActual());
        }
        return this.estado();
    }

    detener({ silencioso = false } = {}) {
        this.generacion++;
        clearTimeout(this.temporizador);
        this.temporizador = null;
        const habia = Boolean(this.proveedor);
        this.proveedor = null;
        let movimiento = Promise.resolve();
        if (habia && !silencioso) {
            this.emit("log", "Monitoreo detenido.");
            movimiento = this.irASinSenal();
        }
        if (!silencioso) this.cambiarEstado("detenido");
        return movimiento;
    }

    programar(ms) {
        clearTimeout(this.temporizador);
        const generacion = this.generacion;
        this.temporizador = setTimeout(() => this.ciclo(generacion), ms);
        this.temporizador.unref?.();
    }

    esperaBackoff() {
        const base = this.intervaloActual();
        return Math.min(base * 2 ** Math.max(0, this.erroresSeguidos - 1), this.opciones.maxBackoffMs);
    }

    async ciclo(generacion) {
        if (generacion !== this.generacion || !this.proveedor) return;
        await this.leerAhora();
        if (generacion !== this.generacion || !this.proveedor) return;
        this.programar(this.erroresSeguidos ? this.esperaBackoff() : this.intervaloActual());
    }

    // Hace una lectura inmediata (también la usan los tests y el botón "Leer ahora").
    async leerAhora() {
        if (!this.proveedor) return null;
        const generacion = this.generacion;
        const inicio = Date.now();
        try {
            const lectura = await this.proveedor.leer();
            if (generacion !== this.generacion) return null;
            this.estadisticas.latenciaApiMs = Date.now() - inicio;
            return await this.procesarLectura(lectura);
        } catch (e) {
            if (generacion !== this.generacion) return null;
            if (e.reintentable === false) {
                this.ultimoError = { mensaje: e.message, codigo: e.codigo || "ERROR" };
                this.emit("log", `Error definitivo: ${e.message}`);
                this.proveedor = null;
                clearTimeout(this.temporizador);
                this.irASinSenal();
                this.cambiarEstado("error");
                return null;
            }
            await this.registrarError(e);
            return null;
        }
    }

    async registrarError(e) {
        this.erroresSeguidos++;
        this.estadisticas.errores++;
        this.ultimoError = { mensaje: e.message, codigo: e.codigo || "ERROR" };
        this.emit("log", `Error leyendo audiencia (${this.erroresSeguidos} seguidos): ${e.message}`);
        if (this.erroresSeguidos === 1 || this.erroresSeguidos % 5 === 0) {
            // Solo se mueve la aguja a "sin señal" al empezar a fallar, no en cada reintento.
            await this.irASinSenal();
        }
        this.cambiarEstado("reintentando");
    }

    async irASinSenal() {
        const { angulo, mover } = this.mapeador.sinSenal();
        if (mover) {
            await this.servo.mover({ angle: angulo, viewers: 0, trend: "flat", live: false });
        }
    }

    // Recoloca la aguja con la calibración nueva sin contar una lectura extra.
    async reaplicarCalibracion() {
        const ultima = this.ultimaLectura;
        if (!ultima || !ultima.enVivo || ultima.viewers === null || this.mapeador.viewersSuavizados === null) {
            this.emit("cambio");
            return;
        }
        const angulo = this.mapeador.anguloPara(this.mapeador.viewersSuavizados);
        this.mapeador.ultimoAnguloEnviado = angulo;
        this.ultimaLectura = {
            ...ultima,
            angulo,
            anguloCalculado: angulo,
            porcentaje: Math.round(this.mapeador.normalizar(this.mapeador.viewersSuavizados) * 100),
            rango: this.mapeador.rangoActual()
        };
        await this.servo.mover({
            angle: angulo,
            viewers: ultima.viewers,
            trend: TENDENCIA_A_PLACA[ultima.tendencia ? ultima.tendencia.direccion : "estable"],
            live: true
        });
        this.emit("lectura", this.ultimaLectura);
        this.emit("cambio");
    }

    async procesarLectura(lectura) {
        const ahora = new Date().toISOString();
        this.erroresSeguidos = 0;
        this.ultimoError = null;

        if (!lectura.enVivo || lectura.viewers === null || lectura.viewers === undefined) {
            this.ultimaLectura = {
                fecha: ahora,
                enVivo: Boolean(lectura.enVivo),
                viewers: null,
                angulo: null,
                titulo: lectura.titulo || null,
                canal: lectura.canal || null,
                aviso: lectura.aviso || null
            };
            await this.irASinSenal();
            this.ultimaLectura.angulo = this.mapeador.ultimoAnguloEnviado;
            this.emit("lectura", this.ultimaLectura);
            this.cambiarEstado("offline");
            return this.ultimaLectura;
        }

        const resultado = this.mapeador.procesar(lectura.viewers);
        this.estadisticas.lecturas++;
        this.estadisticas.pico = Math.max(this.estadisticas.pico, resultado.viewers);

        this.ultimaLectura = {
            fecha: ahora,
            enVivo: true,
            titulo: lectura.titulo || null,
            canal: lectura.canal || null,
            aviso: null,
            ...resultado
        };

        this.historial.push({ t: ahora, viewers: resultado.viewers, angulo: resultado.angulo });
        if (this.historial.length > MAX_HISTORIAL) this.historial.shift();

        if (resultado.mover) {
            await this.servo.mover({
                angle: resultado.angulo,
                viewers: resultado.viewers,
                trend: TENDENCIA_A_PLACA[resultado.tendencia.direccion],
                live: true
            });
        }

        this.emit("lectura", this.ultimaLectura);
        this.cambiarEstado("en_vivo");
        return this.ultimaLectura;
    }
}

module.exports = { MonitorAudiencia };
