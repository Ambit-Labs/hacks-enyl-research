# Ornith-1.5-9B LoRA fine-tune (issue #16)

Rejection-sampled SFT on the r08 trajectories: train on the 342 tasks that
already passed with DeepSeek, hold out the 58 that failed plus a random 60
passes for honest evaluation. See `docs/research/ornith-self-improvement.md`
for the full plan and the reasoning behind this design.

## Phase 1: build the dataset (this workstation, no GPU, ~1 minute)

```sh
python3 scripts/ft9b/build_sft.py
```

Reads `runs/r08/results.json` and `runs/r08/traces/*.jsonl`. Writes:

- `runs/ft9b/ids-train.txt` (282 ids, trained on)
- `runs/ft9b/ids-holdout-pass.txt` (60 ids, seed 20260906, never trained on)
- `runs/ft9b/ids-holdout-fail.txt` (58 ids, r08's own failures, never trained on)
- `runs/ft9b/sft.jsonl` (282 chat-format samples, one per line: `{"messages": [...], "tools": [...]}`)

Prints sample counts, a token estimate, and the longest sample on stderr. No
GPU or model download needed for this step; it only reads JSON already on
disk.

## Phase 2: train and serve (Runcrate H100, only after "box free: \<name\>")

```sh
export RUNCRATE_PROJECT_ID=29550a54-cba3-4938-8b0b-b5e30156abc1

# copy the dataset and scripts over
rc cp runs/ft9b/sft.jsonl <name>:/root/ft9b/sft.jsonl
rc cp scripts/ft9b/train_lora.py <name>:/root/ft9b/train_lora.py
rc cp scripts/ft9b/serve_ft9b.sh <name>:/root/ft9b/serve_ft9b.sh

# install deps in a venv, then train (foreground poll under nohup, per AGENTS.md)
rc ssh <name> -- 'python3 -m venv /root/venv && /root/venv/bin/pip install -U torch transformers trl peft datasets accelerate'
rc ssh <name> -- 'cd /root/ft9b && nohup /root/venv/bin/python train_lora.py > train.log 2>&1 &'
# then poll train.log in a foreground until-loop until it prints "merged model written to"

# serve
rc ssh <name> -- 'bash /root/ft9b/serve_ft9b.sh'
```

`train_lora.py` trains a rank-32 LoRA (alpha 64, dropout 0.05, all linear
projections) on `ornith-ai/Ornith-1.5-9B` in bf16, 2 epochs, lr 1e-4 cosine,
effective batch 8 (1 x grad-accum 8), max sequence length 32768 with packing
off, gradient checkpointing on, Liger or flash-attn if installed. It masks
loss to assistant tokens only, preferring TRL's `SFTConfig(assistant_only_loss=True)`
where the installed TRL version supports it and falling back to
`DataCollatorForCompletionOnlyLM` otherwise (check `trl.__version__` printed
at startup against what the flag needs before trusting it blindly). Saves
the adapter to `/root/ft9b/adapter`, merges to `/root/ft9b/merged` in bf16.

`serve_ft9b.sh` starts vLLM on the merged model, port 8001, served as
`Ornith-9B-ft`, with the same `--tool-call-parser qwen3_xml
--reasoning-parser qwen3` flags `scripts/runcrate/serve_ornith.sh` uses for
the 35B (same model family). Waits for `/v1/models` before returning.

### Expected durations

- Training: minutes to low tens of minutes of optimizer time on one H100
  (282 examples is small); tokenization, dataset loading, and the merge step
  dominate wall clock, likely 20-40 minutes end to end.
- Serving: vLLM's first boot JIT-compiles kernels, typically a few minutes
  for a 9B model.

## Honest-eval protocol

Never run `scripts/predict.ts` against the fine-tuned endpoint on the 282
training ids — that number would be memorization, not generalization. Only
`runs/ft9b/ids-holdout-pass.txt` and `runs/ft9b/ids-holdout-fail.txt` (118
ids total) tell you whether the fine-tune generalizes: holdout-pass tests
whether it still gets right what it already got right without training on
those specific trajectories, holdout-fail tests whether it fixes any of the
58 the base model missed. Report both numbers separately; do not average
them into one "held-out pass rate" without saying which bucket moved.

## Endpoint handoff

After `serve_ft9b.sh` reports ready, write its base URL and key to
`runs/boxes/ft9b.env` (mode 0600) as `FT9B_BASE_URL=` / `FT9B_API_KEY=`, and
report the file's path to the coordinator without printing its contents —
the coordinator runs the held-out evaluation from there.
