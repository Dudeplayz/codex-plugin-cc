#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import {
  CLAUDE_PID_ENV,
  isProcessAlive,
  resolveClaudeSessionPid,
  terminateProcessTree,
  terminateProcessTreeDeep
} from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  isBrokerProcess,
  LOG_FILE_ENV,
  loadBrokerSession,
  loadSessionBrokers,
  PID_FILE_ENV,
  removeSessionRegistry,
  sendBrokerShutdown,
  teardownBrokerSession,
  unregisterSessionBroker
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// SessionEnd hooks get 5 seconds; leave room for teardown and job cleanup.
const BROKER_SHUTDOWN_BUDGET_MS = 2500;
const BROKER_SHUTDOWN_REQUEST_MS = 1000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  // Brokers watch this PID and exit once the Claude session is gone, even when
  // SessionEnd never runs (crash, kill, closed app window).
  appendEnvVar(CLAUDE_PID_ENV, resolveClaudeSessionPid());
}

async function waitForExit(pid, deadline) {
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

async function shutdownBroker(broker, deadline) {
  const pid = Number.isInteger(broker.pid) ? broker.pid : null;
  // Saved PIDs can be reused after the broker exits; only a process that still
  // runs the broker for this endpoint may be signalled.
  const ownedPid = pid !== null && isBrokerProcess(pid, broker.endpoint) ? pid : null;
  if (broker.endpoint) {
    await sendBrokerShutdown(broker.endpoint, Math.max(0, Math.min(BROKER_SHUTDOWN_REQUEST_MS, deadline - Date.now())));
  }
  const exited = ownedPid === null || (await waitForExit(ownedPid, deadline));
  teardownBrokerSession({
    endpoint: broker.endpoint ?? null,
    pidFile: broker.pidFile ?? null,
    logFile: broker.logFile ?? null,
    sessionDir: broker.sessionDir ?? null,
    pid: ownedPid,
    killProcess: exited ? null : (target) => isBrokerProcess(target, broker.endpoint) && terminateProcessTreeDeep(target)
  });
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const cwdBroker =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);

  // The session may have started brokers for other workspaces too (worktrees,
  // `--cwd`), so shut down everything registered under its session id.
  const brokers = [];
  const seenEndpoints = new Set();
  for (const broker of [cwdBroker ? { ...cwdBroker, cwd } : null, ...loadSessionBrokers(sessionId)]) {
    if (!broker || (broker.endpoint && seenEndpoints.has(broker.endpoint))) {
      continue;
    }
    seenEndpoints.add(broker.endpoint);
    brokers.push(broker);
  }

  const deadline = Date.now() + BROKER_SHUTDOWN_BUDGET_MS;
  await Promise.all(brokers.map((broker) => shutdownBroker(broker, deadline)));

  const workspaces = new Set([cwd, ...brokers.map((broker) => broker.cwd).filter(Boolean)]);
  for (const workspace of workspaces) {
    cleanupSessionJobs(workspace, sessionId);
  }
  for (const broker of brokers) {
    clearBrokerSession(broker.cwd ?? cwd, broker.cwd && broker.cwd !== cwd ? { endpoint: broker.endpoint } : {});
    unregisterSessionBroker(sessionId, broker.endpoint);
  }
  if (brokers.length === 0) {
    clearBrokerSession(cwd);
  }
  removeSessionRegistry(sessionId);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
