# Shelf: one image for HomersLab and standalone (ADR 0001).
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @shelf/web build \
 && pnpm --filter @shelf/server build \
 && pnpm --filter @shelf/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/ \
 && cp -r apps/web/dist /out/web \
 && pnpm --filter @shelf/worker build \
 && pnpm --filter @shelf/worker deploy --prod --legacy /out-worker \
 && cp -r apps/worker/dist /out-worker/

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    SHELF_HOST=0.0.0.0 SHELF_PORT=8080 \
    SHELF_DATA_DIR=/data SHELF_KEYS_DIR=/keys SHELF_WORK_DIR=/work SHELF_WEB_DIR=/app/web SHELF_MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
COPY --from=build /out/web ./web
# The media worker (ADR 0009) has its own tree: sharp and pdfjs-dist live only there, run as `node /app/worker/dist/main.js`
# in its own container without a network (docker-compose.yml).
COPY --from=build /out-worker ./worker
COPY LICENSE NOTICE ./
# `docker exec <container> shelf recover <admin handle>` (ADR 0010)
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/shelf && chmod 755 /usr/local/bin/shelf
RUN mkdir -p /data /keys /work && chown node:node /data /keys /work && chmod 700 /keys /work
USER node
VOLUME /data /keys /work
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
