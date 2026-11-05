// Habla con la NodeMCU ESP8266 por WiFi (HTTP), igual que la lámpara del Proyecto B.
//
//   GET  http://<ip>/status  -> estado de la placa
//   POST http://<ip>/servo   -> { "angle": 90, "viewers": 123, "trend": "up", "live": true }

class ServoHttpDriver {

    constructor(ip, { fetch: fetchFn, timeoutMs = 2500 } = {}) {
        this.tipo = "http";
        this.ip = String(ip || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
        this.fetch = fetchFn || globalThis.fetch;
        this.timeoutMs = timeoutMs;
        if (!this.ip) throw new Error("Falta la IP de la ESP8266.");
    }

    descripcion() {
        return `WiFi · http://${this.ip}`;
    }

    async pedir(ruta, init = {}) {
        const respuesta = await this.fetch(`http://${this.ip}${ruta}`, {
            ...init,
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        const texto = await respuesta.text();
        if (!respuesta.ok) throw new Error(`La placa respondió HTTP ${respuesta.status}: ${texto.slice(0, 120)}`);
        try {
            return JSON.parse(texto);
        } catch {
            return { texto };
        }
    }

    async conectar() {
        return this.pedir("/status");
    }

    async enviar(comando) {
        return this.pedir("/servo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(comando)
        });
    }

    async cerrar() {}
}

module.exports = { ServoHttpDriver };
