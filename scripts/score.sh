#!/usr/bin/env bash
# Scores a prediction run against the SpreadsheetBench evaluator and writes
# <run-dir>/results.json.
#
# Usage:
#   scripts/score.sh <run-dir>
#
# Reads SB_DATASET_DIR from the environment, falling back to .env.local at
# the repo root if it isn't already set. Runs the vendored evaluator with
# `uv run --project eval` so it works from the repo root (the root is a Node
# project, so a plain `uv run` there fails).
set -euo pipefail

usage() {
  echo "usage: scripts/score.sh <run-dir>" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

run_dir="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

if [ -z "${SB_DATASET_DIR:-}" ] && [ -f "$repo_root/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo_root/.env.local"
  set +a
fi

if [ -z "${SB_DATASET_DIR:-}" ]; then
  echo "score.sh: SB_DATASET_DIR is not set and .env.local did not provide it" >&2
  exit 1
fi

predictions="$run_dir/predictions.jsonl"
if [ ! -f "$predictions" ]; then
  echo "score.sh: no predictions file at $predictions" >&2
  exit 1
fi

results="$run_dir/results.json"
task_count=$(wc -l < "$predictions" | tr -d ' ')

echo "score.sh: scoring $task_count predicted task(s) from $predictions against $SB_DATASET_DIR (--all, so every dataset task counts); writing $results" >&2

# evaluate.py scores every dataset task in one blocking call and has no
# per-task progress output of its own, so we emit a heartbeat on a timer
# instead of a true every-20-tasks count.
(
  elapsed=0
  while true; do
    sleep 20
    elapsed=$((elapsed + 20))
    echo "score.sh: still scoring... (${elapsed}s elapsed)" >&2
  done
) &
heartbeat_pid=$!
trap 'kill "$heartbeat_pid" 2>/dev/null || true' EXIT

uv run --project "$repo_root/eval" "$repo_root/eval/evaluate.py" \
  --predictions "$predictions" \
  --all \
  --out "$results" \
  --dataset-dir "$SB_DATASET_DIR"

kill "$heartbeat_pid" 2>/dev/null || true
echo "score.sh: done, wrote $results" >&2
