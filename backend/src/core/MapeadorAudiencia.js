// Traduce la cantidad de espectadores simultáneos a un ángulo del servomotor.
//
// Pasos en cada lectura:
//   1. Suavizado exponencial (EMA) para que la aguja no tiemble con cada variación chica.
//   2. Normalización 0..1 según el modo:
//        - lineal:      t = (v - min) / (max - min)
//        - logaritmico: t = log(1 + v - min) / log(1 + max - min)   (útil si la audiencia varía mucho)
//        - auto:        igual que lineal, pero min/max se aprenden de lo visto en la sesión
//   3. Ángulo = anguloMin + t * (anguloMax - anguloMin)  (o al revés si "invertir")
//   4. Zona muerta: solo se ordena mover el servo si el cambio supera N grados.

const MODOS = ["lineal", "logaritmico", "auto"];
const VENTANA_TENDENCIA = 6;      // lecturas usadas para calcular la tendencia
const UMBRAL_TENDENCIA = 0.02;    // 2 % de cambio para considerar subida/bajada

function limitar(valor, min, max) {
    return Math.min(max, Math.max(min, valor));
}

class MapeadorAudiencia {

    constructor(opciones = {}) {
        this.opciones = {
            modo: "lineal",
            viewersMin: 0,
            viewersMax: 1000,
            anguloMin: 0,
            anguloMax: 180,
            invertir: false,
            suavizado: 0.5,
            zonaMuerta: 2,
            sinSenal: "minimo"
        };
        this.configurar(opciones);
        this.reiniciar();
    }

    reiniciar() {
        this.viewersSuavizados = null;
        this.ultimoAnguloEnviado = null;
        this.minVisto = null;
        this.maxVisto = null;
        this.historial = [];
    }

    // Valida y aplica un cambio parcial de configuración. Lanza Error si algo no tiene sentido.
    configurar(parcial = {}) {
        const nuevo = { ...this.opciones };

        for (const clave of ["viewersMin", "viewersMax", "anguloMin", "anguloMax", "suavizado", "zonaMuerta"]) {
            if (parcial[clave] !== undefined) {
                const n = Number(parcial[clave]);
                if (!Number.isFinite(n)) {
                    throw new Error(`"${clave}" debe ser un número.`);
                }
                nuevo[clave] = n;
            }
        }
        if (parcial.modo !== undefined) nuevo.modo = String(parcial.modo);
        if (parcial.invertir !== undefined) nuevo.invertir = parcial.invertir === true || parcial.invertir === "true";
        if (parcial.sinSenal !== undefined) nuevo.sinSenal = String(parcial.sinSenal);

        if (!MODOS.includes(nuevo.modo)) {
            throw new Error(`Modo inválido "${nuevo.modo}". Opciones: ${MODOS.join(", ")}.`);
        }
        if (!["minimo", "mantener"].includes(nuevo.sinSenal)) {
            throw new Error('"sinSenal" debe ser "minimo" o "mantener".');
        }
        if (nuevo.viewersMin < 0 || nuevo.viewersMax <= nuevo.viewersMin) {
            throw new Error("Se necesita 0 <= viewersMin < viewersMax.");
        }
        if (nuevo.anguloMin < 0 || nuevo.anguloMax > 180 || nuevo.anguloMax <= nuevo.anguloMin) {
            throw new Error("Se necesita 0 <= anguloMin < anguloMax <= 180.");
        }
        if (nuevo.suavizado <= 0 || nuevo.suavizado > 1) {
            throw new Error('"suavizado" debe estar entre 0 (exclusivo) y 1.');
        }
        if (nuevo.zonaMuerta < 0 || nuevo.zonaMuerta > 45) {
            throw new Error('"zonaMuerta" debe estar entre 0 y 45 grados.');
        }

        const cambioModo = nuevo.modo !== this.opciones.modo;
        this.opciones = nuevo;
        if (cambioModo) {
            this.minVisto = null;
            this.maxVisto = null;
        }
        // Forzar reenvío del ángulo con la nueva calibración.
        this.ultimoAnguloEnviado = null;
        return this.opciones;
    }

