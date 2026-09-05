# Ornith self-improvement, and a 9B fine-tune plan for SpreadsheetBench

Baseline today: DeepSeek-V4-Flash solver, tool loop (`load_task` → bash/openpyxl edits → LibreOffice recalc → `submit`), 0.855 pass rate on the 400-task verified set (`runs/r08/results.json`, `runs/r03/results.json`). Deadline 2026-09-06 11:00 UTC.

## 1. What Ornith is

Ornith-1.5 is a family of open-weight models from ornith-ai, released in three sizes: a 397B MoE flagship, a 35B-A3B MoE (3B active params/token, the one already wired into `agent/lib/solver.ts`), and a 9B dense model ([Ornith-1.5-397B](https://huggingface.co/ornith-ai/Ornith-1.5-397B), [Ornith-1.5-35B-A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B), [Ornith-1.5-9B](https://huggingface.co/ornith-ai/Ornith-1.5-9B), [org page](https://huggingface.co/ornith-ai)). Both the 35B and 9B are built on Qwen3-series architecture and tokenizer: the model card for the 9B states "Ornith-1.5 extends Ornith-1.0, which was developed on top of Qwen3.5 and Gemma4 with additional continued pretraining, mid-training, and post-training," and it ships a modified `chat_template.jinja` "to ensure consistency between training and inference." The 9B is MIT-licensed, dense, ~19 GB in bf16, natively 262,144-token context (YaRN to ~1M), and its recommended vLLM serving flags are `--enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3` — Qwen3-family parsers, not a bespoke Ornith format. Recommended sampling: temperature 1.0 / top_p 0.95 for general tasks, temperature 0.6 / top_p 0.95 for "precise coding." This matches what the coordinator's own worker found (issue #13 comment): at temperature 0, Ornith's thinking never terminates on non-trivial prompts; `ORNITH_VARIANT` in `agent/lib/solver.ts` works around this by disabling `enable_thinking` via `chat_template_kwargs` and keeping temperature 0 (variant B), or keeping thinking on at the model card's 0.6 (variant A).

The self-improvement loop, described on the [Ornith blog](https://ornith.ai/ornith_1_5.html) and covered by [MindStudio](https://www.mindstudio.ai/blog/ornith-1-5-moe-model-release) and a [Medium writeup](https://medium.com/data-science-in-your-pocket/ornith-1-5-9b-self-improving-llm-for-coding-07a6340922f0), has three stages that feed each other in a loop:

1. **Task generation** — the model proposes new tasks harder than what it has already solved, aimed at its own capability gaps.
2. **Scaffold construction** — for each task it generates or refines a task-specific scaffold: instructions, tools, decomposition strategy, orchestration.
3. **Solution rollout and RL** — conditioned on the task and scaffold, the policy produces a rollout; reward (validity, frontier difficulty around a 20% success rate, novelty against past tasks) is propagated back across all three stages, so a stronger policy generates harder tasks, which produce more informative training signal, which strengthens the policy again.

This is a genuine end-to-end loop (self-play plus RL, not one-off distillation), but it is Ornith AI's internal training pipeline, not something released to run yourself. The [Ornith-1 GitHub repo](https://github.com/ornith-ai/Ornith-1/blob/main/README.md) ships weights, vLLM/SGLang serving recipes, and Chat Completions examples — no task-generation code, no RL loop, no evaluation harness, no fine-tuning script. There is no published tool to reproduce "self-improvement" on our own data in the time we have. Concretely, what we can borrow from the idea (not the tooling) is the shape of stage 3 alone: generate rollouts, keep the ones that pass a verifier, train on those. That is standard rejection-sampled SFT, and it is doable locally; the task-generation and scaffold-refinement stages are not, on this timeline.

## 2. Rules constraints on any of this

From `research/README.md` and `research/SUBMISSION.md` in `../encode-hackathon/`:

- Judges score `pass_rate` (share of tasks where every graded cell matches the golden workbook) via `evaluate.py --predictions ... --all`, on tasks we have not seen.
- `traces/<id>.jsonl` is read for the top teams. **"A trace with the golden value and no reasoning, a prompt containing golden values, or a lookup step is a disqualification."**
- Model id is fixed in code, temperature 0 where the API allows it (per this project's `CLAUDE.md`).
- The 400 verified tasks are the only data with golden workbooks we may legitimately hold (`SpreadsheetBench Verified`, CC-BY-SA-4.0, [dataset](https://huggingface.co/datasets/KAKA22/SpreadsheetBench)). Training a checkpoint on these goldens is not against the letter of the submission rules (goldens never touch a prompt or a trace at inference time), but it means our own 400-task number stops being informative about generalization — judges test on unseen tasks. Any pass-rate gain from training directly on golden target values for these 400 should be treated as noise for our own tracking, and the training data construction must never let a golden value leak into the *inference-time* prompt or *trace* of the model being graded, which rejection-sampled SFT (below) respects: golden workbooks are used offline, only to *label* which already-generated trajectories get kept for training, never inserted into a prompt.
- `tinker_predict.py` (the organizers' baseline) drives a Tinker sampling/training client against a `--base-model` from Tinker's catalog, optionally with a `--model-path tinker://<run>/sampler_weights/final` LoRA checkpoint. Tinker's catalog is Qwen3/Llama3/Kimi-K2-class base checkpoints ([Tinker docs](https://tinker-docs.thinkingmachines.ai/tinker/)); Ornith itself does not appear there, and Tinker does not accept an arbitrary externally-trained checkpoint as a base model for continued fine-tuning — it only lets you resume from a LoRA checkpoint you produced with Tinker on one of its own bases. So Tinker cannot fine-tune Ornith-1.5-9B directly, only a Qwen3 base of similar shape.

## 3. Can we run "Ornith's self-improvement loop" ourselves before 11:00 UTC

No, not the real thing, and it would be the wrong tool even if we could. The loop needs a task generator, a scaffold refiner, an RL trainer, and enough rollout volume to get a low-variance reward signal — that is a training run measured in GPU-days to weeks for the published Ornith models, not hours. None of that code is public. What is feasible on our clock, using the same intuition (verify, then train on what verified), is a single pass of rejection-sampled SFT:

1. Generate trajectories on the 400 tasks with the current tool-loop harness (`agent/`), at higher sampling diversity than temperature 0 (e.g. 2-4 samples per task at temperature 0.6-1.0, matching Ornith's own "precise coding" and general settings) using the working Ornith-35B or DeepSeek solver.
2. Score every trajectory's output workbook against the golden with the existing evaluator (`eval/evaluate.py`) — offline, never inside a prompt.
3. Keep only the *passing* trajectories' full tool-call sequences (the same shape already recorded in `runs/*/traces/<id>.jsonl`: `load_task`, bash edits, `recalc_and_read`, `submit`).
4. Format those trajectories as SFT examples (system prompt + tool calls + tool outputs + final answer) matching Ornith's `qwen3_xml` tool-call format and chat template.
5. LoRA fine-tune Ornith-1.5-9B on that filtered set.
6. Re-serve with vLLM, using the LoRA adapter, and re-run the harness on held-out tasks to see whether the fine-tune generalizes rather than memorizes.

This is the standard "STaR"/rejection-sampling recipe (best-of-N self-distillation), and it is what stage 3 of Ornith's loop does internally — we're just doing one iteration of it, without the task-generation or scaffold stages, and bootstrapped from our harness rather than the model's own scaffolding.

## 4. Concrete plan: LoRA fine-tune of Ornith-1.5-9B, on one H100

**Data we actually have right now**, without any new generation:
- `runs/r03/traces/` and `runs/r08/traces/` (9.1 MB, 489 files each ≈ 400 tasks with multiple trace variants), each a full step-by-step tool-call trajectory against DeepSeek. `runs/r08` passed 342/400 (0.855); those 342 trajectories are immediately usable as positive SFT examples with zero new generation cost.
- The 400 init/golden workbook pairs, for scoring any newly generated trajectories offline.
- `runs/r02-ornith-fails` and `runs/r02-ornith-smoke*` (Ornith-format trajectories, but low pass rate — 0.08 and lower — from early integration bugs per issue #12; check these are post-fix before reusing, most likely discard).

**Step-by-step (target: 3-4 hours wall clock, one H100)**

1. **Build the SFT set (30-45 min, CPU-bound).** From `runs/r08/traces/*.jsonl`, extract the 342 passing task trajectories. Reformat each into a single training example: system + user turn from `agent/instructions.md`/`load_task` output, then the recorded assistant tool-calls and tool-outputs, ending in `submit`. Render through Ornith-1.5-9B's actual chat template (`chat_template.jinja` from the HF repo) so token boundaries match what vLLM will see at inference, and emit tool calls in the `qwen3_xml` format the model expects. This step needs no GPU. 342 examples is thin for full SFT but plausible for LoRA, which needs far less data than full fine-tuning; pad by including 2-3 sampled retries per task (varying which tool calls it took) if time allows, but do not synthesize or paraphrase golden values into the text — only real recorded tool outputs.
2. **(Optional, if time allows) Generate more positives (1-2 hrs).** Re-run the harness against Ornith-1.5-9B itself (not DeepSeek) at temperature 0.6-1.0 with 2 samples per failing task from `runs/r08/failures.md`'s 58 failures, score with `eval/evaluate.py`, keep passes. This is the actual rejection-sampling step and is what would make the fine-tune "self-improvement" in spirit rather than pure distillation from DeepSeek's trajectories. Skip this step if the clock is tight; step 1 alone is a same-model-family distillation dataset that is much cheaper.
3. **LoRA SFT (1-2 hrs on one H100).** Use TRL's `SFTTrainer` or Unsloth against Ornith-1.5-9B (bf16, ~19 GB weights, fits comfortably alongside LoRA and activations on one 80 GB H100 with room to spare — no quantization needed). LoRA rank 16-32 (Tinker's own default is rank 32, per [Tinker's LoRA primer](https://tinker-docs.thinkingmachines.ai/tinker/lora-primer/)), target attention + MLP projection modules, 2-3 epochs over ~350-700 examples, effective batch size 4-8 with gradient accumulation, learning rate ~1e-4 to 2e-4, mask loss on tool-output tokens (train only on assistant turns). At this dataset size (hundreds, not hundreds of thousands, of examples) a run should complete in well under an hour of GPU time on an H100 with Unsloth's throughput gains; the wider window budgeted above is data engineering and validation overhead, not step count. Reference: Unsloth reports full 8B LoRA fine-tunes completing in ~3 hours on a single A100 40GB for ~100K-example datasets ([ComputingForGeeks](https://computingforgeeks.com/fine-tune-llm-unsloth-qlora/)); our dataset is 2-3 orders of magnitude smaller, so wall time should be minutes to low tens of minutes for the optimizer steps themselves, dominated in practice by tokenization/setup and the validation pass.
4. **Serve and validate (30-45 min).** Merge the LoRA adapter into the base weights (safe and simplest for a one-off submission checkpoint) or serve unmerged via vLLM's `--enable-lora --lora-modules` flag (keeps the base model reusable, adds a small runtime flag rather than a new weights directory). Either way, restart the Runcrate vLLM endpoint with the same `qwen3_xml`/`qwen3` parser flags plus the LoRA. Point `agent/lib/solver.ts`'s Ornith path at it (new `ORNITH_MODEL_NAME` or a LoRA-adapter model name, per vLLM's multi-LoRA serving convention) and run the harness on a held-out slice (e.g. tasks *not* in the 342 used for training, ideally the 58 from `runs/r08/failures.md`) to check for genuine generalization versus memorization of the training trajectories' style.
5. **Full run and score (15-20 min at concurrency).** `scripts/predict.ts` against all 400, then `eval/evaluate.py --all` for the submission `results.json`.

Cost: one H100 for roughly half a day including iteration/debugging (Runcrate is already provisioned, so this is opportunity cost against the deadline, not new spend). The most expensive part is verifying the fine-tune did not overfit the specific tool-call phrasing of the 342 DeepSeek trajectories it was trained on — a 9B LoRA on <1K examples can plausibly learn "always call these five tools in this order" as a surface pattern rather than learning to solve new spreadsheet problems, which is exactly the risk rejection-sampled SFT on a small set carries. Given ~11 hours to the deadline total, this plan is a plausible use of 4-6 of those hours but is not a sure thing, and should run in parallel with, not instead of, cheaper harness fixes (below).

## 5. What the failure buckets say a fine-tune can and cannot fix

`runs/r08/failures.md` (58/400 failed, 0.855 pass) and `runs/r03/failures.md` (58/400 failed, 0.855 pass) — same pass rate, mostly overlapping task ids, both dominated by one bucket:

| kind | r08 | r03 |
|---|---|---|
| wrong value | 51 | 46 |
| no submit | 5 | 8 |
| error value in cell | 2 | 3 |
| exception | 0 | 1 |
| timeout | 0 | 0 |

**Wrong value (51-46 of 58, the overwhelming majority) is the bucket a fine-tune could plausibly move, and it is also the bucket issue #13 already targeted with a self-written-verifier harness change.** These are tasks where the model submits a plausible-looking but incorrect formula or VBA-derived value with no error cell to signal failure — sorting, multi-sheet aggregation, INDEX/MATCH with several conditions, date-format parsing, deduplication logic. This is precisely where rejection-sampled SFT on trajectories that *did* get these right (from the 342 passes) could teach better default strategies — but only if the training set has enough diversity of these subtypes, which 342 examples thinly covering 400 varied real-world Excel-forum tasks may not provide. It's also exactly the bucket a cheaper harness change (self-verification before submit, issue #13, already designed and possibly already implemented — check its status) targets directly without touching model weights.

**No submit (5-8 of 58)** is a harness/step-budget problem: the model ran out of tool-call budget or looped without producing a final answer (`agent.ts` currently caps at a `sessionTimeoutMs`/token budget). A fine-tune that makes the model more efficient per step could help marginally, but this is more directly and cheaply fixed by raising the step budget or tightening the instructions to submit-by-budget-N, which the `CLAUDE.md`/issue history already flags as a known trade-off (issue #13 raised the budget from 12 to 15 for the verifier step alone).

**Error value in cell (2-3 of 58)** is almost always an Excel-function-prefix problem (`_xlfn.XLOOKUP` etc., per `research/README.md`'s explicit warning) or a formula referencing a range that shifted after an edit. This is a harness/instructions fix (make sure `agent/instructions.md` reiterates the `_xlfn.` prefix rule and range-shift caution), not something a fine-tune should be relied on for, since it is a narrow, enumerable failure mode.

**Exception (0-1 of 58)** is noise-level, not worth targeting either way.

Bottom line: harness changes address every bucket at near-zero cost and no generalization risk; a fine-tune's plausible upside is concentrated entirely in "wrong value," and the achievable gain there is speculative given the training set size and the risk of overfitting to trajectory phrasing rather than reasoning quality.

## 6. Ranked list: three cheapest actions likely to raise pass rate before 11:00 UTC

1. **Confirm and, if needed, finish the self-written-verifier-before-submit harness change (issue #13).** It targets the exact 51-46 "wrong value" tasks that dominate every run's failures, needs no GPU, no training data, and no new infra — the design and acceptance criteria are already written. If it's already merged (check `agent/instructions.md` for the `verify.py` step) and running, its measured numbers from `runs/r09-verify` (mentioned in the issue) tell you immediately whether this bucket is fixable at all without weights changes, before spending H100 hours on it.
2. **Tighten `agent/instructions.md` for the two mechanical failure modes.** Explicit reminders on the `_xlfn.` prefix requirement for XLOOKUP/UNIQUE/LET/CHOOSECOLS/FILTER (the README already flags this as a common `#NAME?` cause) and on re-checking ranges after row/column inserts. This is a text edit, testable in minutes against the 2-3 "error value in cell" tasks and the subset of "wrong value" tasks that are actually off-by-shifted-range, at zero risk of regressing anything else.
3. **Raise the step/token budget modestly for sheet-level tasks specifically**, which have both a higher failure share (23-24 of 58, versus 275 total cell-level and 125 total sheet-level tasks in the dataset, i.e. sheet-level fails at roughly double the rate of cell-level) and higher median model-call counts in the failure table (many at 10-20+ calls). A small budget increase, or a cheap "if you're within N calls of budget and haven't submitted, prefer submitting your best partial answer over one more exploratory read," is a one-line instructions/agent.ts change with immediate, cheap A/B testability against the existing failing ids.

The rejection-sampled LoRA fine-tune from §4 is worth attempting in parallel on a second track (it does not block or compete with the above), but given ~11 hours remaining, it carries meaningfully more risk (small dataset, chat-template/parser plumbing, serving changes, generalization uncertainty) for an uncertain payoff, against three changes above that are testable within the hour and carry no risk of the disqualification clause on trace/prompt content since they touch only the deterministic instructions and control flow, not training data provenance.

## Sources

- [ornith-ai/Ornith-1.5-35B-A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B)
- [ornith-ai/Ornith-1.5-9B](https://huggingface.co/ornith-ai/Ornith-1.5-9B)
- [ornith-ai/Ornith-1.5-397B](https://huggingface.co/ornith-ai/Ornith-1.5-397B)
- [ornith-ai (org page)](https://huggingface.co/ornith-ai)
- [Ornith-1.5: From Self-Scaffolding to Self-Improvement (Ornith blog)](https://ornith.ai/ornith_1_5.html)
- [Ornith-1 GitHub repo README](https://github.com/ornith-ai/Ornith-1/blob/main/README.md)
- [Ornith-1.5-35B-A3B: A Self-Improving MoE Model for Coding Agents (MindStudio)](https://www.mindstudio.ai/blog/ornith-1-5-moe-model-release)
- [Ornith-1.5-9B: Self Improving LLM for Coding (Medium)](https://medium.com/data-science-in-your-pocket/ornith-1-5-9b-self-improving-llm-for-coding-07a6340922f0)
- [Tinker documentation](https://tinker-docs.thinkingmachines.ai/tinker/)
- [Tinker LoRA primer](https://tinker-docs.thinkingmachines.ai/tinker/lora-primer/)
- [Unsloth QLoRA fine-tuning walkthrough / A100 timing](https://computingforgeeks.com/fine-tune-llm-unsloth-qlora/)
- `research/README.md`, `research/SUBMISSION.md`, `../encode-hackathon/README.md` (hackathon rules)
- `research/baseline/tinker_predict.py` (organizers' Tinker baseline)
- `agent/lib/solver.ts`, `agent/agent.ts` (this repo's model wiring)
- `runs/r08/failures.md`, `runs/r03/failures.md`, `runs/r08/results.json`, `runs/r03/results.json` (this repo's own run data)
- GitHub issues #12, #13 in `Ambit-Labs/hacks-enyl-research`
