// Runs the agent over a SpreadsheetBench dataset directory and writes the
// submission layout the judges expect: predictions.jsonl, outputs/<id>.xlsx,
// and run.log under --out-dir.
//
// Usage:
//   npm run predict -- --dataset-dir <dir> --out-dir <dir> [--ids 13-1,51-12]
//     [--concurrency 4] [--url http://127.0.0.1:2000] [--force] [--no-retry]
//
// Run with `node --experimental-strip-types` (chosen over tsx: the flag
// already handles this file's plain type annotations on this Node version,
// so no extra devDependency is needed).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { Client } from "eve/client";
import { findInitWorkbook, loadDataset, type Task } from "#lib/dataset.ts";
import { appendFailureLine, findTurnFailureMessage, writeTaskTrace } from "./traces.ts";

// Label eve stamps on every sandbox container for this project (see
// agent/sandbox/sandbox.ts and `docker ps -a --filter
// label=eve.sandbox.tag.agent --format '{{.Labels}}'`). Filtering on it
// scopes cleanup to this agent's own containers, not every eve sandbox on
// the host.
const SANDBOX_LABEL = "eve.sandbox.tag.agent=enyl-research";

const TASK_TIMEOUT_MS = 8 * 60 * 1000;
// A task whose first attempt ends missing_output, model_failed, or error gets
// one retry in a brand-new session (see runTask): the model's degeneration
// into incoherent output is a per-session fluke, not a property of the task,
// so a second independent sample usually recovers it. timeout is excluded:
// it already spent the full per-task budget once, and a second full timeout
// would just double the wall-clock cost of a task that is unlikely to be
// fixed by resampling. --no-retry sets this to 1 to reproduce a run without
// retries.
const MAX_ATTEMPTS = 2;
const EVE_BIN = resolve(import.meta.dirname, "../node_modules/.bin/eve");

