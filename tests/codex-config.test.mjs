import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMcpServerConfig,
  buildThreadParams,
  parseMcpSelection
} from "../plugins/codex/scripts/lib/codex.mjs";

test("parseMcpSelection keeps the Codex config for all or nothing", () => {
  assert.equal(parseMcpSelection(undefined), null);
  assert.equal(parseMcpSelection(""), null);
  assert.equal(parseMcpSelection("all"), null);
  assert.deepEqual(parseMcpSelection("none"), []);
  assert.deepEqual(parseMcpSelection(" rea, playwright ,rea"), ["rea", "playwright"]);
});

test("buildMcpServerConfig enables only the selected servers", () => {
  const configured = { rea: { enabled: false }, playwright: {}, node_repl: {} };
  assert.equal(buildMcpServerConfig(configured, null), null);
  assert.deepEqual(buildMcpServerConfig(configured, ["rea"]), {
    mcp_servers: { rea: { enabled: true }, playwright: { enabled: false }, node_repl: { enabled: false } }
  });
  assert.deepEqual(buildMcpServerConfig(configured, []), {
    mcp_servers: { rea: { enabled: false }, playwright: { enabled: false }, node_repl: { enabled: false } }
  });
});

test("buildMcpServerConfig rejects unknown servers", () => {
  assert.throws(() => buildMcpServerConfig({ rea: {} }, ["reaa"]), /Unknown MCP server: reaa\. Configured: rea\./);
});

test("buildThreadParams only sends config when one is set", () => {
  assert.equal("config" in buildThreadParams("/repo"), false);
  const config = { mcp_servers: { rea: { enabled: true } } };
  assert.deepEqual(buildThreadParams("/repo", { config }).config, config);
});
