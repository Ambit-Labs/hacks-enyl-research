#!/usr/bin/env node
// Local reverse proxy that spreads Ornith requests across several vLLM boxes,
// so the agent keeps a single ORNITH_BASE_URL. No dependencies, Node >= 18.
//
// Backends come from runs/boxes/*.env (ORNITH_API_KEY, ORNITH_BASE_URL), read
// on startup and re-read every 30s so new boxes join without a restart.
//
// Usage: node scripts/runcrate/ornith_proxy.mjs

import http from "node:http";
import https from "node:https";
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BOXES_DIR = join(REPO_ROOT, "runs", "boxes");
const PROXY_ENV_PATH = join(BOXES_DIR, "proxy.env");

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 8100;
const BACKEND_REFRESH_MS = 30_000;
const HEALTH_CHECK_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const SUMMARY_INTERVAL_MS = 60_000;

function log(line) {
  process.stderr.write(`[${new Date().toISOString()}] ${line}\n`);
}

// -- proxy key -----------------------------------------------------------

// Equivalent to `openssl rand -hex 24`, without shelling out.
const PROXY_KEY = randomBytes(24).toString("hex");
try {
  unlinkSync(PROXY_ENV_PATH);
} catch {
  // fine if it doesn't exist yet
}
writeFileSync(
  PROXY_ENV_PATH,
  `ORNITH_API_KEY=${PROXY_KEY}\nORNITH_BASE_URL=http://${LISTEN_HOST}:${LISTEN_PORT}/v1\n`,
  { mode: 0o600 },
);
log(`wrote proxy env file to ${PROXY_ENV_PATH}`);

// -- backend registry ------------------------------------------------------

/** @type {Map<string, {name: string, baseUrl: string, apiKey: string, healthy: boolean, inFlight: number, total: number, errors: number}>} */
const backends = new Map();
let rrCursor = 0;

function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function loadBackends() {
  let files;
  try {
    files = readdirSync(BOXES_DIR).filter(
      (f) => f.endsWith(".env") && f !== "proxy.env",
    );
  } catch (err) {
    log(`failed to list ${BOXES_DIR}: ${err.message}`);
    return;
  }

  const seen = new Set();
  for (const file of files) {
    const name = file.replace(/\.env$/, "");
    seen.add(name);
    let env;
    try {
      env = parseEnvFile(join(BOXES_DIR, file));
    } catch (err) {
      log(`skipping ${file}: ${err.message}`);
      continue;
    }
    const baseUrl = env.ORNITH_BASE_URL;
    const apiKey = env.ORNITH_API_KEY;
    if (!baseUrl || !apiKey) {
      log(`skipping ${file}: missing ORNITH_BASE_URL or ORNITH_API_KEY`);
      continue;
    }
    const existing = backends.get(name);
    if (!existing) {
      backends.set(name, {
        name,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey,
        healthy: false,
        inFlight: 0,
        total: 0,
        errors: 0,
      });
      log(`discovered backend ${name} (${baseUrl})`);
      checkHealth(backends.get(name));
    } else if (existing.baseUrl !== baseUrl.replace(/\/+$/, "") || existing.apiKey !== apiKey) {
      existing.baseUrl = baseUrl.replace(/\/+$/, "");
      existing.apiKey = apiKey;
      log(`updated backend ${name} config`);
      checkHealth(existing);
    }
  }

  for (const name of [...backends.keys()]) {
    if (!seen.has(name)) {
      backends.delete(name);
      log(`backend ${name} removed (env file gone)`);
    }
  }
}

function checkHealth(backend) {
  const url = new URL(`${backend.baseUrl}/models`);
  const client = url.protocol === "https:" ? https : http;
  const req = client.get(
    url,
    {
      headers: { Authorization: `Bearer ${backend.apiKey}` },
      timeout: HEALTH_TIMEOUT_MS,
    },
    (res) => {
      res.resume();
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      setHealthy(backend, ok, `GET /models -> ${res.statusCode}`);
    },
  );
  req.on("timeout", () => {
    req.destroy(new Error("health check timed out"));
  });
  req.on("error", (err) => {
    setHealthy(backend, false, err.message);
  });
}

function setHealthy(backend, healthy, reason) {
  if (backend.healthy !== healthy) {
    log(`backend ${backend.name} ${healthy ? "UP" : "DOWN"} (${reason})`);
  }
  backend.healthy = healthy;
}

