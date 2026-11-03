import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Tests often run inside a Claude Code session. Drop the variables it exports so
// test jobs and brokers do not attach to that session or its plugin data, and
// tie every broker a test spawns to the test process so none outlives the run.
for (const name of Object.keys(process.env)) {
  if (/^(CODEX_COMPANION_|CLAUDE_PLUGIN_)/.test(name) || name === "CLAUDE_CODE_SESSION_ID" || name === "CLAUDE_PID") {
    delete process.env[name];
  }
}
process.env.CODEX_COMPANION_CLAUDE_PID = String(process.pid);
process.env.CODEX_COMPANION_BROKER_WATCH_INTERVAL_MS = "200";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
