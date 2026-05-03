"""
Bot de WhatsApp de Clínica Sonrisas Saludables.

Recibe los mensajes desde el bridge whatsapp-web.js (puerto 3000) en
POST /webhook, los procesa con OpenAI y devuelve la respuesta al
paciente a través del mismo bridge en POST /send.

Sin base de datos: la conversación vive en memoria con TTL de 30 min.
El bot solo sabe llamar a una función externa (Consultar_Doctores) que
expone Make. El resto del flujo (agendar / reagendar / cancelar / dudas /
humano) se resuelve con el prompt y enlaces fijos.
"""
import json
import logging
import os
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from openai import OpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
if not OPENAI_API_KEY:
    raise RuntimeError("Falta OPENAI_API_KEY en el archivo .env")

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
OPENAI_TIMEOUT_S = int(os.getenv("OPENAI_TIMEOUT_S", "30"))

WA_BRIDGE_URL = os.getenv("WA_BRIDGE_URL", "http://127.0.0.1:3000").rstrip("/")
WA_BRIDGE_TOKEN = os.getenv("WA_BRIDGE_TOKEN", "").strip()

MAKE_WEBHOOK_DOCTORES = os.getenv("MAKE_WEBHOOK_DOCTORES", "").strip()

SESSION_TIMEOUT_MIN = 30
MAX_HISTORIAL = 30
TZ_MADRID = ZoneInfo("Europe/Madrid")

# Enlaces fijos del flujo
LINK_AGENDAR = "https://eu.doct.to/ggyp1bcr"
LINK_DOCTORALIA_IOS = (
    "https://apps.apple.com/es/app/doctoralia-espa%C3%B1a/id1444682103"
)
LINK_DOCTORALIA_ANDROID = "https://play.google.com/store/apps/details?id=es.doctoralia"

TELEFONO_HUMANO = "638 35 31 28"
HORARIO_HUMANO = (
    f"Para hablar con nuestro equipo, llame al {TELEFONO_HUMANO} "
    "de lunes a jueves de 10:00 a 14:00 y de 15:30 a 19:30, "
    "y los viernes de 10:00 a 14:00."
)

# Atajo: si el paciente pide humano con frases obvias, evitamos llamar al modelo.
HUMAN_REQUEST_KEYWORDS = (
    "hablar con una persona",
    "hablar con humano",
    "hablar con un humano",
    "pasame con una persona",
    "pásame con una persona",
    "pasame con humano",
    "pásame con humano",
    "necesito un humano",
    "necesito hablar con alguien",
    "quiero hablar con alguien",
    "quiero un agente",
    "quiero agente",
    "atencion al cliente",
    "atención al cliente",
)

