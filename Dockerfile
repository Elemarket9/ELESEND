FROM node:26.12.1-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node services services
COPY --chown=node:node scripts scripts
COPY --chown=node:node database database
COPY --chown=node:node apps/restaurant-web apps/restaurant-web
COPY --chown=node:node apps/company-web apps/company-web
COPY --chown=node:node apps/mobile/src/maps/private-map-style.mjs apps/mobile/src/maps/ghana-sea.mjs apps/mobile/src/maps/
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
USER node
ENV HOST=0.0.0.0 PORT=3090 NODE_ENV=production
EXPOSE 3090
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3090') + '/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "services/api/server.mjs"]
