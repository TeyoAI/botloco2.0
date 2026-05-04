# ============================================================
# Contenedor unificado: Flask bot + WhatsApp bridge (Baileys)
# ============================================================
FROM node:18-slim

# ── Dependencias del sistema ──────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    ca-certificates \
    supervisor \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ── URLs internas ─────────────────────────────────────────
ENV WA_BRIDGE_URL=http://127.0.0.1:3000

WORKDIR /app

# ── Dependencias Node (cacheadas si package.json no cambia)
COPY whatsapp-bridge/package.json whatsapp-bridge/package-lock.json* ./whatsapp-bridge/
RUN cd whatsapp-bridge && npm install --omit=dev

# ── Dependencias Python (cacheadas si requirements.txt no cambia)
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# ── Código fuente ─────────────────────────────────────────
COPY . .

# ── Supervisor ────────────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/app.conf

EXPOSE 8080

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/app.conf"]
