#!/usr/bin/env bash
# Serve Ornith-1.5-35B-A3B-FP8 on a Runcrate H100 as an OpenAI-compatible
# endpoint the eve agent on this workstation can call. Infra for #12 and #13.
#
# Usage:
#   scripts/runcrate/serve_ornith.sh create   # pick cheapest single H100, launch the box
#   scripts/runcrate/serve_ornith.sh setup    # install uv + a 3.12 venv + vLLM, pull the weights
#   scripts/runcrate/serve_ornith.sh serve    # start vLLM, wait for readiness, write .env.local, smoke test
#   scripts/runcrate/serve_ornith.sh status   # print the public IP and a one-line curl check
#   scripts/runcrate/serve_ornith.sh delete   # terminate the box
#
# Runcrate rules (binding, see AGENTS.md / issue #11): RUNCRATE_PROJECT_ID is
# pinned below on every `rc` call; never `rc workspaces switch`; never
# `rc login` (if `rc ps` fails, stop); `rc config show` is not trusted, `rc ps`
# is the liveness check; keep at least 8s between `rc` calls (RC_SLEEP below).
# The box is billed per minute — run `delete` when nothing needs it.
#
# The API key never touches argv or a repo file other than .env.local: it is
# generated locally with `openssl rand -hex 24`, piped to the box over
# `rc ssh ... -- 'cat > ...'` stdin, and appended to .env.local.

set -euo pipefail

export RUNCRATE_PROJECT_ID="${RUNCRATE_PROJECT_ID:-29550a54-cba3-4938-8b0b-b5e30156abc1}"

NAME="${ORNITH_INSTANCE_NAME:-ornith-serve}"
# GPU type for create (H100, GH200, ...). One box per NAME.
GPU="${ORNITH_GPU:-H100}"
TEMPLATE=ubuntu-inference
MODEL_REPO="ornith-ai/Ornith-1.5-35B-A3B-FP8"
MODEL_DIR="/root/models/ornith-1.5-35b-a3b-fp8"
VENV=/root/venv
PORT=8000
MAX_MODEL_LEN="${ORNITH_MAX_MODEL_LEN:-65536}"
RC_SLEEP="${RC_SLEEP:-8}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Where serve writes ORNITH_API_KEY / ORNITH_BASE_URL. Point a second box at
# its own file (e.g. runs/boxes/<name>.env, gitignored) so it does not
# overwrite the endpoint the agent is using.
ENV_LOCAL="${ORNITH_ENV_FILE:-$ROOT/.env.local}"

log() { printf '%s [%s] %s\n' "$(date +%T)" "$NAME" "$*" >&2; }
rc_sleep() { sleep "$RC_SLEEP"; }

check_liveness() {
  rc ps > /dev/null 2>&1 || {
    log "FATAL: rc ps failed — this needs a browser login, which only the user can complete. Stopping."
    exit 1
  }
}

instance_json() { rc instances info "$NAME" --json 2>/dev/null || true; }

instance_field() {
  # $1: field name, read from the last instance_json output on stdin
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get('$1')
    if v not in (None, ''):
        print(v)
except Exception:
    pass
"
}

cmd_create() {
  check_liveness
  rc_sleep
  local st
  st="$(instance_json | instance_field status)"
  if [ -n "$st" ]; then
    log "instance already exists (status=$st) — not creating another"
    cmd_status || true
    return 0
  fi

  log "listing $GPU types to find the cheapest single-GPU option"
  rc_sleep
  local types_json
  types_json="$(rc instances types --gpu "$GPU" --json 2>/dev/null)"
  local type_id rate region selection
  selection="$(printf '%s' "$types_json" | python3 -c '
import json, sys
types = json.load(sys.stdin)
single = [t for t in types if t.get("gpu_count") == 1]
if not single:
    sys.exit("no single-GPU H100 type on offer")
best = min(single, key=lambda t: t["hourly_rate"])
print("\t".join(str(best[k]) for k in ("id", "hourly_rate", "region")))
')"
  IFS=$'\t' read -r type_id rate region <<<"$selection"

  log "creating instance: type=$type_id region=$region \$$rate/hr template=$TEMPLATE"
  rc_sleep
  rc instances create --name "$NAME" --gpu "$GPU" --type-id "$type_id" --template "$TEMPLATE" --json

  log "waiting for the instance to reach status=running"
  local i status
  for i in $(seq 1 60); do
    rc_sleep
    status="$(instance_json | instance_field status)"
    log "poll $i: status=${status:-unknown}"
    [ "$status" = "running" ] && { log "running — name=$NAME rate=\$$rate/hr region=$region"; return 0; }
  done
  log "FATAL: instance did not reach running after $((60 * RC_SLEEP))s"
  exit 1
}

