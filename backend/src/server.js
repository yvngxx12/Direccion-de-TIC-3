// Punto de entrada: node src/server.js  (o npm start)

const path = require("path");
const { crearConfig } = require("./config");
const { crearApp } = require("./app");

const config = crearConfig();
const sistema = crearApp(config, {
    archivoAjustes: path.join(__dirname, "../datos/ajustes.json"),
    archivoTokens: path.join(__dirname, "../datos/google-tokens.json")
});

sistema.server.listen(config.puerto, async () => {
    console.log("------------------------------------------------");
    console.log(" PROYECTO C - INDICADOR MECÁNICO DE AUDIENCIA");
    console.log("------------------------------------------------");
    console.log(` Panel de control:  http://localhost:${config.puerto}`);
    console.log(` Overlay para OBS:  http://localhost:${config.puerto}/overlay.html`);
    const google = sistema.googleAuth.estado();
    console.log(` YouTube API key:   ${config.credenciales.youtubeApiKey ? "configurada" : "no (opcional)"}`);
    console.log(` Google OAuth:      ${!google.configurado ? "NO configurado" : google.autenticado ? `sesión iniciada (${google.cuenta || "ok"})` : `listo, iniciá sesión en http://localhost:${config.puerto}/auth/google`}`);
    console.log(` Twitch:            ${config.credenciales.twitchClientId ? "configurado" : "NO configurado"}`);
    console.log("------------------------------------------------");

    // Reconectar la placa usada la última vez (o la del .env).
    const placa = sistema.ultimaPlaca() || (config.hardware.tipo !== "ninguno" ? {
        tipo: config.hardware.tipo,
        ip: config.hardware.ip,
        puerto: config.hardware.puertoSerie,
        baudios: config.hardware.baudios
    } : null);
    if (placa && placa.tipo) {
        try {
            await sistema.servo.conectar(placa);
        } catch (e) {
            sistema.registrar(`${e.message} (podés reconectarla desde el panel)`);
        }
    }
});

async function salir() {
    console.log("\nCerrando...");
    await sistema.cerrar().catch(() => {});
    process.exit(0);
}
process.on("SIGINT", salir);
process.on("SIGTERM", salir);
