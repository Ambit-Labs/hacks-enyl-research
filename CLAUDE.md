@AGENTS.md

# Project: SpreadsheetBench agent for the Ylookup x Encode hackathon

An eve agent that takes a workbook and a plain-English instruction and returns the workbook with the answer filled in. Judges run `npm run predict` on tasks we have not seen and score the answer cells with the evaluator in `eval/`. Deadline Sunday 6 September 2026, 12:00 UK time.

The task brief, dataset, evaluator and submission rules are in the sibling repo `../encode-hackathon/` (read its `README.md`, `research/README.md`, `research/SUBMISSION.md`). The organizers confirmed verbally that a TypeScript harness is fine and that the sandbox may be Docker or microsandbox. Everything else in those files is binding.

## Hard rules

- Model id is a literal in `agent/agent.ts`: `deepseek/deepseek-v4-flash-0731` via the AI Gateway. Never read it from an env var. Temperature 0 where eve allows it.
- Model-written code runs only in the eve sandbox. Bridge tools in `agent/tools/` may touch the host filesystem; nothing the model writes may.
- No golden files, golden values, or answer lookups anywhere in prompts, instructions, tools, or sandbox seeds. A grep for `golden` in `agent/` must only hit the refusal check in `load_task`.
- Keys come from the environment. `.env.local` is gitignored. `.env.example` lists names only.
- Do not run `git commit` or `git push`. The user commits. Say when a milestone is worth committing.
- Do not upgrade `eve`. Pin what is in `package-lock.json`.

## How work is organized

Work is tracked as GitHub issues in `Ambit-Labs/hacks-enyl-research`. The plan and milestones are in the `epic` issue. Each task issue has a goal, acceptance criteria, and a verifier checklist. Labels: `worker` (open for implementation), `needs-verify` (implementation done), `verified` (checklist passed), `blocked`.

The Claude session running in this repo is the **coordinator**. It does not implement issues itself. It:

1. Reads the epic and picks the next unblocked `worker` issues.
2. Dispatches one **worker** subagent per issue with the Agent tool. Independent issues run in parallel in the same message. Each worker gets: the issue number and full body, the hard rules above, the files it may touch, and the instruction to read the relevant page under `node_modules/eve/docs/` before writing code. Workers follow the `unslop` writing rules for anything a human reads.
3. When a worker reports done, relabels the issue `needs-verify` and dispatches a **verifier** subagent with the issue's verifier checklist. The verifier is a fresh agent that did not write the code. It runs the checks, does not fix anything, and reports pass or fail with the exact command output.
4. On pass: comments the verifier's evidence on the issue, relabels `verified`, closes it, updates the status section of the epic. On fail: comments the failure, relabels `worker`, dispatches a new worker with the failure report attached.
5. Keeps a short running summary for the user: what is done, what is running, what is blocked, and whether the next milestone is on track. Asks the user only for decisions listed as theirs in an issue (keys, repo visibility, spending).

Use `gh issue view <n>`, `gh issue comment`, `gh issue edit --add-label/--remove-label`, `gh issue close`. Never edit an issue body except the epic's status section.

## Worker rules

- One issue per worker. Touch only the files the issue names, plus tests.
- Read the docs page for anything you author in `agent/` before writing it. Docs are under `node_modules/eve/docs/`, index in `README.md` there.
- Run the acceptance commands before reporting done. Paste their output in the report. A report without command output is not done.
- If the issue's design is wrong, say so with the reason, propose the smallest change, and stop. Do not silently do something else.
- Long-running scripts print a startup line and progress lines on stderr.

## Verifier rules

- Start from the issue's verifier checklist. Run every item. Add your own check if the acceptance criteria leave an obvious gap.
- Never modify code. If a check needs a fixture, create it under `runs/verify-<issue>/` and say so.
- Report each item as pass or fail with the command and its output. End with one line: PASS or FAIL.

## Layout

```
agent/            eve agent: agent.ts, instructions.md, sandbox/, tools/, lib/
eval/             the organizers' evaluator, vendored unchanged
scripts/          predict.ts, score.sh, failures.py
runs/<name>/      predictions.jsonl, outputs/, traces/, run.log, results.json, failures.md
Dockerfile        sandbox image with Python, openpyxl, pandas, LibreOffice
```

Dataset path for local dev: `SB_DATASET_DIR` in `.env.local`, normally `../encode-hackathon/research/data/spreadsheetbench_verified_400`.