    // Rango de espectadores que se usa para normalizar.
    rangoActual() {
        const { modo, viewersMin, viewersMax } = this.opciones;
        if (modo !== "auto" || this.minVisto === null) {
            return { min: viewersMin, max: viewersMax };
        }
        // En modo auto se deja un 10 % de margen abajo y arriba de lo visto, así una audiencia
        // estable queda cerca de la mitad y la aguja tiene recorrido para subir o bajar.
        const min = Math.floor(this.minVisto * 0.9);
        const max = Math.max(this.maxVisto * 1.1, min + 10);
        return { min, max };
    }

    // Proporción 0..1 para una cantidad de espectadores (función pura respecto del rango actual).
    normalizar(viewers) {
        const { min, max } = this.rangoActual();
        const v = limitar(viewers, min, max);
        if (this.opciones.modo === "logaritmico") {
            return Math.log1p(v - min) / Math.log1p(max - min);
        }
        return (v - min) / (max - min);
    }

    anguloPara(viewers) {
        const { anguloMin, anguloMax, invertir } = this.opciones;
        let t = this.normalizar(viewers);
        if (invertir) t = 1 - t;
        return Math.round(anguloMin + t * (anguloMax - anguloMin));
    }

    calcularTendencia() {
        if (this.historial.length < 2) {
            return { direccion: "estable", cambio: 0 };
        }
        const primero = this.historial[0];
        const ultimo = this.historial[this.historial.length - 1];
        const base = Math.max(primero, 1);
        const cambio = (ultimo - primero) / base;
        let direccion = "estable";
        if (cambio >= UMBRAL_TENDENCIA) direccion = "subiendo";
        if (cambio <= -UMBRAL_TENDENCIA) direccion = "bajando";
        return { direccion, cambio: Math.round(cambio * 1000) / 10 }; // cambio en %
    }

    // Procesa una lectura nueva. Devuelve lo necesario para mover el servo y mostrar en pantalla.
    procesar(viewersCrudos) {
        const viewers = Math.max(0, Math.round(Number(viewersCrudos) || 0));
        const { suavizado, zonaMuerta } = this.opciones;

        if (this.viewersSuavizados === null) {
            this.viewersSuavizados = viewers;
        } else {
            this.viewersSuavizados = suavizado * viewers + (1 - suavizado) * this.viewersSuavizados;
        }

        if (this.minVisto === null || viewers < this.minVisto) this.minVisto = viewers;
        if (this.maxVisto === null || viewers > this.maxVisto) this.maxVisto = viewers;

        this.historial.push(viewers);
        if (this.historial.length > VENTANA_TENDENCIA) this.historial.shift();

        const angulo = this.anguloPara(this.viewersSuavizados);
        const mover =
            this.ultimoAnguloEnviado === null ||
            Math.abs(angulo - this.ultimoAnguloEnviado) >= zonaMuerta;

        if (mover) this.ultimoAnguloEnviado = angulo;

        return {
            viewers,
            viewersSuavizados: Math.round(this.viewersSuavizados),
            porcentaje: Math.round(this.normalizar(this.viewersSuavizados) * 100),
            angulo: this.ultimoAnguloEnviado,
            anguloCalculado: angulo,
            mover,
            rango: this.rangoActual(),
            tendencia: this.calcularTendencia()
        };
    }

    // Qué hacer cuando el stream está offline o la API falla.
    sinSenal() {
        if (this.opciones.sinSenal === "mantener" && this.ultimoAnguloEnviado !== null) {
            return { angulo: this.ultimoAnguloEnviado, mover: false };
        }
        const { anguloMin, anguloMax, invertir } = this.opciones;
        const angulo = invertir ? anguloMax : anguloMin;
        const mover = this.ultimoAnguloEnviado !== angulo;
        this.ultimoAnguloEnviado = angulo;
        this.viewersSuavizados = null;
        this.historial = [];
        return { angulo, mover };
    }
}

module.exports = { MapeadorAudiencia, MODOS };
