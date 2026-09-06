# enyl-research

An agent that solves SpreadsheetBench tasks: given a workbook and a plain-English
instruction, it edits the workbook so the answer cells hold the correct result. Built on
[eve](https://eve.dev), a framework for durable AI agents; a judge running this repo does
not need to know eve to build the sandbox image, run predictions, or score the result.
The model is fixed in code at `deepseek/deepseek-v4-flash-0731` via the Vercel AI
Gateway; it is not configurable through an environment variable.

## Requirements

- Node 24 or newer
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

- `AI_GATEWAY_API_KEY`: the primary path for a headless run against the Vercel AI
  Gateway. Verified: `npm run predict` and `scripts/score.sh` both ran clean on this
  key alone, with no `VERCEL_OIDC_TOKEN` in the environment.
- `VERCEL_OIDC_TOKEN`: also verified headless, for a linked Vercel project, pulled
  with `vercel env pull`. Set this only if you don't have an `AI_GATEWAY_API_KEY`.
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
- `--no-retry`: disable the retry behavior below, for a reproducible run.

Each task runs as its own session with an 8-minute timeout. On timeout, a model
failure, or a missing output file, the init workbook is copied to
`outputs/<id>.xlsx` and the failure reason is recorded as that task's status, so every
task always gets a `predictions.jsonl` line.

A first attempt that ends `missing_output`, `model_failed`, or `error` (not `timeout`)
gets up to two more attempts, each in a brand-new session with the same first message;
the final attempt's result is what lands in `predictions.jsonl`, whatever its status.
Earlier attempts' traces are kept as `traces/<id>.attempt1.jsonl` and
`traces/<id>.attempt2.jsonl`, and `traces/<id>.jsonl` holds the last attempt, so the
judges still see one trace file per task. Pass `--no-retry` to turn
this off.

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

## Packaging the final run

```bash
scripts/finalize.sh <run-dir>
```

Copies `predictions.jsonl`, `outputs/`, `traces/`, `run.log`, and `results.json` from a
scored run directory to the repo root, and rewrites the scores block in
`SUBMISSION.md` between `<!-- scores:start -->` and `<!-- scores:end -->` markers with
the `summary` from `results.json`. Refuses to run unless `results.json` already shows
`summary.items == 400` and `predictions.jsonl` has at least 400 lines, so it never
overwrites the root artifacts with a partial run. `predictions.jsonl`'s `output` paths
are already relative to its own directory (`outputs/<id>.xlsx`), so no path rewriting
is needed once both land at the repo root together. Copies
`traces/<id>.attempt1.jsonl` files too, alongside the final `traces/<id>.jsonl`, for
any task that needed a retry: the submission rules value honest traces, and a retried
task's first attempt is as real a model call as its second. Add `--dry-run` to see
what it would copy without writing anything, and it warns if `outputs/` plus `traces/`
exceed 100 MB with the `git lfs track` command to run.

Run this once, right before submitting, against the run directory that holds the final
scored 400-task run.

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

## Optional: Ornith on Runcrate

Infra for #12 and #13: serves `ornith-ai/Ornith-1.5-35B-A3B-FP8` on a Runcrate H100 as
an OpenAI-compatible endpoint. Not needed for `npm run predict`, which stays fixed on
`deepseek/deepseek-v4-flash-0731`.

```bash
scripts/runcrate/serve_ornith.sh create   # pick the cheapest single H100, launch the box
scripts/runcrate/serve_ornith.sh setup    # install uv + a venv + vLLM, pull the weights,
                                           #   plus a CUDA forward-compat fix (see below)
scripts/runcrate/serve_ornith.sh serve    # start vLLM, wait for readiness, write .env.local, smoke test
scripts/runcrate/serve_ornith.sh status   # print the public IP and a one-line curl check
scripts/runcrate/serve_ornith.sh delete   # terminate the box
```
Named `ornith-serve`; delete it once nothing needs it (bills per minute, currently
$2.75/hr in montreal-canada-2). `serve` writes `ORNITH_API_KEY` and `ORNITH_BASE_URL`
to `.env.local`; the key is generated locally, sent over `rc ssh` stdin, and never
appears anywhere else. `ubuntu-inference`'s driver only speaks CUDA 12.8, older than
pip's default vLLM/torch build, so `setup` installs `cuda-compat-13-0` for forward
compatibility, and `serve` puts the venv on `PATH` so flashinfer's first-request JIT
can find `ninja`.

`create` to `serve`-ready took about 22 minutes end to end. `ornith-serve` is running
now, left up for #12 and #13.

### Load-balancing across multiple Ornith boxes

`scripts/runcrate/ornith_proxy.mjs` is a dependency-free reverse proxy that spreads
requests across every box that has an env file in `runs/boxes/*.env`, so the agent can
keep pointing at one `ORNITH_BASE_URL` while boxes come and go. It re-reads
`runs/boxes/*.env` every 30s (no restart needed for a new box), health-checks each
backend's `/models` on the same interval, and load-balances chat completions and
`/models` with least-in-flight-requests, retrying once on a different backend if a
connection fails before any response byte arrives. Streaming responses are piped
through unbuffered, so SSE works normally.

```bash
nohup node scripts/runcrate/ornith_proxy.mjs > runs/boxes/proxy.log 2>&1 &
```

On startup it generates a random bearer key and writes it to `runs/boxes/proxy.env`
(mode 0600) alongside `ORNITH_BASE_URL=http://127.0.0.1:8100/v1`; source that file the
same way you would a single box's env file. `GET /healthz` lists each backend's base
URL, health, and request counters. The proxy never logs keys or request bodies.

## Running your task set on the Ornith 9B endpoint

DeepSeek is the default solver and the one the scored submission runs on. This
section is for anyone who wants to point the same harness at our Ornith 9B endpoints
instead, on their own task set.

1. Add these to `.env.local` (values supplied privately, never committed to the
   repo):
   ```
   FT9B_BASE_URL=<endpoint>/v1
   FT9B_API_KEY=<key>
   ```
   For the untuned base model instead of the fine-tune, also add
   `FT9B_BASE_URL_BASE=<endpoint>/v1` (it reuses `FT9B_API_KEY`).
2. In `agent/lib/solver.ts`, set `SOLVER = "ft9b"` for the fine-tune, or `"base9b"`
   for the base model.
3. `npm run build`
4. `npm run predict -- --dataset-dir <their set> --out-dir <out>`
5. `scripts/score.sh <out>`

The endpoint serves an OpenAI-compatible API over vLLM, model names `Ornith-9B-ft`
and `Ornith-1.5-9B-base`, thinking off, temperature 0, `--max-model-len 32768`. Expect
about 45 seconds per task at 16 concurrent requests per box. Remember to set `SOLVER`
back to `"deepseek"` afterward: that default is what the scored submission runs.

## Findings

Every model in this row ran through the same tool loop and instructions as the
DeepSeek final, so the columns compare solvers, not harnesses. "SB 400 full" is our
verified 400-task set; "80 r01 failures" and "58/60 held-out" are fixed id subsets
from issues #12 and #16; "100 DeepSeek passes" is a random sample of tasks DeepSeek
solved; "SB2" is SpreadsheetBench 2, a harder, unrelated held-out benchmark (see
`docs/research/spreadsheetbench2.md`).

| Model | SB 400 full | 80 r01 failures | 100 DeepSeek passes | 58 held-out failures | 60 held-out passes | SB2 282 | SB2 sample 100 |
|---|---|---|---|---|---|---|---|
| DeepSeek r09 | 349 | 44 | 95 | 24 | 58 | 52 | 15 |
| Claude Sonnet 4.5 | not run | not run | not run | 31 | not run | not run | not run |
| Ornith 35B | not run | 31 | 70 | not run | not run | not run | not run |
| Ornith 9B base | BASE9B_FULL400 | 14 | not run | 14 | 31 | not run | 3 |
| Ornith 9B fine-tuned | 136 (0.34) | 11 | not run | 11 | 18 | not run | 3 |

What raised the score: issue #16 found that 7 of the 33 tasks DeepSeek never passed
skipped the pre-submit recalculation check entirely, and 2 more submitted over a
reported Excel error. Moving that check into `submit` itself, tightening the
"fill every cell" instruction so empty answers stay empty, and adding rules against
retyping labels or writing display-formatted values as the wrong type took the pass
rate from 0.855 (r03) to 0.8725 (r09, the final).

Why Ornith 35B lost: on the 100 tasks DeepSeek passed, Ornith kept only 70 (issue
#12). It also needed a much larger context window (one task in five overflowed
65k tokens) and, with thinking on, took about four minutes of model time per task.
No split by instruction type came out net positive, so DeepSeek stayed the solver.

Why the critic didn't help: issue #13 tried a second-model verdict from Ornith 35B
before submit. Against the current code on the same ids, it won 5-7 tasks and lost
10, a wash with a slight negative lean, for the cost of an added call and an Ornith
dependency. The code is kept on branch `worktree-agent-a0dd7ce4b05acbe15`, unmerged.

How the 9B fine-tune was done and why it hurt: issue #16 took the passing trajectories
from a DeepSeek run and LoRA fine-tuned Ornith-1.5-9B on them, then re-served the
adapter over vLLM. On the full 400 it scored 0.34 against DeepSeek's 0.8725,
submitting only 233 of 400 tasks versus DeepSeek's 398. On the held-out set it did
worse than the untuned base model it started from on both passes and failures, and
gave up earlier (median 8-9 tool calls versus the base model's 13-14): fine-tuning on
a few hundred trajectories from a much stronger model taught it to imitate the shape
of a solve, not to solve, and it abandons harder tasks sooner than before the
fine-tune. See `docs/research/ornith-self-improvement.md` for the full plan and the
data-size caveats that predicted this outcome going in.

SB2 as a held-out check: since SB2 shares no tasks with our 400, it separates real
solving ability from anything specific to the 400-task set. DeepSeek's 52/282 (18.4%)
sits in the expected range for a small model against the paper's published 34.89%
best score. Both 9B models scored 3/100 on a sample, not because they're worse
reasoners on this benchmark specifically, but because SB2's workbooks routinely
exceed the 32768-token context these endpoints are configured with, so nearly 90% of
tasks never reach a `submit` call.

## Things to look at

- `runs/*/failures.md`: per-run failure breakdowns from past dev and verification
  runs, one row per failed task with its bucket and model-call count.
- The GitHub issue trail (#1 through #16): the order the pieces were built in, what
  each verifier checked, and the gaps found along the way (a resume bug fixed in #5, a
  `tool.result.status` mislabeling fixed in #6, the 12-call budget edge and the trace
  prompt gap noted above, the Ornith and critic A/B tests in #12 and #13, the
  never-pass-33 analysis and the 9B fine-tune in #16).
- `docs/research/never-pass-33.md`, `docs/research/ornith-self-improvement.md`,
  `docs/research/spreadsheetbench2.md`: the research behind the findings above.
