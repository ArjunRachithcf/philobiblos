#!/usr/bin/env bash
# Runs apps/server/test/imap.test.ts against a real IMAP server: GreenMail in its own container (shelf-test-imap-*),
# with the test-only certificate in apps/server/test/fixtures/tls (for the name imap.test). The tests run in the pinned
# Node image. Removes everything it started.
set -euo pipefail
cd "$(dirname "$0")/.."
name="shelf-test-imap-$$"
image="greenmail/standalone:2.1.5@sha256:8a2024725c7b1ce8f720644bccb6f237781992a8cbf283023446eb7d29326ad0"
node="node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
imaps=$((30000 + $$ % 10000)); smtp=$((imaps + 10000))
docker run -d --name "$name" -p "127.0.0.1:$imaps:3993" -p "127.0.0.1:$smtp:3025" \
  -v "$PWD/apps/server/test/fixtures/tls:/certs:ro,z" \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imaps -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=shelf:test-password@shelf.test -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/certs/greenmail.p12 -Dgreenmail.tls.keystore.password=shelf-test" \
  "$image" >/dev/null
up() { (exec 3<>"/dev/tcp/127.0.0.1/$imaps") 2>/dev/null && (exec 3<>"/dev/tcp/127.0.0.1/$smtp") 2>/dev/null; }
for _ in $(seq 1 60); do up && break; sleep 1; done
up || { docker logs "$name" | tail -20 >&2; exit 1; }
docker run --rm -i --network host -u "$(id -u):$(id -g)" -v "$PWD:/w:z" -w /w \
  -e HOME=/tmp -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e DOCKER_HOST=unix:///nonexistent \
  -e PHILOBIBLOS_IMAP_TEST_PORT="$imaps" -e PHILOBIBLOS_SMTP_TEST_PORT="$smtp" "$node" \
  bash -c 'mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:$PATH && { [ -d node_modules ] || pnpm install --frozen-lockfile >/dev/null; } && pnpm exec vitest run --project unit apps/server/test/imap.test.ts'
