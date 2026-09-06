#!/usr/bin/env bash
# Serves the merged Ornith-1.5-9B LoRA fine-tune (issue #16 phase 2) as an
# OpenAI-compatible vLLM endpoint on the Runcrate box that trained it.
#
# Run this directly on the box (via `rc ssh <name> -- 'bash -s' < serve_ft9b.sh`
# or after `rc cp`-ing it over), after train_lora.py has written
# /root/ft9b/merged. Mirrors the reasoning/tool parser flags
# scripts/runcrate/serve_ornith.sh uses for the 35B, since both are Qwen3.5-
# family models sharing the qwen3_xml/qwen3 parsers.
#
# The API key is read from a file, never a CLI arg or env var dump: generate
# one with `openssl rand -hex 24 > /root/.ft9b_key && chmod 600 /root/.ft9b_key`
# before running this, or pass KEY_FILE pointing at one you already made.

set -euo pipefail

MODEL_DIR="${MODEL_DIR:-/root/ft9b/merged}"
SERVED_NAME="${SERVED_NAME:-Ornith-9B-ft}"
PORT="${PORT:-8001}"
KEY_FILE="${KEY_FILE:-/root/.ft9b_key}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-32768}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.9}"
# At GPU_MEM_UTIL 0.42 (splitting the H100 for two served models) the
# default max_num_seqs of 1024 exceeds the Mamba cache blocks this
# hybrid-attention model can fit; the eval only ever runs at concurrency 16,
# so cap it well below that ceiling instead of raising memory further.
MAX_NUM_SEQS="${MAX_NUM_SEQS:-128}"
VENV="${VENV:-/root/venv}"
LOG_FILE="${LOG_FILE:-/root/vllm-ft9b.log}"

log() { printf '%s [serve_ft9b] %s\n' "$(date +%T)" "$*" >&2; }

[ -d "$MODEL_DIR" ] || { log "FATAL: $MODEL_DIR not found — run train_lora.py first"; exit 1; }
if [ ! -f "$KEY_FILE" ]; then
  log "no key file at $KEY_FILE, generating one"
  openssl rand -hex 24 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi

log "starting: model=$MODEL_DIR served-as=$SERVED_NAME port=$PORT max-model-len=$MAX_MODEL_LEN gpu-mem-util=$GPU_MEM_UTIL"

pkill -f '[v]llm serve.*'"$SERVED_NAME" 2>/dev/null && sleep 3 || true

# Same CUDA-13-forward-compat workaround as scripts/runcrate/serve_ornith.sh,
# for boxes whose driver only speaks CUDA 12.8.
if [ -e /usr/local/cuda-13.0/compat/libcuda.so.1 ]; then
  export LD_LIBRARY_PATH="/usr/local/cuda-13.0/compat:${LD_LIBRARY_PATH:-}"
fi
export PATH="$VENV/bin:$PATH"

VLLM_API_KEY="$(cat "$KEY_FILE")" nohup "$VENV/bin/vllm" serve "$MODEL_DIR" \
  --host 0.0.0.0 --port "$PORT" \
  --served-model-name "$SERVED_NAME" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEM_UTIL" \
  --max-num-seqs "$MAX_NUM_SEQS" \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --reasoning-parser qwen3 --trust-remote-code --enable-prefix-caching \
  > "$LOG_FILE" 2>&1 &
disown
log "vllm launched, pid $!, log at $LOG_FILE"

log "waiting for /v1/models"
for i in $(seq 1 90); do
  sleep 10
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$KEY_FILE")" \
    "http://127.0.0.1:$PORT/v1/models" || true)
  [ "$code" = "200" ] && { log "READY: http://0.0.0.0:$PORT/v1 (served-model-name=$SERVED_NAME)"; exit 0; }
  pgrep -f "[v]llm serve $MODEL_DIR" > /dev/null || {
    log "FATAL: vllm process died; tail $LOG_FILE:"
    tail -40 "$LOG_FILE"
    exit 1
  }
  log "poll $i: http=$code, still waiting"
done

log "FATAL: not ready in time; tail $LOG_FILE:"
tail -40 "$LOG_FILE"
exit 1
