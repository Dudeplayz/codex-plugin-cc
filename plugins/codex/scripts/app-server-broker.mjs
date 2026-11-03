#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { clearBrokerStateFile, unregisterSessionBroker } from "./lib/broker-lifecycle.mjs";
import { isProcessAlive, killSurvivors, listDescendantPids } from "./lib/process.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
// Codex starts a fresh set of MCP servers for every thread it loads and keeps
// them until the app-server exits, so these count towards a recycle.
const THREAD_LOADING_METHODS = new Set(["thread/start", "thread/resume", "thread/fork", "review/start"]);

export const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
export const MAX_THREADS_ENV = "CODEX_COMPANION_BROKER_MAX_THREADS";
export const WATCH_INTERVAL_ENV = "CODEX_COMPANION_BROKER_WATCH_INTERVAL_MS";
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_THREADS = 8;
const DEFAULT_WATCH_INTERVAL_MS = 5000;
// A client that keeps its socket open after the Claude session died must not
// keep the broker alive forever.
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
const APP_SERVER_EXIT_TIMEOUT_MS = 5000;
const MCP_EXIT_GRACE_MS = 2000;

function readDurationOption(value, envName, fallback) {
  const raw = value ?? process.env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${envName}: ${raw}`);
  }
  return parsed;
}

function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] broker ${process.pid}: ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] " +
        "[--state-file <path>] [--parent-pid <pid>] [--session-id <id>] [--idle-timeout-ms <ms>] [--max-threads <n>]"
    );
  }

  const { options } = parseArgs(argv, {
    valueOptions: [
      "cwd",
      "pid-file",
      "endpoint",
      "state-file",
      "parent-pid",
      "session-id",
      "idle-timeout-ms",
      "max-threads",
      "watch-interval-ms"
    ]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const stateFile = options["state-file"] ? path.resolve(options["state-file"]) : null;
  const sessionId = options["session-id"] ? String(options["session-id"]) : null;
  const parentPid = options["parent-pid"] ? Number(options["parent-pid"]) : null;
  const idleTimeoutMs = readDurationOption(options["idle-timeout-ms"], IDLE_TIMEOUT_ENV, DEFAULT_IDLE_TIMEOUT_MS);
  const maxThreads = readDurationOption(options["max-threads"], MAX_THREADS_ENV, DEFAULT_MAX_THREADS);
  const watchIntervalMs =
    readDurationOption(options["watch-interval-ms"], WATCH_INTERVAL_ENV, DEFAULT_WATCH_INTERVAL_MS) ||
    DEFAULT_WATCH_INTERVAL_MS;
  writePidFile(pidFile);

  let appClient = null;
  let recycling = null;
  let shuttingDown = false;
  let threadCount = 0;
  let lastActivityAt = Date.now();
  let parentGoneAt = null;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  let server = null;
  let watchTimer = null;

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function startAppClient() {
    const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    client.setNotificationHandler((message) => {
      lastActivityAt = Date.now();
      routeNotification(message);
      if (message.method === "turn/completed") {
        void maybeRecycle();
      }
    });
    client.exitPromise.then(() => {
      if (appClient === client && !shuttingDown && !recycling) {
        void shutdown(`codex app-server exited${client.exitError ? `: ${client.exitError.message}` : ""}`);
      }
    });
    return client;
  }

  async function closeAppClient(client) {
    const appServerPid = client.proc?.pid ?? null;
    // MCP servers run in their own process groups; remember them before the
    // app-server exits and they get reparented.
    const descendants = appServerPid ? listDescendantPids(appServerPid) : [];
    let exited = false;
    await Promise.race([
      client.close().then(
        () => {
          exited = true;
        },
        () => {
          exited = true;
        }
      ),
      sleep(APP_SERVER_EXIT_TIMEOUT_MS)
    ]);
    if (!exited && appServerPid) {
      killSurvivors([appServerPid]);
    }
    const pending = descendants.filter((pid) => isProcessAlive(pid));
    for (const pid of pending) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    if (pending.length > 0) {
      const deadline = Date.now() + MCP_EXIT_GRACE_MS;
      while (Date.now() < deadline && pending.some((pid) => isProcessAlive(pid))) {
        await sleep(100);
      }
      killSurvivors(pending);
    }
  }

  function isIdle() {
    return !recycling && !activeRequestSocket && !activeStreamSocket;
  }

  async function maybeRecycle() {
    if (shuttingDown || recycling || maxThreads <= 0 || threadCount < maxThreads || !isIdle() || sockets.size > 0) {
      return;
    }
    const previous = appClient;
    log(`recycling codex app-server after ${threadCount} threads`);
    recycling = (async () => {
      await closeAppClient(previous);
      threadCount = 0;
      appClient = await startAppClient();
    })();
    try {
      await recycling;
    } catch (error) {
      log(`recycle failed: ${error instanceof Error ? error.message : String(error)}`);
      recycling = null;
      await shutdown("codex app-server restart failed");
      return;
    }
    recycling = null;
  }

  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    clearInterval(watchTimer);
    for (const socket of sockets) {
      socket.end();
    }
    if (recycling) {
      await recycling.catch(() => {});
    }
    if (appClient) {
      await closeAppClient(appClient);
    }
    if (server) {
      await Promise.race([new Promise((resolve) => server.close(resolve)), sleep(1000)]);
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    if (listenTarget.kind === "unix") {
      removeIfExists(listenTarget.path);
    }
    clearBrokerStateFile(stateFile, { endpoint });
    unregisterSessionBroker(sessionId, endpoint);
    removeIfExists(pidFile);
    if (pidFile) {
      // The session dir also holds the log file our stdio still points at.
      try {
        fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    process.exit(0);
  }

  function watch() {
    if (shuttingDown) {
      return;
    }
    const now = Date.now();
    if (parentPid && parentGoneAt === null && !isProcessAlive(parentPid)) {
      parentGoneAt = now;
      log(`Claude session process ${parentPid} is gone`);
    }
    if (parentGoneAt !== null) {
      if ((sockets.size === 0 && isIdle()) || now - parentGoneAt >= ORPHAN_GRACE_MS) {
        void shutdown(`Claude session process ${parentPid} exited`);
      }
      return;
    }
    if (idleTimeoutMs > 0 && sockets.size === 0 && isIdle() && now - lastActivityAt >= idleTimeoutMs) {
      void shutdown(`idle for ${Math.round((now - lastActivityAt) / 1000)}s`);
      return;
    }
    void maybeRecycle();
  }

  appClient = await startAppClient();
  watchTimer = setInterval(watch, Math.min(watchIntervalMs, idleTimeoutMs > 0 ? idleTimeoutMs : watchIntervalMs));

  server = net.createServer((socket) => {
    sockets.add(socket);
    lastActivityAt = Date.now();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      lastActivityAt = Date.now();
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown("shutdown requested");
        }

        if (message.id === undefined) {
          continue;
        }

        if (recycling) {
          await recycling.catch(() => {});
        }
        if (shuttingDown) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is shutting down.")
          });
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          if (THREAD_LOADING_METHODS.has(message.method)) {
            threadCount += 1;
          }
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      lastActivityAt = Date.now();
      void maybeRecycle();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
