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
    parser.add_argument("--max-steps", type=int, default=-1, help="Override for a smoke test; -1 uses --epochs.")
    return parser.parse_args()


def count_lines(path: str) -> int:
    with open(path, encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


class AssistantOnlyCollator:
    """Masks loss to assistant-turn tokens only, for chat templates with no
    `{% generation %}` tags (see the long comment in main()).

    TRL dropped `DataCollatorForCompletionOnlyLM` in the 1.x line (checked on
    the box: `from trl import DataCollatorForCompletionOnlyLM` raises
    ImportError against trl==1.12.0) in favor of `assistant_only_loss`, which
    itself needs template support Ornith's chat template doesn't have. This
    reimplements the same idea directly on token ids: every assistant turn
    in the rendered text opens with `<|im_start|>assistant` and closes at the
    next `<|im_start|>` (any role) or end of sequence — label everything in
    between, mask everything else.
    """

    def __init__(self, tokenizer, response_marker: str = "<|im_start|>assistant", turn_marker: str = "<|im_start|>"):
        self.tokenizer = tokenizer
        self.response_ids = tokenizer.encode(response_marker, add_special_tokens=False)
        self.turn_ids = tokenizer.encode(turn_marker, add_special_tokens=False)
        self.pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else tokenizer.eos_token_id

    @staticmethod
    def _find_all(seq: list[int], sub: list[int]) -> list[int]:
        n, m = len(seq), len(sub)
        return [i for i in range(n - m + 1) if seq[i : i + m] == sub]

    def __call__(self, examples: list[dict]):
        import torch

        max_len = max(len(e["input_ids"]) for e in examples)
        input_ids = torch.full((len(examples), max_len), self.pad_id, dtype=torch.long)
        attention_mask = torch.zeros((len(examples), max_len), dtype=torch.long)
        labels = torch.full((len(examples), max_len), -100, dtype=torch.long)

        for i, example in enumerate(examples):
            ids = example["input_ids"]
            length = len(ids)
            input_ids[i, :length] = torch.tensor(ids, dtype=torch.long)
            attention_mask[i, :length] = 1

            response_starts = self._find_all(ids, self.response_ids)
            turn_starts = self._find_all(ids, self.turn_ids)
            for start in response_starts:
                segment_start = start + len(self.response_ids)
                later_turns = [t for t in turn_starts if t >= segment_start]
                segment_end = later_turns[0] if later_turns else length
                labels[i, segment_start:segment_end] = torch.tensor(ids[segment_start:segment_end], dtype=torch.long)

        return {"input_ids": input_ids, "attention_mask": attention_mask, "labels": labels}


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
    raw_dataset = load_dataset("json", data_files=args.data, split="train")

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
    if args.max_steps > 0:
        sft_config_kwargs["max_steps"] = args.max_steps
        sft_config_kwargs["save_strategy"] = "no"
    if use_liger:
        sft_config_kwargs["use_liger_kernel"] = True

    # TRL's assistant-only-loss support has moved around across versions
    # (SFTConfig(assistant_only_loss=...) in newer releases, no such flag in
    # older ones that instead expect a DataCollatorForCompletionOnlyLM). But
    # having the flag is not sufficient: it works by asking the tokenizer's
    # chat template for a `return_assistant_tokens_mask`, which only means
    # anything if the template has `{% generation %}...{% endgeneration %}`
    # markers around assistant content. Checked directly against Ornith's
    # template on the box: `assistant_only_loss` exists on this TRL, but the
    # template has no such tags, so the mask comes back all zero (silently
    # training on nothing) — confirmed via
    # `tokenizer.apply_chat_template(..., return_assistant_tokens_mask=True)`
    # printing "chat template does not contain `{% generation %}` keyword".
    # So probe the actual rendered mask rather than trusting the flag's mere
    # presence, and fall back to DataCollatorForCompletionOnlyLM whenever it
    # would be a no-op.
    sft_config_params = inspect.signature(SFTConfig.__init__).parameters
    assistant_mask_works = False
    if "assistant_only_loss" in sft_config_params:
        probe_messages = raw_dataset[0]["messages"]
        probe_tools = raw_dataset[0].get("tools")
        try:
            probe = tokenizer.apply_chat_template(
                probe_messages, tools=probe_tools, tokenize=True, return_assistant_tokens_mask=True, return_dict=True
            )
            assistant_mask_works = bool(probe.get("assistant_masks")) and sum(probe["assistant_masks"]) > 0
        except Exception as exc:  # noqa: BLE001 - any failure here just means "unsupported"
            log(f"assistant-mask probe raised {exc!r}, treating as unsupported")

    if assistant_mask_works:
        log("SFTConfig.assistant_only_loss works on this chat template (probed a nonzero mask); using it")
        sft_config_kwargs["assistant_only_loss"] = True
        dataset = raw_dataset
        collator = None
    else:
        log(
            "assistant_only_loss unavailable, or the chat template has no {% generation %} tags "
            "(probed mask was all-zero) — rendering each sample through the chat template ourselves "
            "and masking loss with AssistantOnlyCollator (trl.DataCollatorForCompletionOnlyLM was "
            "removed in the installed TRL 1.x line)"
        )

        def render_and_tokenize(example: dict) -> dict:
            text = tokenizer.apply_chat_template(
                example["messages"], tools=example.get("tools"), tokenize=False, add_generation_prompt=False
            )
            input_ids = tokenizer(text, truncation=True, max_length=MAX_SEQ_LENGTH, add_special_tokens=False)[
                "input_ids"
            ]
            return {"input_ids": input_ids}

        dataset = raw_dataset.map(
            render_and_tokenize,
            remove_columns=raw_dataset.column_names,
            desc="rendering chat template and tokenizing",
        )
        collator = AssistantOnlyCollator(tokenizer)

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
