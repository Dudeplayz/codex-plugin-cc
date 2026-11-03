import test from "node:test";
import assert from "node:assert/strict";

import {
  listDescendantPids,
  resolveClaudeSessionPid,
  terminateProcessTree,
  terminateProcessTreeDeep
} from "../plugins/codex/scripts/lib/process.mjs";

function psResult(stdout) {
  return { command: "ps", args: [], status: 0, signal: null, stdout, stderr: "", error: null };
}

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("listDescendantPids walks children that left the process group", () => {
  const table = ["10 1 broker", "11 10 codex", "12 11 node", "13 11 node_repl", "14 12 npm", "20 1 other"].join("\n");
  const pids = listDescendantPids(10, {
    platform: "darwin",
    runCommandImpl: () => psResult(table)
  });
  assert.deepEqual(pids, [11, 12, 13, 14]);
});

test("terminateProcessTreeDeep signals the group and every descendant", () => {
  const signals = [];
  const outcome = terminateProcessTreeDeep(10, {
    platform: "darwin",
    runCommandImpl: () => psResult("11 10 codex\n12 11 node\n"),
    killImpl(pid, signal) {
      signals.push([pid, signal]);
    }
  });
  assert.deepEqual(outcome.pids, [10, 11, 12]);
  assert.deepEqual(signals, [
    [-10, "SIGTERM"],
    [11, "SIGTERM"],
    [12, "SIGTERM"]
  ]);
});

test("resolveClaudeSessionPid prefers a live CLAUDE_PID", () => {
  const pid = resolveClaudeSessionPid({
    env: { CLAUDE_PID: "4242" },
    killImpl(target, signal) {
      assert.equal(target, 4242);
      assert.equal(signal, 0);
    },
    runCommandImpl() {
      throw new Error("ancestor walk should not run");
    }
  });
  assert.equal(pid, 4242);
});

test("resolveClaudeSessionPid falls back to the nearest claude ancestor", () => {
  const parents = new Map([
    [300, "200 /bin/zsh"],
    [200, "100 /Applications/Claude.app/Contents/MacOS/claude"],
    [100, "1 /sbin/launchd"]
  ]);
  const pid = resolveClaudeSessionPid({
    env: { CLAUDE_PID: "999" },
    platform: "darwin",
    startPid: 300,
    killImpl() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    },
    runCommandImpl(command, args) {
      return psResult(parents.get(Number(args.at(-1))) ?? "");
    }
  });
  assert.equal(pid, 200);
});
