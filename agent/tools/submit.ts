// Submits the model's finished workbook: validates it loads with openpyxl
// inside the sandbox, then copies its bytes out to
// $SB_OUT_DIR/outputs/<id>.xlsx on the host.
//
// Runs in the app runtime. The current task id comes from the enyl.currentTaskId
// session state slot that load_task sets; submit never accepts an id from the
// model, so it can't be pointed at another task's output file.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { currentTaskId } from "./load_task";

const DEFAULT_PATH = "/workspace/task/output.xlsx";
const VALIDATE_PATH = "/workspace/task/.validate.py";

// Fixed content: just confirms the workbook loads with openpyxl. Written as
// a script and passed the path via argv, rather than interpolated into a
// python -c string, so a path containing shell metacharacters can't reach
// an unquoted context.
const VALIDATE_SCRIPT = `import sys
from openpyxl import load_workbook

load_workbook(sys.argv[1])
`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the environment.`);
  return value;
}

/** Single-quotes a value for a POSIX shell, escaping any embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export default defineTool({
  description:
    "Submit the finished workbook as the answer for the loaded task. Validates it loads with " +
    "openpyxl inside the sandbox, then writes it to the output folder on the host.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe(`Workbook to submit. Defaults to ${DEFAULT_PATH}.`),
  }),
  async execute({ path }, ctx) {
    const workbookPath = path ?? DEFAULT_PATH;
    const id = currentTaskId.get();
    if (!id) throw new Error("No task loaded yet. Call load_task first.");

    const sandbox = await ctx.getSandbox();
    const quotedPath = shellQuote(workbookPath);

    await sandbox.writeTextFile({ path: VALIDATE_PATH, content: VALIDATE_SCRIPT });
    const validate = await sandbox.run({
      command: `python3 ${VALIDATE_PATH} ${quotedPath}`,
    });
    if (validate.exitCode !== 0) {
      throw new Error(`${workbookPath} does not load with openpyxl: ${validate.stderr || validate.stdout}`);
    }

    const bytes = await sandbox.readBinaryFile({ path: workbookPath });
    if (bytes === null) {
      throw new Error(`${workbookPath} does not exist in the sandbox.`);
    }

    const outDir = requireEnv("SB_OUT_DIR");
    const outputsDir = join(outDir, "outputs");
    mkdirSync(outputsDir, { recursive: true });
    writeFileSync(join(outputsDir, `${id}.xlsx`), bytes);

    return { ok: true as const };
  },
});
