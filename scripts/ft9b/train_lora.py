#!/usr/bin/env python3
"""LoRA SFT of Ornith-1.5-9B on `runs/ft9b/sft.jsonl` (issue #16, phase 2).

Runs on the Runcrate H100, not this workstation (no GPU here). Reads the
tool-call trajectories `build_sft.py` wrote, renders them through the base
model's own chat template (so token boundaries match what vLLM sees at
inference), and trains a LoRA adapter with loss masked to assistant tokens
only.

Base model: ornith-ai/Ornith-1.5-9B (verified via
`curl -s https://huggingface.co/api/models/ornith-ai/Ornith-1.5-9B`:
architecture Qwen3_5ForConditionalGeneration, MIT-licensed, ~19 GB bf16).

Saves the LoRA adapter to /root/ft9b/adapter, then merges it into the base
weights and saves the merged bf16 model to /root/ft9b/merged for vLLM to
serve directly (scripts/ft9b/serve_ft9b.sh).
"""

from __future__ import annotations

import argparse
import inspect
import json
import sys
from pathlib import Path

BASE_MODEL = "ornith-ai/Ornith-1.5-9B"
DEFAULT_DATA = "/root/ft9b/sft.jsonl"
ADAPTER_DIR = "/root/ft9b/adapter"
MERGED_DIR = "/root/ft9b/merged"
MAX_SEQ_LENGTH = 32768
LORA_TARGET_MODULES = [
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default=DEFAULT_DATA)
    parser.add_argument("--base-model", default=BASE_MODEL)
    parser.add_argument("--adapter-dir", default=ADAPTER_DIR)
    parser.add_argument("--merged-dir", default=MERGED_DIR)
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--skip-merge", action="store_true", help="Save the adapter only; skip the merge step.")
    return parser.parse_args()


def count_lines(path: str) -> int:
    with open(path, encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def build_completion_collator(tokenizer):
    """Falls back to response-template masking when the installed TRL has no
    `assistant_only_loss` support (see main() for the primary path)."""
    from trl import DataCollatorForCompletionOnlyLM

    # Ornith uses the Qwen3-family chat template; the assistant turn opens
    # with this marker in every Qwen3-derived template. If the base model's
    # own chat_template.jinja uses a different literal, inspect
    # tokenizer.chat_template and adjust this string before relying on it.
    response_template = "<|im_start|>assistant"
    return DataCollatorForCompletionOnlyLM(response_template=response_template, tokenizer=tokenizer)


def main() -> int:
    args = parse_args()

    total = count_lines(args.data)
    log(
        f"train_lora: {total} training samples from {args.data}, base={args.base_model}, "
        f"epochs={args.epochs}, lr={args.lr}, rank=32 alpha=64 dropout=0.05, "
        f"max_seq_length={MAX_SEQ_LENGTH}, adapter -> {args.adapter_dir}"
    )

    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    import trl

    log(f"trl version: {trl.__version__}")

    attn_impl = "sdpa"
    try:
        import flash_attn  # noqa: F401

        attn_impl = "flash_attention_2"
        log("flash-attn available, using flash_attention_2")
    except ImportError:
        log("flash-attn not installed, falling back to sdpa attention")

    use_liger = False
    try:
        import liger_kernel.transformers  # noqa: F401

        use_liger = True
        log("liger-kernel available, enabling use_liger_kernel")
    except ImportError:
        log("liger-kernel not installed, training without it")

    log(f"loading tokenizer and base model ({args.base_model})")
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        attn_implementation=attn_impl,
    )
    model.config.use_cache = False  # required alongside gradient checkpointing

    log(f"loading dataset from {args.data}")
    dataset = load_dataset("json", data_files=args.data, split="train")

    lora_config = LoraConfig(
        r=32,
        lora_alpha=64,
        lora_dropout=0.05,
        target_modules=LORA_TARGET_MODULES,
        task_type="CAUSAL_LM",
    )

    sft_config_kwargs = dict(
        output_dir=args.adapter_dir,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        gradient_checkpointing=True,
        bf16=True,
        max_length=MAX_SEQ_LENGTH,
        packing=False,
        logging_steps=1,
        save_strategy="epoch",
        report_to=[],
    )
    if use_liger:
        sft_config_kwargs["use_liger_kernel"] = True

    # TRL's assistant-only-loss support has moved around across versions
    # (SFTConfig(assistant_only_loss=...) in newer releases, no such flag in
    # older ones that instead expect a DataCollatorForCompletionOnlyLM).
    # Detect what the installed version actually accepts rather than
    # assuming — the docstring in the issue calls this out explicitly.
    sft_config_params = inspect.signature(SFTConfig.__init__).parameters
    collator = None
    if "assistant_only_loss" in sft_config_params:
        log("SFTConfig supports assistant_only_loss; masking loss to assistant turns via the chat template")
        sft_config_kwargs["assistant_only_loss"] = True
    else:
        log("installed TRL has no SFTConfig.assistant_only_loss; falling back to DataCollatorForCompletionOnlyLM")
        collator = build_completion_collator(tokenizer)

    sft_config = SFTConfig(**sft_config_kwargs)

    trainer_kwargs = dict(
        model=model,
        args=sft_config,
        train_dataset=dataset,
        peft_config=lora_config,
        processing_class=tokenizer,
    )
    if collator is not None:
        trainer_kwargs["data_collator"] = collator

    trainer_params = inspect.signature(SFTTrainer.__init__).parameters
    if "processing_class" not in trainer_params:
        # Older TRL used `tokenizer=` instead of `processing_class=`.
        trainer_kwargs["tokenizer"] = trainer_kwargs.pop("processing_class")

    log("building SFTTrainer")
    trainer = SFTTrainer(**trainer_kwargs)

    log("starting training")
    trainer.train()

    log(f"saving LoRA adapter to {args.adapter_dir}")
    trainer.save_model(args.adapter_dir)
    tokenizer.save_pretrained(args.adapter_dir)

    if args.skip_merge:
        log("--skip-merge set, done")
        return 0

    log(f"merging adapter into base weights, saving bf16 merged model to {args.merged_dir}")
    from peft import PeftModel

    # Reload the base model fresh (the trainer's copy has grad-checkpointing
    # hooks and possibly Liger patches attached) for a clean merge.
    base = AutoModelForCausalLM.from_pretrained(args.base_model, torch_dtype=torch.bfloat16, trust_remote_code=True)
    merged = PeftModel.from_pretrained(base, args.adapter_dir)
    merged = merged.merge_and_unload()
    Path(args.merged_dir).mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(args.merged_dir, safe_serialization=True)
    tokenizer.save_pretrained(args.merged_dir)
    log(f"merged model written to {args.merged_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