// scripts/score.sh sources .env.local itself; do the same here so a judge
// running `npm run predict` straight from the README gets SB_DATASET_DIR and
// friends without exporting them by hand first. Resolved from this script's
// own location, not cwd, so it still finds the repo root when invoked from
// elsewhere. process.loadEnvFile never overrides a variable already set in
// the environment, so an explicit `export` or shell env still wins.
function loadEnvLocal(): void {
  const envPath = resolve(import.meta.dirname, "../.env.local");
  if (!existsSync(envPath)) {
    process.stderr.write("predict: no .env.local found, using process environment as-is\n");
    return;
  }
  try {
    process.loadEnvFile(envPath);
    process.stderr.write(`predict: loaded env from ${envPath}\n`);
  } catch (err) {
    process.stderr.write(
      `predict: failed to load ${envPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
loadEnvLocal();

interface Args {
  datasetDir: string;
  outDir: string;
  ids: string[] | null;
  concurrency: number;
  url: string | null;
  force: boolean;
  maxAttempts: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    datasetDir: process.env.SB_DATASET_DIR ?? "",
    outDir: "",
    ids: null,
    concurrency: 4,
    url: null,
    force: false,
    maxAttempts: MAX_ATTEMPTS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) throw new Error(`${arg} needs a value.`);
      return argv[i];
    };
    switch (arg) {
      case "--dataset-dir":
        args.datasetDir = next();
        break;
      case "--out-dir":
        args.outDir = next();
        break;
      case "--ids":
        args.ids = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--concurrency":
        args.concurrency = Number.parseInt(next(), 10);
        break;
      case "--url":
        args.url = next();
        break;
      case "--force":
        args.force = true;
        break;
      case "--no-retry":
        args.maxAttempts = 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.datasetDir) {
    throw new Error("--dataset-dir is required (or set SB_DATASET_DIR).");
  }
  if (!args.outDir) {
    throw new Error("--out-dir is required.");
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }
  return args;
}

type Status = "ok" | "timeout" | "model_failed" | "missing_output" | "error";

interface Prediction {
  id: string;
  output: string;
  status: Status;
}

function readPredictions(path: string): Map<string, Prediction> {
  const map = new Map<string, Prediction>();
  if (!existsSync(path)) return map;
  const text = readFileSync(path, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Prediction;
      map.set(record.id, record);
    } catch {
      // Skip a corrupt line rather than fail the whole resume.
    }
  }
  return map;
}

/** Rewrites predictions.jsonl from the in-memory map, atomically via a temp file + rename. */
function writePredictions(path: string, records: Map<string, Prediction>): void {
  const lines = [...records.values()].map((r) => JSON.stringify(r)).join("\n") + (records.size ? "\n" : "");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, lines);
  renameSync(tmp, path);
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine a free port."));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/** Spawns a child, tee-ing its stdout/stderr into `log` while inheriting the console. */
function spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv, log: NodeJS.WritableStream): ChildProcess {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
  return child;
}

/** Builds the app, then starts it on a free port with the given env, returning its URL and a stop function. */
async function startServer(env: NodeJS.ProcessEnv, log: NodeJS.WritableStream): Promise<{ url: string; stop: () => void }> {
  await new Promise<void>((resolveBuild, reject) => {
    const build = spawnLogged(EVE_BIN, ["build"], env, log);
    build.on("exit", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`eve build exited with code ${code}`));
    });
    build.on("error", reject);
  });

  const port = await findFreePort();
  const startChild = spawnLogged(EVE_BIN, ["start", "--port", String(port)], env, log);
  const url = `http://127.0.0.1:${port}`;

  const client = new Client({ host: url });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const health = await client.health();
      if (health.status === "ready") break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`eve start did not become healthy at ${url} within 30s.`);
    if (startChild.exitCode !== null) throw new Error(`eve start exited early with code ${startChild.exitCode}.`);
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    url,
    // Resolves once the child has actually exited, so callers can run
    // cleanup (e.g. sweeping leaked sandbox containers) only after the
    // server that created them is gone.
    stop: () =>
      new Promise<void>((resolveStop) => {
        if (startChild.exitCode !== null || startChild.signalCode !== null) {
          resolveStop();
          return;
        }
        startChild.once("exit", () => resolveStop());
        startChild.kill("SIGTERM");
      }),
  };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** Runs `docker`, returning stdout or null if the binary is missing or the command failed. */
function runDocker(args: string[]): string | null {
  const result = spawnSync("docker", args, { encoding: "utf-8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * Best-effort sweep for sandbox containers this run leaked. `submit` now
 * stops or deletes the sandbox itself on the success path, and the idle
 * timeout in agent/sandbox/sandbox.ts is a safety net for tasks that never
 * submit, so this is a backstop for whatever slips past both: a killed
 * worker, a crashed `eve start`, or a task that timed out mid-write. Scoped
 * to this project's label and to containers created at or after the run's
 * start, so it never touches another project's sandboxes or containers
 * that predate this run. Never throws: cleanup failing is not a reason to
 * fail the run.
 */
function cleanupLeakedSandboxes(runStartedAt: Date): void {
  const listing = runDocker(["ps", "-a", "--filter", `label=${SANDBOX_LABEL}`, "--format", "{{.ID}} {{.CreatedAt}}"]);
  if (listing === null) {
    process.stderr.write("predict: docker unavailable or `docker ps` failed, skipping sandbox cleanup\n");
    return;
  }
  const ids: string[] = [];
  for (const line of listing.split("\n")) {
    if (!line.trim()) continue;
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) continue;
    const id = line.slice(0, spaceIndex);
    const createdAt = new Date(line.slice(spaceIndex + 1).trim());
    if (Number.isNaN(createdAt.getTime())) continue;
    if (createdAt.getTime() >= runStartedAt.getTime()) ids.push(id);
  }
  if (ids.length === 0) {
    process.stderr.write("predict: no leaked sandbox containers found\n");
    return;
  }
  const batchSize = 50;
  let removed = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const removal = runDocker(["rm", "-f", ...batch]);
    if (removal !== null) removed += batch.length;
  }
  process.stderr.write(`predict: removed ${removed}/${ids.length} leaked sandbox container(s)\n`);
}

/** Statuses worth a fresh-session retry: the model degenerated or the turn errored out, not a timeout that already spent the full per-task budget. */
const RETRYABLE_STATUSES: readonly Status[] = ["missing_output", "model_failed", "error"];

async function runTaskAttempt(client: Client, task: Task, outputsDir: string, outDir: string, log: NodeJS.WritableStream): Promise<Prediction> {
  const outputPath = join(outputsDir, `${task.id}.xlsx`);
  const outputRel = `outputs/${task.id}.xlsx`;
  const firstMessage = `task ${task.id}`;
  const taskStartedAt = Date.now();
  const elapsed = () => Date.now() - taskStartedAt;

  const fallback = (status: Status): Prediction => {
    try {
      const initPath = findInitWorkbook(task.datasetDir, task);
      mkdirSync(dirname(outputPath), { recursive: true });
      copyFileSync(initPath, outputPath);
    } catch {
      // If even the init copy fails, leave no file; the missing output is
      // still recorded so the run's line-per-task guarantee holds.
    }
    return { id: task.id, output: outputRel, status };
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);
  // agent/tools/submit.ts now stops or deletes the task's sandbox itself on
  // the success path, so cleanup no longer depends on this call. Keep it
  // anyway: reset terminally retires the session ID, so a task that already
  // tore down its own sandbox can't have it reopened by a stray retry or
  // reused handle later in the run.
  let session: Awaited<ReturnType<typeof client.sessions.create>>["session"] | null = null;
  try {
    const created = await client.sessions.create({
      message: firstMessage,
      signal: controller.signal,
    });
    session = created.session;
    const result = await created.response.result();
    try {
      writeTaskTrace(outDir, task.id, firstMessage, result);
    } catch (traceErr) {
      const msg = `predict: ${task.id} trace not written: ${traceErr instanceof Error ? traceErr.message : String(traceErr)}\n`;
      process.stderr.write(msg);
      log.write(msg);
    }
    if (result.status === "failed") {
      const reason = findTurnFailureMessage(result.events) ?? "turn ended in failure with no message";
      appendFailureLine(outDir, task.id, `model_failed: ${reason}`, elapsed());
      return fallback("model_failed");
    }
    if (!existsSync(outputPath)) {
      appendFailureLine(outDir, task.id, `missing_output: ${outputPath} was never submitted`, elapsed());
      return fallback("missing_output");
    }
    return { id: task.id, output: outputRel, status: "ok" };
  } catch (err) {
    if (controller.signal.aborted) {
      // The client's response.result() promise rejects on abort with a
      // plain error and no partial event list, so there is nothing to
      // recover from a timed-out turn beyond the timeout itself; see the
      // longer note on appendFailureLine in traces.ts.
      appendFailureLine(outDir, task.id, `timeout after ${TASK_TIMEOUT_MS} ms`, elapsed());
      return fallback("timeout");
    }
    process.stderr.write(`predict: ${task.id} threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    appendFailureLine(outDir, task.id, err instanceof Error ? err.message : String(err), elapsed());
    return fallback("error");
  } finally {
    clearTimeout(timer);
    if (session) {
      try {
        await session.reset({ reason: "predict.ts: task done, releasing session" });
      } catch (resetErr) {
        const msg = `predict: ${task.id} session reset failed: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}\n`;
        process.stderr.write(msg);
        log.write(msg);
      }
    }
  }
}

/**
 * Runs a task, retrying once more in a brand-new session (same first
 * message, same per-task timeout) when the first attempt ends
 * missing_output, model_failed, or error. `maxAttempts` bounds the loop, so
 * it can never run more than `maxAttempts` attempts regardless of how many
 * consecutive attempts come back retryable. Before a retry starts, the prior
 * attempt's trace is renamed out of the way (traces/<id>.jsonl ->
 * traces/<id>.attemptN.jsonl) so the next attempt's writeTaskTrace call,
 * which truncates rather than appends, doesn't clobber it — the judges'
 * trace path (traces/<id>.jsonl) always ends up holding the final attempt.
 * The final attempt's result is taken whatever its status, per the retry
 * policy: one extra sample, not a search for a passing one.
 */
async function runTask(
  client: Client,
  task: Task,
  outputsDir: string,
  outDir: string,
  log: NodeJS.WritableStream,
  maxAttempts: number,
): Promise<{ prediction: Prediction; retried: number }> {
  let attempt = 1;
  let prediction = await runTaskAttempt(client, task, outputsDir, outDir, log);

  while (attempt < maxAttempts && RETRYABLE_STATUSES.includes(prediction.status)) {
    const tracePath = join(outDir, "traces", `${task.id}.jsonl`);
    const preservedPath = join(outDir, "traces", `${task.id}.attempt${attempt}.jsonl`);
    if (existsSync(tracePath)) {
      try {
        renameSync(tracePath, preservedPath);
      } catch (renameErr) {
        const msg =
          `predict: ${task.id} failed to preserve attempt ${attempt} trace: ` +
          `${renameErr instanceof Error ? renameErr.message : String(renameErr)}\n`;
        process.stderr.write(msg);
        log.write(msg);
      }
    }
    attempt++;
    const retryLine = `predict: ${task.id} retrying (attempt ${attempt}/${maxAttempts}) after ${prediction.status}\n`;
    process.stderr.write(retryLine);
    log.write(retryLine);
    prediction = await runTaskAttempt(client, task, outputsDir, outDir, log);
  }

  return { prediction, retried: attempt - 1 };
}

async function main(): Promise<void> {
  const runStartedAt = new Date();
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = resolve(args.datasetDir);
  const outDir = resolve(args.outDir);
  const outputsDir = join(outDir, "outputs");
  mkdirSync(outputsDir, { recursive: true });

  const predictionsPath = join(outDir, "predictions.jsonl");
  const logPath = join(outDir, "run.log");
  const log = createWriteStream(logPath, { flags: "a" });

  let allTasks = loadDataset(datasetDir).map((t) => ({ ...t, datasetDir }));
  if (args.ids) {
    const wanted = new Set(args.ids);
    allTasks = allTasks.filter((t) => wanted.has(t.id));
    const found = new Set(allTasks.map((t) => t.id));
    for (const id of args.ids) {
      if (!found.has(id)) {
        const msg = `warning: task id ${id} not found in ${datasetDir}/dataset.json, skipping.\n`;
        process.stderr.write(msg);
        log.write(msg);
      }
    }
  }

  const existing = readPredictions(predictionsPath);
  /** A task is done only if its line says "ok" and the output file it names is still on disk. */
  const isDone = (t: Task): boolean => {
    const prediction = existing.get(t.id);
    if (!prediction || prediction.status !== "ok") return false;
    return existsSync(resolve(outDir, prediction.output));
  };
  const toRun = allTasks.filter((t) => args.force || !isDone(t));
  const skipCount = allTasks.length - toRun.length;

  const startupLine =
    `predict: dataset=${datasetDir} tasks=${allTasks.length} concurrency=${args.concurrency} ` +
    `resume=${skipCount}/${allTasks.length} already ok\n`;
  process.stderr.write(startupLine);
  log.write(startupLine);

  let stopServer: (() => Promise<void>) | null = null;
  let baseUrl = args.url;
  if (!baseUrl) {
    // EVE_DEV=1 marks this process as a local development server, the same
    // flag `eve dev` sets on itself. The default eve channel auth chain
    // (agent/channels/eve.ts) admits any request once that flag is set, so
    // our own batch client doesn't need to carry a bearer token to talk to
    // a server we just spawned on loopback for this run.
    const env = { ...process.env, SB_DATASET_DIR: datasetDir, SB_OUT_DIR: outDir, EVE_DEV: "1" };
    const server = await startServer(env, log);
    baseUrl = server.url;
    stopServer = server.stop;
    const upLine = `predict: started eve server at ${baseUrl}\n`;
    process.stderr.write(upLine);
    log.write(upLine);
  }
  // A server reached via --url (e.g. a real deployment) isn't ours to flag as
  // local-dev, so fall back to the Vercel OIDC bearer token from .env.local,
  // the same credential `eve invoke` uses against a remote target.
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  const client = new Client({
    host: baseUrl,
    ...(oidcToken ? { auth: { bearer: async () => oidcToken } } : {}),
  });

  let interrupted = false;
  const onSigint = async () => {
    if (interrupted) return;
    interrupted = true;
    const msg =
      "\npredict: interrupted. Finished tasks are already recorded in " +
      `${predictionsPath}; rerun the same command to resume the rest ` +
      "(a task only counts as done if its output file is still on disk).\n";
    process.stderr.write(msg);
    log.write(msg);
    await stopServer?.();
    cleanupLeakedSandboxes(runStartedAt);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const records = existing;
  let done = 0;
  let ok = 0;
  let err = 0;
  let retried = 0;
  const total = toRun.length;
  const startedAt = Date.now();

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (interrupted) return;
      const index = cursor++;
      if (index >= toRun.length) return;
      const task = toRun[index];
      const { prediction, retried: taskRetried } = await runTask(client, task, outputsDir, outDir, log, args.maxAttempts);
      records.set(prediction.id, prediction);
      writePredictions(predictionsPath, records);

      done++;
      retried += taskRetried;
      if (prediction.status === "ok") ok++;
      else err++;
      const elapsedMs = Date.now() - startedAt;
      const etaMs = done > 0 ? (elapsedMs / done) * (total - done) : 0;
      const line =
        `predict: ${task.id} ${prediction.status} ` +
        `(${done}/${total} ok=${ok} err=${err} retried=${retried} elapsed=${formatElapsed(elapsedMs)} eta=${formatElapsed(etaMs)})\n`;
      process.stderr.write(line);
      log.write(line);
    }
  }

  const workers = Array.from({ length: Math.min(args.concurrency, Math.max(toRun.length, 1)) }, () => worker());
  await Promise.all(workers);

  process.off("SIGINT", onSigint);
  if (stopServer) {
    await stopServer();
  }
  // agent/tools/submit.ts stops or deletes each task's sandbox on the
  // success path now, and the idle timeout in agent/sandbox/sandbox.ts is
  // a safety net for tasks that never submit, so no fixed wait belongs
  // here. This sweep only catches what both of those missed.
  cleanupLeakedSandboxes(runStartedAt);

  const missing = allTasks.filter((t) => !records.has(t.id));
  const exitCode = missing.length === 0 ? 0 : 1;
  const summary =
    `predict: done. ${records.size}/${allTasks.length} tasks have a prediction line. ` +
    `retried=${retried} exit=${exitCode}\n`;
  process.stderr.write(summary);
  log.write(summary);
  log.end();
  process.exitCode = exitCode;
}

main().catch((err) => {
  process.stderr.write(`predict: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
