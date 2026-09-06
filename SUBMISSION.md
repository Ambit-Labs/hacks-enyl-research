# Submission: <team name>

## Team

- Team name: Ambit Labs
- Members, one GitHub handle per line:
  - ciocan
  - anamariastate
- Repo URL: https://github.com/Ambit-Labs/hacks-enyl-research

## What we built and why

We built an eve agent that solves SpreadsheetBench tasks end to end: load a task, edit
the workbook, recalculate, submit. The model is `deepseek/deepseek-v4-flash-0731`,
called through the Vercel AI Gateway. The tool loop has four steps: `load_task`
returns the instruction, the answer range, and a first-look dump of the workbook's
sheets and formulas; a sandboxed bash tool lets the model write and run Python
against the workbook with openpyxl; `recalc_and_read` runs the workbook through
headless LibreOffice and reads back the answer range plus any error-valued cells, so
the model checks its own work before submitting; `submit` recalculates once more,
refuses if an answer cell holds an unconfirmed Excel error, then validates the
workbook and writes it out. The sandbox is a Docker (or microsandbox) container built
from a repo-root Dockerfile with no network egress. An agent beats a single model
call here because most answers need a formula computed from the sheet's own data,
not a value guessed from the prompt, and only code execution plus recalculation can
verify that. Instructions tell the model that an empty cell can be the right answer,
to copy labels byte for byte from the workbook, and to write display strings as text
and numbers as numbers, since the grader compares cached values exactly. A failed
attempt gets up to two more tries in a fresh session, absorbing the model's
occasional garbled first turn. Instructions cap the agent at 12 tool calls; most
tasks finish well under that, and the rest submit their best attempt rather than loop
further. A per-task timeout copies the init workbook as a fallback output, so every
task gets a scored prediction even when the model never finishes.

## Models

- Scored submission: Ornith 1.5 9B (`ornith-ai/Ornith-1.5-9B`), LoRA fine-tuned by us
  on 282 of our own passing agent trajectories, weights at
  https://huggingface.co/ciocan/ornith-1.5-9b-spreadsheetbench-merged (adapter:
  ciocan/ornith-1.5-9b-spreadsheetbench-lora), served on a private vLLM endpoint
  (details supplied separately). Selected by default; `SOLVER` in `.env.local` picks
  another solver without a code change.
- `deepseek/deepseek-v4-flash-0731` via the Vercel AI Gateway drove the harness
  development and produced the training trajectories (0.8725 on the 400, see README).

## Scores on the 400

<!-- scores:start -->
```json
{
  "items": 400,
  "graded": 400,
  "missing": 0,
  "errors": 0,
  "pass_rate": 0.34,
  "cell_accuracy": 0.4337,
  "pass_rate_cell_level": 0.32,
  "pass_rate_sheet_level": 0.384
}
```
<!-- scores:end -->

Why the 9B did not complete all 400 tasks. Every task has a prediction line and an
output workbook, because the runner retries a failed attempt in a fresh session up to
three times and then copies the untouched init workbook as the output; those fallback
tasks score zero. In the fine-tuned 9B's run, 233 tasks reached `submit`, 135 never
did after three attempts, and 32 ended in a model error. Three causes, in order of
weight: the model stops calling tools and answers in prose before submitting, which
the fine-tune made worse (median 8 to 9 tool calls against the base model's 13 to 14,
and against DeepSeek's habit of finishing the loop); workbook dumps and long tool
outputs overflow the 32768-token context the 9B is served with, so large sheets fail on
the first call; and a share of first turns come back as malformed tool-call text
rather than a structured call, which a small model does more often than DeepSeek. The
untuned base 9B shows the same pattern at a lower rate, which is why it scores higher
on the held-out sets.

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
variables the run needs: `AI_GATEWAY_API_KEY` (the primary path for judges, verified
headless on a fresh clone with no `VERCEL_OIDC_TOKEN` in the environment) or
`VERCEL_OIDC_TOKEN` (also verified, for a linked Vercel project) for model auth, and
`SB_DATASET_DIR` for the dataset location. See `README.md` for the full setup and run
commands.

## Things to look at

- `README.md`: setup, run, and scoring commands, plus where every output file lands
  and what to do if the sandbox backend isn't detected.
- `runs/*/failures.md`: per-run failure breakdowns from development and verification
  runs, one row per failed task with its bucket and model-call count.
- GitHub issues #1 through #8 on this repo: the build order, what each verifier
  checked, and the gaps found along the way, including a resume bug, a tool-status
  mislabeling in trace generation, and the trace prompt gap described above.