cmd_setup() {
  check_liveness
  log "starting remote setup (uv, python 3.12 venv, vLLM, weight pull) — this can take a while for a 35B FP8 download"
  rc_sleep
  rc ssh "$NAME" -- 'bash -s' <<REMOTE_EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "\$(date +%T) [remote] checking for a CUDA toolkit"
if [ -x /usr/local/cuda/bin/nvcc ]; then
  echo "\$(date +%T) [remote] using the toolkit already on the box: \$(/usr/local/cuda/bin/nvcc --version | tail -1)"
else
  echo "\$(date +%T) [remote] FATAL: no /usr/local/cuda on this template; ubuntu-inference should ship one"
  exit 1
fi

# pip's default torch build tracks the latest CUDA major (13.x as of this
# writing), which the driver on this template (570.x, CUDA 12.8) is too old
# to run. Rather than pin torch to an older release (which vllm may not
# support), install NVIDIA's CUDA-13.0 forward-compatibility libs so the
# 12.8 driver can still run CUDA-13 binaries; serve exports
# LD_LIBRARY_PATH to put them ahead of the driver's own libcuda.
if [ ! -e /usr/local/cuda-13.0/compat/libcuda.so.1 ]; then
  echo "\$(date +%T) [remote] installing cuda-compat-13-0 (driver forward compatibility)"
  apt-get update -qq
  apt-get install -y -qq cuda-compat-13-0
else
  echo "\$(date +%T) [remote] cuda-compat-13-0 already installed"
fi

command -v uv > /dev/null 2>&1 || { echo "\$(date +%T) [remote] installing uv"; curl -LsSf https://astral.sh/uv/install.sh | sh; }
export PATH="\$HOME/.local/bin:\$PATH"

[ -x "$VENV/bin/python" ] || { echo "\$(date +%T) [remote] creating python 3.12 venv at $VENV"; uv venv --seed --python 3.12 "$VENV"; }

"$VENV/bin/python" -c 'import vllm' 2>/dev/null && echo "\$(date +%T) [remote] vllm already installed: \$($VENV/bin/python -c 'import vllm; print(vllm.__version__)')" || {
  echo "\$(date +%T) [remote] installing vllm>=0.19.1"
  "$VENV/bin/pip" install -U 'vllm>=0.19.1' 'huggingface_hub[hf_transfer]'
}
"$VENV/bin/python" -c 'import vllm; print("vllm", vllm.__version__)'

mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_DIR/.download-complete" ]; then
  echo "\$(date +%T) [remote] pulling $MODEL_REPO to $MODEL_DIR"
  HF_HUB_ENABLE_HF_TRANSFER=1 "$VENV/bin/hf" download "$MODEL_REPO" --local-dir "$MODEL_DIR"
  touch "$MODEL_DIR/.download-complete"
else
  echo "\$(date +%T) [remote] weights already present"
fi
echo "=== SETUP COMPLETE ==="
REMOTE_EOF
}

cmd_serve() {
  check_liveness

  local key
  if [ -f "$ENV_LOCAL" ] && grep -q '^ORNITH_API_KEY=' "$ENV_LOCAL"; then
    key="$(grep '^ORNITH_API_KEY=' "$ENV_LOCAL" | head -1 | cut -d= -f2-)"
    log "reusing existing ORNITH_API_KEY from .env.local"
  else
    key="$(openssl rand -hex 24)"
    log "generated a new API key"
  fi

  log "sending the API key to the box over ssh stdin"
  rc_sleep
  printf '%s' "$key" | rc ssh "$NAME" -- 'cat > /root/.ornith_key && chmod 600 /root/.ornith_key'

  log "starting vllm serve on 0.0.0.0:$PORT and waiting for /v1/models (first boot JIT-compiles kernels, can take 10+ minutes)"
  rc_sleep
  rc ssh "$NAME" -- 'bash -s' <<REMOTE_EOF
set -euo pipefail
pkill -f '[v]llm serve' 2>/dev/null && sleep 3 || true
# The 570.x driver on this template only speaks CUDA 12.8; the CUDA-13
# forward-compat libs installed in setup let it run torch's CUDA-13 build.
export LD_LIBRARY_PATH="/usr/local/cuda-13.0/compat:\${LD_LIBRARY_PATH:-}"
# flashinfer JIT-compiles a sampling kernel on first request and shells out
# to plain "ninja"; put the venv's bin (where pip installed it) on PATH.
export PATH="$VENV/bin:\$PATH"
VLLM_API_KEY="\$(cat /root/.ornith_key)" nohup "$VENV/bin/vllm" serve "$MODEL_DIR" \
  --host 0.0.0.0 --port $PORT \
  --served-model-name Ornith-1.5-35B-A3B \
  --max-model-len $MAX_MODEL_LEN \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --reasoning-parser qwen3 --trust-remote-code --enable-prefix-caching \
  > /root/vllm.log 2>&1 &
disown
echo "\$(date +%T) [remote] vllm launched, pid \$!"
for i in \$(seq 1 90); do
  sleep 20
  code=\$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer \$(cat /root/.ornith_key)" http://127.0.0.1:$PORT/v1/models || true)
  [ "\$code" = 200 ] && { echo "=== SERVER READY ==="; exit 0; }
  pgrep -f '[v]llm serve' > /dev/null || { echo "FATAL: server died; tail /root/vllm.log:"; tail -40 /root/vllm.log; exit 1; }
  echo "\$(date +%T) [remote] poll \$i: http=\$code, still waiting"
done
echo "FATAL: not ready in time; tail /root/vllm.log:"
tail -40 /root/vllm.log
exit 1
REMOTE_EOF

  log "fetching public IP"
  rc_sleep
  local ip
  ip="$(instance_json | instance_field ip)"
  [ -n "$ip" ] || { log "FATAL: no public IP on the instance yet"; exit 1; }

  local base_url="http://$ip:$PORT/v1"
  log "endpoint ready at $base_url"

  # Write/replace ORNITH_API_KEY and ORNITH_BASE_URL in .env.local, preserving
  # everything else in the file.
  touch "$ENV_LOCAL"
  grep -v '^ORNITH_API_KEY=' "$ENV_LOCAL" | grep -v '^ORNITH_BASE_URL=' > "$ENV_LOCAL.tmp" || true
  mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"
  { echo "ORNITH_API_KEY=$key"; echo "ORNITH_BASE_URL=$base_url"; } >> "$ENV_LOCAL"
  log "wrote ORNITH_API_KEY and ORNITH_BASE_URL to .env.local"

  smoke_test "$base_url" "$key"
}

smoke_test() {
  local base_url="$1" key="$2"
  log "running smoke test: one chat completion with a tool definition"
  local resp
  resp="$(curl -s -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
    "$base_url/chat/completions" -d '{
      "model": "Ornith-1.5-35B-A3B",
      "messages": [{"role": "user", "content": "What is the weather in Cluj-Napoca? Use the tool."}],
      "tools": [{
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the current weather for a city",
          "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
          }
        }
      }],
      "tool_choice": "required"
    }')"
  if printf '%s' "$resp" | python3 -c '
