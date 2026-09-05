// Second opinion on a task's recalculated answer, called right before
// submit. Runs synchronously in the app runtime (not the sandbox, not a
// subagent): a plain blocking AI SDK call to Ornith, in the same style as
// recalc_and_read's blocking sandbox call. A declared eve subagent was tried
// first (issue #13's original design) and dropped: every declared subagent
// call is unconditionally a background task (node_modules/eve/docs/subagents/
// index.mdx), so the calling turn only ever gets a { status: "working" }
// receipt, never the verdict, and scripts/predict.ts's single
// response.result() per session send never lives long enough to see the
// task-triggered follow-up turn that would carry it. Confirmed empirically:
// the model busy-waited with invented `bash sleep` calls and submitted
// without ever seeing a verdict. See the comment on issue #13 for the full
// writeup.
//
// This tool never touches the workbook itself and never reads a dataset's
// expected-answer field. Everything it reviews is text the solver already
// collected and passes in the input.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

const ORNITH_MODEL_ID = "Ornith-1.5-35B-A3B";
const TIMEOUT_MS = 45_000;
// Without this, Ornith's chat template opens a chain-of-thought field before
// the answer, and at temperature 0 that reasoning ran away: every one of a
// non-trivial prompt's output tokens went to "reasoning" and none to
// content, at any token budget tried up to 4096, so the tool always got back
// an empty response and fell back to approve. vLLM's `chat_template_kwargs:
// {enable_thinking: false}` (forwarded as extra body fields, keyed by this
// client's `name: "ornith"`) turns that off; confirmed against the raw
// response that content then holds the plain answer directly, no reasoning
// prefix to strip, in well under a second for a short prompt.
const MAX_OUTPUT_TOKENS = 768;

const verdictSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  reason: z.string(),
  suspect_cells: z.array(z.string()),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the environment.`);
  return value;
}

function buildPrompt(input: {
  instruction: string;
  answer_sheet: string | null;
  answer_range: string;
  recalculated_values: Record<string, unknown>;
  error_cells: string[];
  workbook_dump: string;
}): string {
  return `You are a second opinion on a spreadsheet answer, called right before it gets submitted. \
You have no tools and cannot open the workbook yourself; judge only from what follows.

Instruction: ${input.instruction}

Answer sheet: ${input.answer_sheet ?? "(workbook's active sheet)"}
Answer range: ${input.answer_range}

Recalculated values in the answer range:
${JSON.stringify(input.recalculated_values, null, 2)}

Error cells in the answer range (any of #NAME?, #REF!, #VALUE!, #DIV/0!, or similar; empty means none):
${JSON.stringify(input.error_cells)}

Workbook excerpt (first 80 lines of dump_workbook.py's output):
${input.workbook_dump}

Check whether each value in the answer range matches what the instruction asks for, given the \
workbook excerpt: right type and shape, no error cells, the right count of filled cells for what \
the instruction implies. Trace two or three cells yourself from the excerpt and the instruction's \
stated rule; if your own trace disagrees with a recalculated value, that cell is suspect. You are \
checking for wrong values, not style: a correct value in an unexpected format is still correct.

Return verdict "approve" when the values match and no cell is suspect. Return "revise" when at \
least one cell is wrong, missing, or an error, or you cannot rule out that it's wrong from the \
given excerpt and it looks inconsistent with the stated rule. When the excerpt is too short to \
check a claim, say so in reason and lean toward "approve" rather than guessing a failure.

reason: one or two sentences a solver can act on, naming the rule you think was applied wrong or \
the mismatch you found. suspect_cells: coordinates like "Sheet1!C4" you flagged, empty when you \
approve.

Reply with exactly one JSON object and nothing else before or after it: no markdown fences, no \
commentary. It must have exactly these three keys, with these exact names and value types:

{"verdict": "approve" or "revise", "reason": "<string>", "suspect_cells": ["<string>", ...]}`;
}

/** Pulls the first balanced {...} substring out of a response that may still carry stray text around it. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export default defineTool({
  description:
    "Get a second opinion from Ornith on the recalculated answer before submit. Pass the " +
    "instruction, the answer sheet and range, the recalc_and_read values and error cells for " +
    "that range, and the workbook dump. Returns approve or revise with a reason and any " +
    "suspect cell coordinates. One call; if Ornith is unavailable or too slow, this returns " +
    "approve rather than blocking submit.",
  inputSchema: z.object({
    instruction: z.string().min(1).describe("The task's plain-English instruction."),
    answer_sheet: z
      .string()
      .nullable()
      .describe("The answer sheet name, or null for the workbook's active sheet."),
    answer_range: z.string().min(1).describe("The answer range, e.g. \"A1:C10\"."),
    recalculated_values: z
      .record(z.string(), z.unknown())
      .describe("The values object recalc_and_read returned for the answer range."),
    error_cells: z.array(z.string()).describe("The error_cells array recalc_and_read returned."),
    workbook_dump: z
      .string()
      .min(1)
      .describe("The first 80 lines of dump_workbook.py's output (or load_task's workbook_dump)."),
  }),
  async execute(input) {
    const startedAt = Date.now();
    const fallback = (reason: string) => {
      console.error(`critic: falling back to approve: ${reason}`);
      return {
        verdict: "approve" as const,
        reason,
        suspect_cells: [] as string[],
        model: ORNITH_MODEL_ID,
        latency_ms: Date.now() - startedAt,
      };
    };

    try {
      const ornith = createOpenAICompatible({
        name: "ornith",
        baseURL: requireEnv("ORNITH_BASE_URL"),
        apiKey: requireEnv("ORNITH_API_KEY"),
      });

      // generateObject relies on the provider's structured-output response
      // format, which Ornith's OpenAI-compatible endpoint doesn't support:
      // it silently accepts a bare `{"type":"json_object"}` request but
      // never sees the schema, so it invents its own field names (confirmed
      // empirically: it returned {"status":"approved",...} instead of
      // {"verdict":"approve",...}). Asking in plain text for an exact key
      // shape, then parsing and validating that ourselves, is what actually
      // gets the right keys back from this model.
      const { text } = await generateText({
        model: ornith(ORNITH_MODEL_ID),
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        prompt: buildPrompt(input),
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        providerOptions: {
          ornith: { chat_template_kwargs: { enable_thinking: false } },
        },
      });

      const jsonText = extractJsonObject(text);
      if (!jsonText) return fallback(`critic gave no parseable JSON: ${text.slice(0, 200)}`);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        return fallback(`critic's JSON did not parse: ${message}`);
      }

      const result = verdictSchema.safeParse(parsed);
      if (!result.success) {
        return fallback(`critic's JSON did not match the expected shape: ${result.error.message}`);
      }

      return {
        verdict: result.data.verdict,
        reason: result.data.reason,
        suspect_cells: result.data.suspect_cells,
        model: ORNITH_MODEL_ID,
        latency_ms: Date.now() - startedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fallback(`critic unavailable: ${message}`);
    }
  },
});
