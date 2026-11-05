// Prueba rápida por consola: muestra los espectadores de un stream sin abrir el panel.
//
//   npm run probar-stream -- https://www.youtube.com/watch?v=XXXXXXXXXXX
//   npm run probar-stream -- https://www.twitch.tv/canal
//   npm run probar-stream -- simulador
//
// Usa las credenciales de backend/.env.

const { crearConfig } = require("../src/config");
const { crearProveedor } = require("../src/providers");
const { MapeadorAudiencia } = require("../src/core/MapeadorAudiencia");

async function main() {
    const entrada = process.argv[2];
    const veces = Number(process.argv[3]) || 3;
    if (!entrada) {
        console.log("Uso: npm run probar-stream -- <link del stream> [cantidad de lecturas]");
        process.exit(1);
    }
    const config = crearConfig();
    const proveedor = crearProveedor(entrada, { credenciales: config.credenciales, timeoutMs: config.monitor.timeoutMs });
    const mapeador = new MapeadorAudiencia(config.mapeo);
    const espera = proveedor.plataforma === "simulador" ? 500 : 5000;

    console.log(`Fuente: ${proveedor.descripcion()}`);
    let lectura = await proveedor.conectar();
    for (let i = 1; i <= veces; i++) {
        if (i > 1) {
            await new Promise((r) => setTimeout(r, espera));
            lectura = await proveedor.leer();
        }
        if (lectura.enVivo && lectura.viewers !== null) {
            const r = mapeador.procesar(lectura.viewers);
            console.log(`#${i}  ${lectura.viewers} espectadores  ->  servo ${r.angulo}°  (${lectura.canal || ""} · ${lectura.titulo || ""})`);
        } else {
            console.log(`#${i}  sin espectadores: ${lectura.aviso || "offline"}`);
        }
    }
}

main().catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
