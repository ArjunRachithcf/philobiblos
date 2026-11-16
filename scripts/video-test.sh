#!/usr/bin/env bash
# The media worker's video tests against its real ffmpeg: builds the Dockerfile's `ffmpeg` stage (FFmpeg's release,
# pinned, apps/worker/ffmpeg/build.sh), then runs apps/worker/test/video.test.ts in the Node image CI uses, with
# Debian's full ffmpeg there only to make the test videos from its test sources. A throwaway `docker run --rm`: no
# compose project, nothing of the household's. With --keep, the build is also left in apps/worker/bin for local runs.
set -euo pipefail
cd "$(dirname "$0")/.."
tag="shelf-test-ffmpeg:$$"
out="$(mktemp -d)"
cleanup() { docker image rm "$tag" >/dev/null 2>&1 || true; rm -rf "$out"; }
trap cleanup EXIT

docker build -q --target ffmpeg -t "$tag" . >/dev/null
cid="$(docker create "$tag")"
docker cp -q "$cid:/opt/ffmpeg/bin/." "$out/"
docker rm "$cid" >/dev/null
if [ "${1:-}" = --keep ]; then mkdir -p apps/worker/bin && cp "$out/ffmpeg" "$out/ffprobe" apps/worker/bin/; fi

node_image="$(sed -n 's/^ARG NODE_IMAGE=//p' Dockerfile)"
# The checkout as git sees it (tracked and new files, never what .gitignore keeps out: seed/, private/, node_modules).
git ls-files -co --exclude-standard -z | tar --null -T - -cf - | docker run --rm -i -v "$out:/ffmpeg:ro,z" \
  -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e DOCKER_HOST=unix:///nonexistent "$node_image" sh -euc '
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
    mkdir /work && tar -xf - -C /work && cd /work
    mkdir -p apps/worker/bin && cp /ffmpeg/ffmpeg /ffmpeg/ffprobe apps/worker/bin/
    corepack enable && pnpm install --frozen-lockfile >/dev/null
    SHELF_VIDEO_TESTS=required pnpm exec vitest run --project unit apps/worker/test/video.test.ts'
