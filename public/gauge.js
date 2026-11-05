// Medidor semicircular con aguja: representa en pantalla lo mismo que hace el servo físico.
// Ángulo del servo 0° = aguja a la izquierda, 90° = arriba, 180° = derecha.
// La aguja se mueve a velocidad limitada (igual que el firmware) para que la
// simulación en pantalla se vea como el prototipo real.

(function () {
    const NS = "http://www.w3.org/2000/svg";
    const GRADOS_POR_SEGUNDO = 120;

    function el(tag, attrs, padre) {
        const e = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
        if (padre) padre.appendChild(e);
        return e;
    }

    function polar(cx, cy, r, anguloServo) {
        // 0° servo -> 180° matemático (izquierda); 180° servo -> 0° (derecha)
        const rad = Math.PI - (anguloServo * Math.PI) / 180;
        return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
    }

    function arco(cx, cy, r, desde, hasta) {
        const [x1, y1] = polar(cx, cy, r, desde);
        const [x2, y2] = polar(cx, cy, r, hasta);
        const grande = hasta - desde > 180 ? 1 : 0;
        return `M ${x1} ${y1} A ${r} ${r} 0 ${grande} 1 ${x2} ${y2}`;
    }

    // Valor de espectadores que corresponde a una proporción t (inversa del mapeo del backend).
    function viewersParaProporcion(t, mapeo, rango) {
        const { min, max } = rango;
        if (mapeo.modo === "logaritmico") return min + Math.expm1(t * Math.log1p(max - min));
        return min + t * (max - min);
    }

    function formatear(n) {
        if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
        return String(Math.round(n));
    }

    class Medidor {
        constructor(contenedor) {
            this.angulo = 0;
            this.objetivo = 0;
            this.ultimoFrame = null;

            const svg = el("svg", { viewBox: "0 0 300 175", class: "medidor-svg", role: "img", "aria-label": "Indicador de audiencia" });
            this.svg = svg;
            this.cx = 150;
            this.cy = 155;

            el("path", { d: arco(150, 155, 120, 0, 180), class: "medidor-pista" }, svg);
            this.relleno = el("path", { d: arco(150, 155, 120, 0, 0.01), class: "medidor-relleno" }, svg);
            this.zona = el("path", { d: arco(150, 155, 120, 0, 180), class: "medidor-zona" }, svg);
            this.grupoMarcas = el("g", { class: "medidor-marcas" }, svg);

            this.aguja = el("g", { class: "medidor-aguja" }, svg);
            el("path", { d: "M 150 150 L 146 155 L 150 50 L 154 155 Z", class: "medidor-aguja-cuerpo" }, this.aguja);
            el("circle", { cx: 150, cy: 155, r: 9, class: "medidor-eje" }, svg);
            el("circle", { cx: 150, cy: 155, r: 3.5, class: "medidor-eje-centro" }, svg);

            contenedor.appendChild(svg);
            this.dibujarAguja();
            requestAnimationFrame((t) => this.animar(t));
        }

        // Marcas con la cantidad de espectadores que corresponde a cada posición.
        actualizarEscala(mapeo, rango) {
            if (!mapeo || !rango) return;
            const clave = JSON.stringify([mapeo.modo, mapeo.anguloMin, mapeo.anguloMax, mapeo.invertir, Math.round(rango.min), Math.round(rango.max)]);
            if (clave === this.claveEscala) return;
            this.claveEscala = clave;

            this.grupoMarcas.innerHTML = "";
            const { anguloMin, anguloMax, invertir } = mapeo;
            this.zona.setAttribute("d", arco(this.cx, this.cy, 120, anguloMin, Math.max(anguloMax, anguloMin + 0.01)));

            for (let i = 0; i <= 20; i++) {
                const t = i / 20;
                const ang = anguloMin + t * (anguloMax - anguloMin);
                const mayor = i % 5 === 0;
                const [x1, y1] = polar(this.cx, this.cy, mayor ? 102 : 108, ang);
                const [x2, y2] = polar(this.cx, this.cy, 114, ang);
                el("line", { x1, y1, x2, y2, class: mayor ? "tick mayor" : "tick" }, this.grupoMarcas);
                if (mayor) {
                    const v = viewersParaProporcion(invertir ? 1 - t : t, mapeo, rango);
                    const [tx, ty] = polar(this.cx, this.cy, 86, ang);
                    const texto = el("text", { x: tx, y: ty + 4, class: "tick-texto", "text-anchor": "middle" }, this.grupoMarcas);
                    texto.textContent = formatear(v);
                }
            }
        }

        fijarObjetivo(angulo, { instantaneo = false } = {}) {
            if (angulo === null || angulo === undefined || !Number.isFinite(Number(angulo))) return;
            this.objetivo = Math.max(0, Math.min(180, Number(angulo)));
            // Con la pestaña oculta el navegador pausa las animaciones: se salta directo al valor.
            if (instantaneo || document.hidden) {
                this.angulo = this.objetivo;
                this.dibujarAguja();
            }
        }

        animar(t) {
            if (this.ultimoFrame !== null) {
                const dt = Math.min(0.1, (t - this.ultimoFrame) / 1000);
                const paso = GRADOS_POR_SEGUNDO * dt;
                const dif = this.objetivo - this.angulo;
                if (Math.abs(dif) > 0.01) {
                    this.angulo = Math.abs(dif) <= paso ? this.objetivo : this.angulo + Math.sign(dif) * paso;
                    this.dibujarAguja();
                }
            }
            this.ultimoFrame = t;
            requestAnimationFrame((tt) => this.animar(tt));
        }

        dibujarAguja() {
            this.aguja.setAttribute("transform", `rotate(${this.angulo - 90} ${this.cx} ${this.cy})`);
            this.relleno.setAttribute("d", arco(this.cx, this.cy, 120, 0, Math.max(0.01, this.angulo)));
        }
    }

    window.Medidor = Medidor;
    window.formatearViewers = formatear;
})();
