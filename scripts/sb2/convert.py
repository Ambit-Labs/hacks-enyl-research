#!/usr/bin/env python3
"""Converts SpreadsheetBench 2 (KAKA22/SpreadsheetBench-v2) into our dataset
layout so eval/sb.py and scripts/predict.ts can read it unchanged.

Source: https://huggingface.co/datasets/KAKA22/SpreadsheetBench-v2
  spreadsheetbench-v2.zip, category folders Financial_Model / Template /
  Debugging / Visualization, each with a dataset.json plus a spreadsheet/
  tree. Fields differ from our dataset.json: spreadsheet_path points at the
  input .xlsx file directly (not a folder), golden lives in a separate
  golden_response_path field, and there is no instruction_type or
  data_position.

Visualization is skipped: its tasks are graded with a VLM chart-quality
checklist, not cell values against a golden workbook, so they cannot be
scored by eval/sb.py at all.

Output layout matches research/data/spreadsheetbench_verified_400:
  dataset.json
  spreadsheet/<id>/1_<id>_init.xlsx
  spreadsheet/<id>/1_<id>_golden.xlsx
  spreadsheet/<id>/prompt.txt

Run:
  uv run --project ../encode-hackathon/research scripts/sb2/convert.py \
      --source <extracted spreadsheetbench-v2 dir> --out <output dir>
"""

import argparse
import json
import shutil
from pathlib import Path

CATEGORIES = ["Financial_Model", "Template", "Debugging"]  # Visualization excluded, see module docstring
PREFIX = {"Financial_Model": "fm", "Template": "tpl", "Debugging": "dbg"}


def convert(source: Path, out: Path) -> list[dict]:
    out_spreadsheet = out / "spreadsheet"
    out_spreadsheet.mkdir(parents=True, exist_ok=True)
    rows = []
    for category in CATEGORIES:
        cat_dir = source / category
        tasks = json.loads((cat_dir / "dataset.json").read_text())
        for task in tasks:
            src_id = str(task["id"])
            new_id = f"{PREFIX[category]}-{src_id}"
            init_src = cat_dir / task["spreadsheet_path"]
            golden_src = cat_dir / task["golden_response_path"]
            if not init_src.exists() or not golden_src.exists():
                print(f"skip {new_id}: missing input or golden file")
                continue

            task_dir = out_spreadsheet / new_id
            task_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(init_src, task_dir / f"1_{new_id}_init.xlsx")
            shutil.copyfile(golden_src, task_dir / f"1_{new_id}_golden.xlsx")
            (task_dir / "prompt.txt").write_text(task["instruction"])

            rows.append({
                "id": new_id,
                "instruction": task["instruction"],
                "spreadsheet_path": f"spreadsheet/{new_id}",
                "instruction_type": category,
                "answer_position": task["answer_position"],
                "answer_sheet": None,
                # SB2 has no data_position field. answer_position is always
                # sheet-qualified, so eval/sb.py's grading never needs this;
                # it stands in only for load_task.ts's prompt to the model.
                "data_position": task["answer_position"],
                "source_id": src_id,
            })
    (out / "dataset.json").write_text(json.dumps(rows, indent=2))
    return rows


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True, help="extracted spreadsheetbench-v2 dir (with Financial_Model/, Template/, Debugging/, Visualization/)")
    p.add_argument("--out", required=True, help="output dataset dir in our layout")
    args = p.parse_args()

    source = Path(args.source)
    out = Path(args.out)
    rows = convert(source, out)
    by_category: dict[str, int] = {}
    for row in rows:
        by_category[row["instruction_type"]] = by_category.get(row["instruction_type"], 0) + 1
    print(f"converted {len(rows)} tasks into {out}")
    for category, count in sorted(by_category.items()):
        print(f"  {category}: {count}")


if __name__ == "__main__":
    main()