# ---------------------------------------------------------------------------
# Prompt maestro
# ---------------------------------------------------------------------------
PROMPT_MAESTRO_TEMPLATE = """Eres el asistente virtual de Clínica Dental Sonrisas Saludables.

FECHA ACTUAL: Hoy es {fecha_hoy}. Úsala como referencia cuando el paciente diga "mañana", "el lunes", etc.

CLÍNICA
- Dirección: Calle Genista 7, local, 28011, Madrid (zona Puerta del Ángel / Lucero).
- Horario de la clínica: lunes a jueves 10:00-14:00 y 15:30-19:30; viernes 10:00-14:00; sábado y domingo cerrado.

TONO
- Trato de usted, natural y breve.
- Sin emojis.
- Máximo 3 párrafos por respuesta.
- No inventes datos médicos, disponibilidad ni precios. Si no lo sabes, deriva a atención humana.

INTENCIONES POSIBLES
1. Agendar una cita nueva.
2. Reagendar o cancelar una cita existente.
3. Resolver dudas (dirección, horario, formas de pago si las conoce, etc.).
4. Hablar con una persona.

Si la intención no está clara, pregunta una vez para aclarar.

============================================================
A) AGENDAR CITA
============================================================
Sigue este orden estricto (NO TE SALTES NINGÚN PASO):

1. PRIMERO: Pregunta para quién es la cita: el propio paciente o un tercero. Si es para un tercero, confirma si tiene 14 años o más.
   - Si es menor de 14: clasifica como menor de edad y pide su edad.
   - Si tiene 14 o más: pide solo su nombre y clasifica como mayor de edad.
   (¡ES OBLIGATORIO HACER ESTAS PREGUNTAS ANTES DE CONTINUAR!)

2. SEGUNDO: Pregunta qué le ocurre al paciente (molestia, motivo).
   ¡MUY IMPORTANTE (TRIAJE)!: Si el síntoma es ambiguo (por ejemplo: "me duele la muela"), NO adivines el servicio. Hazle preguntas para descartar opciones (ejemplo: "¿Es un dolor muy agudo que le impide dormir o es solo una molestia leve?"). Usa las descripciones de abajo para saber qué preguntar.
   (¡NO EJECUTES NINGUNA FUNCIÓN HASTA HABER PREGUNTADO Y ESTAR 100% SEGURO DEL SERVICIO!)

3. TERCERO: Una vez que hayas hecho las preguntas necesarias y estés completamente seguro, clasifica el problema en EXACTAMENTE uno de estos servicios:

SERVICIOS OFRECIDOS
- Urgencia Adultos: dolor agudo, inflamación, flemón, pus, fractura, sangrado importante, dolor que impide dormir o no cede.
- Urgencia Niños: lo mismo en menores de 14 años o golpes/caídas con sangrado o rotura.
- Primera visita Adultos: valoración general, segunda opinión, presupuesto o no sabe qué necesita, sin urgencia clara.
- Primera visita Niños: primera revisión general sin urgencia.
- Dentista infantil / Odontopediatría: valoración o tratamiento dental infantil.
- Revisión odontopediatría: revisión de niño ya paciente.
- Empaste dental: caries, agujeros, puntos negros, sensibilidad breve, pequeño trozo roto sin dolor fuerte.
- Endodoncia: dolor fuerte, profundo o pulsátil, peor al tumbarse o morder.
- Limpieza dental: sarro, manchas, sangrado leve al cepillado, mantenimiento.
- Curetaje dental: encías muy inflamadas, sangrado frecuente, mal aliento persistente, retracción o movilidad.
- Blanqueamiento dental: aclarar color de dientes sanos.
- Ortodoncia brackets: alineación con brackets o molestia leve de brackets.
- Ortodoncia invisible: férulas transparentes.
- Ortodoncia para adultos: ortodoncia general en adultos.
- Valoracion Ortodoncia: cita inicial para decidir tratamiento.
- Implantes dentales: falta un diente o van a extraerlo y quiere reponerlo.
- Implantoprotesis: ya lleva implante y necesita corona final.
- Prótesis dentales: dentadura removible, puente o arreglo de prótesis.
- TAC DENTAL: escáner 3D solicitado.
- Roncopatias y apnea del sueño: ronquidos, pausas respiratorias o cansancio al despertar.

4. CUARTO: SOLO CUANDO ya tengas las respuestas de los Pasos 1 y 2, y hayas clasificado el servicio en el Paso 3, ejecuta la función Consultar_Doctores con el nombre exacto del servicio. La función te devolverá el nombre del doctor o doctores que atienden ese servicio.

5. QUINTO: En el siguiente turno, tras recibir el resultado de Consultar_Doctores, indícale al paciente qué doctor le atenderá y envíale el enlace para reservar su hueco. Estructura ejemplo:
   "Esta cita la atenderá la Dra. [nombre]. Puede reservar su hueco en el siguiente enlace: {link_agendar}"
   - Si la función devuelve varios doctores, nómbrelos todos en la frase.
   - El enlace SIEMPRE es {link_agendar}, sin importar qué doctor atienda.
   - No vuelvas a llamar Consultar_Doctores en el mismo flujo de agendamiento.

6. SEXTO: Cierre: "¿Le puedo ayudar con algo más?".

============================================================
B) REAGENDAR O CANCELAR CITA
============================================================
Sigue este orden EN ESTE ORDEN EXACTO:

1. Confirma con el paciente si quiere reagendar o cancelar.

2. Responde: "Para gestionar sus citas le recomendamos descargar la app de Doctoralia. ¿Su móvil es Android o iPhone?".

3. Cuando el paciente diga su tipo de móvil:
   - Si es iPhone (iOS, Apple): envía el enlace {link_ios}.
   - Si es Android: envía el enlace {link_android}.
   - Si dice algo que no es claramente uno de los dos, pregunta de nuevo.
   Estructura: "Aquí tiene el enlace de Doctoralia para [iPhone/Android]: <enlace>".

4. DESPUÉS de enviar el enlace, en el siguiente turno, pregunta el motivo del cambio o cancelación. Texto orientativo: "¿Podría indicarme el motivo del cambio (o de la cancelación)? Es para nuestros registros internos." No insistas si el paciente no quiere darlo.

5. Cierre: agradece y pregunta "¿Le puedo ayudar con algo más?".

============================================================
C) DUDAS GENERALES
============================================================
Responde con la información de la clínica indicada arriba. Si no tienes la información concreta (precios, formas de pago específicas, citas concretas, etc.), deriva al flujo D (atención humana).

============================================================
D) ATENCIÓN HUMANA
============================================================
Cuando el paciente pida hablar con una persona, o cuando una duda no la puedas resolver con la información que tienes, responde EXACTAMENTE este texto y nada más:

"{horario_humano}"

NO escales a nadie. NO digas que vas a avisar a alguien. Solo da la información de contacto y los horarios.

============================================================
REGLAS DE FORMATO DE RESPUESTA
============================================================
SIEMPRE respondes en JSON válido con esta estructura exacta:
{{
  "respuesta_usuario": "Lo que le vas a decir al paciente",
  "funcion_a_ejecutar": "Consultar_Doctores" o null,
  "datos_funcion": {{ "servicio_requerido": "<uno de los servicios listados>" }} o {{}}
}}

- La única función que puedes llamar es Consultar_Doctores. Cualquier otra cosa va con funcion_a_ejecutar=null y datos_funcion={{}}.
- ¡REGLA DE ORO!: funcion_a_ejecutar DEBE SER null mientras estás haciendo las preguntas de los pasos 1 y 2. ¡NO te inventes un servicio! Solo pon "Consultar_Doctores" cuando el paciente ya te haya respondido TODO lo necesario.
- Cuando llames Consultar_Doctores, datos_funcion debe contener exclusivamente el campo "servicio_requerido" con el nombre exacto del servicio elegido (de la lista de SERVICIOS OFRECIDOS).
- Nunca incluyas otros campos en datos_funcion."""


