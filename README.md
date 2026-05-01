# Sonrisas Saludables — Bot de WhatsApp por QR

Bot conversacional para la clínica dental Sonrisas Saludables. Atiende
mensajes de WhatsApp y resuelve cuatro flujos:

| Intención | Qué hace el bot |
|---|---|
| Agendar cita | Clasifica el servicio, consulta el doctor en Make y envía el enlace de Doctoralia. |
| Reagendar / cancelar | Recomienda la app Doctoralia, manda el enlace de Android o iPhone y pregunta el motivo. |
| Dudas | Responde con la información de la clínica (dirección, horario). Si no la tiene, deriva a humano. |
| Hablar con persona | Envía el teléfono de atención y los horarios. No escala. |

No hay panel humano, ni base de datos persistente, ni inbox web. Todo el
estado vive en memoria con TTL de 30 minutos.

---

## Arquitectura

```
                                                   .─────────.
   WhatsApp móvil  ───►  whatsapp-bridge   ───►   │  Flask   │
       (paciente)        (Node, puerto 3000)      │ botapp.py│
                            ▲                     │ puerto    │
                            │                     │  5000    │
                            └──── /send ──────────┤          │
                                                   `─────────'
                                                        │
                                                        ▼
                                             ┌──── OpenAI (gpt-4o-mini)
                                             │
                                             └──── Make (Consultar_Doctores)
```

Dos procesos en la **misma máquina**:

1. **whatsapp-bridge** (Node) — usa `whatsapp-web.js` con `LocalAuth`. La
   primera vez muestra un código QR en consola que hay que escanear desde
   el WhatsApp del cliente. La sesión queda guardada en
   `whatsapp-bridge/.wwebjs_auth/` y persiste entre reinicios.
2. **botapp.py** (Python/Flask) — recibe los mensajes del bridge en
   `POST /webhook`, los procesa con OpenAI siguiendo el prompt maestro y
   responde llamando a `POST /send` del bridge.

Ambos se autentican entre sí con un token compartido (`WA_BRIDGE_TOKEN`).

---

## Requisitos

- Node.js 18 o superior.
- Python 3.10 o superior.
- Una clave de OpenAI con saldo.
- Un escenario en Make con webhook activo que reciba `{servicio_requerido}`
  y devuelva el nombre del doctor.
- Un número de WhatsApp dedicado al bot (idealmente uno solo del cliente).

---

## Instalación

```bash
# 1. Clonar el repo
git clone https://github.com/Marcocr06/botLoco.git
cd botLoco

# 2. Crear .env (ver plantilla más abajo)
#    En Windows usa Notepad; en Mac/Linux usa el editor que prefieras.

# 3. Backend Python
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Mac/Linux:
source .venv/bin/activate
pip install -r requirements.txt

# 4. Bridge Node
cd whatsapp-bridge
npm install
cd ..
```

---

## Configuración: `.env`

Crea un archivo llamado `.env` en la raíz del proyecto con este contenido
(reemplaza los valores marcados):

```ini
# OpenAI
OPENAI_API_KEY=sk-...                       # tu clave real
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_S=30

# Make
MAKE_WEBHOOK_DOCTORES=https://hook.eu2.make.com/XXXXXXXX

# Token compartido bridge ↔ Flask. Ponlo largo y aleatorio.
WA_BRIDGE_TOKEN=cambia-esto-por-un-token-largo

# Bridge Node
WA_BRIDGE_HOST=127.0.0.1
WA_BRIDGE_PORT=3000
WA_BUFFER_WAIT_MS=5000
WA_BUFFER_MAX_MS=15000

# URLs cruzadas (déjalas si bridge y Flask corren en la misma máquina)
WA_BRIDGE_URL=http://127.0.0.1:3000
FLASK_WEBHOOK_URL=http://127.0.0.1:5000/webhook

# Backend Flask
FLASK_HOST=127.0.0.1
FLASK_PORT=5000
LOG_LEVEL=INFO
```

> ⚠️ Nunca subas `.env` a Git. Está en `.gitignore`.

---

## Arrancar (desarrollo)

Necesitas **dos terminales**.

**Terminal 1 — bridge:**
```bash
cd whatsapp-bridge
npm start
```
La primera vez aparecerá un QR. Escanéalo desde el móvil con WhatsApp →
Ajustes → Dispositivos vinculados → Vincular un dispositivo. Cuando veas
`Cliente WhatsApp Web listo`, está conectado y la sesión queda guardada.

**Terminal 2 — backend:**
```bash
# Con el venv activado
python botapp.py
```

Manda un WhatsApp al número del bot desde otro teléfono y debería
responder. Para verlo todo bien hay que mirar las dos terminales en
paralelo.

Health check rápido:
```bash
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:3000/health
```

---

## Producción

Recomendado: una VPS Linux (Hetzner, DigitalOcean, etc.) con `systemd` o
Docker. Dos servicios:

- `bot-bridge.service` ejecutando `node index.js` en `/opt/botloco/whatsapp-bridge`.
- `bot-flask.service` ejecutando `python botapp.py` en `/opt/botloco`.

Puntos a vigilar:

- El proceso del bridge necesita Chromium (lo trae Puppeteer; en VPS sin
  Chrome/Chromium instalar `chromium` y dependencias gráficas básicas).
- La carpeta `whatsapp-bridge/.wwebjs_auth/` debe estar en disco persistente
  para no tener que escanear QR en cada reinicio.
- Mantén `WA_BRIDGE_HOST=127.0.0.1` y `FLASK_HOST=127.0.0.1`. Ningún
  servicio debe escuchar en `0.0.0.0` en producción.
- No expongas `/send` a internet. La comunicación bridge ↔ Flask es local.

---

## Operación

| Acción | Cómo |
|---|---|
| Ver si el bridge está conectado | `curl http://127.0.0.1:3000/health` (esperar `ready: true`). |
| Reescanear QR | Borrar `whatsapp-bridge/.wwebjs_auth/` y reiniciar el bridge. |
| Cambiar el prompt | Editar `botapp.py` (constante `PROMPT_MAESTRO_TEMPLATE`) y reiniciar. |
| Ver mensajes en tiempo real | Mirar la consola del bridge (`IN <…>`) y de Flask (`IN <…>` / `OUT <…>`). |
| Cambiar teléfono o horario humano | Editar las constantes `TELEFONO_HUMANO` y `HORARIO_HUMANO` en `botapp.py`. |

---

## Limitaciones conocidas (v1)

- Solo procesa mensajes de tipo `text`. Audios, imágenes y ubicaciones se
  ignoran silenciosamente — el paciente no recibe ningún acuse.
- Sin persistencia: si reinicias Flask se pierde el contexto conversacional
  de cada paciente (volverá a presentarse y empezará de cero).
- Sin firma de webhook ni rate limiting. Bridge y Flask asumen que están
  detrás del mismo host (127.0.0.1). No expongas Flask a internet sin
  proxy/firewall.
- `whatsapp-web.js` es una librería no oficial. WhatsApp puede romperla en
  cualquier actualización; mantenla en una versión reciente.
