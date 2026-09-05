#!/usr/bin/env python3
"""Builds the SFT training set for the Ornith-1.5-9B LoRA fine-tune (issue #16).

Reads `runs/r08/results.json` (pass/fail per task) and `runs/r08/traces/<id>.jsonl`
(one line per model step: see `scripts/traces.ts` for the schema), and:

1. Splits the 400 tasks into three id lists (honest-eval protocol, seeded):
   - holdout-fail: every task where r08 failed (58 ids).
   - holdout-pass: a seeded random 60 of the 342 passing ids (seed 20260906).
   - train: the remaining 282 passing ids. Only these are used for training.
2. Converts each training id's trace into one multi-turn OpenAI chat sample:
   system = agent/instructions.md verbatim (what the solver saw), user = the
   first message ("task <id>"), assistant turns carry tool_calls rebuilt from
   each step's `tool`/`tool_input`, tool turns carry `tool_output` (truncated
   to 6000 characters). The sample ends at the submit call's tool result; any
   trailing closing remark after submit is dropped, since it adds no tool-use
   signal to imitate.

Goldens never enter this: the only golden-derived signal is the boolean
pass/fail already computed by eval/evaluate.py in results.json, used solely to
decide which trajectories are eligible for training. No golden value, cell,
or workbook is read here.

Output: runs/ft9b/sft.jsonl, runs/ft9b/ids-{train,holdout-pass,holdout-fail}.txt.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

from rich.console import Console

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED = 20260906
HOLDOUT_PASS_COUNT = 60
TOOL_OUTPUT_CHAR_LIMIT = 6000
TRUNCATE_MARKER = "\n...[truncated at 6000 characters]"
MAX_SAMPLE_CHARS = 100_000

console = Console(stderr=True)

# Tool definitions, transcribed from the zod schemas in agent/tools/*.ts and
# the built-in bash tool (node_modules/eve/dist/src/tools/provided/bash.js),
# rendered as JSON Schema so the chat template can present them the way the
# solver actually saw them at inference time.
TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a shell command in the shared workspace environment.",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string", "description": "The shell command to execute."}},
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "load_task",
            "description": (
                "Load a SpreadsheetBench task by id. Copies its init workbook into the sandbox at "
                "/workspace/task/init.xlsx and /workspace/task/output.xlsx, writes the instruction to "
                "/workspace/task/prompt.txt, and returns the instruction, answer sheet, answer position, "
                "data position, and the first lines of dump_workbook.py's output so a separate dump call "
                "usually isn't needed."
            ),
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string", "description": 'The task id, e.g. "13-1".', "minLength": 1}},
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recalc_and_read",
            "description": (
                "Recalculate a workbook in the sandbox with LibreOffice, then read back the values in the "
                "task's answer range and flag any cell in that range holding an Excel error "
                "(#NAME?, #REF!, #VALUE!, #DIV/0!, and similar). Call this before submit."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workbook to recalculate. Defaults to /workspace/task/output.xlsx.",
                        "minLength": 1,
                    }
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit",
            "description": (
                "Submit the finished workbook as the answer for the loaded task. Validates it loads with "
                "openpyxl inside the sandbox, then writes it to the output folder on the host."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workbook to submit. Defaults to /workspace/task/output.xlsx.",
                        "minLength": 1,
                    }
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-dir", type=Path, default=REPO_ROOT / "runs" / "r08")
    parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "runs" / "ft9b")
    parser.add_argument("--instructions", type=Path, default=REPO_ROOT / "agent" / "instructions.md")
    parser.add_argument("--seed", type=int, default=SEED)
    return parser.parse_args()


def load_results(results_path: Path) -> tuple[list[str], list[str]]:
    """Returns (passing_ids, failing_ids), both sorted for a deterministic sample."""
    data = json.loads(results_path.read_text(encoding="utf-8"))
    items = data["items"]
    passes = sorted(item["id"] for item in items if item["pass"])
    fails = sorted(item["id"] for item in items if not item["pass"])
    return passes, fails


def split_ids(passes: list[str], fails: list[str], seed: int) -> tuple[list[str], list[str], list[str]]:
    rng = random.Random(seed)
    holdout_pass = sorted(rng.sample(passes, HOLDOUT_PASS_COUNT))
    holdout_pass_set = set(holdout_pass)
    train = sorted(i for i in passes if i not in holdout_pass_set)
    return train, holdout_pass, sorted(fails)


def truncate_tool_output(value: object) -> str:
    """Renders a tool_output field as a string, truncated to the character limit."""
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    if len(text) <= TOOL_OUTPUT_CHAR_LIMIT:
        return text
    return text[:TOOL_OUTPUT_CHAR_LIMIT] + TRUNCATE_MARKER


def build_sample(task_id: str, trace_lines: list[dict], system_prompt: str) -> dict | None:
    """Converts one trace's step lines into one OpenAI-messages chat sample.

    Returns None if the trace never reaches a submit step (not eligible: the
    honest-eval split only feeds this ids that passed r08, which requires a
    submit call, but a defensive check costs nothing).
    """
    first_message = next((line["prompt"] for line in trace_lines if line.get("prompt")), f"task {task_id}")
    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": first_message},
    ]

    call_counter = 0
    reached_submit = False
    for line in trace_lines:
        tool = line.get("tool")
        response_text = line.get("response") or ""

        if not tool:
            # A pure-text assistant step with no tool call (for example, the
            # closing remark after submit). Only keep it if it happens before
            # submit; the closing remark itself is dropped below by the
            # reached_submit break.
            if response_text:
                messages.append({"role": "assistant", "content": response_text})
            continue

        call_counter += 1
        call_id = f"call_{call_counter}"
        tool_input = line.get("tool_input")
        arguments = json.dumps(tool_input if tool_input is not None else {})
        messages.append(
            {
                "role": "assistant",
                "content": response_text,
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {"name": tool, "arguments": arguments},
                    }
                ],
            }
        )
        tool_output = line.get("tool_output")
        messages.append(
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": truncate_tool_output(tool_output),
            }
        )

        if tool == "submit":
            reached_submit = True
            break

    if not reached_submit:
        return None

    return {"messages": messages, "tools": TOOL_DEFS}


def sample_char_length(sample: dict) -> int:
    return sum(len(json.dumps(m)) for m in sample["messages"])


def main() -> int:
    args = parse_args()
    traces_dir = args.runs_dir / "traces"
    results_path = args.runs_dir / "results.json"
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    console.print(
        f"[bold]build_sft[/bold]: reading {results_path} and traces from {traces_dir}, "
        f"seed={args.seed}, holding out 58 fails + {HOLDOUT_PASS_COUNT} random passes"
    )

    system_prompt = args.instructions.read_text(encoding="utf-8")
    passes, fails = load_results(results_path)
    console.print(f"results.json: {len(passes)} pass, {len(fails)} fail (of {len(passes) + len(fails)})")

    train_ids, holdout_pass_ids, holdout_fail_ids = split_ids(passes, fails, args.seed)
    (out_dir / "ids-train.txt").write_text("\n".join(train_ids) + "\n", encoding="utf-8")
    (out_dir / "ids-holdout-pass.txt").write_text("\n".join(holdout_pass_ids) + "\n", encoding="utf-8")
    (out_dir / "ids-holdout-fail.txt").write_text("\n".join(holdout_fail_ids) + "\n", encoding="utf-8")
    console.print(
        f"split written: train={len(train_ids)} holdout-pass={len(holdout_pass_ids)} "
        f"holdout-fail={len(holdout_fail_ids)}"
    )

    samples: list[dict] = []
    dropped_too_long = 0
    dropped_no_submit = 0
    dropped_missing_trace = 0
    longest: tuple[int, str] | None = None
    total_chars = 0

    for task_id in track_progress(train_ids, "building SFT samples"):
        trace_path = traces_dir / f"{task_id}.jsonl"
        if not trace_path.exists():
            dropped_missing_trace += 1
            console.print(f"[yellow]warning[/yellow]: no trace file for {task_id}, skipping")
            continue

        trace_lines = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        sample = build_sample(task_id, trace_lines, system_prompt)
        if sample is None:
            dropped_no_submit += 1
            console.print(f"[yellow]warning[/yellow]: {task_id} trace never reaches submit, skipping")
            continue

        length = sample_char_length(sample)
        if length > MAX_SAMPLE_CHARS:
            dropped_too_long += 1
            continue

        total_chars += length
        if longest is None or length > longest[0]:
            longest = (length, task_id)
        samples.append(sample)

    out_path = out_dir / "sft.jsonl"
    with out_path.open("w", encoding="utf-8") as f:
        for sample in samples:
            f.write(json.dumps(sample) + "\n")

    token_estimate = total_chars // 4
    console.print()
    console.print("[bold]done[/bold]")
    console.print(f"  samples written: {len(samples)}")
    console.print(f"  dropped (missing trace): {dropped_missing_trace}")
    console.print(f"  dropped (no submit reached): {dropped_no_submit}")
    console.print(f"  dropped (over {MAX_SAMPLE_CHARS} chars): {dropped_too_long}")
    console.print(f"  total chars: {total_chars}  (~{token_estimate} tokens at chars/4)")
    if longest:
        console.print(f"  longest sample: {longest[1]} ({longest[0]} chars)")
    console.print(f"  wrote {out_path}")
    return 0


def track_progress(items: list[str], description: str):
    """Yields items with a rich progress bar on stderr, or plain periodic lines if stderr isn't a tty."""
    if console.is_terminal:
        from rich.progress import Progress

        with Progress(console=console) as progress:
            task = progress.add_task(description, total=len(items))
            for item in items:
                yield item
                progress.advance(task)
    else:
        total = len(items)
        for i, item in enumerate(items, start=1):
            if i == 1 or i % 50 == 0 or i == total:
                console.print(f"{description}: {i}/{total}")
            yield item


if __name__ == "__main__":
    sys.exit(main())
