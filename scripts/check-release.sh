#!/usr/bin/env bash
# Refuses a release whose manifest still has placeholders or an image not pinned by digest. CI runs it on tags.
set -euo pipefail
cd "$(dirname "$0")/.."
image="$(awk '/^image:/{print $2}' contracts/homerslab-app.yaml)"
fail=0
if grep -q '<[a-z]*>' <<<"$image"; then echo "contracts/homerslab-app.yaml: image has placeholders: $image" >&2; fail=1; fi
if ! grep -Eq '@sha256:[0-9a-f]{64}$' <<<"$image"; then echo "contracts/homerslab-app.yaml: image is not pinned by digest: $image" >&2; fail=1; fi
version="$(awk '/^version:/{print $2}' contracts/homerslab-app.yaml)"
if [ -n "${GITHUB_REF_NAME:-}" ] && [ "${GITHUB_REF_NAME#v}" != "$version" ]; then echo "tag $GITHUB_REF_NAME does not match manifest version $version" >&2; fail=1; fi
exit "$fail"
