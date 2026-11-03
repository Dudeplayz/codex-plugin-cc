import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

function readProcessTable(runCommandImpl) {
  const result = runCommandImpl("ps", ["-axo", "pid=,ppid=,comm="]);
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] }));
}

export function listDescendantPids(rootPid, options = {}) {
  if (!Number.isFinite(rootPid) || (options.platform ?? process.platform) === "win32") {
    return [];
  }
  const table = readProcessTable(options.runCommandImpl ?? runCommand);
  const childrenByParent = new Map();
  for (const entry of table) {
    if (!childrenByParent.has(entry.ppid)) {
      childrenByParent.set(entry.ppid, []);
    }
    childrenByParent.get(entry.ppid).push(entry.pid);
  }
  const descendants = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

/**
 * Terminates a process, its process group, and every descendant, including
 * children that moved into their own process group (Codex starts each MCP
 * server that way, so a group kill alone leaves them behind).
 */
export function terminateProcessTreeDeep(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, pids: [] };
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const result = terminateProcessTree(pid, options);
    return { ...result, pids: [pid] };
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  const descendants = listDescendantPids(pid, options);
  const result = terminateProcessTree(pid, options);
  for (const child of descendants) {
    try {
      killImpl(child, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  return { ...result, pids: [pid, ...descendants] };
}

export function killSurvivors(pids, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const survivors = pids.filter((pid) => isProcessAlive(pid, { killImpl }));
  for (const pid of survivors) {
    try {
      killImpl(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return survivors;
}

function readParentPid(pid, runCommandImpl) {
  const result = runCommandImpl("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
  if (result.error || result.status !== 0) {
    return null;
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(.*)$/);
  return match ? { ppid: Number(match[1]), comm: match[2] } : null;
}

export const CLAUDE_PID_ENV = "CODEX_COMPANION_CLAUDE_PID";

/**
 * Finds the PID of the Claude Code session that owns this process: an explicit
 * env override, Claude Code's own CLAUDE_PID, or the nearest `claude` ancestor.
 */
export function resolveClaudeSessionPid(options = {}) {
  const env = options.env ?? process.env;
  const killImpl = options.killImpl;
  for (const name of [CLAUDE_PID_ENV, "CLAUDE_PID"]) {
    const value = Number(env[name]);
    if (Number.isInteger(value) && value > 1 && isProcessAlive(value, { killImpl })) {
      return value;
    }
  }
  if ((options.platform ?? process.platform) === "win32") {
    return null;
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  let pid = options.startPid ?? process.ppid;
  for (let depth = 0; depth < 32 && pid > 1; depth += 1) {
    const info = readParentPid(pid, runCommandImpl);
    if (!info) {
      return null;
    }
    if (/(^|\/)claude$/i.test(info.comm.trim())) {
      return pid;
    }
    pid = info.ppid;
  }
  return null;
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
