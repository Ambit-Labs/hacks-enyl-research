# SpreadsheetBench 2 as a held-out evaluation set

## What it is

"SpreadsheetBench 2" is not a v2 split of our 400-task dataset. It is a
separate, harder benchmark from the same lab (RUCKBReasoning / KAKA22):
end-to-end business spreadsheet workflows, rather than the single-cell or
single-range edits in the original SpreadsheetBench.

- Paper: [SpreadsheetBench 2: Evaluating Agents on End-to-End Business
  Spreadsheet Workflows](https://arxiv.org/abs/2606.29955) (arXiv 2606.29955)
- Code: [RUCKBReasoning/SpreadsheetBench-2](https://github.com/RUCKBReasoning/SpreadsheetBench-2)
- Data: [KAKA22/SpreadsheetBench-v2](https://huggingface.co/datasets/KAKA22/SpreadsheetBench-v2)
  on Hugging Face, license MIT
- 321 tasks total, four categories: Debugging (100), Financial_Model (100),
  Template (97), Visualization (24). Best model in the paper scores 34.89%
  overall task accuracy; debugging alone is 12.00%. Tasks average 11.8
  worksheets and 593.5 cell modifications per instance, so this is
  meaningfully harder than the 400-task set.

Original SpreadsheetBench (912 questions, the source of our 400-task
verified subset) is unrelated to this release beyond sharing an author.

## Download

Archive kept at
`/home/ubuntu/projects/hacks/encode-ylookup/encode-hackathon/research/data/spreadsheetbench2/spreadsheetbench-v2.zip`
(134 MB), downloaded from:

```
https://huggingface.co/datasets/KAKA22/SpreadsheetBench-v2/resolve/main/spreadsheetbench-v2.zip?download=true
```

Extracted to `spreadsheetbench2/extracted/spreadsheetbench-v2/`, one folder
per category (`Debugging/`, `Financial_Model/`, `Template/`,
`Visualization/`), each with its own `dataset.json` and `spreadsheet/` tree.

## Format differences from our layout, and why Visualization is out

SB2's `dataset.json` rows use different fields than ours:
`spreadsheet_path` points straight at the input `.xlsx` file (not a task
folder), the golden file is a separate `golden_response_path` field, there
is no `instruction_type` or `data_position`, and `answer_position` is always
fully sheet-qualified (no bare `answer_sheet` fallback needed).

Visualization tasks are graded by a VLM chart-quality checklist
(`criteria` field, GLM-4.6V judge), not cell values against a golden
workbook. `eval/sb.py` has no way to score that, so the 24 Visualization
tasks are excluded entirely. Debugging, Financial_Model, and Template
(100 + 100 + 97 = 297 tasks) all grade the same way our 400-task set does:
graded cells on `answer_sheet`/`answer_position` compared, cell by cell,
against a golden workbook.

## Conversion

`scripts/sb2/convert.py` reads the three compatible categories and writes
our layout:

```
spreadsheetbench2/converted/
  dataset.json
  spreadsheet/<id>/1_<id>_init.xlsx
  spreadsheet/<id>/1_<id>_golden.xlsx
  spreadsheet/<id>/prompt.txt
```

Ids are prefixed by category to keep them unique and traceable back to the
source: `fm-<id>` (Financial_Model), `tpl-<id>` (Template), `dbg-<id>`
(Debugging). Each converted row also keeps `source_id`, the original SB2 id,
and sets `instruction_type` to the category name. `answer_sheet` is left
null (unused, since every range in `answer_position` already carries its own
sheet) and `data_position` is set equal to `answer_position` as a
best-effort stand-in. SB2 has no such field, and it is informational only
(only `load_task.ts`'s prompt to the model reads it; grading never does).

Run it:

```sh
python3 scripts/sb2/convert.py \
  --source .../encode-hackathon/research/data/spreadsheetbench2/extracted/spreadsheetbench-v2 \
  --out .../encode-hackathon/research/data/spreadsheetbench2/converted
```

Output: `converted 297 tasks`, Debugging 100, Financial_Model 100,
Template 97.

## Overlap with our 400-task set

Zero. Compared both by id and by SB2's original `source_id`; no
intersection with the 400 ids in
`.../spreadsheetbench_verified_400/dataset.json`. The id schemes don't
even collide by construction (`13-1` style vs `fm-01_01` style), and the
task content is drawn from a different, later release.

All 297 converted ids are therefore safe to use as a held-out set. The full
list is at `runs/sb2/ids-heldout.txt` in this repo.

## Oracle check

```sh
cd eval
uv run --project . evaluate.py --oracle \
  --dataset-dir .../encode-hackathon/research/data/spreadsheetbench2/converted \
  --out .../enyl-research/runs/sb2/oracle-results.json
```

Result (golden scored against itself):

```json
{
  "items": 297,
  "graded": 282,
  "missing": 0,
  "errors": 15,
  "pass_rate": 0.9495,
  "cell_accuracy": 1.0,
  "pass_rate_cell_level": null,
  "pass_rate_sheet_level": null
}
```

`cell_accuracy` is 1.0 for every task the evaluator could grade: the
converted golden files score perfectly against themselves, same as the
400-task set's oracle run. `pass_rate` is 0.9495, not 1.0, because of a
pre-existing parser limitation, not a data or conversion problem; see below.

### Known limitation: 15 tasks fail on comma-containing sheet names

`parse_answer_position` in `eval/sb.py` (and its byte-for-byte TypeScript
port in `agent/lib/dataset.ts`) splits `answer_position` on `,` to separate
per-sheet ranges, e.g. `'Sheet A'!A1:B2,'Sheet B'!C1:D2`. Two SB2 financial
workbooks have sheet names that themselves contain a comma,
`'Debt, Interest and Finance Cost'` and `'PP&E, Debt, NWC'`, which the
naive split breaks apart mid-name. This throws `... is not a valid
coordinate or range` for every task built on those two workbooks:

- `fm-14_01` through `fm-14_05` (5 tasks, the `Debt, Interest and Finance
  Cost` sheet)
- `dbg-04_01` through `dbg-04_10` (10 tasks, the `PP&E, Debt, NWC` sheet)

The 400-task set apparently never hits this edge case, so it's gone
unnoticed there. It is a real limitation of the vendored evaluator/dataset
code, not something specific to this conversion; fixing it means teaching
`parse_answer_position` to respect quoted sheet names when splitting on
commas, which touches `eval/sb.py` (vendored, not owned by this repo) and
its TS port in `agent/lib/dataset.ts` (out of scope for this task). Until
fixed, exclude those 15 ids when scoring predict runs on this set, or expect
them to always error rather than reflect real model performance.

## Running predict on this set

```sh
npm run predict -- \
  --dataset-dir .../encode-hackathon/research/data/spreadsheetbench2/converted \
  --out-dir runs/sb2-<model> \
  --ids "$(paste -sd, runs/sb2/ids-heldout.txt)"
```

Drop `--ids` to run all 297, or filter out the 15 known-broken ids listed
above first. Score the same way as the 400-task set:

```sh
cd eval
uv run --project . evaluate.py \
  --predictions ../runs/sb2-<model>/predictions.jsonl \
  --dataset-dir .../encode-hackathon/research/data/spreadsheetbench2/converted \
  --all
```

Predict was not run as part of this research task.
