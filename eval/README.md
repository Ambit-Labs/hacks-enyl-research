# eval

`evaluate.py` and `sb.py`, vendored unchanged from `encode-hackathon/research/`, so judges can score a clone of this repo without the sibling hackathon repo. `pyproject.toml` and `uv.lock` pin the same dependency set.

## Score a run

This directory carries its own `pyproject.toml` and `uv.lock`, separate from the repo root's Node project. Run from inside `eval/`, or pass `--project eval` from the repo root.

```sh
cd eval && uv run evaluate.py --predictions <predictions.jsonl> --dataset-dir $SB_DATASET_DIR --all --out results.json
```

`--oracle` scores golden against golden (must print `pass_rate: 1.0`) and is how you check the grader itself:

```sh
cd eval && uv run evaluate.py --oracle --dataset-dir $SB_DATASET_DIR
# or, from the repo root:
uv run --project eval eval/evaluate.py --oracle --dataset-dir $SB_DATASET_DIR
```

`$SB_DATASET_DIR` is set in `.env.local`; see `.env.example` for the variable name.
