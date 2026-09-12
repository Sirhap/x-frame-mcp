"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { compositeAttackTrails } = require("../../mcp/xsxb_mcp_trail_preview");

/** Exercises persisted sweep bindings and the same compositor used by sheet/GIF export. */
test("sweep tool bakes linear blade history and expires by elapsed time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-sweep-tool-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  let baked;
  try {
    const sequence = path.join(root, "frames");
    fs.mkdirSync(sequence);
    const framePaths = Array.from({ length: 6 }, (_, index) => path.join(sequence, `${index}.png`));
    for (const file of framePaths)
      fs.writeFileSync(file, encodePngRgba(new Uint8ClampedArray(64 * 64 * 4), 64, 64));
    const created = await service.callMcp("xsxb_create_project", { project_id: "sweep", label: "Sweep" });
    assert.ok(created.ok, JSON.stringify(created));
    const imported = await service.callMcp("xsxb_import_animation", {
      project_id: "sweep",
      source: "png_sequence",
      directory: sequence,
      animation_id: "attack",
      fps: 10,
    });
    assert.ok(imported.ok, JSON.stringify(imported));
    const added = await service.callMcp("xsxb_add_attack_trail", {
      project_id: "sweep",
      animation_id: "attack",
      id: "sweep",
      render_mode: "sweep",
      path_kind: "polyline",
      trail_duration_ms: 150,
      opacity: 1,
      color: "#00aaff",
      sticks: [
        { frame: 0, top: { x: -20, y: -40 }, bottom: { x: -20, y: -20 }, layer: "front" },
        { frame: 1, top: { x: 0, y: -40 }, bottom: { x: 0, y: -20 }, layer: "front" },
        { frame: 2, top: { x: 20, y: -40 }, bottom: { x: 20, y: -20 }, layer: "front" },
      ],
    });
    assert.ok(added.ok, JSON.stringify(added));
    assert.equal(added.data.segment.renderMode, "sweep");
    baked = await compositeAttackTrails({
      root,
      framePaths,
      frameIndexes: [0, 1, 2, 3, 4, 5],
      fps: 10,
      durations: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      bindingKey: added.data.bindingKey,
      trails: { bindings: { [added.data.bindingKey]: [added.data.segment] } },
    });
    assert.equal(baked.bakedTrails, true);
    const active = decodePngRgba(baked.framePaths[1]);
    const visible = Array.from(active.data).filter((value, index) => index % 4 === 3 && value > 32).length;
    assert.ok(visible > 100, `Expected visible filled ribbon, got ${visible}`);
    const expired = decodePngRgba(baked.framePaths[4]);
    assert.ok(
      expired.data.every((value, index) => index % 4 !== 3 || value === 0),
      "No visible trail after lifetime",
    );
    const sheet = await service.callMcp("xsxb_export_sheet", {
      project_id: "sweep",
      animation_id: "attack",
      grid: false,
      output_path: path.join(root, "sheet.png"),
    });
    assert.ok(sheet.ok, JSON.stringify(sheet));
    await assert.rejects(
      service.callMcp("xsxb_add_attack_trail", {
        project_id: "sweep",
        animation_id: "attack",
        render_mode: "sweep",
      }),
      { code: "SWEEP_STICKS_REQUIRED" },
    );
  } finally {
    service.close();
    if (baked?.tempDir) fs.rmSync(baked.tempDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
