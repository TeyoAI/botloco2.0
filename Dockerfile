# ============================================================
# Contenedor unificado: Flask bot + WhatsApp bridge Node.js
# Ambos procesos comparten localhost -> sin config de URLs.
# Railway expone solo el puerto de Flask (PORT).
# ============================================================
FROM node:18-slim

# ── Dependencias del sistema ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python
    python3 python3-pip \
    # Chromium para Puppeteer/whatsapp-web.js
    chromium \
    ca-certificates fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
    libnss3 libxcomposite1 libxdamage1 libxrandr2 libxss1 libxtst6 \
    # Supervisor para correr dos procesos
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# ── Puppeteer: usa Chromium del sistema ───────────────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── URLs internas: Flask <-> Bridge por localhost ─────────
# NO cambiar estas variables en Railway; comunican los dos
# procesos dentro del mismo contenedor.
ENV FLASK_WEBHOOK_URL=http://127.0.0.1:5000/webhook
ENV WA_BRIDGE_URL=http://127.0.0.1:3000
ENV WA_BRIDGE_PORT=3000
ENV WA_BRIDGE_HOST=127.0.0.1
ENV FLASK_HOST=0.0.0.0

WORKDIR /app

# ── Dependencias Node ─────────────────────────────────────
COPY whatsapp-bridge/package.json whatsapp-bridge/package-lock.json ./whatsapp-bridge/
RUN cd whatsapp-bridge && npm install --omit=dev

# ── Dependencias Python ───────────────────────────────────
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# ── Código fuente ─────────────────────────────────────────
COPY . .

# ── Configuración de Supervisor ───────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/app.conf

# Railway asigna PORT dinámicamente; Flask lo escucha.
EXPOSE 5000

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/app.conf"]
