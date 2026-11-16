#!/bin/sh
# Before bumping the worker's FFmpeg (the Dockerfile's ffmpeg stage): downloads a release and its signature, checks
# the signature against FFmpeg's release signing key (its fingerprint pinned here, the key itself fetched from
# ffmpeg.org into a throwaway keyring), and prints the SHA-256 to pin. A pin alone only says the file did not change
# since it was pinned; this says FFmpeg made it. Usage: verify.sh VERSION (e.g. 9.0.2). Needs curl, gpg, sha256sum.
# `verify.sh --judge` reads gpg's status lines on stdin and only judges them (apps/worker/test/verify.test.ts).
set -eu
key=FCF986EA15E6E293A5644F10B4322F04D67658D8 # "FFmpeg release signing key <ffmpeg-devel@ffmpeg.org>"
# A good signature (GOODSIG) by the pinned key (VALIDSIG with its fingerprint, GOODSIG with its long id), and nothing
# that says otherwise: gpg still prints VALIDSIG for a signature by an expired or revoked key (EXPKEYSIG, REVKEYSIG),
# and an expired signature (EXPSIG), a bad one (BADSIG) or one it cannot check (ERRSIG) never counts.
judge() {
  status=$(cat)
  long=$(printf %s "$key" | cut -c25-40)
  printf '%s\n' "$status" | grep -q "^\[GNUPG:\] GOODSIG $long " || return 1
  printf '%s\n' "$status" | grep -q "^\[GNUPG:\] VALIDSIG $key " || return 1
  ! printf '%s\n' "$status" | grep -Eq '^\[GNUPG:\] (EXPKEYSIG|REVKEYSIG|EXPSIG|BADSIG|ERRSIG)( |$)'
}
if [ "${1:-}" = --judge ]; then judge; exit; fi
version=$1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -m 700 "$tmp/gpg"
cd "$tmp"
curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz"
curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz.asc"
curl -fsSL https://ffmpeg.org/ffmpeg-devel.asc -o key.asc
gpg --homedir gpg --batch --quiet --import key.asc
gpg --homedir gpg --batch --list-keys --with-colons | grep -q "^fpr:::::::::$key:" || { echo "the key fetched is not $key" >&2; exit 1; }
{ gpg --homedir gpg --batch --status-fd 1 --verify "ffmpeg-$version.tar.xz.asc" "ffmpeg-$version.tar.xz" 2>/dev/null || true; } \
  | judge || { echo "the signature is not a good one by $key (or the key is expired or revoked)" >&2; exit 1; }
echo "ffmpeg-$version.tar.xz: signed by $key"
echo "sha256: $(sha256sum "ffmpeg-$version.tar.xz" | cut -d' ' -f1)"
