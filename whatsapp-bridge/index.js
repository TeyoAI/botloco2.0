/**
 * Puente WhatsApp Web -> backend Flask.
 *
 * - Recibe mensajes vía whatsapp-web.js (cliente que escanea QR).
 * - Los reenvía a FLASK_WEBHOOK_URL como POST con un payload con forma de Meta.
 * - Expone POST /send para que el backend mande respuestas por WA.
 *
 * Reconexión automática, flag isReady, bind a 127.0.0.1 por defecto,
 * cabecera Authorization: Bearer compartida con Flask, cap absoluto del buffer.
 */
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// LocalAuth guarda la sesión aquí. Para que persista entre redeploys hace falta
// montar un volume de Railway en esta ruta.
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');

const PORT = parseInt(process.env.PORT || process.env.WA_BRIDGE_PORT || '3000', 10);
const HOST = process.env.WA_BRIDGE_HOST || '0.0.0.0';
const FLASK_WEBHOOK_URL =
  process.env.FLASK_WEBHOOK_URL || 'http://127.0.0.1:5000/webhook';
const SHARED_TOKEN = (process.env.WA_BRIDGE_TOKEN || '').trim();

const BUFFER_WAIT_MS = parseInt(process.env.WA_BUFFER_WAIT_MS || '5000', 10);
const BUFFER_MAX_MS = parseInt(process.env.WA_BUFFER_MAX_MS || '15000', 10);
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 60000;

