# enyl-research

An agent that solves SpreadsheetBench tasks: given a workbook and a plain-English
instruction, it edits the workbook so the answer cells hold the correct result. Built on
[eve](https://eve.dev), a framework for durable AI agents; a judge running this repo does
not need to know eve to build the sandbox image, run predictions, or score the result.
The model is fixed in code at `deepseek/deepseek-v4-flash-0731` via the Vercel AI
Gateway; it is not configurable through an environment variable.

## Requirements

- Node 24
- Docker, or a host that can run [microsandbox](https://github.com/microsandbox/microsandbox) — the agent's code-execution sandbox needs one of the two
- LibreOffice, only if you want to run `scripts/score.sh` or `scripts/failures.py` outside the sandbox image (the vendored evaluator recalculates formulas with `soffice`)
- [`uv`](https://docs.astral.sh/uv/), to run the vendored evaluator in `eval/`

## Setup

```bash
npm ci
```

Build the sandbox image the agent runs model-written code in (Python, openpyxl,
pandas, and headless LibreOffice on top of eve's base image):

```bash
docker build -t enyl-sandbox:local .
```

Copy `.env.example` to `.env.local` and fill in:

- `AI_GATEWAY_API_KEY`: the intended path for a headless run against the Vercel AI
  Gateway. **Unverified as of this draft** — not yet tested on this machine; the
  coordinator will remove this note once it is.
- `VERCEL_OIDC_TOKEN`: the alternative that has been proven to work headless on this
  repo, pulled from a linked Vercel project with `vercel env pull`. Set this if
  `AI_GATEWAY_API_KEY` isn't available to you yet.
- `SB_DATASET_DIR`: path to the SpreadsheetBench dataset directory (a `dataset.json`
  plus per-task init workbooks and prompts).
- `EVE_TRACES_CONTENT`, `EVE_TRACES_RETAIN_COUNT`, `EVE_TRACES_MAX_AGE_MS`,
  `EVE_TRACES_MAX_TOTAL_BYTES`: eve's own trace-retention knobs, unrelated to scoring;
  leave unset unless you need them.

## Run

```bash
npm run predict -- --dataset-dir /path/to/data --out-dir /path/to/out
```

- `--dataset-dir` defaults to `$SB_DATASET_DIR` when that env var is set.
- `--ids 13-1,51-12`: run only the listed task ids instead of the whole dataset.
- `--concurrency 4` (default): number of tasks run at once.
- `--url http://127.0.0.1:2000`: point at a server you already started, instead of
  letting the command build (`eve build`) and start (`eve start`) its own on a free
  port. Without `--url`, it stops the server it started when the run ends.
- `--force`: rerun a task even if `predictions.jsonl` already has an `ok` line for it
  with an output file that still exists on disk.

Each task runs as its own session with an 8-minute timeout. On timeout, a model
failure, or a missing output file, the init workbook is copied to
`outputs/<id>.xlsx` and the failure reason is recorded as that task's status, so every
task always gets a `predictions.jsonl` line.

Rerunning the same command resumes: it skips any id already recorded with status `ok`
whose output file is still present, and reruns everything else. Ctrl-C stops cleanly
and prints the same resume instructions.

Run one `npm run predict` at a time per host. eve's dev server is a per-project
singleton, and a second concurrent run can end up sharing it with the first, producing
stray output files.

## Score

```bash
scripts/score.sh <run-dir>
```

Scores `<run-dir>/predictions.jsonl` against the full dataset (the evaluator's `--all`
flag, the mode judges use) and writes `<run-dir>/results.json`. Reads `SB_DATASET_DIR`
from the environment, falling back to `.env.local` at the repo root. Runs the
evaluator through `uv run --project eval`, since the repo root is a Node project and a
plain `uv run` there fails. The evaluator scores the whole dataset in one blocking
call with no per-task progress of its own, so `score.sh` prints a heartbeat on a timer
instead.

```bash
uv run --project eval python scripts/failures.py <run-dir>
```

Reads that `results.json`, `<run-dir>/predictions.jsonl`, and
`<run-dir>/traces/<id>.jsonl` (optional), and writes `<run-dir>/failures.md`: counts by
instruction type and by failure kind (no submit, error value in cell, wrong value,
timeout, exception), then one row per failed task with its bucket, model call count,
whether `submit` was called, any error-valued output cells, and the first 120
characters of its instruction. It only reports on tasks present in
`predictions.jsonl` — `results.json` under `--all` covers the entire dataset, and a
task this run never attempted isn't a bucket-worthy failure. Plain `python3` works
too if `openpyxl` is already on your `PATH`.

## Where outputs land

Under `<out-dir>`:

- `predictions.jsonl`: one `{"id", "output", "status"}` line per task. `status` is
  `ok` or the failure text.
- `outputs/<id>.xlsx`: the predicted workbook for each task.
- `traces/<id>.jsonl`: one line per model call for that task, written from the
  session's event stream: `step`, `model`, `prompt`, `response`, `input_tokens`,
  `output_tokens`, `latency_ms`, `error`, and, on a step that called a tool, `tool`,
  `tool_input`, `tool_output`. Any field over 20,000 characters is cut with a trailing
  `[truncated]`. `prompt` holds the literal first user message (`task <id>`) on step
  1 only; later steps leave it empty, because the full model input for those calls —
  system instructions, history, tool results — is assembled server-side per call and
  never reaches the client event stream. A trace-writing failure is logged to stderr
  and `run.log` but never fails the task.
- `run.log`: the full stdout/stderr of the run.
- `results.json`: written by `scripts/score.sh`, the evaluator's summary block.
- `failures.md`: written by `scripts/failures.py`.

## If the sandbox backend isn't detected

`agent/sandbox/sandbox.ts` uses eve's `defaultBackend()`, which tries, in order: Vercel
Sandbox (only on hosted Vercel), Docker, microsandbox, then a plain-bash fallback with
no isolation. On a judge's laptop this means Docker or microsandbox. To check which one
eve will pick:

- Docker: `docker info` succeeds and the daemon is reachable.
- microsandbox: a microsandbox runtime is installed and reachable on this host.

Build the sandbox image first (`docker build -t enyl-sandbox:local .`, above) — both
backends are configured to pull `enyl-sandbox:local`, and neither exists until that
build runs. If neither backend is available, `npm run predict` will fail when the agent
tries to run code in the sandbox, not at startup.

## Things to look at

- `runs/*/failures.md`: per-run failure breakdowns from past dev and verification
  runs, one row per failed task with its bucket and model-call count.
- The GitHub issue trail (#1 through #8): the order the pieces were built in, what each
  verifier checked, and the gaps found along the way (a resume bug fixed in #5, a
  `tool.result.status` mislabeling fixed in #6, the 12-call budget edge and the
  trace prompt gap noted above).
