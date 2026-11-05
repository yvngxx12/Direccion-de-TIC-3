const test = require("node:test");
const assert = require("node:assert/strict");
const { parsearFuente } = require("../src/utils/parsearFuente");

const ID = "dQw4w9WgXcQ";

test("reconoce todas las formas de link de video de YouTube", () => {
    const casos = [
        `https://www.youtube.com/watch?v=${ID}`,
        `https://youtube.com/watch?v=${ID}&t=30s`,
        `https://m.youtube.com/watch?v=${ID}`,
        `https://youtu.be/${ID}`,
        `https://youtu.be/${ID}?si=abc`,
        `https://www.youtube.com/live/${ID}?feature=share`,
        `https://www.youtube.com/shorts/${ID}`,
        `https://www.youtube.com/embed/${ID}`,
        `youtube.com/watch?v=${ID}`,
        ID,
        `yt:${ID}`
    ];
    for (const c of casos) {
        assert.deepEqual(parsearFuente(c), { plataforma: "youtube", tipo: "video", id: ID }, c);
    }
});

test("reconoce canales de YouTube por @handle o channelId", () => {
    assert.deepEqual(parsearFuente("https://www.youtube.com/@MinisterioTIC"), { plataforma: "youtube", tipo: "handle", id: "@MinisterioTIC" });
    assert.deepEqual(parsearFuente("https://www.youtube.com/@MinisterioTIC/live"), { plataforma: "youtube", tipo: "handle", id: "@MinisterioTIC" });
    assert.deepEqual(parsearFuente("@MinisterioTIC"), { plataforma: "youtube", tipo: "handle", id: "@MinisterioTIC" });
    assert.deepEqual(parsearFuente("youtube:MinisterioTIC"), { plataforma: "youtube", tipo: "handle", id: "@MinisterioTIC" });
    const canal = "UC_x5XG1OV2P6uZZ5FSM9Ttw";
    assert.deepEqual(parsearFuente(`https://www.youtube.com/channel/${canal}`), { plataforma: "youtube", tipo: "canal", id: canal });
    assert.deepEqual(parsearFuente(canal), { plataforma: "youtube", tipo: "canal", id: canal });
});

test("reconoce canales de Twitch", () => {
    assert.deepEqual(parsearFuente("https://www.twitch.tv/MiCanal"), { plataforma: "twitch", tipo: "canal", id: "micanal" });
    assert.deepEqual(parsearFuente("twitch.tv/mi_canal?x=1"), { plataforma: "twitch", tipo: "canal", id: "mi_canal" });
    assert.deepEqual(parsearFuente("twitch:otro_canal"), { plataforma: "twitch", tipo: "canal", id: "otro_canal" });
});

test("reconoce el simulador", () => {
    assert.equal(parsearFuente("simulador").plataforma, "simulador");
    assert.equal(parsearFuente("  Demo ").plataforma, "simulador");
});

test("da errores claros con entradas inválidas", () => {
    assert.throws(() => parsearFuente(""), /Ingresá/);
    assert.throws(() => parsearFuente("https://vimeo.com/123"), /no soportada/);
    assert.throws(() => parsearFuente("https://www.youtube.com/feed/trending"), /No se reconoce/);
    assert.throws(() => parsearFuente("https://www.twitch.tv/directory"), /Twitch/);
    assert.throws(() => parsearFuente("twitch:x"), /inválido/);
    assert.throws(() => parsearFuente("https://youtu.be/corto"), /youtu\.be/);
});
