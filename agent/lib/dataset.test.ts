import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Task } from "./dataset";

// A plain "./dataset" specifier satisfies tsc's bundler module resolution
// (which the rest of the app relies on) but Node's own ESM loader needs the
// real ".ts" extension to resolve a relative import. Resolving the URL and
// importing that keeps both happy without relying on a bundler at test time.
const {
  answerRanges,
  columnLettersToNumber,
  expandRange,
  numberToColumnLetters,
  parseAnswerPosition,
  repairRange,
} = await import(fileURLToPath(new URL("./dataset.ts", import.meta.url)));

test("columnLettersToNumber and numberToColumnLetters round-trip", () => {
  assert.equal(columnLettersToNumber("A"), 1);
  assert.equal(columnLettersToNumber("Z"), 26);
  assert.equal(columnLettersToNumber("AA"), 27);
  assert.equal(numberToColumnLetters(1), "A");
  assert.equal(numberToColumnLetters(26), "Z");
  assert.equal(numberToColumnLetters(27), "AA");
});

test("repairRange fixes a truncated end like A3:32", () => {
  assert.equal(repairRange("A3:32"), "A3:A32");
  assert.equal(repairRange("A3:D32"), "A3:D32");
  assert.equal(repairRange("A:G"), "A:G");
  assert.equal(repairRange("A1"), "A1");
});

test("parseAnswerPosition splits a single sheet!range", () => {
  assert.deepEqual(parseAnswerPosition("LISTS!A3:D32"), [{ sheet: "LISTS", range: "A3:D32" }]);
});

test("parseAnswerPosition splits multiple comma-separated sheet!range tokens", () => {
  assert.deepEqual(parseAnswerPosition("'Sheet1'!A1:B2,'Sheet2'!C3:D4"), [
    { sheet: "Sheet1", range: "A1:B2" },
    { sheet: "Sheet2", range: "C3:D4" },
  ]);
});

test("parseAnswerPosition handles a bare range with no sheet", () => {
  assert.deepEqual(parseAnswerPosition("B6:B8"), [{ sheet: null, range: "B6:B8" }]);
});

test("parseAnswerPosition repairs a truncated end within a sheet!range token", () => {
  assert.deepEqual(parseAnswerPosition("Sheet1!A3:32"), [{ sheet: "Sheet1", range: "A3:A32" }]);
});

test("expandRange expands a small rectangular range", () => {
  assert.deepEqual(expandRange("A1:B2"), ["A1", "B1", "A2", "B2"]);
});

test("expandRange expands a single cell", () => {
  assert.deepEqual(expandRange("C5"), ["C5"]);
});

test("expandRange needs maxRow for a whole-column range", () => {
  assert.deepEqual(expandRange("A:B", 3), ["A1", "B1", "A2", "B2", "A3", "B3"]);
});

test("expandRange falls back to minRow when neither the range nor maxRow gives a last row", () => {
  assert.deepEqual(expandRange("A5:B", undefined), ["A5", "B5"]);
});

test("answerRanges falls back to the task's answer_sheet when a range has no sheet prefix", () => {
  const task: Task = {
    id: "13-1",
    instruction: "",
    instruction_type: "",
    answer_sheet: "LISTS",
    answer_position: "A3:D32",
    data_position: "A1:E56",
    spreadsheet_path: "spreadsheet/13-1",
  };
  assert.deepEqual(answerRanges(task), [{ sheet: "LISTS", range: "A3:D32" }]);
});
