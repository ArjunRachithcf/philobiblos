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
mkdir -p "$work/data"
port=$((20000 + $$ % 20000))
SHELF_IMAGE="$tag" SHELF_PORT="$port" SHELF_UID="$(id -u)" SHELF_GID="$(id -g)" \
  docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" up -d --no-build
wait_health "http://127.0.0.1:$port/api/health" standalone
test -s "$work/data/shelf.sqlite"
grep -q "^http://localhost:$port/setup#" "$work/data/setup-link.txt"
# the recovery CLI is in the image (ADR 0010); with no admin yet it refuses, and prints no link
out="$(SHELF_IMAGE="$tag" docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" exec -T shelf shelf recover alex 2>&1 || true)"
grep -q "no admin with the handle alex" <<<"$out" || { echo "shelf recover: $out" >&2; exit 1; }

# 2. HomersLab: the manifest's image settings (port, volume, env).
env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done < <(
  awk '/^env:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  [A-Z_]+:/{sub(/^  /,""); sub(/ *#.*/,""); sub(/: */,"="); print}' contracts/homerslab-app.yaml)
[ "${#env_args[@]}" -gt 0 ] || { echo "no env in the manifest" >&2; exit 1; }
port2=$((port + 1))
# SHELF_TRUSTED_PROXY and SHELF_ORIGIN are HomersLab's to give; stand-ins here.
docker run -d --name "$hl" "${env_args[@]}" -e SHELF_TRUSTED_PROXY=127.0.0.1 -e SHELF_ORIGIN=https://shelf.example.org \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$hl-data:/data" -p "127.0.0.1:$port2:8080" "$tag" >/dev/null
wait_health "http://127.0.0.1:$port2/api/health" homerslab
echo "smoke: both modes healthy"
