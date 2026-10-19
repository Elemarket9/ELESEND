FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node services/maps services/maps
USER node
ENV MAP_HOST=0.0.0.0 MAP_PORT=3145 GHANA_MBTILES=/data/ghana.mbtiles
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3145/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","services/maps/tile-server.mjs"]
