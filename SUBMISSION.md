# Submission: <team name>

## Team

- Team name:
- Members, one GitHub handle per line:
- Repo URL: https://github.com/Ambit-Labs/hacks-enyl-research

## What we built and why

We built an eve agent that solves SpreadsheetBench tasks end to end: load a task, edit
the workbook, recalculate, submit. The model is `deepseek/deepseek-v4-flash-0731`,
called through the Vercel AI Gateway. Its tool loop is four steps: `load_task` returns
the instruction, the answer range, and a first-look dump of the workbook's sheets and
formulas; a sandboxed bash tool lets the model write and run Python against the
workbook with openpyxl; `recalc_and_read` runs the workbook through headless
LibreOffice and reads back the answer range plus any error-valued cells, so the model
checks its own work before submitting; `submit` validates the workbook and writes it
to the output directory. The sandbox is a Docker (or microsandbox) container built
from a repo-root Dockerfile with no network egress, since everything the model needs
is already in the image. We chose an agent over a single model call because
SpreadsheetBench answers usually need a formula computed from the sheet's own data,
not a value guessed from the prompt text, and only code execution plus a recalculation
step can verify that. Instructions cap the agent at 12 tool calls; most tasks finish well under that, but
some hit the ceiling and submit their best attempt rather than looping further.
Traces capture every tool call and token count, with one known gap: the full model
input for calls after the first is assembled server-side and never reaches the client
event stream, so `prompt` is populated on step 1 only. A per-task timeout copies the
init workbook as a fallback output so every task always gets a scored prediction, even
one the model never finishes.

## Models

- `deepseek/deepseek-v4-flash-0731`, called through the Vercel AI Gateway. Fixed as a
  literal in `agent/agent.ts`, not read from an environment variable.
- No fine-tuning. No training data.

## Scores on the 400

<!-- paste runs/final/results.json summary here -->

## Your run on the 400

Copied at packaging time from `runs/final/` to the repo root:

- `predictions.jsonl`: path
- `outputs/`: path
- `traces/`: path
- `run.log`: path

## Code

`Dockerfile` (repo root) builds the sandbox the agent executes model-written code in:
Python, openpyxl, pandas, and headless LibreOffice on top of eve's base image. Build
it with `docker build -t enyl-sandbox:local .` before running predictions. Environment
variables the run needs: `AI_GATEWAY_API_KEY` (intended path for judges, unverified as
of this draft) or `VERCEL_OIDC_TOKEN` (proven headless on our own machine) for model
auth, and `SB_DATASET_DIR` for the dataset location. See `README.md` for the full
setup and run commands.

## Things to look at

- `README.md`: setup, run, and scoring commands, plus where every output file lands
  and what to do if the sandbox backend isn't detected.
- `runs/*/failures.md`: per-run failure breakdowns from development and verification
  runs, one row per failed task with its bucket and model-call count.
- GitHub issues #1 through #8 on this repo: the build order, what each verifier
  checked, and the gaps found along the way, including a resume bug, a tool-status
  mislabeling in trace generation, and the trace prompt gap described above.
