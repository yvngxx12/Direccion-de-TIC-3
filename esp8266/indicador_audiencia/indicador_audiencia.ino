// =====================================================================
// PROYECTO C - INDICADOR MECÁNICO DE AUDIENCIA
// NodeMCU ESP8266 + servomotor (SG90 / MG90S) con aguja física.
//
// La placa recibe el ángulo calculado por el backend y mueve la aguja
// de forma suave. Acepta comandos por dos vías (se pueden usar a la vez):
//
//   1) WiFi (HTTP), igual que la lámpara del Proyecto B:
//        GET  http://<ip>/status
//        POST http://<ip>/servo   {"angle":90,"viewers":123,"trend":"up","live":true}
//        POST http://<ip>/sweep   (barrido de prueba 0 -> 180 -> 0)
//
//   2) USB (puerto serie, 115200 baud), igual que el Proyecto A:
//        una línea JSON por comando: {"angle":90,"viewers":123,"trend":"up","live":true}
//
// Seguridad: si no llega ningún comando en TIMEOUT_SIN_SENAL_MS (el backend
// manda un "latido" cada 5 s), la aguja vuelve lentamente a 0.
//
// Conexiones:
//   Servo señal (naranja/amarillo) -> D5 (GPIO14)
//   Servo +5V  (rojo)              -> VIN (5V del USB)  *ver nota
//   Servo GND  (marrón/negro)      -> GND
//   (Opcional) NeoPixel de la placa FANIOT "Interfaz v1.2" -> D2 (GPIO4)
//
//   *Nota: un SG90 puede consumir picos de ~500 mA. Si la placa se reinicia
//    al moverse, alimentar el servo con una fuente de 5 V aparte y unir las masas (GND).
//
// Librerías: Servo (viene con el core ESP8266). Para el LED opcional,
// instalar "Adafruit NeoPixel" desde el Gestor de Librerías.
// =====================================================================

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <Servo.h>

// ---------------- CONFIGURACIÓN ----------------
const char* WIFI_SSID     = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD";

const int PIN_SERVO = D5;                // GPIO14
const int PULSO_MIN_US = 500;            // pulso para 0°   (ajustar según el servo)
const int PULSO_MAX_US = 2400;           // pulso para 180°

const float GRADOS_POR_SEGUNDO = 120.0;  // velocidad máxima de la aguja
const unsigned long TIMEOUT_SIN_SENAL_MS = 30000;
const unsigned long TIMEOUT_WIFI_MS = 15000;

// Poner en 1 para usar los LEDs NeoPixel como indicador de tendencia
// (verde = sube, rojo = baja, azul = estable, apagado = offline).
#define USAR_NEOPIXEL 0
// ------------------------------------------------

#if USAR_NEOPIXEL
#include <Adafruit_NeoPixel.h>
const int PIN_NEOPIXEL = D2;
const int NUM_LEDS = 4;
Adafruit_NeoPixel leds(NUM_LEDS, PIN_NEOPIXEL, NEO_GRB + NEO_KHZ800);
#endif

Servo servo;
ESP8266WebServer server(80);

float anguloActual = 0;      // posición real (se mueve de a poco)
int anguloObjetivo = 0;      // posición pedida por el backend
long viewers = 0;
String tendencia = "flat";
bool enVivo = false;
bool wifiOk = false;

unsigned long ultimoComando = 0;
unsigned long ultimoTick = 0;
String bufferSerie = "";

// ---------------- JSON liviano ----------------
// (mismo enfoque que el Proyecto B: sin librerías externas)

long extraerNumero(const String& json, const String& clave, long porDefecto) {
    int i = json.indexOf("\"" + clave + "\"");
    if (i < 0) return porDefecto;
    i = json.indexOf(':', i);
    if (i < 0) return porDefecto;
    i++;
    while (i < (int)json.length() && json[i] == ' ') i++;
    int fin = i;
    if (fin < (int)json.length() && json[fin] == '-') fin++;
    while (fin < (int)json.length() && (isDigit(json[fin]) || json[fin] == '.')) fin++;
    if (fin == i) return porDefecto;
    return (long)json.substring(i, fin).toFloat();
}

String extraerTexto(const String& json, const String& clave, const String& porDefecto) {
    int i = json.indexOf("\"" + clave + "\"");
    if (i < 0) return porDefecto;
    i = json.indexOf(':', i);
    if (i < 0) return porDefecto;
    i = json.indexOf('"', i);
    if (i < 0) return porDefecto;
    int fin = json.indexOf('"', i + 1);
    if (fin < 0) return porDefecto;
    return json.substring(i + 1, fin);
}

bool extraerBool(const String& json, const String& clave, bool porDefecto) {
    int i = json.indexOf("\"" + clave + "\"");
    if (i < 0) return porDefecto;
    i = json.indexOf(':', i);
    if (i < 0) return porDefecto;
    String resto = json.substring(i + 1, i + 8);
    resto.trim();
    if (resto.startsWith("true")) return true;
    if (resto.startsWith("false")) return false;
    return porDefecto;
}

// ---------------- Lógica ----------------

