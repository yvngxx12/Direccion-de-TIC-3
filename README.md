# Proyecto C: Indicador Mecánico/Físico de Audiencia

Prototipo con **servomotor y aguja física** (NodeMCU ESP8266) que se mueve en tiempo real según la cantidad de **espectadores simultáneos** (*concurrent viewers*) de un directo de **YouTube** o **Twitch**. Incluye un **panel web** para conectar el stream, calibrar y probar, un **simulador** para trabajar sin directo, un **overlay para OBS** y **66 pruebas automáticas**.

Sigue la misma línea que los proyectos anteriores: ESP8266 + Node.js + Socket.IO, con la placa conectada por **WiFi (HTTP, como el Proyecto B)** o por **USB (serie, como el Proyecto A)**.

---

## Arquitectura

```text
 YouTube Data API v3 ─┐
 Twitch Helix API ────┼──► Proveedor ──► Monitor ──► Mapeador ──► Controlador servo ──► ESP8266 ──► Servo + aguja
 Simulador ───────────┘    (lee viewers)  (cada N s,   (viewers →    (WiFi HTTP o USB)
                                           reintentos)   ángulo)
                                              │
                                              └──► Socket.IO ──► Panel web  (http://localhost:4300)
                                                             └─► Overlay OBS (http://localhost:4300/overlay.html)
```

1. **Proveedor**: pregunta a la API oficial cuántos espectadores hay.
   - YouTube: `videos.list` → `liveStreamingDetails.concurrentViewers` (1 unidad de cuota por consulta).
   - Twitch: `helix/streams` → `viewer_count`.
2. **Monitor**: repite la consulta cada 15 s (configurable). Si la API falla, reintenta con espera creciente (15 s, 30 s, 60 s…) y lleva la aguja a la posición "sin señal". Si el error no tiene arreglo (API key inválida, video inexistente) se detiene y lo muestra en el panel.
3. **Mapeador**: convierte espectadores en ángulo (0–180°):
   - **Suavizado** (media móvil exponencial) para que la aguja no tiemble.
   - **Modos**: `lineal`, `logaritmico` (más precisión con audiencias chicas) o `auto` (aprende el mínimo y máximo de la sesión).
   - **Zona muerta**: solo mueve el servo si el cambio supera N grados.
   - **Calibración**: ángulo mínimo/máximo, sentido invertido.
4. **Controlador del servo**: manda el ángulo a la placa, reenvía un "latido" cada 5 s y tiene un **modo calibración** para mover la aguja a mano.
5. **Firmware ESP8266**: mueve la aguja suave (120°/s). Si deja de recibir comandos durante 30 s, la lleva a 0 para no mostrar un valor viejo.

### Contrato JSON con la placa

| Vía | Mensaje | Respuesta |
| --- | --- | --- |
| WiFi | `POST http://<ip>/servo` con `{"angle":90,"viewers":123,"trend":"up","live":true}` | `{"ok":true,"angle":88,"target":90}` |
| WiFi | `GET http://<ip>/status` | `{"status":"online","angle":88,"target":90,"viewers":123,...}` |
| USB | una línea `{"angle":90,"viewers":123,"trend":"up","live":true}\n` a 115200 baud | una línea `{"ok":true,...}` |

`trend` puede ser `up`, `down` o `flat` (usado para los LEDs opcionales).

---

## Estructura

```text
TIC 3/
├── backend/
│   ├── src/
│   │   ├── server.js                # Punto de entrada
│   │   ├── app.js                   # API REST + Socket.IO
│   │   ├── config.js                # Configuración (lee .env)
│   │   ├── core/
│   │   │   ├── MapeadorAudiencia.js # viewers -> ángulo (suavizado, modos, zona muerta)
│   │   │   └── MonitorAudiencia.js  # bucle de consulta, reintentos, offline
│   │   ├── providers/               # YouTube, Twitch, Simulador
│   │   ├── hardware/                # Drivers WiFi (HTTP) y USB (serie) + controlador
│   │   └── utils/parsearFuente.js   # Entiende links de YouTube/Twitch
│   ├── test/                        # Pruebas automáticas (node --test)
│   ├── tools/
│   │   ├── emulador-esp.js          # Placa virtual para probar sin hardware
│   │   └── probar-stream.js         # Prueba rápida por consola
│   └── .env.example
├── public/                          # Panel web + overlay de OBS
│   ├── index.html · panel.js · panel.css
│   ├── overlay.html
│   └── gauge.js                     # Medidor con aguja (compartido)
└── esp8266/indicador_audiencia/indicador_audiencia.ino
```

