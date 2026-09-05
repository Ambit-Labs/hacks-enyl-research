#!/usr/bin/env python3
"""Replaces the scores block in SUBMISSION.md with the summary from a
results.json, between <!-- scores:start --> and <!-- scores:end --> markers.
Idempotent: a second run replaces the block instead of appending another
one. If SUBMISSION.md still has the original placeholder comment instead of
the markers, that placeholder is upgraded to the marker pair in place.

Usage: finalize_scores.py <results.json> <SUBMISSION.md>
Called by scripts/finalize.sh; not meant to be run standalone.
"""
import json
import sys

START = "<!-- scores:start -->"
END = "<!-- scores:end -->"
OLD_PLACEHOLDER = "<!-- paste runs/final/results.json summary here -->"


def block(summary: dict) -> str:
    return f"{START}\n```json\n{json.dumps(summary, indent=2)}\n```\n{END}"


def main() -> None:
    results_path, submission_path = sys.argv[1], sys.argv[2]
    summary = json.load(open(results_path))["summary"]
    text = open(submission_path).read()
    new_block = block(summary)

    if START in text and END in text:
        start_i = text.index(START)
        end_i = text.index(END) + len(END)
        text = text[:start_i] + new_block + text[end_i:]
    elif OLD_PLACEHOLDER in text:
        text = text.replace(OLD_PLACEHOLDER, new_block)
    else:
        raise SystemExit(
            f"finalize_scores.py: no scores markers or placeholder found in {submission_path}"
        )

    open(submission_path, "w").write(text)


if __name__ == "__main__":
    main()
