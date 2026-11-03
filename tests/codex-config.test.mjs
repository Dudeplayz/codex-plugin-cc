import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMcpServerConfig,
  buildThreadParams,
  parseMcpSelection
} from "../plugins/codex/scripts/lib/codex.mjs";

const CONFIGURED = { rea: { enabled: false }, playwright: { enabled: false }, context7: {} };

test("parseMcpSelection keeps the Codex config for all or nothing", () => {
  assert.equal(parseMcpSelection(undefined), null);
  assert.equal(parseMcpSelection(""), null);
  assert.equal(parseMcpSelection("all"), null);
});

test("parseMcpSelection reads additions, removals and none", () => {
  assert.deepEqual(parseMcpSelection(" rea, +playwright ,rea"), {
    exclusive: false,
    enable: ["rea", "playwright"],
    disable: []
  });
  assert.deepEqual(parseMcpSelection("-context7"), { exclusive: false, enable: [], disable: ["context7"] });
  assert.deepEqual(parseMcpSelection("none"), { exclusive: true, enable: [], disable: [] });
  assert.deepEqual(parseMcpSelection("none,rea"), { exclusive: true, enable: ["rea"], disable: [] });
});

test("buildMcpServerConfig switches on the named servers on top of the Codex config", () => {
  assert.equal(buildMcpServerConfig(CONFIGURED, null), null);
  assert.deepEqual(buildMcpServerConfig(CONFIGURED, parseMcpSelection("rea")), {
    mcp_servers: { rea: { enabled: true } }
  });
  assert.deepEqual(buildMcpServerConfig(CONFIGURED, parseMcpSelection("rea,-context7")), {
    mcp_servers: { rea: { enabled: true }, context7: { enabled: false } }
  });
});

test("buildMcpServerConfig with none runs only the named servers", () => {
  assert.deepEqual(buildMcpServerConfig(CONFIGURED, parseMcpSelection("none")), {
    mcp_servers: { rea: { enabled: false }, playwright: { enabled: false }, context7: { enabled: false } }
  });
  assert.deepEqual(buildMcpServerConfig(CONFIGURED, parseMcpSelection("none,rea")), {
    mcp_servers: { rea: { enabled: true }, playwright: { enabled: false }, context7: { enabled: false } }
  });
});

test("buildMcpServerConfig rejects unknown servers", () => {
  assert.throws(() => buildMcpServerConfig({ rea: {} }, parseMcpSelection("reaa")), /Unknown MCP server: reaa\. Configured: rea\./);
  assert.throws(() => buildMcpServerConfig({ rea: {} }, parseMcpSelection("-nope")), /Unknown MCP server: nope/);
});

test("buildThreadParams only sends config when one is set", () => {
  assert.equal("config" in buildThreadParams("/repo"), false);
  const config = { mcp_servers: { rea: { enabled: true } } };
  assert.deepEqual(buildThreadParams("/repo", { config }).config, config);
});