String estadoJson() {
    String s = "{";
    s += "\"status\":\"online\",";
    s += "\"device\":\"NodeMCU ESP8266 + Servo\",";
    s += "\"ip\":\"" + (wifiOk ? WiFi.localIP().toString() : String("sin wifi")) + "\",";
    s += "\"angle\":" + String((int)round(anguloActual)) + ",";
    s += "\"target\":" + String(anguloObjetivo) + ",";
    s += "\"viewers\":" + String(viewers) + ",";
    s += "\"trend\":\"" + tendencia + "\",";
    s += "\"live\":" + String(enVivo ? "true" : "false") + ",";
    s += "\"uptime\":" + String(millis() / 1000);
    s += "}";
    return s;
}

String respuestaComando() {
    return "{\"ok\":true,\"angle\":" + String((int)round(anguloActual)) + ",\"target\":" + String(anguloObjetivo) + "}";
}

void actualizarLeds() {
#if USAR_NEOPIXEL
    uint32_t color = leds.Color(0, 0, 0);
    if (enVivo) {
        if (tendencia == "up") color = leds.Color(0, 200, 40);
        else if (tendencia == "down") color = leds.Color(220, 20, 20);
        else color = leds.Color(0, 90, 255);
    }
    for (int i = 0; i < NUM_LEDS; i++) leds.setPixelColor(i, color);
    leds.show();
#endif
}

// Aplica un comando JSON. Devuelve false si no trae "angle".
bool aplicarComando(const String& json) {
    long angulo = extraerNumero(json, "angle", -1);
    if (angulo < 0) return false;
    anguloObjetivo = constrain((int)angulo, 0, 180);
    viewers = extraerNumero(json, "viewers", viewers);
    tendencia = extraerTexto(json, "trend", tendencia);
    enVivo = extraerBool(json, "live", true);
    ultimoComando = millis();
    actualizarLeds();
    return true;
}

void moverSuave() {
    unsigned long ahora = millis();
    if (ahora - ultimoTick < 20) return;  // 50 Hz
    float dt = (ahora - ultimoTick) / 1000.0;
    ultimoTick = ahora;

    // Sin señal del backend: volver a 0 para que nadie lea un número viejo.
    if (ultimoComando > 0 && ahora - ultimoComando > TIMEOUT_SIN_SENAL_MS && anguloObjetivo != 0) {
        anguloObjetivo = 0;
        enVivo = false;
        actualizarLeds();
        Serial.println("{\"log\":\"sin senal del backend, aguja a 0\"}");
    }

    float paso = GRADOS_POR_SEGUNDO * dt;
    float diferencia = anguloObjetivo - anguloActual;
    if (fabs(diferencia) <= paso) anguloActual = anguloObjetivo;
    else anguloActual += (diferencia > 0 ? paso : -paso);

    servo.write((int)round(anguloActual));
}

void barridoPrueba() {
    for (int a = 0; a <= 180; a += 2) { servo.write(a); delay(15); }
    for (int a = 180; a >= 0; a -= 2) { servo.write(a); delay(15); }
    anguloActual = 0;
}

// ---------------- HTTP ----------------

void enviarCors() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
}

void manejarStatus() {
    enviarCors();
    server.send(200, "application/json", estadoJson());
}

void manejarServo() {
    enviarCors();
    if (!server.hasArg("plain") || !aplicarComando(server.arg("plain"))) {
        server.send(400, "application/json", "{\"ok\":false,\"error\":\"falta angle\"}");
        return;
    }
    server.send(200, "application/json", respuestaComando());
}

void manejarBarrido() {
    enviarCors();
    barridoPrueba();
    server.send(200, "application/json", respuestaComando());
}

// ---------------- Serie ----------------

void leerSerie() {
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n') {
            bufferSerie.trim();
            if (bufferSerie.length() > 0) {
                if (aplicarComando(bufferSerie)) Serial.println(respuestaComando());
                else Serial.println("{\"ok\":false,\"error\":\"falta angle\"}");
            }
            bufferSerie = "";
        } else if (bufferSerie.length() < 200) {
            bufferSerie += c;
        }
    }
}

// ---------------- Setup / Loop ----------------

void setup() {
    Serial.begin(115200);
    delay(100);
    Serial.println();
    Serial.println("{\"log\":\"Indicador de audiencia iniciando\"}");

    servo.attach(PIN_SERVO, PULSO_MIN_US, PULSO_MAX_US);
    servo.write(0);

#if USAR_NEOPIXEL
    leds.begin();
    leds.setBrightness(80);
    actualizarLeds();
#endif

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long inicio = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - inicio < TIMEOUT_WIFI_MS) {
        delay(250);
    }
    wifiOk = WiFi.status() == WL_CONNECTED;

    if (wifiOk) {
        server.on("/status", HTTP_GET, manejarStatus);
        server.on("/servo", HTTP_POST, manejarServo);
        server.on("/sweep", HTTP_POST, manejarBarrido);
        server.begin();
        Serial.println("{\"log\":\"WiFi conectado\",\"ip\":\"" + WiFi.localIP().toString() + "\"}");
    } else {
        Serial.println("{\"log\":\"Sin WiFi: funcionando solo por USB\"}");
    }

    barridoPrueba();  // confirma visualmente que el servo responde
    ultimoTick = millis();
}

void loop() {
    if (wifiOk) server.handleClient();
    leerSerie();
    moverSuave();
}
