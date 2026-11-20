#!/usr/bin/env bash
# Fetch and build the local (LAN-only, no cloud) tools Synth's studio tools run on this machine.
# Nothing here is committed: everything lands in vendor/ (git-ignored) or the local docker image store.
#   make_captions  whisper.cpp (MIT) + ggml small q5_1 + Silero VAD v6.2.0 (MIT)
#   compose        editly (mifi/editly, MIT) as the docker image synth-editly:0.15.0-rc.1 (run with --network none)
#   make_deck      power-pptx in .venv (requirements.txt)
# Needs: git, cmake, a C/C++ toolchain, curl, docker, python3-venv, ffmpeg.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; V="$HERE/vendor"; mkdir -p "$V/whisper-models"
WHISPER_COMMIT=95b3b2f855e09404499529228de15734cdeeb6a1
EDITLY_COMMIT=dc46674052eacd15ef6e0f563a58eb378b3804ad

if [ ! -d "$V/whisper.cpp" ]; then git clone https://github.com/ggml-org/whisper.cpp "$V/whisper.cpp"; fi
git -C "$V/whisper.cpp" checkout --quiet "$WHISPER_COMMIT"
cmake -S "$V/whisper.cpp" -B "$V/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$V/whisper.cpp/build" -j"$(nproc)" --config Release --target whisper-cli
curl -fL -o "$V/whisper-models/ggml-small-q5_1.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin
curl -fL -o "$V/whisper-models/ggml-silero-v6.2.0.bin" https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin

if [ ! -d "$V/editly-src" ]; then git clone https://github.com/mifi/editly "$V/editly-src"; fi
git -C "$V/editly-src" checkout --quiet "$EDITLY_COMMIT"
git -C "$V/editly-src" apply --check "$HERE/scripts/editly-node22.patch" 2>/dev/null && git -C "$V/editly-src" apply "$HERE/scripts/editly-node22.patch"
docker build -t synth-editly:0.15.0-rc.1 "$V/editly-src"

python3 -m venv "$HERE/.venv"
"$HERE/.venv/bin/pip" install -r "$HERE/requirements.txt"
echo "vendor ready: $V"
