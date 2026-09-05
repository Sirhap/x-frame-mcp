"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MCP_TOOL_NAMES } = require("../xsxb_mcp_service");
const { runUsabilityAudit } = require("../xsxb_mcp_tool_usability");

test("every MCP tool has an isolated usability probe and none fail", async () => {
  const audit = await runUsabilityAudit();
  assert.deepEqual(
    audit.results.map((row) => row.tool),
    MCP_TOOL_NAMES,
  );
  assert.equal(audit.transport, "tools/call");
  assert.ok(
    audit.results.every((row) => row.publicCalls > 0),
    "every ready verdict has public MCP evidence",
  );
  assert.equal(audit.missing.length, 0);
  assert.equal(audit.counts.fail, 0, JSON.stringify(audit.results.filter((row) => row.status === "fail")));
  assert.equal(audit.counts.stub, 0, JSON.stringify(audit.results.filter((row) => row.status === "stub")));
  assert.equal(audit.counts.ready, MCP_TOOL_NAMES.length);
});
