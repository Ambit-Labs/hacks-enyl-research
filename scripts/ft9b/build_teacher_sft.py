#!/usr/bin/env python3
"""Builds extra SFT samples from the teacher's trajectories (issue #16 follow-up).

The teacher (claude-sonnet-4.5 over OpenRouter, see agent/lib/solver.ts) ran
the 58 tasks DeepSeek/r08 fails, at runs/teacher-fails. This script reuses
build_sft.py's trace-to-sample conversion (build_sample, TOOL_DEFS) to turn
the teacher's *passing* trajectories into the same OpenAI-chat sample shape
used for the 9B fine-tune, and writes them to the main tree's
runs/ft9b/sft-teacher.jsonl.

Pass/fail comes from runs/teacher-fails/results.json, computed by the
organizers' evaluator against goldens. That boolean is the only
golden-derived signal used here, exactly as in build_sft.py: it decides
which trajectories are eligible, and nothing else. No golden value, cell, or
workbook is read or written into a sample.

Usage:
  python3 scripts/ft9b/build_teacher_sft.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_sft import build_sample, sample_char_length, MAX_SAMPLE_CHARS  # noqa: E402

from rich.console import Console

console = Console(stderr=True)

# This script runs from a worktree, but the ids-holdout-fail.txt split and
# the sft-teacher.jsonl output both live in the main tree's runs/ft9b/ (that
# directory is gitignored dev scratch, not checked into the branch, so each
# worktree has its own unless we point at the main tree explicitly).
MAIN_TREE_ROOT = Path("/home/ubuntu/projects/hacks/encode-ylookup/enyl-research")

TEACHER_RUN_DIR = REPO_ROOT / "runs" / "teacher-fails"
INSTRUCTIONS_PATH = REPO_ROOT / "agent" / "instructions.md"
HOLDOUT_FAIL_IDS_PATH = MAIN_TREE_ROOT / "runs" / "ft9b" / "ids-holdout-fail.txt"
OUT_PATH = MAIN_TREE_ROOT / "runs" / "ft9b" / "sft-teacher.jsonl"


def main() -> int:
    results_path = TEACHER_RUN_DIR / "results.json"
    traces_dir = TEACHER_RUN_DIR / "traces"

    console.print(
        f"[bold]build_teacher_sft[/bold]: reading {results_path} and traces from {traces_dir}"
    )

    data = json.loads(results_path.read_text(encoding="utf-8"))
    holdout_fail_ids = set(HOLDOUT_FAIL_IDS_PATH.read_text(encoding="utf-8").split())
    items = [item for item in data["items"] if item["id"] in holdout_fail_ids]
    passing_ids = sorted(item["id"] for item in items if item["pass"])
    console.print(
        f"teacher run: {len(passing_ids)} pass of {len(items)} (of the 58 DeepSeek fails)"
    )

    system_prompt = INSTRUCTIONS_PATH.read_text(encoding="utf-8")

    samples: list[dict] = []
    dropped_too_long = 0
    dropped_no_submit = 0
    dropped_missing_trace = 0

    for task_id in passing_ids:
        trace_path = traces_dir / f"{task_id}.jsonl"
        if not trace_path.exists():
            dropped_missing_trace += 1
            console.print(f"[yellow]warning[/yellow]: no trace file for {task_id}, skipping")
            continue

        trace_lines = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()
        ]
        sample = build_sample(task_id, trace_lines, system_prompt)
        if sample is None:
            dropped_no_submit += 1
            console.print(f"[yellow]warning[/yellow]: {task_id} trace never reaches submit, skipping")
            continue

        length = sample_char_length(sample)
        if length > MAX_SAMPLE_CHARS:
            dropped_too_long += 1
            console.print(f"[yellow]warning[/yellow]: {task_id} sample over {MAX_SAMPLE_CHARS} chars, skipping")
            continue

        samples.append(sample)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        for sample in samples:
            f.write(json.dumps(sample) + "\n")

    console.print()
    console.print("[bold]done[/bold]")
    console.print(f"  samples written: {len(samples)}")
    console.print(f"  dropped (missing trace): {dropped_missing_trace}")
    console.print(f"  dropped (no submit reached): {dropped_no_submit}")
    console.print(f"  dropped (too long): {dropped_too_long}")
    console.print(f"  wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
