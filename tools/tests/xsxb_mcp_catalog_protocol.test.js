"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { handleMessage, startServer, INSTRUCTIONS } = require("../../mcp/xsxb_mcp_server");
const { toolDefinitions } = require("../../mcp/xsxb_mcp_tool_catalog");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");

/** Builds a JSON-RPC request for the public transport seam. */
function request(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

/**
 * Yields the event loop so STDIO handlers can settle.
 * @returns {Promise<void>}
 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("wire catalog omits shared envelopes and stays within the compact payload budget", async () => {
  const service = createXsxbMcpService({ florenceDetectImpl: null });
  try {
    const listed = await handleMessage(request(1, "tools/list"), service);
    assert.equal(listed.result.tools.length, toolDefinitions().length);
    assert.ok(listed.result.tools.every((tool) => tool.outputSchema === undefined));
    assert.ok(JSON.stringify(listed.result).length < 100_000);
    assert.ok(toolDefinitions().every((tool) => tool.outputSchema.type === "object"));
  } finally {
    service.close();
  }
});

test("initialize instructions are self-contained and do not advertise missing methods", async () => {
  const service = { tools: [] };
  const initialized = await handleMessage(request(1, "initialize"), service);
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.ok(INSTRUCTIONS.length < 2000, "initialize must not embed full playbooks");
  assert.doesNotMatch(
    INSTRUCTIONS,
    /Register\/plant\/estimate\/compress preview/,
    "estimate_boxes commits when dry_run is omitted; do not list it with preview-until-apply tools",
  );
  assert.match(INSTRUCTIONS, /Register\/plant\/compress preview until apply or dry_run:false/);
  assert.match(INSTRUCTIONS, /suggestedGameFps/);
  assert.doesNotMatch(INSTRUCTIONS, /prompts\/(list|get)|resources\/(list|read)/);
  assert.match(INSTRUCTIONS, /xsxb_measure_frames/);
  assert.match(INSTRUCTIONS, /xsxb_get_animation/);
  assert.match(INSTRUCTIONS, /xsxb_analyze/);
  assert.match(INSTRUCTIONS, /xsxb_plan_place/);
  assert.match(INSTRUCTIONS, /xsxb_plan_smear/);
  assert.match(INSTRUCTIONS, /dry_run:false/);
  assert.match(INSTRUCTIONS, /xsxb_diff_frames/);
  assert.match(INSTRUCTIONS, /xsxb_validate_for_godot/);
  assert.match(INSTRUCTIONS, /skills\/x-frame/);
  assert.match(INSTRUCTIONS, /qa=warn/);
  const importSkill = fs.readFileSync(path.join(__dirname, "../../skills/x-frame-import/SKILL.md"), "utf8");
  assert.match(importSkill, /suggestedGameFps/);
  assert.match(importSkill, /export_gif/);
  assert.equal((await handleMessage(request(2, "prompts/list"), service)).error.code, -32601);
  assert.equal(
    (await handleMessage(request(3, "resources/read", { uri: "xsxb://docs/session" }), service)).error.code,
    -32601,
  );
});

test("ping bypasses an active tool while writes and tools/list remain ordered", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  const started = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = {
    tools: [],
    async call(name) {
      started.push(name);
      if (name === "first") await gate;
      return { name };
    },
  };
  output.on("data", (chunk) => replies.push(JSON.parse(chunk.toString())));
  const lines = startServer({ input, output, service });
  try {
    input.write(JSON.stringify(request(1, "tools/call", { name: "first" })) + "\n");
    for (let i = 0; i < 20 && started[0] !== "first"; i += 1) await tick();
    input.write(JSON.stringify(request(2, "tools/call", { name: "second" })) + "\n");
    input.write(JSON.stringify(request(3, "ping")) + "\n");
    input.write(JSON.stringify(request(4, "tools/list")) + "\n");
    await tick();
    assert.deepEqual(started, ["first"]);
    assert.deepEqual(
      replies.map((r) => r.id),
      [3],
    );
    release();
    for (let i = 0; i < 20 && replies.length < 4; i += 1) await tick();
    assert.deepEqual(started, ["first", "second"]);
    assert.deepEqual(
      replies.map((r) => r.id),
      [3, 1, 2, 4],
    );
  } finally {
    release();
    lines.close();
    input.destroy();
    output.destroy();
  }
});
