#!/bin/bash
#
# Rebuild the SLOP WebAssembly engine.
#
# Requires the Emscripten SDK to be installed and activated, e.g.
#   git clone https://github.com/emscripten-core/emsdk.git
#   ./emsdk/emsdk install latest && ./emsdk/emsdk activate latest
#   source ./emsdk/emsdk_env.sh
#
# Produces msa_engine_opt.js and msa_engine_opt.wasm, both of which are
# committed to the repository so the app runs without a build step.
#
# Set EMCC_EXTRA_FLAGS to append compiler flags, e.g. to compile in the
# engine's verbose tracing:
#   EMCC_EXTRA_FLAGS=-DSLOP_DEBUG ./build_wasm.sh

set -euo pipefail

if ! command -v emcc >/dev/null 2>&1; then
    echo "error: emcc not found. Activate the Emscripten SDK first:" >&2
    echo "       source /path/to/emsdk/emsdk_env.sh" >&2
    exit 1
fi

# Word-split intentionally so multiple flags can be passed in one variable.
read -r -a extra_flags <<< "${EMCC_EXTRA_FLAGS:-}"

echo "Building SLOP WebAssembly engine..."

# DEFAULT_TO_CXX is a link-time setting: it pulls in the C++ runtime even though
# emcc (not em++) is the driver, which is required because pdfgen.c is in the
# input list. Compiling stays per-extension, so pdfgen.c is still built as C.
emcc -O3 \
    msa_engine_optimized.cpp alignment_pdf.cpp font_manager.cpp pdfgen.c \
    -o msa_engine_opt.js \
    -s DEFAULT_TO_CXX=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='createMSAEngine' \
    --bind \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MAXIMUM_MEMORY=4GB \
    -s USE_FREETYPE=1 \
    -s FORCE_FILESYSTEM=1 \
    -s EXPORTED_RUNTIME_METHODS='["FS"]' \
    ${extra_flags[@]+"${extra_flags[@]}"}

echo "Build complete:"
echo "  - msa_engine_opt.js"
echo "  - msa_engine_opt.wasm"
echo
echo "Note: index.html loads the engine with a cache-busting query string"
echo "      (msa_engine_opt.js?v=N). Bump it after rebuilding if your browser"
echo "      serves a stale copy."
