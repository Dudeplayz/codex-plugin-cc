import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  loadSessionBrokers
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { isProcessAlive, terminateProcessTreeDeep } from "../plugins/codex/scripts/lib/process.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "plugins", "codex", "scripts");
const BROKER = path.join(SCRIPTS, "app-server-broker.mjs");
const SESSION_HOOK = path.join(SCRIPTS, "session-lifecycle-hook.mjs");

const spawnedPids = new Set();

// Whatever a test leaves running dies with the suite, even when an assertion
// fails half-way.
test.after(() => {
  for (const pid of spawnedPids) {
    if (isProcessAlive(pid)) {
      terminateProcessTreeDeep(pid);
    }
  }
});

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function setupWorkspace() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  return { repo, binDir, env: buildEnv(binDir), fakeStatePath: path.join(binDir, "fake-codex-state.json") };
}

function startBroker({ cwd, env, extraArgs = [] }) {
  const sessionDir = makeTempDir("cxc-test-");
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const child = spawn(process.execPath, [BROKER, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile, ...extraArgs], {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  spawnedPids.add(child.pid);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, endpoint, sessionDir, pidFile, exited, stderr: () => stderr };
}

async function connect(endpoint) {
  const socketPath = endpoint.replace(/^unix:/, "");
  await waitFor(() => fs.existsSync(socketPath));
  const socket = net.createConnection({ path: socketPath });
  socket.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  const waiting = new Map();
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  let nextId = 1;
  return {
    socket,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() {
      return new Promise((resolve) => {
        socket.once("close", resolve);
        socket.end();
      });
    }
  };
}

test("broker shuts down and cleans up after the idle timeout", async () => {
  const { repo, env } = setupWorkspace();
  const stateFile = path.join(makeTempDir(), "broker.json");
  fs.writeFileSync(stateFile, "{}\n");
  const broker = startBroker({
    cwd: repo,
    env,
    extraArgs: ["--idle-timeout-ms", "400", "--watch-interval-ms", "100", "--state-file", stateFile]
  });
  // The fixture state file describes a different endpoint, so it must survive.
  const ownStateFile = path.join(makeTempDir(), "broker.json");

  const client = await connect(broker.endpoint);
  await client.request("initialize", {});
  await client.close();

  const code = await broker.exited;
  assert.equal(code, 0, broker.stderr());
  assert.match(broker.stderr(), /shutting down: idle for/);
  assert.equal(fs.existsSync(broker.sessionDir), false);
  assert.equal(fs.existsSync(stateFile), true);

  // A broker.json that still points at the broker is removed with it.
  const second = startBroker({
    cwd: repo,
    env,
    extraArgs: ["--idle-timeout-ms", "300", "--watch-interval-ms", "100", "--state-file", ownStateFile]
  });
  fs.writeFileSync(ownStateFile, `${JSON.stringify({ endpoint: second.endpoint })}\n`);
  assert.equal(await second.exited, 0, second.stderr());
  assert.equal(fs.existsSync(ownStateFile), false);
});

test("broker stays up while a client is connected", async () => {
  const { repo, env } = setupWorkspace();
  const broker = startBroker({ cwd: repo, env, extraArgs: ["--idle-timeout-ms", "300", "--watch-interval-ms", "100"] });
  const client = await connect(broker.endpoint);
  await client.request("initialize", {});
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(isProcessAlive(broker.child.pid), true);
  await client.close();
  assert.equal(await broker.exited, 0, broker.stderr());
});

test("broker exits once the Claude session process is gone", async () => {
  const { repo, env } = setupWorkspace();
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawnedPids.add(parent.pid);
  const broker = startBroker({
    cwd: repo,
    env,
    extraArgs: ["--parent-pid", String(parent.pid), "--idle-timeout-ms", "0", "--watch-interval-ms", "100"]
  });
  const client = await connect(broker.endpoint);
  await client.request("initialize", {});
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(isProcessAlive(broker.child.pid), true);

  parent.kill("SIGKILL");
  assert.equal(await broker.exited, 0, broker.stderr());
  assert.match(broker.stderr(), new RegExp(`Claude session process ${parent.pid} exited`));
});

test("broker restarts the app-server after the thread limit once idle", async () => {
  const { repo, env, fakeStatePath } = setupWorkspace();
  const broker = startBroker({ cwd: repo, env, extraArgs: ["--max-threads", "2", "--watch-interval-ms", "100"] });

  for (let round = 0; round < 2; round += 1) {
    const client = await connect(broker.endpoint);
    await client.request("initialize", {});
    const response = await client.request("thread/start", { cwd: repo, ephemeral: true });
    assert.ok(response.result?.thread?.id, JSON.stringify(response));
    await client.close();
  }

  await waitFor(() => JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts === 2);
  assert.match(broker.stderr(), /recycling codex app-server after 2 threads/);

  // The fresh app-server keeps serving requests.
  const client = await connect(broker.endpoint);
  await client.request("initialize", {});
  const response = await client.request("thread/start", { cwd: repo, ephemeral: true });
  assert.ok(response.result?.thread?.id, JSON.stringify(response));
  await client.request("broker/shutdown", {});
  assert.equal(await broker.exited, 0, broker.stderr());
});

test("SessionEnd shuts down every broker the session started", async () => {
  const first = setupWorkspace();
  const second = setupWorkspace();
  const pluginData = makeTempDir();
  const sessionId = `sess-${process.pid}`;
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const sessions = [];
    for (const workspace of [first, second]) {
      const env = { ...workspace.env, CLAUDE_PLUGIN_DATA: pluginData, CODEX_COMPANION_SESSION_ID: sessionId };
      const session = await ensureBrokerSession(workspace.repo, { env });
      assert.ok(session, "broker should start");
      spawnedPids.add(session.pid);
      sessions.push(session);
    }
    assert.equal(loadSessionBrokers(sessionId).length, 2);

    const result = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: first.repo,
      env: { ...first.env, CLAUDE_PLUGIN_DATA: pluginData },
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: first.repo, session_id: sessionId })
    });
    assert.equal(result.status, 0, result.stderr);

    for (const session of sessions) {
      await waitFor(() => !isProcessAlive(session.pid));
      assert.equal(fs.existsSync(session.sessionDir), false);
    }
    assert.equal(loadBrokerSession(first.repo), null);
    assert.equal(loadBrokerSession(second.repo), null);
    assert.deepEqual(loadSessionBrokers(sessionId), []);
  } finally {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("ensureBrokerSession records the Claude session and its PID", async () => {
  const { repo, env } = setupWorkspace();
  const session = await ensureBrokerSession(repo, { env: { ...env, CODEX_COMPANION_SESSION_ID: "sess-record" } });
  assert.ok(session);
  spawnedPids.add(session.pid);
  try {
    assert.equal(session.sessionId, "sess-record");
    assert.equal(session.parentPid, process.pid);
    assert.equal(loadBrokerSession(repo).parentPid, process.pid);
  } finally {
    terminateProcessTreeDeep(session.pid);
    await waitFor(() => !isProcessAlive(session.pid));
  }
});