def construir_prompt_maestro() -> str:
    fecha_hoy = datetime.now(TZ_MADRID).strftime("%Y-%m-%d")
    return PROMPT_MAESTRO_TEMPLATE.format(
        fecha_hoy=fecha_hoy,
        link_agendar=LINK_AGENDAR,
        link_ios=LINK_DOCTORALIA_IOS,
        link_android=LINK_DOCTORALIA_ANDROID,
        horario_humano=HORARIO_HUMANO,
    )


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bot")


# ---------------------------------------------------------------------------
# Estado en memoria
# ---------------------------------------------------------------------------
sesiones: dict[str, dict] = {}
sesiones_lock = threading.Lock()

# Idempotencia: ids de mensaje recientes para evitar procesar el mismo mensaje
# dos veces si el bridge reintenta. TTL implícito por tamaño máximo.
mensajes_vistos: dict[str, float] = {}
mensajes_vistos_lock = threading.Lock()
MENSAJES_VISTOS_MAX = 5000
MENSAJES_VISTOS_TTL_S = 3600


def _purgar_mensajes_vistos() -> None:
    ahora = time.time()
    with mensajes_vistos_lock:
        if len(mensajes_vistos) <= MENSAJES_VISTOS_MAX:
            for mid in [
                mid
                for mid, ts in mensajes_vistos.items()
                if ahora - ts > MENSAJES_VISTOS_TTL_S
            ]:
                mensajes_vistos.pop(mid, None)
            return
        # Si superamos el máximo, conservamos solo los más recientes.
        ordenados = sorted(mensajes_vistos.items(), key=lambda x: x[1], reverse=True)
        mensajes_vistos.clear()
        mensajes_vistos.update(dict(ordenados[: MENSAJES_VISTOS_MAX // 2]))


def es_mensaje_duplicado(message_id: str) -> bool:
    if not message_id:
        return False
    ahora = time.time()
    with mensajes_vistos_lock:
        if message_id in mensajes_vistos:
            return True
        mensajes_vistos[message_id] = ahora
    _purgar_mensajes_vistos()
    return False


def crear_historial_inicial(numero: str) -> list[dict]:
    return [
        {"role": "system", "content": construir_prompt_maestro()},
        {
            "role": "system",
            "content": f"NÚMERO DE TELÉFONO ACTUAL DEL USUARIO: {numero}",
        },
    ]


def recortar_historial(historial: list[dict]) -> list[dict]:
    """Conserva system messages + últimos N turnos."""
    sistemas = [m for m in historial if m["role"] == "system"]
    no_sistemas = [m for m in historial if m["role"] != "system"]
    if len(no_sistemas) > MAX_HISTORIAL:
        no_sistemas = no_sistemas[-MAX_HISTORIAL:]
    return sistemas + no_sistemas


def obtener_o_resetear_sesion(numero: str) -> dict:
    ahora = time.time()
    with sesiones_lock:
        sesion = sesiones.get(numero)
        if sesion is None or ahora - sesion["ultimo_uso"] > SESSION_TIMEOUT_MIN * 60:
            sesion = {
                "historial": crear_historial_inicial(numero),
                "ultimo_uso": ahora,
            }
            sesiones[numero] = sesion
        else:
            sesion["ultimo_uso"] = ahora
            sesion["historial"] = recortar_historial(sesion["historial"])
        return sesion


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------
cliente_ai = OpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT_S)


def solicitar_json_al_modelo(mensajes: list[dict]) -> dict:
    """Llama al modelo y devuelve el JSON parseado.

    Si el modelo devuelve algo que no es JSON válido, levanta ValueError.
    """
    completion = cliente_ai.chat.completions.create(
        model=OPENAI_MODEL,
        messages=mensajes,
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    raw = completion.choices[0].message.content or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Respuesta del modelo no es JSON válido: {raw!r}") from exc
    return data


# ---------------------------------------------------------------------------
# WhatsApp bridge
# ---------------------------------------------------------------------------
def enviar_a_whatsapp(numero_destino: str, texto: str) -> bool:
    if not texto:
        return False
    payload = {"to": numero_destino, "text": {"body": texto}}
    headers = {}
    if WA_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {WA_BRIDGE_TOKEN}"
    try:
        respuesta = requests.post(
            f"{WA_BRIDGE_URL}/send", json=payload, headers=headers, timeout=15
        )
    except requests.RequestException as exc:
        log.error("Bridge inalcanzable enviando a %s: %s", numero_destino, exc)
        return False
    if respuesta.status_code != 200:
        log.error(
            "Bridge devolvió %s al enviar a %s: %s",
            respuesta.status_code,
            numero_destino,
            respuesta.text[:200],
        )
        return False
    return True


# ---------------------------------------------------------------------------
# Make: Consultar_Doctores
# ---------------------------------------------------------------------------
def consultar_doctores(servicio: str) -> dict:
    if not MAKE_WEBHOOK_DOCTORES:
        log.warning("MAKE_WEBHOOK_DOCTORES no configurado")
        return {"ok": False, "error": "webhook_not_configured"}
    try:
        respuesta = requests.post(
            MAKE_WEBHOOK_DOCTORES,
            json={"servicio": servicio},
            timeout=15,
        )
    except requests.RequestException as exc:
        log.error("Error llamando Consultar_Doctores: %s", exc)
        return {"ok": False, "error": str(exc)}
    if respuesta.status_code != 200:
        log.error("Consultar_Doctores devolvió %s: %s", respuesta.status_code, respuesta.text[:200])
        return {"ok": False, "status_code": respuesta.status_code, "raw": respuesta.text}
    try:
        data = respuesta.json()
    except ValueError:
        data = {"raw": respuesta.text}
    return {"ok": True, "data": data}


def generar_respuesta_tras_make(numero: str, plan_inicial: dict, resultado_make: dict) -> dict:
    """Pide al modelo que genere la respuesta final tras ejecutar Consultar_Doctores."""
    sesion = obtener_o_resetear_sesion(numero)
    instrucciones = (
        "Has recibido el resultado de Consultar_Doctores. Genera la respuesta final al paciente. "
        "MUY IMPORTANTE: Primero debes decirle al paciente de forma EXPLÍCITA en qué servicio has clasificado su problema (el que enviaste a Make), "
        "luego indícale qué doctor le atenderá, y finalmente dale el enlace de agendamiento. "
        f"Ejemplo: 'Para su caso, hemos clasificado la cita como [Nombre del Servicio]. Le atenderá el Dr. [Nombre]. Puede reservar su hueco aquí: {LINK_AGENDAR}'. "
        "Responde en JSON con funcion_a_ejecutar=null y datos_funcion={}."
    )
    mensajes = sesion["historial"] + [
        {"role": "system", "content": instrucciones},
        {
            "role": "user",
            "content": json.dumps(
                {"plan_inicial": plan_inicial, "resultado_make": resultado_make},
                ensure_ascii=False,
            ),
        },
    ]
    try:
        datos = solicitar_json_al_modelo(mensajes)
    except Exception as exc:  # noqa: BLE001
        log.exception("Fallo generando respuesta tras Make: %s", exc)
        return {
            "respuesta_usuario": (
                "Disculpe, he tenido un problema técnico. ¿Podría volver a indicarme el motivo de la cita?"
            ),
            "funcion_a_ejecutar": None,
            "datos_funcion": {},
        }
    datos["funcion_a_ejecutar"] = None
    datos["datos_funcion"] = {}
    return datos


# ---------------------------------------------------------------------------
# Detección de "humano" (atajo sin OpenAI)
# ---------------------------------------------------------------------------
def detectar_solicitud_humano(texto: str) -> bool:
    if not texto:
        return False
    texto_norm = texto.lower().strip()
    return any(kw in texto_norm for kw in HUMAN_REQUEST_KEYWORDS)


# ---------------------------------------------------------------------------
# Orquestación de un mensaje entrante
# ---------------------------------------------------------------------------
def procesar_mensaje(numero: str, texto: str) -> str | None:
    """Procesa un mensaje entrante y devuelve la respuesta a enviar (o None)."""
    if detectar_solicitud_humano(texto):
        sesion = obtener_o_resetear_sesion(numero)
        sesion["historial"].append({"role": "user", "content": texto})
        sesion["historial"].append({"role": "assistant", "content": HORARIO_HUMANO})
        return HORARIO_HUMANO

    sesion = obtener_o_resetear_sesion(numero)
    sesion["historial"].append({"role": "user", "content": texto})

    try:
        datos = solicitar_json_al_modelo(sesion["historial"])
    except Exception as exc:  # noqa: BLE001
        log.exception("Fallo llamando al modelo: %s", exc)
        return (
            "Disculpe, he tenido un problema técnico. ¿Podría intentarlo de nuevo en un momento?"
        )

    respuesta_usuario = (datos.get("respuesta_usuario") or "").strip()
    funcion = datos.get("funcion_a_ejecutar")

    sesion["historial"].append(
        {"role": "assistant", "content": json.dumps(datos, ensure_ascii=False)}
    )

    if funcion == "Consultar_Doctores":
        servicio = (datos.get("datos_funcion") or {}).get("servicio_requerido", "")
        resultado = consultar_doctores(servicio)
        datos_finales = generar_respuesta_tras_make(numero, datos, resultado)
        respuesta_usuario = (datos_finales.get("respuesta_usuario") or "").strip()
        sesion["historial"].append(
            {"role": "assistant", "content": json.dumps(datos_finales, ensure_ascii=False)}
        )
    elif funcion not in (None, ""):
        log.warning("El modelo intentó llamar función no permitida: %s", funcion)

    return respuesta_usuario or None


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"status": "ok"}), 200


@app.post("/webhook")
def webhook():
    """Recibe el payload del bridge whatsapp-web.js (formato Meta-shim)."""
    payload = request.get_json(silent=True) or {}
    try:
        mensaje = payload["entry"][0]["changes"][0]["value"]["messages"][0]
        numero = mensaje["from"]
        message_id = mensaje.get("id") or ""
        tipo = mensaje.get("type")
        texto = (mensaje.get("text") or {}).get("body", "").strip()
    except (KeyError, IndexError, TypeError):
        log.warning("Payload de webhook con formato inesperado")
        return jsonify({"ok": False, "error": "bad_payload"}), 200

    if tipo != "text":
        log.info("Mensaje no-texto de %s ignorado (type=%s)", numero, tipo)
        return jsonify({"ok": True, "ignored": "non_text"}), 200

    if not texto:
        return jsonify({"ok": True, "ignored": "empty"}), 200

    if es_mensaje_duplicado(message_id):
        log.info("Mensaje duplicado %s ignorado", message_id)
        return jsonify({"ok": True, "ignored": "duplicate"}), 200

    log.info("IN <%s>: %s", numero, texto[:120])

    try:
        respuesta = procesar_mensaje(numero, texto)
    except Exception as exc:  # noqa: BLE001
        log.exception("Error procesando mensaje: %s", exc)
        respuesta = (
            "Disculpe, he tenido un problema técnico. ¿Podría intentarlo de nuevo en un momento?"
        )

    if respuesta:
        if enviar_a_whatsapp(numero, respuesta):
            log.info("OUT <%s>: %s", numero, respuesta[:120])
        else:
            log.error("No pude entregar respuesta a %s", numero)

    return jsonify({"ok": True}), 200


@app.route("/api/webhooks/retell", methods=["GET", "POST"], strict_slashes=False)
def retell_webhook():
    """Recibe eventos de llamadas de Retell AI (análisis post-llamada)."""
    if request.method == "GET":
        return jsonify({"status": "ready"}), 200

    try:
        datos = request.get_json(silent=True) or {}
        evento = datos.get("event")
        
        if evento == "call_analyzed":
            call = datos.get("call", {})
            
            # Unimos las variables dinámicas y los datos de análisis post-llamada
            analisis = call.get("call_analysis", {}) or {}
            custom_data = analisis.get("custom_analysis_data", {}) or {}
            dynamic_data = call.get("collected_dynamic_variables", {}) or {}
            
            variables = {**dynamic_data, **custom_data}
            
            # Procesamos motivo y número
            motivo = str(variables.get("motivo", "")).lower().strip()
            numero_cliente = call.get("from_number", "").replace("+", "")
            
            log.info("🎯 MOTIVO DETECTADO: '%s' para %s", motivo, numero_cliente)

            if "agendar" in motivo:
                servicio = variables.get("servicio") or "tu tratamiento"
                doctoras = variables.get("doctoras") or "nuestros profesionales"
                mensaje = (
                    f"Para reservar tu cita de {servicio} con {doctoras}, hazlo aquí: "
                    "https://www.doctoralia.es/clinicas/clinica-dental-sonrisas-saludables"
                )
                enviar_a_whatsapp(numero_cliente, mensaje)

            elif any(x in motivo for x in ["cancelar", "reagendar", "recordar"]):
                mensaje = (
                    "Para gestionar, cancelar o recordar tus citas, te recomendamos descargar la App de Doctoralia:\n"
                    "📲 iOS: https://apps.apple.com/es/app/doctoralia/id1081682337\n"
                    "📲 Android: https://play.google.com/store/apps/details?id=com.docplanner.doctoralia\n\n"
                    "Si prefieres hablar con nosotros, nuestro horario es de Lunes a Jueves: 10:00 - 14:00 y 15:30 - 19:30. Y Viernes: 10:00 - 14:00"
                )
                enviar_a_whatsapp(numero_cliente, mensaje)

            elif "humano" in motivo:
                mensaje = (
                    "¡Hola! Hemos visto que querías hablar con nosotros. "
                    "Para poder atenderte personalmente, llámanos en nuestro horario laboral:\n"
                    "🕒 Lunes a Jueves: 10:00 - 14:00 y 15:30 - 19:30.\nY Viernes: 10:00 - 14:00\n"
                    "¡Estaremos encantados de ayudarte!"
                )
                enviar_a_whatsapp(numero_cliente, mensaje)

            elif "aseguradora" in motivo:
                mensaje = (
                    "Gracias por consultarnos sobre tu aseguradora. "
                    "Recuerda traer tu tarjeta física o digital el día de tu cita para poder tramitar la autorización."
                )
                enviar_a_whatsapp(numero_cliente, mensaje)

            elif "informacion" in motivo:
                log.info("El cliente %s solo buscaba información. No se envía WhatsApp.", numero_cliente)

            else:
                log.warning("Motivo no identificado (%s).", motivo)

    except Exception as e:
        log.exception("Error procesando webhook de Retell: %s", e)
        
    return jsonify({"status": "received"}), 200


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("PORT", os.getenv("FLASK_PORT", "5000")))
    app.run(host=host, port=port, debug=False)
