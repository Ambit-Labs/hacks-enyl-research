// Writes traces/<id>.jsonl for one predict.ts task run: one line per model
// call, in the judges' format (see issue #6).
//
// Spike notes (issue #6). Two sources were on the table:
//
//   1. The session event stream (`response.result().events`, from
//      client.sessions.create() in the batch runner). step.started names the
//      model per call, step.completed carries token usage and finish reason,
//      actions.requested/action.result carry the tool name, input, and
//      output, and message.completed carries the assistant's text for that
//      step. Every event is timestamped (`meta.at`), so latency is a
//      subtraction.
//   2. Local OTel traces under `.eve/traces/v1`, read with `eve traces <id>
//      --json`. With EVE_TRACES_CONTENT=on these do carry the full system
//      prompt and response text (confirmed against traces recorded by an
//      earlier `eve dev` session in this repo).
//
// Option 2 turned out not to apply here: per docs/guides/instrumentation.md
// ("Local traces") and docs/reference/cli.md ("When no authored
// instrumentation.ts exists, local dev also records traces"), that store is
// populated by `eve dev`, not by `eve build` + `eve start` — the pair
// predict.ts (issue #5) actually spawns. A five-task smoke run through
// predict.ts confirmed this empirically: `eve traces ls` showed no new
// entries afterward. So this file uses option 1.
//
// Trade-off, stated plainly per the issue's instruction not to invent
// content: the stream's `message.received` gives the literal outbound text
// of the *first* user message (`task <id>`) but never the system prompt —
// that only rides on the server-side AI SDK spans, which requires option 2's
// unavailable trace store to read back. So `prompt` on the step-1 line is
// that first message text, and `prompt` on every later line is `""`: the
// full model input for those calls (history, tool results, instructions) is
// assembled server-side per call and never appears on the client stream.
//
// Issue #6 follow-up: a non-ok predict.ts status (timeout, model_failed,
// missing_output, error) used to leave the trace file either missing an
// error line or missing entirely. `appendFailureLine` below is what
// predict.ts now calls on every one of those paths so the trace always ends
// with a line naming what went wrong, in the same per-line schema.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MessageResult, MessageStreamEvent } from "eve/client";

const FIELD_LIMIT = 20_000;

// Mirrors the literal in agent/agent.ts. Not read from that file or from an
// env var at runtime: the model choice for this agent is a source constant,
// not a trace-time setting, so a hardcoded copy here can't drift silently
// out of sync with what actually ran without a human editing both spots.
const MODEL_ID = "deepseek/deepseek-v4-flash-0731";

function truncateString(value: string): string {
  if (value.length <= FIELD_LIMIT) return value;
  return `${value.slice(0, FIELD_LIMIT)}[truncated]`;
}

/** Truncates a field for the trace line: strings are clipped directly; anything else is clipped via its JSON form and falls back to a string. */
function truncateField(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value);
  if (value === null || value === undefined) return value;
  const json = JSON.stringify(value);
  if (json.length <= FIELD_LIMIT) return value;
  return truncateString(json);
}

interface StepLine {
  step: number;
  model: string;
  prompt: string;
  response: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  error: string | null;
  tool?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
}

