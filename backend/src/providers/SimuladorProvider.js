// Fuente de audiencia simulada, para probar todo sin un directo real.
// Cada llamada a leer() avanza un "paso" del escenario elegido.

const ESCENARIOS = {
    estable: "Audiencia estable con pequeñas variaciones",
    subida: "Crecimiento sostenido (el directo se vuelve popular)",
    bajada: "Caída progresiva (fin del directo)",
    pico: "Pico repentino (raid / momento viral) y luego baja",
    ola: "Sube y baja de forma periódica",
    caos: "Saltos bruscos aleatorios (prueba de estabilidad del servo)"
};

class SimuladorProvider {

    constructor({ escenario = "estable", viewersIniciales = 300, aleatorio = Math.random } = {}) {
        this.plataforma = "simulador";
        this.aleatorio = aleatorio;
        this.viewers = viewersIniciales;
        this.paso = 0;
        this.fijado = null;
        this.enVivo = true;
        this.cambiarEscenario(escenario);
    }

    descripcion() {
        return `Simulador · ${this.escenario}`;
    }

    cambiarEscenario(escenario) {
        if (!ESCENARIOS[escenario]) {
            throw new Error(`Escenario desconocido "${escenario}". Opciones: ${Object.keys(ESCENARIOS).join(", ")}.`);
        }
        this.escenario = escenario;
        this.paso = 0;
        this.fijado = null;
        this.base = this.viewers;
    }

    // Fija un valor manual (desde el panel). null vuelve al escenario.
    fijar(viewers) {
        this.fijado = viewers === null ? null : Math.max(0, Math.round(Number(viewers) || 0));
        if (this.fijado !== null) this.viewers = this.fijado;
    }

    ponerOffline(offline) {
        this.enVivo = !offline;
    }

    ruido(amplitud) {
        return (this.aleatorio() * 2 - 1) * amplitud;
    }

    avanzar() {
        this.paso++;
        const v = this.viewers;
        switch (this.escenario) {
            case "estable":
                return v + this.ruido(Math.max(3, v * 0.02));
            case "subida":
                return v * 1.04 + 5 + this.ruido(4);
            case "bajada":
                return v * 0.95 + this.ruido(3);
            case "pico": {
                // 10 pasos normales, salto x3, luego decae hacia la base.
                if (this.paso === 10) return v * 3;
                if (this.paso > 10) return v + (this.base - v) * 0.08 + this.ruido(5);
                return v + this.ruido(5);
            }
            case "ola":
                return this.base + this.base * 0.6 * Math.sin(this.paso / 6) + this.ruido(5);
            case "caos":
                return this.aleatorio() * 1000;
            default:
                return v;
        }
    }

    async conectar() {
        return this.leer();
    }

    async leer() {
        if (!this.enVivo) {
            return { viewers: null, enVivo: false, titulo: "Directo simulado", canal: "Simulador", aviso: "Simulador en modo offline." };
        }
        if (this.fijado === null) {
            this.viewers = Math.max(0, Math.round(this.avanzar()));
        }
        return { viewers: this.viewers, enVivo: true, titulo: `Escenario: ${this.escenario}`, canal: "Simulador" };
    }
}

module.exports = { SimuladorProvider, ESCENARIOS };
