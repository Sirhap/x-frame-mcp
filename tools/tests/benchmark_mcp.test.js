"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { toolAndPing } = require("../benchmark_mcp");

/** Starts a real STDIO server whose tool deliberately blocks or yields. */
function fixtureServer(blocking) {
  const benchmark = path.resolve(__dirname, "../benchmark_mcp.js");
  const server = path.resolve(__dirname, "../../mcp/xsxb_mcp_server.js");
  const script = `
    const { instrumentService } = require(${JSON.stringify(benchmark)});
    const { startServer } = require(${JSON.stringify(server)});
    startServer({ service: instrumentService({
      tools: [],
      async callMcp() {
        if (${blocking}) {
          const deadline = performance.now() + 300;
          while (performance.now() < deadline) {}
        } else await new Promise(resolve => setTimeout(resolve, 300));
        return { ok: true, data: { completed: true } };
      }
    }) });
  `;
  return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
}

for (const blocking of [true, false]) {
  test(`benchmark probes during ${blocking ? "synchronous" : "asynchronous"} tool execution`, async () => {
    const child = fixtureServer(blocking);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const result = await toolAndPing(child, "fixture", {});
      assert.equal(result.receipt.data.completed, true);
      assert.equal(result.pingIssuedDuringTool, true);
      if (blocking) assert.ok(result.pingMs > 100, `busy ping returned in ${result.pingMs} ms`);
      else assert.ok(result.pingMs < result.toolMs - 100, "yielding tool should allow ping through");
    } finally {
      child.kill();
      await exited;
    }
  });
}

test("benchmark rejects an exited server without waiting for the request timeout", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  await assert.rejects(toolAndPing(child, "fixture", {}), /Benchmark server exited/);
});
