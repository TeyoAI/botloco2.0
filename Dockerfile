# ============================================================
# Contenedor unificado: Flask bot + WhatsApp bridge Node.js
# ============================================================
FROM node:18-slim

# ── Dependencias del sistema en una sola capa ─────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    chromium \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
    libnss3 libxcomposite1 libxdamage1 libxrandr2 libxss1 libxtst6 \
    supervisor \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ── Puppeteer: usa Chromium del sistema ───────────────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── URLs internas ─────────────────────────────────────────
ENV WA_BRIDGE_URL=http://127.0.0.1:3000

WORKDIR /app

# ── Dependencias Node (cacheadas si package.json no cambia)
COPY whatsapp-bridge/package.json whatsapp-bridge/package-lock.json ./whatsapp-bridge/
RUN cd whatsapp-bridge && npm ci --omit=dev --prefer-offline

# ── Dependencias Python (cacheadas si requirements.txt no cambia)
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# ── Código fuente ─────────────────────────────────────────
COPY . .

# ── Supervisor ────────────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/app.conf

EXPOSE 8080

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/app.conf"]
