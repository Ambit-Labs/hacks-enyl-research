// Recalculates a workbook in the sandbox with LibreOffice (via the seeded
// recalc.py) and reads back the values in the task's answer range, plus any
// cell in that range holding an Excel error value. This is the model's
// self-check before it calls submit.
//
// Runs in the app runtime. The recalculate-and-read routine itself lives in
// ../lib/recalc.ts, shared with submit.ts, so the two can never drift.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { answerRanges, findTask } from "../lib/dataset";
import { recalcAndRead } from "../lib/recalc";
import { currentTaskId } from "./load_task";

const DEFAULT_PATH = "/workspace/task/output.xlsx";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the environment.`);
  return value;
}

export default defineTool({
  description:
    "Recalculate a workbook in the sandbox with LibreOffice, then read back the values in the " +
    "task's answer range and flag any cell in that range holding an Excel error " +
    "(#NAME?, #REF!, #VALUE!, #DIV/0!, and similar). Call this before submit.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe(`Workbook to recalculate. Defaults to ${DEFAULT_PATH}.`),
  }),
  async execute({ path }, ctx) {
    const workbookPath = path ?? DEFAULT_PATH;
    const id = currentTaskId.get();
    if (!id) throw new Error("No task loaded yet. Call load_task first.");

    const task = findTask(requireEnv("SB_DATASET_DIR"), id);
    const ranges = answerRanges(task);

    const sandbox = await ctx.getSandbox();
    const { values, error_cells } = await recalcAndRead(sandbox, workbookPath, ranges);

    return { path: workbookPath, values, error_cells };
  },
});
