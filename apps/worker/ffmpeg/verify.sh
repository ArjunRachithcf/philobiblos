#!/bin/sh
# Before bumping the worker's FFmpeg (the Dockerfile's ffmpeg stage): downloads a release and its signature, checks
# the signature against FFmpeg's release signing key (its fingerprint pinned here, the key itself fetched from
# ffmpeg.org into a throwaway keyring), and prints the SHA-256 to pin. A pin alone only says the file did not change
# since it was pinned; this says FFmpeg made it. Usage: verify.sh VERSION (e.g. 9.0.2). Needs curl, gpg, sha256sum.
set -eu
version=$1
key=FCF986EA15E6E293A5644F10B4322F04D67658D8 # "FFmpeg release signing key <ffmpeg-devel@ffmpeg.org>"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -m 700 "$tmp/gpg"
cd "$tmp"
curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz"
curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz.asc"
curl -fsSL https://ffmpeg.org/ffmpeg-devel.asc -o key.asc
gpg --homedir gpg --batch --quiet --import key.asc
gpg --homedir gpg --batch --list-keys --with-colons | grep -q "^fpr:::::::::$key:" || { echo "the key fetched is not $key" >&2; exit 1; }
gpg --homedir gpg --batch --status-fd 1 --verify "ffmpeg-$version.tar.xz.asc" "ffmpeg-$version.tar.xz" 2>/dev/null \
  | grep -q "^\[GNUPG:\] VALIDSIG $key " || { echo "the signature is not by $key" >&2; exit 1; }
echo "ffmpeg-$version.tar.xz: signed by $key"
echo "sha256: $(sha256sum "ffmpeg-$version.tar.xz" | cut -d' ' -f1)"
