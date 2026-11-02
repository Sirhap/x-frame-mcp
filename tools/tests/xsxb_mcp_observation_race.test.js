"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { handleMessage } = require("../../mcp/xsxb_mcp_server");

/** Creates a real imported frame and always releases its temporary project. */
async function withAnimation(operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-observation-race-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const pixels = new Uint8ClampedArray(8 * 8 * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([255, 0, 0, 255], index);
  try {
    await service.callMcp("xsxb_create_project", { project_id: "race" });
    await service.callMcp("xsxb_import_animation", {
      source: "items",
      animation_id: "walk",
      items: [{ data: `data:image/png;base64,${encodePngRgba(pixels, 8, 8).toString("base64")}` }],
    });
    const initial = await service.callMcp("xsxb_get_animation");
    await operation({ service, file: initial.data.animation.frames[0].absolutePath, initial, pixels });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const tool of ["xsxb_get_animation", "xsxb_measure_frames", "xsxb_export_sheet"]) {
  test(`${tool} refuses a source changed after observation through public JSON-RPC`, async () => {
    await withAnimation(async ({ service, file, pixels }) => {
      for (let index = 0; index < pixels.length; index += 4) pixels.set([0, 255, 0, 255], index);
      const replacement = encodePngRgba(pixels, 8, 8);
      const readFile = fs.readFileSync;
      let changed = false;
      // Replace after returning the original bytes to the preflight digest.
      // This deterministically models an external writer during the request.
      fs.readFileSync = (target, ...args) => {
        const bytes = readFile(target, ...args);
        if (target === file && !changed) {
          changed = true;
          fs.writeFileSync(file, replacement);
        }
        return bytes;
      };
      let response;
      try {
        response = await handleMessage(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } },
          service,
        );
      } finally {
        fs.readFileSync = readFile;
      }
      assert.equal(changed, true, "the request must exercise the injected external write");
      assert.equal(response.result.isError, true);
      const receipt = response.result.structuredContent;
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, "STALE_SNAPSHOT");
      assert.notEqual(receipt.error.details.expected, receipt.error.details.actual);
      assert.deepEqual(fs.readFileSync(file), replacement, "read tools must preserve external edits");
    });
  });
}

test("unchanged observations retain their content id across reads and exports", async () => {
  await withAnimation(async ({ service, initial }) => {
    for (const name of ["xsxb_get_animation", "xsxb_measure_frames", "xsxb_export_sheet"]) {
      const receipt = await service.callMcp(name);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.observation.snapshotId, initial.observation.snapshotId);
    }
  });
});
