import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RecalcSandbox } from "./recalc";

// A plain "./recalc" specifier satisfies tsc's bundler module resolution
// (which the rest of the app relies on) but Node's own ESM loader needs the
// real ".ts" extension to resolve a relative import. Resolving the URL and
// importing that keeps both happy without relying on a bundler at test time.
const { recalcAndRead } = await import(fileURLToPath(new URL("./recalc.ts", import.meta.url)));

/** A fake sandbox that records every run/writeTextFile call and answers with canned recalc.py and reader outputs. */
function fakeSandbox(readerStdout: string): { sandbox: RecalcSandbox; commands: string[] } {
  const commands: string[] = [];
  const sandbox: RecalcSandbox = {
    async run({ command }) {
      commands.push(command);
      if (command.includes("recalc.py")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: readerStdout, stderr: "" };
    },
    async writeTextFile() {},
  };
  return { sandbox, commands };
}

test("recalcAndRead runs recalc.py then the reader, and returns values and error cells", async () => {
  const readerOutput = JSON.stringify({
    values: { "Sheet1!A1": 1, "Sheet1!A2": "#N/A" },
    errors: ["Sheet1!A2"],
  });
  const { sandbox, commands } = fakeSandbox(readerOutput);

  const result = await recalcAndRead(sandbox, "/workspace/task/output.xlsx", [
    { sheet: "Sheet1", range: "A1:A2" },
  ]);

  assert.deepEqual(result, {
    values: { "Sheet1!A1": 1, "Sheet1!A2": "#N/A" },
    error_cells: ["Sheet1!A2"],
  });
  assert.equal(commands.length, 2);
  assert.match(commands[0], /recalc\.py '\/workspace\/task\/output\.xlsx' '\/workspace\/task\/output\.xlsx'/);
  assert.match(commands[1], /\.read_answer\.py '\/workspace\/task\/output\.xlsx' \/workspace\/task\/\.answer_ranges\.json/);
});

test("recalcAndRead returns no error cells when none are present", async () => {
  const readerOutput = JSON.stringify({ values: { "Sheet1!A1": 1 }, errors: [] });
  const { sandbox } = fakeSandbox(readerOutput);

  const result = await recalcAndRead(sandbox, "/workspace/task/output.xlsx", [
    { sheet: "Sheet1", range: "A1" },
  ]);

  assert.deepEqual(result.error_cells, []);
});

test("recalcAndRead throws when recalc.py fails", async () => {
  const sandbox: RecalcSandbox = {
    async run({ command }) {
      if (command.includes("recalc.py")) return { exitCode: 1, stdout: "", stderr: "boom" };
      throw new Error("should not reach the reader");
    },
    async writeTextFile() {},
  };

  await assert.rejects(
    () => recalcAndRead(sandbox, "/workspace/task/output.xlsx", [{ sheet: null, range: "A1" }]),
    /recalc\.py failed/,
  );
});

test("recalcAndRead throws when the reader script fails", async () => {
  const sandbox: RecalcSandbox = {
    async run({ command }) {
      if (command.includes("recalc.py")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "boom" };
    },
    async writeTextFile() {},
  };

  await assert.rejects(
    () => recalcAndRead(sandbox, "/workspace/task/output.xlsx", [{ sheet: null, range: "A1" }]),
    /Reading the answer range from .* failed/,
  );
});