/** Builds one trace line per model step from a turn's raw event list, honestly reflecting what the client stream carries (see the file header). */
export function buildTraceLines(events: readonly MessageStreamEvent[], firstUserMessage: string): StepLine[] {
  const byStep = new Map<number, MessageStreamEvent[]>();
  for (const event of events) {
    const stepIndex = (event.data as { stepIndex?: number }).stepIndex;
    if (typeof stepIndex !== "number") continue;
    const bucket = byStep.get(stepIndex) ?? [];
    bucket.push(event);
    byStep.set(stepIndex, bucket);
  }

  const lines: StepLine[] = [];
  const stepIndices = [...byStep.keys()].sort((a, b) => a - b);
  for (const stepIndex of stepIndices) {
    const stepEvents = byStep.get(stepIndex)!;
    const started = stepEvents.find((e) => e.type === "step.started");
    const completed = stepEvents.find((e) => e.type === "step.completed");
    const failed = stepEvents.find((e) => e.type === "step.failed");
    const messages = stepEvents.filter((e) => e.type === "message.completed");
    const actionsRequested = stepEvents.find((e) => e.type === "actions.requested");
    const actionResult = stepEvents.find((e) => e.type === "action.result");

    const startedAt = started ? Date.parse(started.meta.at) : undefined;
    const endedAt = completed ? Date.parse(completed.meta.at) : failed ? Date.parse(failed.meta.at) : undefined;
    const latencyMs = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : null;

    const usage = completed?.type === "step.completed" ? completed.data.usage : undefined;
    const response = messages
      .map((m) => (m.type === "message.completed" ? (m.data.message ?? "") : ""))
      .filter(Boolean)
      .join("\n");

    const line: StepLine = {
      step: stepIndex + 1,
      model: MODEL_ID,
      prompt: stepIndex === 0 ? firstUserMessage : "",
      response: truncateField(response) as string,
      // A failed step carries no usage, and a step with no started/completed
      // timestamp on either end has no way to compute latency. Both default
      // to 0 rather than null so every line satisfies the schema (issue #6).
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      latency_ms: latencyMs ?? 0,
      error: failed?.type === "step.failed" ? failed.data.message : null,
    };

    if (actionsRequested?.type === "actions.requested") {
      const call = actionsRequested.data.actions.find((a) => a.kind === "tool-call");
      if (call) {
        line.tool = call.toolName;
        line.tool_input = truncateField(call.input);
      }
    }
    if (actionResult?.type === "action.result" && actionResult.data.result.kind === "tool-result") {
      const result = actionResult.data.result;
      line.tool_output = truncateField(result.output);
      if (actionResult.data.status !== "completed" || result.isError) {
        line.error = line.error ?? actionResult.data.error?.message ?? "tool call failed";
      }
    }

    line.prompt = truncateField(line.prompt) as string;
    lines.push(line);
  }
  return lines;
}

/** Writes `<outDir>/traces/<taskId>.jsonl` from one turn's `MessageResult`. */
export function writeTaskTrace(outDir: string, taskId: string, firstUserMessage: string, result: MessageResult): void {
  const lines = buildTraceLines(result.events, firstUserMessage);
  const outPath = join(outDir, "traces", `${taskId}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
}

/** Finds the message on a turn's terminal `turn.failed`/`session.failed` event, for a caller building a status reason string. Returns null if the turn has no such event (for example, a network error that never reached the server). */
export function findTurnFailureMessage(events: readonly MessageStreamEvent[]): string | null {
  const failure = events.find((e) => e.type === "turn.failed" || e.type === "session.failed");
  if (!failure) return null;
  return (failure.data as { message?: string }).message ?? `${failure.type} with no message`;
}

/**
 * Appends one line to `<outDir>/traces/<taskId>.jsonl` recording why a task
 * ended in a non-ok predict.ts status (timeout, model_failed,
 * missing_output, error). This is how the trace file keeps the guarantee
 * that every task's status is reflected somewhere in its trace, not just
 * the ones that fail mid-turn with a `step.failed` or `turn.failed` event.
 *
 * If `writeTaskTrace` already wrote step lines for this task (true for
 * model_failed and missing_output, where a turn result came back before the
 * outer check decided the status was non-ok), those lines are kept and the
 * new line is numbered one past the last of them. If no trace file exists
 * yet (true for timeout and for an error thrown before a turn result ever
 * arrived), this starts the file with just the one line, at step 1.
 *
 * A per-task timeout aborts `response.result()` via its `AbortController`;
 * that promise then rejects with a plain error and no partial event list on
 * it, so there is no way to recover whatever stream steps a timed-out turn
 * had already produced from here. If a future client version exposes those
 * partial events on the abort error, this is the place to fold them in
 * ahead of the failure line the same way `writeTaskTrace` does for a normal
 * result; today the caller can only pass the timeout reason and elapsed
 * time.
 */
export function appendFailureLine(outDir: string, taskId: string, reason: string, elapsedMs: number): void {
  const outPath = join(outDir, "traces", `${taskId}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });

  let priorLines: StepLine[] = [];
  if (existsSync(outPath)) {
    const text = readFileSync(outPath, "utf-8");
    priorLines = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StepLine);
  }

  const nextStep = priorLines.length > 0 ? priorLines[priorLines.length - 1].step + 1 : 1;
  const failureLine: StepLine = {
    step: nextStep,
    model: MODEL_ID,
    prompt: "",
    response: "",
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: elapsedMs,
    error: truncateField(reason) as string,
    tool: null,
  };

  const allLines = [...priorLines, failureLine];
  writeFileSync(outPath, allLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
