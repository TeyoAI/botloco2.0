# ============================================================
# Contenedor unificado: Flask bot + WhatsApp bridge Node.js
# ============================================================
FROM node:18-slim

# ── Dependencias del sistema ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    chromium \
    ca-certificates fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
    libnss3 libxcomposite1 libxdamage1 libxrandr2 libxss1 libxtst6 \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# ── Puppeteer: usa Chromium del sistema ───────────────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── URLs internas: Flask <-> Bridge por localhost ─────────
# El bridge enviará los mensajes a Flask a través de la URL de webhook local.
ENV FLASK_WEBHOOK_URL=http://127.0.0.1:8080/webhook
ENV WA_BRIDGE_URL=http://127.0.0.1:3000

WORKDIR /app

# ── Dependencias Node ─────────────────────────────────────
COPY whatsapp-bridge/package.json whatsapp-bridge/package-lock.json ./whatsapp-bridge/
RUN cd whatsapp-bridge && npm install --omit=dev

# ── Dependencias Python ───────────────────────────────────
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# ── Código fuente ─────────────────────────────────────────
COPY . .

# ── Configuración de Supervisor ───────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/app.conf

# Railway usa la variable PORT; nosotros la pasamos a Supervisor.
EXPOSE 8080

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/app.conf"]
