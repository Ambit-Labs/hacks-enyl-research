// Shared recalculate-and-read routine for `recalc_and_read` and `submit`, so
// the two tools can never drift: `submit` must see exactly what
// `recalc_and_read` sees before it writes the output file.
//
// Runs in the app runtime. The only thing that executes in the sandbox is
// the seeded recalc.py and a small, fixed reader script this module writes
// itself (its content never depends on model input).

import type { SheetRange } from "./dataset";

const RANGES_PATH = "/workspace/task/.answer_ranges.json";
const READER_PATH = "/workspace/task/.read_answer.py";

/** The subset of the sandbox handle this module needs, kept structural so callers don't have to import eve's sandbox type. */
export interface RecalcSandbox {
  run(args: { command: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeTextFile(args: { path: string; content: string }): Promise<void>;
}

export interface RecalcResult {
  values: Record<string, unknown>;
  error_cells: string[];
}

/** Single-quotes a value for a POSIX shell, escaping any embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Fixed content: reads the recalculated workbook and, for each answer range,
// reports every cell's value plus whether it holds an Excel error. A
// whole-column range (e.g. "A:G") falls back to the sheet's own max_row,
// mirroring expand_range in agent/lib/dataset.ts and eval/sb.py.
const READER_SCRIPT = `import json, sys
from datetime import date, datetime, time
from decimal import Decimal
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import range_boundaries

ERROR_VALUES = {"#NAME?", "#REF!", "#VALUE!", "#DIV/0!", "#N/A", "#NULL!", "#NUM!"}

def to_json_safe(value):
    # Cell values can carry types json.dumps does not know: dates and
    # datetimes become ISO 8601 strings, Decimal becomes float, and
    # anything else falls back to its string form.
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return str(value)

path, ranges_path = sys.argv[1], sys.argv[2]
ranges = json.loads(open(ranges_path, encoding="utf-8").read())
wb = load_workbook(path, data_only=True)

values = {}
errors = []
for item in ranges:
    # "sheet" can be missing or null: the task's dataset row itself may have
    # no answer_sheet, in which case eval/sb.py falls back to the workbook's
    # active sheet, mirrored here.
    sheet, rng = item.get("sheet"), item["range"]
    ws = wb[sheet] if sheet in wb.sheetnames else wb.active
    min_col, min_row, max_col, max_row = range_boundaries(rng)
    min_row = min_row or 1
    max_row = max_row or ws.max_row
    for r in range(min_row, max_row + 1):
        for c in range(min_col, max_col + 1):
            coord = f"{get_column_letter(c)}{r}"
            value = ws[coord].value
            key = f"{ws.title}!{coord}"
            values[key] = value
            if isinstance(value, str) and value in ERROR_VALUES:
                errors.append(key)

print(json.dumps({"values": values, "errors": errors}, default=to_json_safe))
`;

/**
 * Recalculates `workbookPath` in the sandbox with LibreOffice, then reads
 * back the values in `ranges` plus which of those cells hold an Excel error.
 */
export async function recalcAndRead(
  sandbox: RecalcSandbox,
  workbookPath: string,
  ranges: SheetRange[],
): Promise<RecalcResult> {
  const quotedPath = shellQuote(workbookPath);

  const recalc = await sandbox.run({
    command: `python3 /workspace/tools/recalc.py ${quotedPath} ${quotedPath}`,
  });
  if (recalc.exitCode !== 0) {
    throw new Error(`recalc.py failed on ${workbookPath}: ${recalc.stderr || recalc.stdout}`);
  }

  await sandbox.writeTextFile({ path: RANGES_PATH, content: JSON.stringify(ranges) });
  await sandbox.writeTextFile({ path: READER_PATH, content: READER_SCRIPT });

  const read = await sandbox.run({
    command: `python3 ${READER_PATH} ${quotedPath} ${RANGES_PATH}`,
  });
  if (read.exitCode !== 0) {
    throw new Error(`Reading the answer range from ${workbookPath} failed: ${read.stderr || read.stdout}`);
  }

  const parsed = JSON.parse(read.stdout) as { values: Record<string, unknown>; errors: string[] };
  return { values: parsed.values, error_cells: parsed.errors };
}