function healthyBackends() {
  return [...backends.values()].filter((b) => b.healthy);
}

function pickBackend(exclude) {
  const pool = healthyBackends().filter((b) => !exclude || b !== exclude);
  if (pool.length === 0) return null;
  const minInFlight = Math.min(...pool.map((b) => b.inFlight));
  const candidates = pool.filter((b) => b.inFlight === minInFlight);
  const chosen = candidates[rrCursor % candidates.length];
  rrCursor = (rrCursor + 1) % Math.max(candidates.length, 1);
  return chosen;
}

// -- proxy server ----------------------------------------------------------

function unauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function badGateway(res, message) {
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
  }
  res.end(JSON.stringify({ error: message || "bad gateway" }));
}

function handleHealthz(req, res) {
  const body = {
    backends: [...backends.values()].map((b) => ({
      name: b.name,
      baseUrl: b.baseUrl,
      healthy: b.healthy,
      inFlight: b.inFlight,
      total: b.total,
      errors: b.errors,
    })),
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function forward(req, res, body, attempt) {
  const backend = pickBackend(attempt && attempt.excludeBackend);
  if (!backend) {
    badGateway(res, "no healthy backends");
    return;
  }

  backend.inFlight += 1;
  backend.total += 1;
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    backend.inFlight -= 1;
  };

  // backend.baseUrl already ends in /v1 (e.g. http://host:8000/v1), and the
  // incoming request path also starts with /v1 (e.g. /v1/models), so the
  // forwarded URL is the backend's origin plus the incoming path unchanged.
  const backendOrigin = new URL(backend.baseUrl).origin;
  const targetUrl = new URL(backendOrigin + req.url);
  const client = targetUrl.protocol === "https:" ? https : http;

  const headers = { ...req.headers };
  headers.authorization = `Bearer ${backend.apiKey}`;
  headers.host = targetUrl.host;

  let firstByteSent = false;

  const upstreamReq = client.request(
    targetUrl,
    { method: req.method, headers },
    (upstreamRes) => {
      firstByteSent = true;
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on("end", release);
      upstreamRes.on("error", () => {
        backend.errors += 1;
        release();
      });
    },
  );

  // If the client disconnects mid-stream, stop pulling from the backend and
  // release the in-flight slot instead of leaking it.
  res.on("close", () => {
    if (settled) return;
    upstreamReq.destroy();
    release();
  });

  upstreamReq.on("error", (err) => {
    if (settled) {
      return;
    }
    if (!firstByteSent) {
      backend.errors += 1;
      release();
      log(`backend ${backend.name} request error before response: ${err.message}`);
      const alreadyRetried = attempt && attempt.retried;
      if (!alreadyRetried) {
        forward(req, res, body, { retried: true, excludeBackend: backend });
        return;
      }
      badGateway(res, "upstream connection failed");
    } else {
      backend.errors += 1;
      release();
      log(`backend ${backend.name} stream error after response started: ${err.message}`);
      try {
        res.end();
      } catch {
        // response already closed
      }
    }
  });

  if (body && body.length) {
    upstreamReq.end(body);
  } else {
    upstreamReq.end();
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    handleHealthz(req, res);
    return;
  }

  if (!req.url.startsWith("/v1/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (token !== PROXY_KEY) {
    unauthorized(res);
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    forward(req, res, body);
  });
  req.on("error", (err) => {
    log(`incoming request error: ${err.message}`);
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(
    `ornith proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT} (v1 forwarding), ` +
      `backends dir ${BOXES_DIR}`,
  );
});

// -- periodic tasks ----------------------------------------------------------

loadBackends();
setInterval(loadBackends, BACKEND_REFRESH_MS);
setInterval(() => {
  for (const backend of backends.values()) checkHealth(backend);
}, HEALTH_CHECK_MS);

setInterval(() => {
  const lines = [...backends.values()].map(
    (b) =>
      `${b.name}: healthy=${b.healthy} inFlight=${b.inFlight} total=${b.total} errors=${b.errors}`,
  );
  log(`summary: ${lines.length ? lines.join(" | ") : "no backends"}`);
}, SUMMARY_INTERVAL_MS);

process.on("SIGTERM", () => {
  log("shutting down (SIGTERM)");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  log("shutting down (SIGINT)");
  server.close(() => process.exit(0));
});