if (!SHARED_TOKEN) {
  console.warn(
    '[bridge] AVISO: WA_BRIDGE_TOKEN no está definido. /send aceptará cualquier petición que llegue al puerto.'
  );
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let isReady = false;
let qrPending = false;
let lastQrCode = null;
let lastDisconnectReason = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

const messageBuffers = new Map();

const log = (level, ...args) => {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level}]`, ...args);
};

// ---------------------------------------------------------------------------
// Cliente whatsapp-web.js
// ---------------------------------------------------------------------------
let client = null;
let isResetting = false;
let isInitializing = false;
// Cada llamada a crearCliente() incrementa esta generación. Los listeners
// capturan su generación en closure y se vuelven no-op si ya no son los
// activos: previene cascadas de reconexión cuando el cliente viejo emite
// eventos tardíos tras destroy().
let clientGeneration = 0;

function crearCliente() {
  const generation = ++clientGeneration;
  const isStale = () => generation !== clientGeneration;

  const c = new Client({
    authStrategy: new LocalAuth({
      clientId: `gen-${generation}`,
      dataPath: './.wwebjs_auth'
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
      headless: true,
      // Margen sobre el default por si el contenedor va lento al inyectar el
      // store de WA Web. El error original era exactamente este timeout.
      protocolTimeout: 120000,
      // Sin --single-process: ese flag colapsa renderer+browser en un proceso
      // y bloquea Runtime.callFunctionOn al recargar sesión en WA Web.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      executablePath: '/usr/bin/chromium'
    },
  });

  c.on('qr', (qr) => {
    if (isStale()) return;
    qrPending = true;
    isReady = false;
    lastQrCode = qr;
    console.log('\n=========================================');
    console.log('QR DISPONIBLE! Abre este enlace para escanear:');
    console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    console.log('=========================================\n');
    qrcode.generate(qr, { small: true });
  });

  c.on('loading_screen', (percent, message) => {
    if (isStale()) return;
    log('info', `loading_screen: ${percent}% ${message || ''}`);
  });

  c.on('authenticated', () => {
    if (isStale()) return;
    qrPending = false;
    log('info', `[gen ${generation}] Sesión autenticada (LocalAuth guardado)`);
  });

  c.on('auth_failure', (msg) => {
    if (isStale()) return;
    isReady = false;
    qrPending = false;
    log('error', 'auth_failure:', msg);
    if (!isResetting) scheduleReconnect();
  });

  c.on('ready', () => {
    if (isStale()) return;
    isReady = true;
    qrPending = false;
    lastQrCode = null;
    reconnectAttempt = 0;
    log('info', `[gen ${generation}] Cliente WhatsApp Web listo`);
    log('info', `>>> MONITOR ACTIVADO - ESPERANDO MENSAJES (v1.0.6) <<<`);
  });

  c.on('disconnected', (reason) => {
    if (isStale()) {
      log('warn', `[gen ${generation}] disconnected (stale, ignorado): ${reason}`);
      return;
    }
    isReady = false;
    qrPending = false;
    lastDisconnectReason = String(reason);
    log('warn', `[gen ${generation}] disconnected, motivo:`, reason);
    if (isResetting) return;

    // Si el motivo indica que el dispositivo fue desvinculado desde el móvil
    // (o entró en conflicto con otra sesión), reusar la sesión local provoca
    // el ProtocolError en inject. Borramos .wwebjs_auth y forzamos QR nuevo.
    const wipeReasons = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'CONFLICT'];
    if (wipeReasons.includes(String(reason).toUpperCase())) {
      wipeAndReinit(reason).catch((err) => {
        log('error', `wipeAndReinit tras disconnect falló: ${err.message}`);
        scheduleReconnect();
      });
    } else {
      scheduleReconnect();
    }
  });

  c.on('change_state', (state) => {
    if (isStale()) return;
    log('info', 'change_state:', state);
  });

  c.on('message_create', async (msg) => {
    if (isStale()) return;
    
    // Ignoramos estados para no ensuciar el log y no asustar al usuario
    if (msg.from === 'status@broadcast') return;

    // Log de lo que entra
    log('info', `Recibido: from=${msg.from} type=${msg.type} fromMe=${msg.fromMe} body="${msg.body ? msg.body.substring(0, 50) : ''}"`);

    if (msg.fromMe) {
        log('debug', 'Ignorado: mensaje enviado por el propio bot');
        return;
    }
    
    if (msg.from.includes('@g.us')) {
        log('debug', 'Ignorado: mensaje de grupo');
        return;
    }
    
    // Si el tipo no es chat, lo logueamos por si acaso
    if (msg.type !== 'chat') {
        log('info', `Tipo de mensaje no procesable: ${msg.type}`);
        return;
    }

    let chatId = msg.from;
    if (chatId.endsWith('@lid')) {
      try {
        const contact = await msg.getContact();
        if (contact && contact.number) {
          chatId = `${contact.number}@c.us`;
          log('info', `Resuelto @lid ${msg.from} -> ${chatId}`);
        } else {
          log('warn', `@lid sin número resoluble (${msg.from}), descartando mensaje`);
          return;
        }
      } catch (err) {
        log('warn', `getContact() falló para ${msg.from}: ${err.message}, descartando`);
        return;
      }
    }

    let fromNumber = chatId.replace('@c.us', '');
    if (!fromNumber.startsWith('+') && fromNumber.length >= 11) {
      fromNumber = '+' + fromNumber;
    }

    let buffer = messageBuffers.get(fromNumber);
    if (!buffer) {
      buffer = {
        messages: [],
        ids: [],
        timer: null,
        hardTimer: null,
        startedAt: Date.now(),
      };
      messageBuffers.set(fromNumber, buffer);
      // Cap absoluto: aunque sigan llegando mensajes, flush a los BUFFER_MAX_MS
      // desde el primero, para que conversaciones encadenadas no queden retenidas.
      buffer.hardTimer = setTimeout(() => flushBuffer(fromNumber), BUFFER_MAX_MS);
    }

    buffer.messages.push(msg.body);
    buffer.ids.push(msg.id.id);

    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => flushBuffer(fromNumber), BUFFER_WAIT_MS);
  });

  return c;
}

client = crearCliente();

async function flushBuffer(fromNumber) {
  const buffer = messageBuffers.get(fromNumber);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.hardTimer) clearTimeout(buffer.hardTimer);
  messageBuffers.delete(fromNumber);

  const combinedText = buffer.messages.join('\n');
  // Usamos el id del ÚLTIMO mensaje del lote, no del primero. Si en el
  // futuro se dedupean reintentos por id, lo razonable es identificar el
  // grupo por su mensaje más reciente.
  const finalMsgId = buffer.ids[buffer.ids.length - 1];

  const metaPayload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: fromNumber,
                  id: finalMsgId,
                  type: 'text',
                  text: { body: combinedText },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  try {
    const headers = {};
    if (SHARED_TOKEN) {
      headers['Authorization'] = `Bearer ${SHARED_TOKEN}`;
    }
    log('info', `>>> Enviando a Flask: POST ${FLASK_WEBHOOK_URL} (from=${fromNumber})`);
    await axios.post(FLASK_WEBHOOK_URL, metaPayload, { headers, timeout: 30000 });
    log('info', `IN <${fromNumber}> (${buffer.messages.length} msg) -> Flask OK`);
  } catch (error) {
    const status = error.response && error.response.status;
    log(
      'error',
      `!!! FALLO enviando a Flask en ${FLASK_WEBHOOK_URL} | from=${fromNumber} | HTTP ${status} | ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Reconexión
