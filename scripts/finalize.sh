#!/usr/bin/env bash
# Copies a completed run's submission artifacts to the repo root and fills
# in the scores block in SUBMISSION.md.
#
# Usage:
#   scripts/finalize.sh <run-dir> [--dry-run]
#
# <run-dir> must already hold results.json (400 items, from
# scripts/score.sh) and predictions.jsonl (400 lines). The script refuses to
# run otherwise: a partial run must not overwrite the root artifacts.
#
# Copies predictions.jsonl, outputs/, traces/, run.log, and results.json
# from <run-dir> to the repo root, overwriting whatever is there. Includes
# traces/<id>.attempt1.jsonl files (retry traces from tasks that needed a
# second attempt) alongside the final traces/<id>.jsonl -- the submission
# rules value honest traces over a tidied file list, and a retried task's
# first attempt is as real a model call as its second.
#
# predictions.jsonl's output paths (outputs/<id>.xlsx) are relative and
# resolve against the jsonl's own directory (see eval/sb.py:resolve_output),
# so once predictions.jsonl and outputs/ both sit at the repo root, no path
# rewriting is needed.
#
# Set FINALIZE_ROOT to target a different root directory (used by this
# script's own test in runs/finalize-test/); it defaults to the repo root.
set -euo pipefail

usage() {
  echo "usage: scripts/finalize.sh <run-dir> [--dry-run]" >&2
}

dry_run=0
run_dir=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [ -n "$run_dir" ]; then
        usage
        exit 1
      fi
      run_dir="$arg"
      ;;
  esac
done

if [ -z "$run_dir" ]; then
  usage
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
target_root="${FINALIZE_ROOT:-$repo_root}"

if [ ! -d "$run_dir" ]; then
  echo "finalize.sh: no such run dir: $run_dir" >&2
  exit 1
fi
run_dir="$(cd "$run_dir" && pwd)"

echo "finalize.sh: packaging $run_dir into $target_root$( [ "$dry_run" -eq 1 ] && echo ' (dry run)')" >&2

results_json="$run_dir/results.json"
predictions_jsonl="$run_dir/predictions.jsonl"

if [ ! -f "$results_json" ]; then
  echo "finalize.sh: refusing -- no results.json in $run_dir (run scripts/score.sh first)" >&2
  exit 1
fi
if [ ! -f "$predictions_jsonl" ]; then
  echo "finalize.sh: refusing -- no predictions.jsonl in $run_dir" >&2
  exit 1
fi

items=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['summary']['items'])" "$results_json")
if [ "$items" != "400" ]; then
  echo "finalize.sh: refusing -- results.json summary.items is $items, not 400" >&2
  exit 1
fi

pred_lines=$(wc -l < "$predictions_jsonl" | tr -d ' ')
if [ "$pred_lines" -lt 400 ]; then
  echo "finalize.sh: refusing -- predictions.jsonl has $pred_lines line(s), fewer than 400" >&2
  exit 1
fi

echo "finalize.sh: run dir checks passed (items=400, predictions=$pred_lines lines)" >&2

copy_file() {
  src="$1"
  dst="$2"
  if [ "$dry_run" -eq 1 ]; then
    echo "would copy: $src -> $dst"
    return
  fi
  cp -f "$src" "$dst"
}

copy_dir() {
  src="$1"
  dst="$2"
  if [ "$dry_run" -eq 1 ]; then
    echo "would copy dir: $src/ -> $dst/"
    return
  fi
  mkdir -p "$dst"
  cp -f "$src"/*.jsonl "$dst"/ 2>/dev/null || cp -rf "$src"/. "$dst"/
}

mkdir -p "$target_root"

copy_file "$predictions_jsonl" "$target_root/predictions.jsonl"
copy_file "$run_dir/run.log" "$target_root/run.log"
copy_file "$results_json" "$target_root/results.json"

if [ "$dry_run" -eq 1 ]; then
  echo "would copy dir: $run_dir/outputs/ -> $target_root/outputs/"
  echo "would copy dir: $run_dir/traces/ -> $target_root/traces/ (including attempt1 retry traces)"
else
  mkdir -p "$target_root/outputs" "$target_root/traces"
  cp -f "$run_dir"/outputs/*.xlsx "$target_root/outputs/"
  cp -f "$run_dir"/traces/*.jsonl "$target_root/traces/"
fi

if [ "$dry_run" -eq 1 ]; then
  echo "finalize.sh: dry run, no files were written" >&2
  exit 0
fi

# --- rewrite SUBMISSION.md's scores block ---
submission_md="$target_root/SUBMISSION.md"
if [ -f "$submission_md" ]; then
  python3 "$script_dir/finalize_scores.py" "$results_json" "$submission_md"
  echo "finalize.sh: updated scores block in $submission_md" >&2
else
  echo "finalize.sh: warning -- no SUBMISSION.md at $submission_md, skipped scores block" >&2
fi

# --- size report ---
outputs_bytes=$(du -sb "$target_root/outputs" 2>/dev/null | cut -f1)
traces_bytes=$(du -sb "$target_root/traces" 2>/dev/null | cut -f1)
total_bytes=$((outputs_bytes + traces_bytes))
total_mb=$((total_bytes / 1024 / 1024))
echo "finalize.sh: outputs/ + traces/ = ${total_mb} MB ($(du -sh "$target_root/outputs" | cut -f1) + $(du -sh "$target_root/traces" | cut -f1))" >&2

limit_bytes=$((100 * 1024 * 1024))
if [ "$total_bytes" -gt "$limit_bytes" ]; then
  echo "finalize.sh: WARNING -- outputs/ + traces/ exceed 100 MB. Consider Git LFS for outputs/:" >&2
  echo "  git lfs track \"outputs/*.xlsx\"" >&2
  echo "  git add .gitattributes outputs" >&2
fi

echo "finalize.sh: done -- predictions.jsonl, outputs/, traces/, run.log, results.json copied from $run_dir to $target_root; SUBMISSION.md scores updated" >&2
