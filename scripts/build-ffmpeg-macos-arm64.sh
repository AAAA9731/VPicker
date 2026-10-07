#!/usr/bin/env bash
# ffmpeg-static's Darwin ARM64 binary enables nonfree. Build our own portable
# GPL binary instead; only macOS system libraries may remain dynamically linked.
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This script requires an Apple Silicon Mac.' >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/build/ffmpeg-macos-arm64"
PREFIX="$WORK/install"
SOURCES="$WORK/sources"
JOBS="$(sysctl -n hw.ncpu)"
export MACOSX_DEPLOYMENT_TARGET=11.0
# Do not accidentally link codecs installed by Homebrew.
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
mkdir -p "$SOURCES" "$PREFIX" "$ROOT/release"

checkout() {
  local name="$1" url="$2" ref="$3"
  if [[ ! -d "$SOURCES/$name/.git" ]]; then
    git init "$SOURCES/$name"
    git -C "$SOURCES/$name" fetch --depth 1 "$url" "$ref"
    git -C "$SOURCES/$name" checkout --detach FETCH_HEAD
  fi
}
checkout ffmpeg https://github.com/FFmpeg/FFmpeg.git n8.0.1
checkout x264 https://code.videolan.org/videolan/x264.git b35605ace3ddf7c1a5d67a2eb553f034aef41d55
checkout libvpx https://github.com/webmproject/libvpx.git v1.15.2

# Keep the exact sources and build recipe available alongside the release.
cp "$0" "$SOURCES/build-ffmpeg-macos-arm64.sh"
tar --exclude=.git -czf "$ROOT/release/FFmpeg-macos-arm64-sources.tar.gz" -C "$SOURCES" .

(
  cd "$SOURCES/x264"
  ./configure --prefix="$PREFIX" --enable-static --enable-pic --disable-cli \
    --disable-opencl --disable-swscale --disable-lavf --disable-ffms
  make -j"$JOBS"
  make install
)
(
  cd "$SOURCES/libvpx"
  # Explicit target avoids detection failures when macos-latest changes version.
  ./configure --prefix="$PREFIX" --target=arm64-darwin24-gcc \
    --enable-static --disable-shared --enable-pic --disable-examples \
    --disable-tools --disable-unit-tests --disable-docs
  make -j"$JOBS"
  make install
)
(
  cd "$SOURCES/ffmpeg"
  ./configure --prefix="$PREFIX" --cc=clang --enable-gpl --enable-version3 \
    --disable-autodetect --disable-shared --enable-static --disable-doc \
    --disable-debug --disable-ffplay --disable-ffprobe --disable-everything \
    --enable-ffmpeg --enable-libx264 --enable-libvpx \
    --enable-encoder=libx264,libvpx_vp9,rawvideo \
    --enable-decoder=rawvideo,h264,vp9 --enable-parser=h264,vp9 \
    --enable-demuxer=rawvideo,mov,matroska --enable-muxer=mp4,webm,rawvideo \
    --enable-protocol=file,pipe --enable-filter=vflip,scale,format,null \
    --pkg-config-flags=--static --extra-cflags="-I$PREFIX/include" \
    --extra-ldflags="-L$PREFIX/lib"
  make -j"$JOBS"
  make install
)

BIN="$PREFIX/bin/ffmpeg"
BAD_LINKS="$(otool -L "$BIN" | awk '/^\t/ && $1 !~ /^\/usr\/lib\// && $1 !~ /^\/System\/Library\// { print }')"
if [[ -n "$BAD_LINKS" ]]; then
  echo "FFmpeg has non-system dynamic dependencies: $BAD_LINKS" >&2
  exit 1
fi
codesign --force --sign - "$BIN"

{
  echo 'VPicker macOS ARM64 FFmpeg: GPL-3.0-or-later, invoked as a subprocess.'
  echo 'Exact sources and build recipe: FFmpeg-macos-arm64-sources.tar.gz in the same release.'
  echo 'Recipe: scripts/build-ffmpeg-macos-arm64.sh in the VPicker repository.'
  for name in ffmpeg x264 libvpx; do
    echo "$name: $(git -C "$SOURCES/$name" rev-parse HEAD)"
  done
  cat "$SOURCES/ffmpeg/COPYING.GPLv3" "$SOURCES/x264/COPYING" "$SOURCES/libvpx/LICENSE"
  "$BIN" -version
} > "$PREFIX/NOTICE.txt"

# Both integration tests and SEA packaging use this exact binary.
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "FFMPEG_PATH=$BIN" >> "$GITHUB_ENV"
  echo "FFMPEG_NOTICE_PATH=$PREFIX/NOTICE.txt" >> "$GITHUB_ENV"
fi
echo "Built $BIN"