// ---------------------------------------------------------------------------
// Recreamos siempre el cliente: tras un disconnected, el objeto puppeteer
// asociado puede quedar en estado degradado y reusar el mismo cliente es
// parte de la causa del ProtocolError en inject. isInitializing impide que
// dos ciclos de reconexión arranquen a la vez (cascada de clientes).
function scheduleReconnect() {
  if (reconnectTimer || isInitializing || isResetting) return;
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
  log('warn', `Reintentando inicialización en ${Math.round(delay / 1000)}s (intento #${reconnectAttempt})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (isInitializing || isResetting) return;
    isInitializing = true;
    try {
      try { await client.destroy(); } catch (_) { /* puede estar ya muerto */ }
      client = crearCliente();
      await client.initialize();
    } catch (err) {
      log('error', 'Fallo en reconnect:', err.message);
      isInitializing = false;
      scheduleReconnect();
      return;
    }
    isInitializing = false;
  }, delay);
}

// Borra la sesión local, destruye el cliente y arranca uno nuevo. Se usa
// tanto desde POST /reset como desde el handler 'disconnected' cuando el
// motivo indica logout/unpair (la sesión cacheada ya no sirve).
async function wipeAndReinit(reason) {
  if (isResetting || isInitializing) return;
  isResetting = true;
  isInitializing = true;
  log('warn', `wipeAndReinit (${reason}): destruyendo cliente y borrando sesión local`);

  isReady = false;
  qrPending = false;
  lastQrCode = null;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    try {
      await client.destroy();
    } catch (err) {
      log('warn', 'client.destroy() en wipeAndReinit falló:', err.message);
    }

    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    log('info', `Sesión borrada en ${AUTH_DIR}`);

    reconnectAttempt = 0;
    client = crearCliente();
    await client.initialize();
  } finally {
    isResetting = false;
    isInitializing = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));

// Auth middleware solo para /send (el resto -- /health -- queda libre).
function requireAuth(req, res, next) {
  if (!SHARED_TOKEN) return next();
  const header = req.get('Authorization') || '';
  const expected = `Bearer ${SHARED_TOKEN}`;
  if (header !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({
    ready: isReady,
    qr_pending: qrPending,
    last_disconnect: lastDisconnectReason,
    reconnect_attempt: reconnectAttempt,
  });
});

app.get('/qr', (req, res) => {
  if (isReady) return res.send('Ya conectado');
  if (!lastQrCode) return res.send('Esperando QR... recarga en 10 segundos');
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(lastQrCode)}`;
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#111;color:white;font-family:sans-serif">
        <h2>Escanea este QR</h2>
        <img src="${qrUrl}" style="border:10px solid white;border-radius:10px" />
        <p>Se actualiza solo cada 30s</p>
        <script>setTimeout(() => location.reload(), 30000)</script>
      </body>
    </html>
  `);
});

app.post('/send', requireAuth, async (req, res) => {
  if (!isReady) {
    return res
      .status(503)
      .json({ error: 'bridge_not_ready', qr_pending: qrPending });
  }

  const { to, text } = req.body || {};
  const body = text && typeof text === 'object' ? text.body : null;

  if (!to || typeof to !== 'string') {
    return res.status(400).json({ error: 'invalid_to' });
  }
  if (!body || typeof body !== 'string') {
    return res.status(400).json({ error: 'invalid_text' });
  }
  if (body.length > 4000) {
    return res.status(400).json({ error: 'text_too_long' });
  }

  let targetId = to.replace(/\+/g, '');
  if (!targetId.includes('@')) targetId += '@c.us';
  
  log('info', `DEBUG: Enviando respuesta a ${targetId} (limpio)`);

  try {
    await client.sendMessage(targetId, body);
    log('info', `OUT <${targetId}> (${body.length} chars)`);
    res.json({ status: 'ok' });
  } catch (err) {
    log('error', `FALLO CRITICO enviando a ${targetId}: ${err.message}`);
    res.status(502).json({ error: 'send_failed', message: err.message });
  }
});

// Resetea la sesión de WhatsApp: destruye el cliente, borra .wwebjs_auth/ y
// reinicializa para que aparezca un QR nuevo. Se usa al cambiar de número o
// cuando la sesión queda en estado raro tras vincular varios móviles.
app.post('/reset', requireAuth, async (req, res) => {
  if (isResetting) {
    return res.status(429).json({ error: 'reset_in_progress' });
  }
  try {
    await wipeAndReinit('manual_reset');
    return res.json({ status: 'ok', message: 'sesión borrada, esperando nuevo QR en /qr' });
  } catch (err) {
    log('error', '/reset falló:', err.message);
    scheduleReconnect();
    return res.status(500).json({ error: 'reset_failed', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------
app.get('/debug', async (req, res) => {
  const info = {
    bridge_ready: isReady,
    qr_pending: qrPending,
    flask_webhook_url: FLASK_WEBHOOK_URL,
    shared_token_set: !!SHARED_TOKEN,
    reconnect_attempt: reconnectAttempt,
    last_disconnect: lastDisconnectReason,
  };
  try {
    const r = await axios.get(FLASK_WEBHOOK_URL.replace('/webhook', '/health'), { timeout: 5000 });
    info.flask_health = r.data;
    info.flask_reachable = true;
  } catch (err) {
    info.flask_reachable = false;
    info.flask_error = err.message;
  }
  res.json(info);
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
app.listen(PORT, HOST, () => {
  log('info', `Bridge HTTP escuchando en ${HOST}:${PORT}`);
  log('info', `FLASK_WEBHOOK_URL = ${FLASK_WEBHOOK_URL}`);
});

isInitializing = true;
client.initialize()
  .then(() => { isInitializing = false; })
  .catch((err) => {
    isInitializing = false;
    log('error', 'client.initialize() inicial falló:', err.message);
    scheduleReconnect();
  });

// Salida limpia
function gracefulExit(signal) {
  log('info', `Señal ${signal} recibida, cerrando...`);
  // Forzamos flush de buffers pendientes para no perder mensajes del paciente.
  const pending = Array.from(messageBuffers.keys());
  Promise.allSettled(pending.map((number) => flushBuffer(number))).finally(() => {
    client.destroy().finally(() => process.exit(0));
  });
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
