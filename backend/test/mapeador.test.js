const test = require("node:test");
const assert = require("node:assert/strict");
const { MapeadorAudiencia } = require("../src/core/MapeadorAudiencia");

const sinSuavizar = (extra = {}) => new MapeadorAudiencia({ suavizado: 1, zonaMuerta: 0, ...extra });

test("modo lineal: extremos y punto medio", () => {
    const m = sinSuavizar({ viewersMin: 0, viewersMax: 1000 });
    assert.equal(m.anguloPara(0), 0);
    assert.equal(m.anguloPara(500), 90);
    assert.equal(m.anguloPara(1000), 180);
});

test("los valores fuera de rango se limitan (el servo nunca pasa de sus topes)", () => {
    const m = sinSuavizar({ viewersMin: 100, viewersMax: 200 });
    assert.equal(m.anguloPara(0), 0);
    assert.equal(m.anguloPara(5000), 180);
});

test("respeta los ángulos de calibración y el sentido invertido", () => {
    const m = sinSuavizar({ anguloMin: 20, anguloMax: 160 });
    assert.equal(m.anguloPara(0), 20);
    assert.equal(m.anguloPara(1000), 160);
    m.configurar({ invertir: true });
    assert.equal(m.anguloPara(0), 160);
    assert.equal(m.anguloPara(1000), 20);
});

test("modo logarítmico da más resolución a las audiencias chicas", () => {
    const lineal = sinSuavizar({ viewersMax: 10000 });
    const log = sinSuavizar({ viewersMax: 10000, modo: "logaritmico" });
    assert.ok(log.anguloPara(100) > lineal.anguloPara(100) * 10);
    assert.equal(log.anguloPara(0), 0);
    assert.equal(log.anguloPara(10000), 180);
    // Monótono creciente
    let anterior = -1;
    for (const v of [0, 1, 10, 100, 1000, 5000, 10000]) {
        const a = log.anguloPara(v);
        assert.ok(a >= anterior, `no es creciente en ${v}`);
        anterior = a;
    }
});

test("modo auto aprende el rango de la sesión", () => {
    const m = sinSuavizar({ modo: "auto" });
    m.procesar(50);
    m.procesar(150);
    const r = m.procesar(100);
    assert.equal(r.rango.min, 45);                    // 50 * 0.9
    assert.ok(Math.abs(r.rango.max - 165) < 0.001); // 150 * 1.1
    assert.ok(r.angulo > 0 && r.angulo < 180);
});

test("modo auto: una audiencia grande y estable deja la aguja cerca de la mitad", () => {
    const m = new MapeadorAudiencia({ modo: "auto", suavizado: 1, zonaMuerta: 0 });
    let r;
    for (const v of [60183, 60152, 59998, 60100]) r = m.procesar(v);
    assert.ok(r.angulo > 60 && r.angulo < 120, `quedó en ${r.angulo}°`);
});

test("el suavizado amortigua los saltos bruscos", () => {
    const m = new MapeadorAudiencia({ suavizado: 0.5, zonaMuerta: 0 });
    m.procesar(0);
    const r = m.procesar(1000);
    assert.equal(r.viewers, 1000);
    assert.equal(r.viewersSuavizados, 500);
    assert.equal(r.angulo, 90);
});

test("la zona muerta evita mover el servo por cambios mínimos", () => {
    const m = new MapeadorAudiencia({ suavizado: 1, zonaMuerta: 5 });
    assert.equal(m.procesar(500).mover, true);      // primera lectura siempre mueve
    const chico = m.procesar(510);                   // ~1.8°
    assert.equal(chico.mover, false);
    assert.equal(chico.angulo, 90);                  // conserva el último ángulo enviado
    const grande = m.procesar(560);                  // ~10.8°
    assert.equal(grande.mover, true);
    assert.equal(grande.angulo, 101);
});

test("tendencia: detecta subida, bajada y estabilidad", () => {
    const m = sinSuavizar();
    [100, 110, 120].forEach((v) => m.procesar(v));
    assert.equal(m.calcularTendencia().direccion, "subiendo");
    m.reiniciar();
    [300, 250, 200].forEach((v) => m.procesar(v));
    assert.equal(m.calcularTendencia().direccion, "bajando");
    m.reiniciar();
    [300, 301, 300].forEach((v) => m.procesar(v));
    assert.equal(m.calcularTendencia().direccion, "estable");
});

test("sin señal: va al mínimo o mantiene según configuración", () => {
    const m = sinSuavizar();
    m.procesar(800);
    assert.deepEqual(m.sinSenal(), { angulo: 0, mover: true });
    assert.deepEqual(m.sinSenal(), { angulo: 0, mover: false });

    const mant = sinSuavizar({ sinSenal: "mantener" });
    mant.procesar(500);
    assert.deepEqual(mant.sinSenal(), { angulo: 90, mover: false });
});

test("rechaza configuraciones inválidas sin modificar la actual", () => {
    const m = sinSuavizar();
    assert.throws(() => m.configurar({ viewersMax: -1 }), /viewersMin < viewersMax/);
    assert.throws(() => m.configurar({ anguloMax: 200 }), /anguloMax <= 180/);
    assert.throws(() => m.configurar({ suavizado: 0 }), /suavizado/);
    assert.throws(() => m.configurar({ modo: "magico" }), /Modo inválido/);
    assert.throws(() => m.configurar({ viewersMin: "abc" }), /número/);
    assert.equal(m.opciones.viewersMax, 1000);
    assert.equal(m.opciones.anguloMax, 180);
});

test("entradas raras (negativos, texto, decimales) no rompen el cálculo", () => {
    const m = sinSuavizar();
    assert.equal(m.procesar(-50).viewers, 0);
    assert.equal(m.procesar("abc").viewers, 0);
    assert.equal(m.procesar(499.6).viewers, 500);
});
