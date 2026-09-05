// Dataset loading and answer-range math shared by the bridge tools.
//
// parseAnswerPosition, repairRange, and expandRange are direct ports of
// parse_answer_position, _repair_range, and expand_range in eval/sb.py.
// Keep them byte-for-byte equivalent to the evaluator's Python so a task's
// answer range means the same thing on both sides of the grader.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Task {
  id: string;
  instruction: string;
  instruction_type: string;
  // Some dataset rows omit this field entirely (see eval/sb.py's
  // `task.get("answer_sheet")`), so it is not always present.
  answer_sheet?: string | null;
  answer_position: string;
  data_position: string;
  spreadsheet_path: string;
}

export interface SheetRange {
  sheet: string | null;
  range: string;
}

/** Loads dataset.json and normalizes every task's id to a string. */
export function loadDataset(datasetDir: string): Task[] {
  const raw = readFileSync(join(datasetDir, "dataset.json"), "utf-8");
  const tasks = JSON.parse(raw) as Task[];
  return tasks.map((t) => ({ ...t, id: String(t.id) }));
}

/** Finds a task by id, or throws a message safe to show the model. */
export function findTask(datasetDir: string, id: string): Task {
  const task = loadDataset(datasetDir).find((t) => t.id === id);
  if (!task) {
    throw new Error(`No task with id ${JSON.stringify(id)} in the dataset.`);
  }
  return task;
}

/**
 * Finds the task's init workbook on the host. Refuses any filename
 * containing "golden" and requires the match to actually be an *_init.xlsx
 * file, never a stray match on another naming pattern.
 */
export function findInitWorkbook(datasetDir: string, task: Task): string {
  const folder = join(datasetDir, task.spreadsheet_path);
  const entries = readdirSync(folder);
  const initFile = entries.find((name) => /init.*\.xlsx$/i.test(name) && !/golden/i.test(name));
  if (!initFile) {
    throw new Error(`No *_init.xlsx workbook found for task ${task.id} in ${folder}.`);
  }
  if (/golden/i.test(initFile)) {
    throw new Error(`Refusing to load ${initFile}: filename matches *golden*.`);
  }
  return join(folder, initFile);
}

/** Column letters ("A", "AA") to a 1-based column number. */
export function columnLettersToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

/** 1-based column number to column letters ("A", "AA"). */
export function numberToColumnLetters(n: number): string {
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

interface CellRef {
  col: number | null;
  row: number | null;
}

function parseCellRef(token: string): CellRef {
  const cleaned = token.replace(/\$/g, "");
  const match = cleaned.match(/^([A-Za-z]+)?([0-9]+)?$/);
  if (!match) throw new Error(`unrecognized cell reference: ${token}`);
  const [, colLetters, rowDigits] = match;
  return {
    col: colLetters ? columnLettersToNumber(colLetters) : null,
    row: rowDigits ? parseInt(rowDigits, 10) : null,
  };
}

interface RangeBoundaries {
  minCol: number;
  minRow: number | null;
  maxCol: number;
  maxRow: number | null;
}

/** Port of openpyxl's range_boundaries for the shapes SpreadsheetBench uses. */
function rangeBoundaries(cellRange: string): RangeBoundaries {
  if (cellRange.includes(":")) {
    const [left, right] = cellRange.split(":", 2);
    const a = parseCellRef(left);
    const b = parseCellRef(right);
    const cols = [a.col, b.col].filter((c): c is number => c !== null);
    const rows = [a.row, b.row].filter((r): r is number => r !== null);
    if (cols.length === 0) throw new Error(`unrecognized range: ${cellRange}`);
    return {
      minCol: Math.min(...cols),
      maxCol: Math.max(...cols),
      minRow: rows.length ? Math.min(...rows) : null,
      maxRow: rows.length ? Math.max(...rows) : null,
    };
  }
  const p = parseCellRef(cellRange);
  if (p.col === null) throw new Error(`unrecognized cell reference: ${cellRange}`);
  return { minCol: p.col, maxCol: p.col, minRow: p.row, maxRow: p.row };
}

/** Port of eval/sb.py's _repair_range: fixes a truncated end like "A3:32" -> "A3:A32". */
export function repairRange(rng: string): string {
  if (!rng.includes(":")) return rng;
  const [start, end] = rng.split(":", 2);
  if (/^[0-9]+$/.test(end)) {
    const col = [...start].filter((ch) => /[A-Za-z]/.test(ch)).join("");
    return `${start}:${col}${end}`;
  }
  return rng;
}

/** Port of eval/sb.py's parse_answer_position. */
export function parseAnswerPosition(answerPosition: string): SheetRange[] {
  const cleaned = answerPosition.replace(/'/g, "").replace(/"/g, "");
  const bangCount = (cleaned.match(/!/g) ?? []).length;
  const tokens = bangCount === 1 ? [cleaned] : cleaned.split(",");
  return tokens.map((rawToken) => {
    const token = rawToken.trim();
    const bangIndex = token.lastIndexOf("!");
    if (bangIndex !== -1) {
      const sheet = token.slice(0, bangIndex);
      const rng = token.slice(bangIndex + 1);
      return { sheet, range: repairRange(rng) };
    }
    return { sheet: null, range: repairRange(token) };
  });
}

/**
 * Port of eval/sb.py's expand_range: expands "A1:B3" to cell coordinates.
 * A whole-column range like "A:G" needs maxRow (the sheet's last row).
 */
export function expandRange(cellRange: string, maxRow?: number): string[] {
  const b = rangeBoundaries(cellRange);
  const minRow = b.minRow ?? 1;
  const lastRow = b.maxRow ?? maxRow ?? minRow;
  const coords: string[] = [];
  for (let r = minRow; r <= lastRow; r++) {
    for (let c = b.minCol; c <= b.maxCol; c++) {
      coords.push(`${numberToColumnLetters(c)}${r}`);
    }
  }
  return coords;
}

/**
 * Port of eval/sb.py's answer_ranges: resolves each range's sheet against the
 * task default. `answer_sheet` can itself be missing from the dataset row
 * (eval/sb.py falls back to `wb.active` in that case), so this always
 * settles on `null` rather than `undefined`. A plain object literal would
 * silently drop an `undefined` "sheet" key when JSON.stringify'd, and the
 * sandboxed reader indexes that key directly.
 */
export function answerRanges(task: Task): SheetRange[] {
  return parseAnswerPosition(task.answer_position).map(({ sheet, range }) => ({
    sheet: sheet ?? task.answer_sheet ?? null,
    range,
  }));
}
