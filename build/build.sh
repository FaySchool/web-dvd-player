#!/usr/bin/env bash
#
# Build VLC (libVLC + libdvdnav/libdvdread/libdvdcss + FFmpeg) to WebAssembly
# and link it with build/src/dvdplayer.c into vlc/ (at the repository root).
#
# Usage:
#   build/build.sh            full build (fetch, patch, contribs, VLC, link)
#   build/build.sh link       only re-link (after editing build/src/*)
#
# Environment:
#   WORK_DIR   where sources and toolchains are fetched (default: build/work)
#   JOBS       parallel make jobs (default: nproc)
#   DEBUG=1    keep function names in the wasm (readable stack traces)
#
# Host requirements (Debian/Ubuntu package names):
#   git curl python3 build-essential autoconf automake libtool libtool-bin
#   pkg-config gettext autopoint ragel flex bison help2man meson ninja-build
#   nasm gperf ant cmake
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
WORK_DIR="${WORK_DIR:-$BUILD_DIR/work}"
OUT_DIR="$ROOT_DIR/vlc"
JOBS="${JOBS:-$(nproc)}"

# Pinned versions. VLC_HASH / VLCJS_HASH are the combination validated by the
# vlc.js project (https://code.videolan.org/jbk/vlc.js, branch "incoming").
EMSDK_VERSION="3.1.18"
VLC_REPO="https://code.videolan.org/videolan/vlc.git"
VLC_HASH="06e361b127e4609e429909756212ed5e30e7d032"
VLCJS_REPO="https://code.videolan.org/jbk/vlc.js.git"
VLCJS_HASH="af59a33e41e8e518f53d62dd82732b8c541f8abf" # branch "incoming"

log() { printf '\n\033[1;33m### %s\033[0m\n' "$*" >&2; }

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# --------------------------------------------------------------------------
# Toolchain
# --------------------------------------------------------------------------
if [ ! -d emsdk ]; then
    log "Fetching emsdk $EMSDK_VERSION"
    git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
fi
if [ ! -f "emsdk/.installed-$EMSDK_VERSION" ]; then
    (cd emsdk && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION")
    touch "emsdk/.installed-$EMSDK_VERSION"
fi
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null

VLC_DIR="$WORK_DIR/vlc"

if [ "${1:-}" != "link" ]; then
    # ----------------------------------------------------------------------
    # Sources
    # ----------------------------------------------------------------------
    if [ ! -d vlc.js ]; then
        log "Fetching vlc.js patches"
        git clone "$VLCJS_REPO" vlc.js
        git -C vlc.js checkout -q "$VLCJS_HASH"
    fi

    if [ ! -d "$VLC_DIR" ]; then
        log "Fetching VLC $VLC_HASH"
        git init -q "$VLC_DIR"
        git -C "$VLC_DIR" fetch --depth 1 "$VLC_REPO" "$VLC_HASH"
        git -C "$VLC_DIR" checkout -q FETCH_HEAD
        git -C "$VLC_DIR" -c user.name=build -c user.email=build@localhost \
            am -3 -q "$WORK_DIR"/vlc.js/vlc_patches/aug/*.patch
        log "Applying web-dvd-player patches"
        git -C "$VLC_DIR" -c user.name=build -c user.email=build@localhost \
            am -3 -q "$BUILD_DIR"/patches/*.patch
    fi

    # ----------------------------------------------------------------------
    # Contribs + libVLC (uses VLC's own emscripten build script, patched to
    # include the DVD libraries)
    # ----------------------------------------------------------------------
    log "Building contribs and libVLC"
    export MAKEFLAGS="-j$JOBS"
    MODE=1
    [ -f "$VLC_DIR/build-emscripten/config.status" ] && MODE=0
    (cd "$VLC_DIR/extras/package/wasm-emscripten" && ./build.sh --mode=$MODE)
fi

# --------------------------------------------------------------------------
# Link
# --------------------------------------------------------------------------
log "Linking dvdplayer.js / dvdplayer.wasm"
mkdir -p "$OUT_DIR/modules/audio_output/webaudio"
B="$VLC_DIR/build-emscripten"

EXPORTS='["_main","_malloc","_free"]'
RUNTIME='["ccall","cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8"]'

DEBUG_FLAGS=()
if [ -n "${DEBUG:-}" ]; then
    # Keep function names in stack traces
    DEBUG_FLAGS=(--profiling-funcs)
fi

# EXIT_RUNTIME=1 is required: without it emscripten compiles out the runtime
# keepalive counter, and a pthread suspended by ASYNCIFY would be reported as
# exited (and its worker recycled) at its first suspension.
emcc -pthread \
    -O3 "${DEBUG_FLAGS[@]}" \
    -s INITIAL_MEMORY=1GB \
    -s PTHREAD_POOL_SIZE=40 \
    -s OFFSCREEN_FRAMEBUFFER=1 \
    -s OFFSCREENCANVAS_SUPPORT=1 \
    -s USE_WEBGL2=1 \
    -s MODULARIZE=1 -s EXPORT_NAME=createVlcModule \
    -s ASYNCIFY=1 \
    -s EXIT_RUNTIME=1 \
    -s ENVIRONMENT=web,worker \
    -s EXPORTED_FUNCTIONS="$EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS="$RUNTIME" \
    --bind \
    -I "$VLC_DIR/include" \
    "$BUILD_DIR/src/dvdplayer.c" \
    "$B/lib/.libs/libvlc.a" \
    "$B/vlc-modules.bc" \
    "$B"/modules/.libs/*.a \
    "$VLC_DIR"/contrib/wasm32-unknown-emscripten/lib/*.a \
    "$B/src/.libs/libvlccore.a" \
    "$B/compat/.libs/libcompat.a" \
    --js-library "$VLC_DIR/modules/audio_output/webaudio/webaudio.js" \
    -o "$OUT_DIR/dvdplayer.js"

cp "$VLC_DIR/modules/audio_output/webaudio/audio-worklet-processor.js" \
   "$OUT_DIR/modules/audio_output/webaudio/"

# Record what was built (useful in bug reports)
{
    echo "patches_sha256=$(cat "$BUILD_DIR"/patches/*.patch | sha256sum | cut -c1-16)"
    echo "vlc_base=$VLC_HASH"
    echo "emsdk=$EMSDK_VERSION"
    echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT_DIR/BUILD_INFO.txt"

ls -la "$OUT_DIR"
log "Done. Serve the repository root (see README)."