import json, sys
d = json.load(sys.stdin)
calls = d["choices"][0]["message"].get("tool_calls")
sys.exit(0 if calls else 1)
' 2>/dev/null; then
    log "smoke test PASSED — tool_calls present"
    printf '%s\n' "$resp" | python3 -m json.tool
  else
    log "smoke test FAILED — no tool_calls in response"
    printf '%s\n' "$resp"
    exit 1
  fi
}

cmd_status() {
  check_liveness
  rc_sleep
  local ip status rate
  local j
  j="$(instance_json)"
  ip="$(printf '%s' "$j" | instance_field ip)"
  status="$(printf '%s' "$j" | instance_field status)"
  rate="$(printf '%s' "$j" | instance_field cost_per_hour)"
  echo "instance=$NAME status=${status:-unknown} rate=\$${rate:-?}/hr ip=${ip:-none}"
  if [ -n "$ip" ]; then
    local key=""
    [ -f "$ENV_LOCAL" ] && key="$(grep '^ORNITH_API_KEY=' "$ENV_LOCAL" 2>/dev/null | head -1 | cut -d= -f2-)"
    if [ -n "$key" ]; then
      echo "curl check:"
      curl -s -H "Authorization: Bearer $key" "http://$ip:$PORT/v1/models"
      echo
    else
      echo "no ORNITH_API_KEY in .env.local yet — run 'serve' first"
    fi
  fi
}

cmd_delete() {
  check_liveness
  log "terminating instance $NAME"
  rc_sleep
  rc instances delete "$NAME"
}

case "${1:-}" in
  create) cmd_create ;;
  setup)  cmd_setup ;;
  serve)  cmd_serve ;;
  status) cmd_status ;;
  delete) cmd_delete ;;
  *)
    echo "usage: $0 {create|setup|serve|status|delete}" >&2
    exit 2
    ;;
esac
