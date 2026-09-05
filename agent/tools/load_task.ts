// Loads one SpreadsheetBench task into the sandbox: copies the init
// workbook to /workspace/task/{init,output}.xlsx, writes the instruction to
// /workspace/task/prompt.txt, and hands the model the answer position plus
// a first look at the workbook so it doesn't need a separate dump_workbook.py
// round trip.
//
// This tool runs in the app runtime, not the sandbox: it reads the dataset
// off the host filesystem and only ever copies the *_init.xlsx bytes in.
// It never reads or exposes anything matching *golden*, and never reads any
// dataset field beyond instruction, answer_sheet, answer_position, and
// data_position.

import { readFileSync } from "node:fs";
import { defineTool } from "eve/tools";
import { defineState } from "eve/context";
import { z } from "zod";
import { findInitWorkbook, findTask } from "../lib/dataset";

/** The id of the task currently loaded into this session's sandbox, read by recalc_and_read and submit. */
export const currentTaskId = defineState("enyl.currentTaskId", () => null as string | null);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the environment.`);
  return value;
}

const DUMP_LINE_LIMIT = 200;

export default defineTool({
  description:
    "Load a SpreadsheetBench task by id. Copies its init workbook into the sandbox at " +
    "/workspace/task/init.xlsx and /workspace/task/output.xlsx, writes the instruction to " +
    "/workspace/task/prompt.txt, and returns the instruction, answer sheet, answer position, " +
    "data position, and the first lines of dump_workbook.py's output so a separate dump call " +
    "usually isn't needed.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The task id, e.g. \"13-1\"."),
  }),
  async execute({ id }, ctx) {
    const datasetDir = requireEnv("SB_DATASET_DIR");
    const task = findTask(datasetDir, id);
    const initPath = findInitWorkbook(datasetDir, task);
    const bytes = readFileSync(initPath);

    const sandbox = await ctx.getSandbox();
    await sandbox.writeBinaryFile({ path: "/workspace/task/init.xlsx", content: bytes });
    await sandbox.writeBinaryFile({ path: "/workspace/task/output.xlsx", content: bytes });
    await sandbox.writeTextFile({ path: "/workspace/task/prompt.txt", content: task.instruction });

    currentTaskId.update(() => task.id);

    const dump = await sandbox.run({
      command: "python3 /workspace/tools/dump_workbook.py /workspace/task/init.xlsx",
    });
    const dumpOutput = dump.exitCode === 0 ? dump.stdout : `dump_workbook.py failed: ${dump.stderr}`;
    const dumpLines = dumpOutput.split("\n").slice(0, DUMP_LINE_LIMIT).join("\n");

    return {
      id: task.id,
      instruction: task.instruction,
      answer_sheet: task.answer_sheet,
      answer_position: task.answer_position,
      data_position: task.data_position,
      workbook_dump: dumpLines,
    };
  },
});
