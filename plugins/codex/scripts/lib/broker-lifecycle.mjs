import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { readProcessCommand, resolveClaudeSessionPid } from "./process.mjs";
import { resolveStateDir, resolveStateRootDir } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const SESSION_REGISTRY_DIR = "sessions";
const BROKER_SHUTDOWN_TIMEOUT_MS = 3000;

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, timeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    // A wedged broker must not block the SessionEnd hook; the caller kills it instead.
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    socket.on("close", () => clearTimeout(timer));
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  stateFile = null,
  parentPid = null,
  sessionId = null,
  env = process.env
}) {
  const logFd = fs.openSync(logFile, "a");
  const args = [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile];
  if (stateFile) {
    args.push("--state-file", stateFile);
  }
  if (Number.isInteger(parentPid) && parentPid > 1) {
    args.push("--parent-pid", String(parentPid));
  }
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd, options = {}) {
  clearBrokerStateFile(resolveBrokerStateFile(cwd), options);
}

/**
 * Removes a broker.json file. With `endpoint`, only removes it while it still
 * describes that broker, so a newer broker for the same workspace survives.
 */
export function clearBrokerStateFile(stateFile, { endpoint = null } = {}) {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return;
  }
  if (endpoint) {
    try {
      if (JSON.parse(fs.readFileSync(stateFile, "utf8")).endpoint !== endpoint) {
        return;
      }
    } catch {
      // Unreadable state is stale state.
    }
  }
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // Already removed.
  }
}

// Each broker gets its own registry file so brokers, commands and hooks of the
// same session never overwrite each other's entries.
function resolveSessionRegistryDir(sessionId) {
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join(resolveStateRootDir(), SESSION_REGISTRY_DIR, safeId);
}

function resolveSessionRegistryFile(sessionId, endpoint) {
  const key = createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 16);
  return path.join(resolveSessionRegistryDir(sessionId), `${key}.json`);
}

/** Lists every broker a Claude session started, across all workspaces. */
export function loadSessionBrokers(sessionId) {
  if (!sessionId) {
    return [];
  }
  const registryDir = resolveSessionRegistryDir(sessionId);
  let entries;
  try {
    entries = fs.readdirSync(registryDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const brokers = [];
  for (const name of entries) {
    try {
      brokers.push(JSON.parse(fs.readFileSync(path.join(registryDir, name), "utf8")));
    } catch {
      // Removed concurrently.
    }
  }
  return brokers;
}

export function registerSessionBroker(sessionId, broker) {
  if (!sessionId || !broker?.endpoint) {
    return;
  }
  const registryFile = resolveSessionRegistryFile(sessionId, broker.endpoint);
  const tempFile = `${registryFile}.${process.pid}.tmp`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(tempFile, `${JSON.stringify(broker, null, 2)}\n`, "utf8");
      fs.renameSync(tempFile, registryFile);
      return;
    } catch (error) {
      // SessionEnd may remove the session directory in between; recreate it.
      if (error?.code !== "ENOENT" || attempt >= 2) {
        throw error;
      }
    }
  }
}

export function unregisterSessionBroker(sessionId, endpoint) {
  if (!sessionId || !endpoint) {
    return;
  }
  try {
    fs.unlinkSync(resolveSessionRegistryFile(sessionId, endpoint));
  } catch {
    // Already removed.
  }
}

/** Removes the session's registry directory once the session has ended. */
export function removeSessionRegistry(sessionId) {
  if (!sessionId) {
    return;
  }
  try {
    fs.rmdirSync(resolveSessionRegistryDir(sessionId));
  } catch {
    // Not empty or already removed.
  }
}

/**
 * Tells whether `pid` is still the broker serving `endpoint`, so a PID taken
 * from saved state is never signalled after the OS reused it.
 */
export function isBrokerProcess(pid, endpoint, options = {}) {
  const command = readProcessCommand(pid, options);
  return Boolean(command && endpoint && command.includes("app-server-broker.mjs") && command.includes(endpoint));
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const env = options.env ?? process.env;
  const sessionId = options.sessionId ?? env[SESSION_ID_ENV] ?? null;
  const parentPid = options.parentPid !== undefined ? options.parentPid : resolveClaudeSessionPid({ env });
  const stateFile = resolveBrokerStateFile(cwd);
  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    stateFile,
    parentPid,
    sessionId,
    env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    cwd,
    sessionId,
    parentPid: parentPid ?? null
  };
  saveBrokerSession(cwd, session);
  registerSessionBroker(sessionId, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
