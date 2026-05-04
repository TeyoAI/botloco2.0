/**
 * WhatsApp bridge usando @whiskeysockets/baileys (sin Chromium/Puppeteer).
 * - Genera QR en /qr
 * - Reenvía mensajes entrantes a Flask via POST /webhook
 * - Expone POST /send para responder desde Flask
 * - POST /reset para cambiar de número (borra sesión, genera nuevo QR)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  isJidGroup,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

console.error('**********************************************');
console.error('!!! BRIDGE BAILEYS ARRANCANDO - VERSION 3.0.0 !!!');
console.error('**********************************************');

const PORT = parseInt(process.env.PORT || process.env.WA_BRIDGE_PORT || '3000', 10);
const HOST = process.env.WA_BRIDGE_HOST || '0.0.0.0';
const FLASK_WEBHOOK_URL = process.env.FLASK_WEBHOOK_URL || 'http://127.0.0.1:5000/webhook';
const SHARED_TOKEN = (process.env.WA_BRIDGE_TOKEN || '').trim();
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

const BUFFER_WAIT_MS = parseInt(process.env.WA_BUFFER_WAIT_MS || '5000', 10);
const BUFFER_MAX_MS = parseInt(process.env.WA_BUFFER_MAX_MS || '15000', 10);

const log = (level, ...args) => {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level}]`, ...args);
};

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
let isReady = false;
let lastQrCode = null;
let lastDisconnectReason = null;
let sock = null;
let isResetting = false;

const messageBuffers = new Map();

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------
function wipeSession() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    log('info', `Sesión borrada en ${AUTH_DIR}`);
  }
}

// ---------------------------------------------------------------------------
// Baileys socket
// ---------------------------------------------------------------------------
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  log('info', `Usando WA version: ${version.join('.')}`);

  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Sonrisas Bot', 'Chrome', '122.0.0'],
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 3,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQrCode = qr;
      isReady = false;
      log('info', 'QR generado - visita /qr para escanear');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isReady = true;
      lastQrCode = null;
      lastDisconnectReason = null;
      const id = sock.user?.id || 'desconocido';
      log('info', `>>> CONECTADO como ${id} - ESPERANDO MENSAJES (v3.0.0) <<<`);
    }

    if (connection === 'close') {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[code] || code;
      lastDisconnectReason = String(reason);
      log('warn', `Desconectado. Código: ${code} | Razón: ${reason}`);

      const loggedOut = code === DisconnectReason.loggedOut;

      if (isResetting) return;

      if (loggedOut) {
        log('warn', 'Sesión cerrada por el móvil. Borrando credenciales y generando nuevo QR...');
        wipeSession();
        await conectar();
      } else {
        log('info', 'Reconectando en 5s...');
        setTimeout(() => conectar(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';

      // Ignorar grupos, estados y mensajes propios
      if (isJidGroup(jid)) continue;
      if (jid === 'status@broadcast') continue;
      if (msg.key.fromMe) continue;

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      console.error(`[TRACE] Mensaje recibido: from=${jid} body="${body}"`);

      if (!body) continue;

      // Extraer número limpio
      const rawNumber = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
      const fromNumber = rawNumber.startsWith('+') ? rawNumber : `+${rawNumber}`;

      bufferMensaje(fromNumber, body, msg.key.id);
    }
  });
}

// ---------------------------------------------------------------------------
// Buffer de mensajes (igual que antes)
// ---------------------------------------------------------------------------
function bufferMensaje(fromNumber, body, msgId) {
  let buffer = messageBuffers.get(fromNumber);
  if (!buffer) {
    buffer = {
      messages: [],
      ids: [],
      timer: null,
      hardTimer: null,
    };
    messageBuffers.set(fromNumber, buffer);
    buffer.hardTimer = setTimeout(() => flushBuffer(fromNumber), BUFFER_MAX_MS);
  }

  buffer.messages.push(body);
  buffer.ids.push(msgId);

  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => flushBuffer(fromNumber), BUFFER_WAIT_MS);
}

async function flushBuffer(fromNumber) {
  const buffer = messageBuffers.get(fromNumber);
  if (!buffer) return;
  if (buffer.timer) clearTimeout(buffer.timer);
  if (buffer.hardTimer) clearTimeout(buffer.hardTimer);
  messageBuffers.delete(fromNumber);

  const combinedText = buffer.messages.join('\n');
  const finalMsgId = buffer.ids[buffer.ids.length - 1];

  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: fromNumber,
            id: finalMsgId,
            type: 'text',
            text: { body: combinedText },
          }],
        },
      }],
    }],
  };

  try {
    const headers = {};
    if (SHARED_TOKEN) headers['Authorization'] = `Bearer ${SHARED_TOKEN}`;
    log('info', `>>> Enviando a Flask: from=${fromNumber} (${buffer.messages.length} msg)`);
    await axios.post(FLASK_WEBHOOK_URL, payload, { headers, timeout: 30000 });
    log('info', `IN <${fromNumber}> -> Flask OK`);
  } catch (err) {
    const status = err.response?.status;
    log('error', `FALLO enviando a Flask | from=${fromNumber} | HTTP ${status} | ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '256kb' }));

function requireAuth(req, res, next) {
  if (!SHARED_TOKEN) return next();
  const header = req.get('Authorization') || '';
  if (header !== `Bearer ${SHARED_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({
    ready: isReady,
    qr_pending: !!lastQrCode,
    last_disconnect: lastDisconnectReason,
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
    return res.status(503).json({ error: 'bridge_not_ready', qr_pending: !!lastQrCode });
  }

  const { to, text } = req.body || {};
  const body = text && typeof text === 'object' ? text.body : null;

  if (!to || typeof to !== 'string') return res.status(400).json({ error: 'invalid_to' });
  if (!body || typeof body !== 'string') return res.status(400).json({ error: 'invalid_text' });
  if (body.length > 4000) return res.status(400).json({ error: 'text_too_long' });

  let jid = to.replace(/\+/g, '');
  if (!jid.includes('@')) jid += '@s.whatsapp.net';

  try {
    await sock.sendMessage(jid, { text: body });
    log('info', `OUT <${jid}> (${body.length} chars)`);
    res.json({ status: 'ok' });
  } catch (err) {
    log('error', `FALLO enviando a ${jid}: ${err.message}`);
    res.status(502).json({ error: 'send_failed', message: err.message });
  }
});

app.post('/reset', requireAuth, async (req, res) => {
  if (isResetting) return res.status(429).json({ error: 'reset_in_progress' });
  isResetting = true;
  try {
    isReady = false;
    lastQrCode = null;
    if (sock) {
      try { sock.end(); } catch (_) {}
    }
    wipeSession();
    await conectar();
    res.json({ status: 'ok', message: 'sesión borrada, esperando nuevo QR en /qr' });
  } catch (err) {
    log('error', '/reset falló:', err.message);
    res.status(500).json({ error: 'reset_failed', message: err.message });
  } finally {
    isResetting = false;
  }
});

app.get('/debug', async (req, res) => {
  const info = {
    bridge_ready: isReady,
    qr_pending: !!lastQrCode,
    flask_webhook_url: FLASK_WEBHOOK_URL,
    shared_token_set: !!SHARED_TOKEN,
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

app.listen(PORT, HOST, () => {
  log('info', `Bridge HTTP escuchando en ${HOST}:${PORT}`);
  log('info', `FLASK_WEBHOOK_URL = ${FLASK_WEBHOOK_URL}`);
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
conectar().catch((err) => {
  log('error', 'Error fatal al conectar:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => { log('info', 'SIGINT, cerrando...'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'SIGTERM, cerrando...'); process.exit(0); });
