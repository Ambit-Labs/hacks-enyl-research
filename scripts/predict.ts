// Runs the agent over a SpreadsheetBench dataset directory and writes the
// submission layout the judges expect: predictions.jsonl, outputs/<id>.xlsx,
// and run.log under --out-dir.
//
// Usage:
//   npm run predict -- --dataset-dir <dir> --out-dir <dir> [--ids 13-1,51-12]
//     [--concurrency 4] [--url http://127.0.0.1:2000] [--force]
//
// Run with `node --experimental-strip-types` (chosen over tsx: the flag
// already handles this file's plain type annotations on this Node version,
// so no extra devDependency is needed).

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { Client } from "eve/client";
import { findInitWorkbook, loadDataset, type Task } from "#lib/dataset.ts";
import { SANDBOX_IDLE_TIMEOUT_MS } from "#sandbox/sandbox.ts";
import { appendFailureLine, findTurnFailureMessage, writeTaskTrace } from "./traces.ts";

const TASK_TIMEOUT_MS = 8 * 60 * 1000;
const EVE_BIN = resolve(import.meta.dirname, "../node_modules/.bin/eve");

interface Args {
  datasetDir: string;
  outDir: string;
  ids: string[] | null;
  concurrency: number;
  url: string | null;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    datasetDir: process.env.SB_DATASET_DIR ?? "",
    outDir: "",
    ids: null,
    concurrency: 4,
    url: null,
    force: false,
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
    stop: () => {
      startChild.kill("SIGTERM");
    },
  };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

async function runTask(client: Client, task: Task, outputsDir: string, outDir: string, log: NodeJS.WritableStream): Promise<Prediction> {
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
  // Docker and microsandbox sandboxes stay up for the life of the eve
  // process once a durable session opens one; nothing tears the container
  // down when a turn finishes (see agent/sandbox/sandbox.ts and issue #8).
  // The client's only session-lifecycle control is `reset`, which
  // terminally retires the session so it can never reopen its sandbox
  // again; call it once this task's result, trace, and output are all
  // handled so a batch run doesn't strand one container per task.
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

async function main(): Promise<void> {
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

  let stopServer: (() => void) | null = null;
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
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    const msg =
      "\npredict: interrupted. Finished tasks are already recorded in " +
      `${predictionsPath}; rerun the same command to resume the rest ` +
      "(a task only counts as done if its output file is still on disk).\n";
    process.stderr.write(msg);
    log.write(msg);
    stopServer?.();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const records = existing;
  let done = 0;
  let ok = 0;
  let err = 0;
  const total = toRun.length;
  const startedAt = Date.now();

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (interrupted) return;
      const index = cursor++;
      if (index >= toRun.length) return;
      const task = toRun[index];
      const prediction = await runTask(client, task, outputsDir, outDir, log);
      records.set(prediction.id, prediction);
      writePredictions(predictionsPath, records);

      done++;
      if (prediction.status === "ok") ok++;
      else err++;
      const elapsedMs = Date.now() - startedAt;
      const etaMs = done > 0 ? (elapsedMs / done) * (total - done) : 0;
      const line =
        `predict: ${task.id} ${prediction.status} ` +
        `(${done}/${total} ok=${ok} err=${err} elapsed=${formatElapsed(elapsedMs)} eta=${formatElapsed(etaMs)})\n`;
      process.stderr.write(line);
      log.write(line);
    }
  }

  const workers = Array.from({ length: Math.min(args.concurrency, Math.max(toRun.length, 1)) }, () => worker());
  await Promise.all(workers);

  process.off("SIGINT", onSigint);
  if (stopServer) {
    // agent/sandbox/sandbox.ts stops each sandbox after an idle window,
    // but that timer lives in the `eve start` process's memory; killing
    // the process sooner drops the stop for whichever task finished last
    // and leaks its container. Wait out one full idle window first.
    const graceMs = SANDBOX_IDLE_TIMEOUT_MS + 5_000;
    const graceLine = `predict: waiting ${formatElapsed(graceMs)} for idle sandboxes to stop before shutting down the server\n`;
    process.stderr.write(graceLine);
    log.write(graceLine);
    await new Promise((r) => setTimeout(r, graceMs));
    stopServer();
  }

  const missing = allTasks.filter((t) => !records.has(t.id));
  const exitCode = missing.length === 0 ? 0 : 1;
  const summary =
    `predict: done. ${records.size}/${allTasks.length} tasks have a prediction line. ` +
    `exit=${exitCode}\n`;
  process.stderr.write(summary);
  log.write(summary);
  log.end();
  process.exitCode = exitCode;
}

main().catch((err) => {
  process.stderr.write(`predict: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
