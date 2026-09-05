import { defaultBackend, defineSandbox } from "eve/sandbox";
import type { SandboxBackend, SandboxBackendHandle, SandboxSession } from "eve/sandbox";

// The sandbox image bakes in python3, openpyxl, pandas, and a headless
// LibreOffice (libreoffice-calc) so model-written code can inspect and
// recalculate xlsx workbooks without any runtime install step. Build it
// with `docker build -t enyl-sandbox:local .` from the repo root before
// running the agent; see README.md.
//
// Judges may run either Docker or microsandbox, so both backends get the
// same image and neither is pinned as the sole option: defaultBackend()
// still falls through to Vercel Sandbox or just-bash when neither local
// backend is available.
const SANDBOX_IMAGE = "enyl-sandbox:local";

// Unlike Vercel Sandbox, the Docker and microsandbox backends apply no
// idle timeout of their own: a durable session's container (or VM) stays
// up for the life of the `eve start`/`eve dev` process once created (see
// node_modules/eve/docs/sandbox.mdx, "Lifecycle" and "Docker"). A batch
// predict run creates one durable session per task and nothing in that
// script's client can stop or delete a session's sandbox (only an
// authored runtime callback's `ctx.getSandbox()` handle exposes
// `stop`/`delete`, and `client.sessions` offers only compact/clear/reset
// of the *session*, none of which frees the sandbox's compute) so every
// finished task's container kept running until this host ran out of
// capacity (issue #8: 34 -> 454 containers over one 400-task run).
//
// The real fix is `agent/tools/submit.ts` calling `sandbox.delete()`
// once a task's workbook is safely on the host: that is the only point
// where the task is provably done with the sandbox. `withIdleStop`
// below is a safety net for sessions that never reach submit (the model
// gives up, errors out, or the run is killed) — not the primary cleanup
// path.
//
// A stop is not free to fire mid-turn. Checked against
// node_modules/eve/dist/src/execution/sandbox/bindings/docker.js: the
// Docker backend only runs `docker start` inside the backend's
// `create()`, when a session's sandbox handle is (re)built. The `run`/
// `readFile`/`writeFile`/etc. methods on an already-created handle never
// check or restart container state. And
// node_modules/eve/dist/src/execution/sandbox/ensure.js caches that
// handle for the scope it was built in — `stop()` does not clear the
// cache, only `delete()` does. So a handle stopped mid-turn stays
// pointed at a stopped container for any later sandbox call sharing
// that scope: those `docker exec`-backed calls fail outright, not just
// slow down. The doc comment previously here ("eve reopens the same
// container on the next call") describes the cross-turn case, where a
// fresh callback gets a fresh handle and its own `create()`; it does
// not hold for two sandbox calls inside one live model turn.
//
// The timeout below only needs to be long enough that it can't fire
// during a live turn: the per-task timeout is 8 minutes, the session
// timeout is 10 minutes, and normal gaps between one tool call and the
// next are well under a minute. 5 minutes gives comfortable headroom
// over both while still reclaiming containers left by a session that
// stalls or dies without calling submit.
//
// scripts/predict.ts imports this value so it can wait out one idle
// window before it tears down the `eve start` process it spawned: the
// timer below lives in that process's memory, so killing the process
// before the timer fires (the common case right after the last task in
// a batch finishes) drops the stop on the floor and leaks exactly the
// last-active container. Keep the two in sync.
export const SANDBOX_IDLE_TIMEOUT_MS = 300_000;

const SANDBOX_IO_METHODS = [
  "run",
  "spawn",
  "readFile",
  "readBinaryFile",
  "readTextFile",
  "writeFile",
  "writeBinaryFile",
  "writeTextFile",
  "removePath",
] as const satisfies ReadonlyArray<keyof SandboxSession>;

/** Wraps a backend so every live handle it creates stops itself after an idle window. */
function withIdleStop(backend: SandboxBackend): SandboxBackend {
  return {
    ...backend,
    async create(input) {
      const handle = await backend.create(input);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;

      const scheduleStop = () => {
        if (stopped || timer) return;
        timer = setTimeout(() => {
          stopped = true;
          void handle.stop().catch(() => {
            // Best-effort: a failed idle stop just leaves the container
            // running for the next explicit stop or process shutdown.
          });
        }, SANDBOX_IDLE_TIMEOUT_MS);
        timer.unref?.();
      };

      const session: Record<string, unknown> = { ...(handle.session as unknown as Record<string, unknown>) };
      for (const method of SANDBOX_IO_METHODS) {
        const original = (handle.session as unknown as Record<string, unknown>)[method];
        if (typeof original !== "function") continue;
        const bound = original.bind(handle.session);
        session[method] = async (...args: unknown[]) => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          stopped = false;
          try {
            return await bound(...args);
          } finally {
            scheduleStop();
          }
        };
      }
      scheduleStop();

      return { ...handle, session: session as unknown as SandboxSession } satisfies SandboxBackendHandle;
    },
  };
}

export default defineSandbox({
  backend: withIdleStop(
    defaultBackend({
      docker: {
        image: SANDBOX_IMAGE,
        // Everything the model needs is already in the image, so egress
        // stays closed by default.
        networkPolicy: "deny-all",
      },
      microsandbox: {
        image: SANDBOX_IMAGE,
        networkPolicy: "deny-all",
      },
    }),
  ),
});
