#!/usr/bin/env bash
# Builds the image and starts it both ways: standalone with docker-compose.yml, and with the environment of the
# HomersLab manifest (contracts/homerslab-app.yaml). Each must answer /api/health in its mode. Uses its own compose
# projects (shelf-test-*) and removes everything it started.
set -euo pipefail
cd "$(dirname "$0")/.."
tag="shelf:smoke-$$"
work="$(mktemp -d)"
project="shelf-test-$$"
hl="shelf-test-hl-$$"
cleanup() {
  SHELF_IMAGE="$tag" docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$hl" >/dev/null 2>&1 || true
  docker volume rm "$hl-data" >/dev/null 2>&1 || true
  docker image rm "$tag" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker build -q -t "$tag" . >/dev/null

wait_health() { # url mode
  for _ in $(seq 1 30); do
    if out="$(docker run --rm --network host "$tag" node -e "fetch('$1').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))" 2>/dev/null)"; then
      echo "$out"
      grep -q "\"mode\":\"$2\"" <<<"$out" && grep -q '"ok":true' <<<"$out" && return 0
    fi
    sleep 1
  done
  echo "no healthy answer from $1 in $2 mode" >&2
  return 1
}

# 1. Standalone, as a household would run it.
mkdir -p "$work/data" "$work/keys" "$work/work"
port=$((20000 + $$ % 20000))
SHELF_IMAGE="$tag" SHELF_PORT="$port" SHELF_UID="$(id -u)" SHELF_WORKER_UID="$(( $(id -u) + 1 ))" SHELF_GID="$(id -g)" \
  docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" up -d --no-build
wait_health "http://127.0.0.1:$port/api/health" standalone
test -s "$work/data/shelf.sqlite"
grep -q "^http://localhost:$port/setup#" "$work/data/setup-link.txt"
# the recovery CLI is in the image (ADR 0010); with no admin yet it refuses, and prints no link
out="$(SHELF_IMAGE="$tag" docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" exec -T shelf shelf recover alex 2>&1 || true)"
grep -q "no admin with the handle alex" <<<"$out" || { echo "shelf recover: $out" >&2; exit 1; }
# the media worker (ADR 0009): no network at all, nothing reachable from it, and it re-encodes a job the server hands it
dc() { SHELF_IMAGE="$tag" docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" "$@"; }
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$(dc ps -q shelf-worker)")" = none ] || { echo "the worker has a network" >&2; exit 1; }
dc exec -T shelf-worker node -e "fetch('http://1.1.1.1/',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1),()=>process.exit(0))" \
  || { echo "the worker reached the network" >&2; exit 1; }
# its own user; in/ is read-only to it, and out/ cannot be swapped for a link (its parent is the image's read-only /work)
[ "$(dc exec -T shelf-worker id -u)" != "$(dc exec -T shelf id -u)" ] || { echo "the worker runs as the server's user" >&2; exit 1; }
dc exec -T shelf-worker sh -c 'touch /work/in/x' 2>/dev/null && { echo "the worker can write in/" >&2; exit 1; }
dc exec -T shelf-worker sh -c 'mv /work/out /work/out2 || ln -s /tmp /work/x' 2>/dev/null && { echo "the worker can replace out/" >&2; exit 1; }
ok=""
for _ in $(seq 1 20); do if out="$(dc exec -T shelf shelf media-check 2>&1)"; then ok=1; break; fi; sleep 1; done
[ -n "$ok" ] || { echo "media-check: $out" >&2; dc logs --tail 20 shelf-worker >&2; ls -laR "$work/work" >&2; exit 1; }
echo "$out"

# 2. HomersLab: the manifest's image settings (port, volume, env).
env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done < <(
  awk '/^env:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  [A-Z_]+:/{sub(/^  /,""); sub(/ *#.*/,""); sub(/: */,"="); print}' contracts/homerslab-app.yaml)
[ "${#env_args[@]}" -gt 0 ] || { echo "no env in the manifest" >&2; exit 1; }
port2=$((port + 1))
# SHELF_EDGE_IDENTITY, SHELF_TRUSTED_PROXY and SHELF_ORIGIN are HomersLab's to give; stand-ins here.
docker run -d --name "$hl" "${env_args[@]}" -e SHELF_EDGE_IDENTITY=homerslab-v1 -e SHELF_TRUSTED_PROXY=127.0.0.1 -e SHELF_ORIGIN=https://shelf.example.org \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$hl-data:/data" -p "127.0.0.1:$port2:8080" "$tag" >/dev/null
wait_health "http://127.0.0.1:$port2/api/health" homerslab
echo "smoke: both modes healthy"
