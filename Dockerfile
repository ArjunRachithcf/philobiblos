# Philobiblos: one image for HomersLab and standalone (ADR 0001).
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# The media worker's ffmpeg (apps/worker/ffmpeg/build.sh): FFmpeg's own release, pinned by its SHA-256, built with only
# the containers, decoders and the one protocol a phone's video needs. Bumping it: apps/worker/ffmpeg/verify.sh (the
# release's signature, then the SHA-256 to pin). The compilers stay in this stage.
FROM ${NODE_IMAGE} AS ffmpeg
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends gcc libc6-dev make nasm xz-utils >/dev/null && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz /tmp/ffmpeg.tar.xz
COPY apps/worker/ffmpeg/build.sh /tmp/build.sh
RUN mkdir /tmp/src && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/src --strip-components=1 \
 && sh /tmp/build.sh /tmp/src /opt/ffmpeg && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @philobiblos/web build \
 && pnpm --filter @philobiblos/server build \
 && pnpm --filter @philobiblos/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/ \
 && cp -r apps/web/dist /out/web \
 && pnpm --filter @philobiblos/worker build \
 && pnpm --filter @philobiblos/worker deploy --prod --legacy /out-worker \
 && cp -r apps/worker/dist /out-worker/

FROM ${NODE_IMAGE}
# The image's defaults (0.0.0.0:8080, /data, /keys, /work, /app/web, /app/drizzle) are in packages/contracts/src/env.ts,
# applied after the old SHELF_* names: an ENV PHILOBIBLOS_DATA_DIR here would win over a household's SHELF_DATA_DIR.
ENV NODE_ENV=production PHILOBIBLOS_IN_IMAGE=1
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
# The bookshop connectors that ship (data only, docs/connectors.md); a household adds its own with PHILOBIBLOS_CONNECTORS_DIR.
COPY --from=build /src/connectors ./connectors
# The public mail providers a join link's mail-domain rule cannot accept (data only, philobiblos#34 slice 4a).
COPY --from=build /src/mail-providers ./mail-providers
COPY --from=build /out/web ./web
# The media worker (ADR 0009) has its own tree: sharp and pdfjs-dist live only there, run as `node /app/worker/dist/main.js`
# in its own container without a network (docker-compose.yml).
COPY --from=build /out-worker ./worker
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /app/worker/bin/
COPY LICENSE NOTICE ./
# `docker exec <container> philobiblos recover <admin handle>` (ADR 0010). `shelf` still works until 0.2.0, with a warning.
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/philobiblos && chmod 755 /usr/local/bin/philobiblos \
 && printf '#!/bin/sh\necho "shelf is now philobiblos: run philobiblos $*" >&2\nexec /usr/local/bin/philobiblos "$@"\n' > /usr/local/bin/shelf && chmod 755 /usr/local/bin/shelf
RUN mkdir -p /data /keys /work && chown node:node /data /keys /work && chmod 700 /keys && chmod 755 /work
USER node
VOLUME /data /keys /work
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
