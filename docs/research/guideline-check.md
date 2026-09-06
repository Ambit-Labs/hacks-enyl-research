# Guideline compliance check (2026-09-06)

Source of truth: `github.com/ylookup/encode-hackathon` main branch, fetched live via `gh api`
(root `README.md`, `research/README.md`, `research/SUBMISSION.md`,
`research/SUBMISSION_TEMPLATE.md`). Diffed byte-for-byte against the local mirror at
`../encode-hackathon/{README.md,research/README.md,research/SUBMISSION.md,research/SUBMISSION_TEMPLATE.md}`:
all four are identical. The local copy is not stale.

## Rule by rule

| Rule | Status | Evidence |
|---|---|---|
| Repo must be public GitHub | **GAP** | `gh repo view Ambit-Labs/hacks-enyl-research --json visibility` → `"PRIVATE"` |
| Code written before Sat 12:00 doesn't count | Pass | `git log --format='%ci'` spans 2026-09-05 13:41 to 2026-09-06 04:44, all after hacking start |
| `SUBMISSION.md` at repo root, from the template | Pass (mostly) | `SUBMISSION.md` present, all 7 template sections present in order (`grep '^##'` matches template exactly) |
| Team section filled (name, handles, repo URL) | **GAP** | `SUBMISSION.md`: `Team name:` and `Members, one GitHub handle per line:` both blank; `Repo URL:` is filled |
| "What we built" paragraph, 150-300 words | **GAP** | Counted 345 words (`python3` word count on the section) — over the ceiling |
| Models section: exact model id, fine-tune disclosure | Pass | `deepseek/deepseek-v4-flash-0731` named, fixed as a literal per `agent/agent.ts`; states no fine-tuning, no training data |
| Scores from shipped evaluator, `items` = 400 | Pass | `jq '.summary' results.json` → `{"items":400,"graded":400,"missing":0,"errors":0,"pass_rate":0.8725,"cell_accuracy":0.8123,"pass_rate_cell_level":0.8945,"pass_rate_sheet_level":0.824}`; pasted verbatim into `SUBMISSION.md` |
| `predictions.jsonl`, one line per task, `{id, output, status}` | Pass | `head -3 predictions.jsonl` → `{"id":"267-21","output":"outputs/267-21.xlsx","status":"ok"}`; `wc -l` → 400, all 400 distinct ids |
| `outputs/<id>.xlsx` | Pass | `ls outputs \| wc -l` → 400 |
| `traces/<id>.jsonl`, one line per model call | Pass | 400 base trace files, one per prediction id (`traces/*.jsonl` minus `.attemptN` retry files); no id missing, no orphan id |
| Trace required fields (step, model, prompt, response, input_tokens, output_tokens, latency_ms, error) | Pass | Sampled 8 trace files, all lines carry the full field set; `head -c 800 traces/13-1.jsonl` shows a well-formed line with `tool`/`tool_input`/`tool_output` added for agent steps |
| No golden values / no lookup step in prompts or traces | Pass | `grep -ril golden traces/ outputs/` → no hits outside the intended refusal check; `agent/tools/load_task.ts` and `agent/lib/dataset.ts` are the only "golden" hits repo-wide, both are the guard that refuses to load a `*golden*`-named file |
| `run.log`, unedited stdout/stderr | Pass | Present at repo root, 2.7 MB |
| `results.json` from the shipped evaluator | Pass | Present at repo root, `items` array has 400 graded entries plus the `summary` block above |
| Dockerfile if the pipeline is an agent / runs model-written code | Pass | `Dockerfile` at repo root, built on `ghcr.io/vercel/eve:0.52.1`, adds Python/openpyxl/pandas/LibreOffice for the sandbox |
| Docker contract: read `/data` ro, write `/out`, keys from env, model id fixed in code, temp 0 | Pass, with a caveat | Model id is a literal (`agent/agent.ts`); `.env.example` lists key names only, no values; **caveat** below on which key judges will actually have |
| `npm run predict -- --dataset-dir --out-dir` contract | Pass | `scripts/predict.ts` usage comment and `parseArgs` implement exactly this signature; `--dataset-dir` falls back to `SB_DATASET_DIR`; loads `.env.local` from the script's own resolved path, not cwd, so it doesn't depend on anything under `runs/` |
| Keys never committed | Pass | `.env.local` untracked (`git ls-files \| grep -i env` → only `.env.example`); `git grep -i api_key=` hits only `.env.example` (empty values) and shell scripts that read a key from a file/env var, never a literal secret |
| README states run/setup commands, env vars | Pass | `README.md` "Setup" and "Run" sections give `npm ci`, `docker build`, `.env.local` fields, and the exact `npm run predict -- --dataset-dir ... --out-dir ...` invocation |
| Judge-path auth actually verified | **GAP** (contradiction) | `README.md` (committed 2026-09-05 22:48): "`AI_GATEWAY_API_KEY`: ... Verified: `npm run predict` and `scripts/score.sh` both ran clean on this key alone." `SUBMISSION.md` (committed later, 2026-09-06 01:17): "`AI_GATEWAY_API_KEY` (intended path for judges, **unverified** as of this draft)." The two committed files disagree about whether the judges' actual auth path was tested. |

## Gaps, priority order

1. **Repo is private.** The rule is a hard submission requirement ("Put your code in a public GitHub repo"). Fix: flip `Ambit-Labs/hacks-enyl-research` to public before Sunday 12:00 — `gh repo edit Ambit-Labs/hacks-enyl-research --visibility public` (confirm nothing else in the repo should stay private first, e.g. no leaked keys — already checked clean above).
2. **`AI_GATEWAY_API_KEY` path is claimed "verified" in README but "unverified" in SUBMISSION.md, written four hours later.** If the later, more cautious claim is the true state, judges may fail on the one credential they're told to use. Fix: re-run `npm run predict` and `scripts/score.sh` with only `AI_GATEWAY_API_KEY` set (no `VERCEL_OIDC_TOKEN`) in a clean shell, and make both files agree — either confirm and soften SUBMISSION.md's hedge, or fix whatever broke and correct README's premature "Verified" claim.
3. **Team section blank.** `SUBMISSION.md` has no team name or member GitHub handles. Fix: fill both lines; this is a one-line edit once the team knows who's listed.
4. **"What we built" paragraph runs to 345 words, over the stated 150-300 ceiling.** Fix: trim roughly a third, keeping the concrete specifics (model, tool loop, retry policy, the one known trace gap) since those are what the rule says judges read first.

No other gaps found. The submission-file layout, trace schema, evaluator scores, Docker sandbox contract, and secret hygiene all check out against the current upstream rules.
