# [B01] e-Service กลาง · Node 22 (node:sqlite ในตัว) · ฟอนต์ไทยสำหรับ PDF
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-tlwg-garuda-ttf fonts-tlwg-loma-ttf \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/egov.db
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