---

## Instalación

Requisitos: **Node.js 18+** (probado con 24) y, para el hardware, **Arduino IDE** con el core ESP8266.

```bash
cd backend
npm install
cp .env.example .env
```

Completar `backend/.env`. Para YouTube hay dos opciones (alcanza con una):

### Opción A: iniciar sesión con Google (OAuth 2.0, igual que el Proyecto B)

1. En `backend/.env` completar `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (los mismos del Proyecto B).
2. `GOOGLE_REDIRECT_URI` tiene que ser una URL registrada en Google Cloud Console → Credenciales → cliente OAuth. Por defecto se usa `http://localhost:3000/oauth2callback`, que es la del Proyecto B.
3. En el panel apretar **Iniciar sesión con Google**, entrar con la cuenta y aceptar el permiso de **solo lectura** de YouTube.

La sesión se guarda en `backend/datos/google-tokens.json` (ignorado por git) y el token se renueva solo. El panel corre en el puerto 4300, pero si la URL de retorno usa otro puerto (3000), el backend abre ese puerto solo durante el inicio de sesión y lo cierra al terminar. Si el Proyecto B está corriendo en ese puerto, hay que cerrarlo un momento.

### Opción B: API key de YouTube

1. Entrar a [Google Cloud Console](https://console.cloud.google.com/) (se puede usar el mismo proyecto del Proyecto B).
2. **APIs y servicios → Biblioteca →** habilitar **YouTube Data API v3**.
3. **Credenciales → Crear credenciales → Clave de API**.
4. Pegarla en `YOUTUBE_API_KEY` (o en el panel → *Credenciales de API*).

La cuota gratuita es de 10.000 unidades/día. Con una consulta cada 15 s se usan ~240 por hora, suficiente para una jornada completa. Seguir a un canal por `@nombre` gasta 100 unidades extra al buscar el directo activo (como mucho una vez cada 5 minutos si el canal no está en vivo).

### Twitch (opcional)

Registrar una aplicación en <https://dev.twitch.tv/console> y completar `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`.

---

## Uso

```bash
cd backend
npm start
```

- Panel: <http://localhost:4300>
- Overlay para OBS: <http://localhost:4300/overlay.html>

### 1. Conectar un directo

En **Fuente del stream** pegar cualquiera de estos formatos y apretar **Conectar**:

| Entrada | Qué hace |
| --- | --- |
| `https://www.youtube.com/watch?v=XXXXXXXXXXX`, `https://youtu.be/…`, `https://youtube.com/live/…` | Sigue ese directo |
| `https://www.youtube.com/@canal` o `@canal` | Busca el directo activo del canal (y el siguiente cuando termine) |
| `https://www.twitch.tv/canal` | Sigue ese canal de Twitch |
| `simulador` | Audiencia simulada, sin internet |

### 2. Probar sin directo (simulador)

En **Simulador** hay escenarios: *Estable, Subida, Bajada, Pico* (raid/viral), *Ola* (sube y baja) y *Caos* (saltos aleatorios para probar la estabilidad del servo). También se puede **fijar un valor** con el deslizador o **simular offline**.

### 3. Probar sin placa (emulador)

```bash
cd backend
npm run emulador
```

En el panel → **Placa** → WiFi → IP `127.0.0.1:4310` → **Conectar placa**. La consola del emulador muestra cada ángulo recibido.

### 4. Placa real

Conexiones (NodeMCU ESP8266):

| Servo | NodeMCU |
| --- | --- |
| Señal (naranja/amarillo) | **D5** (GPIO14) |
| +5 V (rojo) | **VIN** |
| GND (marrón/negro) | **GND** |

> Si la placa se reinicia cuando el servo se mueve, alimentar el servo con una fuente de 5 V aparte y unir las masas (GND).

1. Abrir `esp8266/indicador_audiencia/indicador_audiencia.ino` en Arduino IDE.
2. Completar `WIFI_SSID` y `WIFI_PASSWORD`. Ajustar `PULSO_MIN_US`/`PULSO_MAX_US` si el servo no llega a los extremos.
3. (Opcional) `#define USAR_NEOPIXEL 1` para usar los LEDs de la placa FANIOT del Proyecto B como indicador de tendencia (verde sube, rojo baja). Requiere la librería *Adafruit NeoPixel*.
4. Subir el programa. Al arrancar la aguja hace un barrido 0° → 180° → 0°.
5. El Monitor Serie (115200) muestra la IP. En el panel: **Placa → WiFi →** esa IP → **Conectar**.
   Por USB: cerrar el Monitor Serie, elegir **USB**, elegir el puerto (COM) y conectar.

### 5. Calibrar la aguja

- **Modo calibración**: activarlo y mover el deslizador o los botones 0°/90°/180° para ver dónde queda la aguja física. Ajustar *Ángulo mín./máx.* hasta que coincida con la escala dibujada en el plató.
- **Espectadores mín./máx.**: qué cantidad corresponde a cada extremo. Si no se sabe, usar el modo **Automático**.
- **Suavizado** y **Zona muerta**: subir si el servo vibra, bajar si responde lento.

Los ajustes se guardan en `backend/datos/ajustes.json` y se recuperan al reiniciar (también se reconecta la última placa).

### 6. OBS Studio

**Fuentes → + → Navegador** → URL `http://localhost:4300/overlay.html`, tamaño 600 × 400. El fondo es transparente. Colores, título, escala y elementos visibles se cambian desde el panel (sección 5) y se aplican al instante. Para moverlo: `overlay.html?x=40&y=40`.

### Prueba rápida por consola

```bash
npm run probar-stream -- https://www.youtube.com/watch?v=XXXXXXXXXXX
```

---

## Pruebas automáticas

```bash
cd backend
npm test
```

66 pruebas (≈6 s), sin internet ni hardware:

| Archivo | Qué prueba |
| --- | --- |
| `mapeador.test.js` | Modos lineal/log/auto, límites, calibración, suavizado, zona muerta, tendencia, validaciones |
| `parsearFuente.test.js` | Todos los formatos de links de YouTube y Twitch, errores |
| `google-auth.test.js` | Login con Google: URL, intercambio del código, guardado y renovación del token, sesión revocada, lectura de YouTube con token |
| `proveedores.test.js` | YouTube y Twitch con respuestas simuladas de la API (directo, offline, terminado, oculto, cuota agotada, key inválida, timeout, token vencido), simulador |
| `monitor.test.js` | Bucle de lectura, reintentos con espera creciente, errores definitivos, offline, cambio de stream |
| `hardware.test.js` | Driver WiFi contra el emulador (movimiento suave, caída y recuperación, latido, calibración), driver USB con un puerto simulado |
| `integracion.test.js` | Sistema completo: link de YouTube → API → ángulo → placa emulada; simulador; errores; guardado de ajustes |

---

## API REST

| Método | Ruta | Cuerpo | Descripción |
| --- | --- | --- | --- |
| GET | `/api/estado` | | Estado completo (stream, placa, calibración, estilo) |
| GET | `/api/historial` | | Últimas 300 lecturas |
| POST | `/api/stream/conectar` | `{ entrada }` | Conecta un link / `simulador` |
| POST | `/api/stream/detener` | | Detiene y lleva la aguja a "sin señal" |
| POST | `/api/stream/leer` | | Fuerza una lectura inmediata |
| POST | `/api/simulador` | `{ escenario?, viewers?, offline? }` | Controla el simulador (`viewers: null` vuelve al escenario) |
| POST | `/api/config/mapeo` | `{ modo, viewersMin, viewersMax, anguloMin, anguloMax, invertir, suavizado, zonaMuerta, sinSenal }` | Calibración |
| POST | `/api/config/monitor` | `{ intervaloMs }` | Intervalo de consulta (mín. 2000) |
| POST | `/api/config/estilo` | `{ colorAcento, colorTexto, titulo, mostrarNumero, mostrarTendencia, escala }` | Estilo del overlay |
| POST | `/api/config/credenciales` | `{ youtubeApiKey?, twitchClientId?, twitchClientSecret? }` | Credenciales en memoria |
| GET | `/api/hardware/puertos` | | Lista de puertos COM |
| POST | `/api/hardware/conectar` | `{ tipo: "http", ip }` o `{ tipo: "serial", puerto, baudios }` | Conecta la placa |
| POST | `/api/hardware/desconectar` | | |
| POST | `/api/hardware/calibracion` | `{ activa }` | Modo calibración |
| POST | `/api/hardware/probar` | `{ angulo }` | Mueve la aguja a mano (solo en calibración) |

Eventos Socket.IO: `estado`, `lectura`, `historial`, `log`, `logs`, `estilo`.

---

## Notas

- Solo se usan **APIs oficiales** (no se lee la página de YouTube ni de Twitch), así que el sistema no se rompe si cambian su diseño.
- Algunos directos ocultan el número de espectadores: el panel lo avisa y la aguja queda en "sin señal".
- Las credenciales cargadas desde el panel quedan solo en memoria; para que queden guardadas, ponerlas en `backend/.env` (que está en `.gitignore`).
