#!/bin/sh
# The media worker's ffmpeg and ffprobe (ADR 0009), built from FFmpeg's release tarball (pinned in the Dockerfile by its
# SHA-256; its signature was checked against FFmpeg's release key FCF986EA15E6E293A5644F10B4322F04D67658D8 when it was
# pinned). Everything is off but what reading a phone's video needs, so the rest cannot be reached by any input:
#
# - containers: MP4/MOV (mov) and WebM/Matroska (matroska); no HLS, DASH, concat, image2 or anything with a playlist;
# - video: H.264, HEVC, VP8, VP9 (all of FFmpeg's own decoders; no external library at all); no audio decoder;
# - out: frames as PPM through a pipe (the worker re-encodes each to a JPEG with sharp);
# - I/O: only the `fd` protocol: ffmpeg reads the one file descriptor the worker opened for it and cannot open a path
#   (no `file`, no network: an external reference in a file, a dref, a playlist, has nothing to open it with);
# - no autodetected libraries (zlib, iconv, X11, VA-API, ...), no devices, no hardware acceleration, no network;
# - hardened toolchain flags (stack protector, FORTIFY_SOURCE, PIE, full RELRO).
# The list is checked by apps/worker/test/video.test.ts ("the build"). Usage: build.sh SRC_DIR PREFIX
set -eu
src=$1 prefix=$2
cd "$src"
./configure --prefix="$prefix" --toolchain=hardened \
  --disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug --disable-ffplay \
  --disable-avdevice --disable-swresample --disable-shared --enable-static \
  --enable-ffmpeg --enable-ffprobe \
  --enable-protocol=fd \
  --enable-demuxer=mov,matroska \
  --enable-decoder=h264,hevc,vp8,vp9 \
  --enable-parser=h264,hevc,vp8,vp9 \
  --enable-filter=fps,scale,format,null \
  --enable-encoder=ppm --enable-muxer=image2pipe
make -j"$(nproc)"
make install
