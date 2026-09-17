"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decodePngRgba, encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { overlayIdFor } = require("../../mcp/xsxb_mcp_place");
const { paintCrescentRgba, planSmear } = require("../../mcp/xsxb_mcp_paint_smear");
const { createXsxbMcpService } = require("../xsxb_mcp_service");

/**
 * Writes one RGBA pixel.
 * @param {Uint8ClampedArray} rgba Buffer.
 * @param {number} width Width.
 * @param {number} x X.
 * @param {number} y Y.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {void}
 */
function setPixel(rgba, width, x, y, r, g, b, a) {
  const off = (y * width + x) * 4;
  rgba[off] = r;
  rgba[off + 1] = g;
  rgba[off + 2] = b;
  rgba[off + 3] = a;
}

/**
 * Counts smear-cyan pixels (not the navy blade).
 * @param {Uint8ClampedArray} rgba Buffer.
 * @returns {number} Count.
 */
function countCyan(rgba) {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 40) continue;
    if (rgba[i + 2] > 180 && rgba[i + 1] > 140 && rgba[i] < 140) count += 1;
  }
  return count;
}

test("paintCrescentRgba fills a hollow arc and leaves the pivot empty", () => {
  const width = 80;
  const height = 80;
  const painted = paintCrescentRgba(width, height, {
    pivot: { x: 20, y: 40 },
    tip: { x: 62, y: 40 },
    color: { r: 48, g: 196, b: 255 },
    arcDegrees: 120,
    innerRatio: 0.4,
    outerScale: 1.12,
  });
  assert.ok(painted.painted > 200, `crescent too thin (${painted.painted})`);
  const hollow = painted.data[(40 * width + 22) * 4 + 3];
  assert.ok(hollow < 20, `pivot must stay inside the hollow, alpha=${hollow}`);
  const outer = painted.data[(40 * width + 58) * 4 + 3];
  assert.ok(outer > 40, `outer band at the tip radius must paint, alpha=${outer}`);
  const above = painted.data[(18 * width + 50) * 4 + 3];
  const below = painted.data[(62 * width + 50) * 4 + 3];
  assert.ok(above > 20 && below > 20, "arc must reach both sides of the blade");
});

test("a high inner_ratio is a thin ribbon, not a filled fan", () => {
  const spec = {
    pivot: { x: 20, y: 40 },
    tip: { x: 62, y: 40 },
    color: { r: 48, g: 196, b: 255 },
    arcDegrees: 120,
    outerScale: 1.12,
  };
  const filled = paintCrescentRgba(80, 80, { ...spec, innerRatio: 0.4 });
  const thin = paintCrescentRgba(80, 80, { ...spec, innerRatio: 0.82 });
  assert.ok(thin.painted < filled.painted * 0.6, `thin=${thin.painted} filled=${filled.painted}`);
  const mid = thin.data[(40 * 80 + 40) * 4 + 3];
  assert.ok(mid < 20, `mid-radius must stay hollow on a ribbon, alpha=${mid}`);
});

test("xsxb_plan_smear paints a crescent from cells; it does not take a smear PNG", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-paint-smear-"));
  const width = 64;
  const height = 64;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 24; y <= 40; y += 1) {
    for (let x = 8; x <= 22; x += 1) setPixel(rgba, width, x, y, 40, 40, 48, 255);
  }
  for (let x = 18; x <= 56; x += 1) {
    setPixel(rgba, width, x, 32, 24, 72, 188, 255);
    setPixel(rgba, width, x, 33, 24, 72, 188, 255);
  }
  const targetPath = path.join(root, "hold.png");
  fs.writeFileSync(targetPath, encodePngRgba(rgba, width, height));
  const view = { x: 0, y: 0, width, height, rows: 8, cols: 8 };
  const overlayId = overlayIdFor(fs.readFileSync(targetPath), view);
  const service = createXsxbMcpService({ root });
  try {
    const tool = require("../../mcp/xsxb_mcp_tool_catalog")
      .toolDefinitions()
      .find((entry) => entry.name === "xsxb_plan_smear");
    assert.equal(tool.inputSchema.properties.object_path, undefined);
    assert.ok(tool.inputSchema.properties.target_path);
    const result = await service.call("xsxb_plan_smear", {
      motion: "horizontal ice slash, tip through G5, cup opening toward the body",
      path_kind: "polyline",
      color: "#30c8ff",
      layer: "behind",
      frames: [{ index: 0, start: "G2", end: "H5", head: "H5", weight: "solid" }],
      target_path: targetPath,
      overlay_id: overlayId,
      view,
      pivot_cells: ["C5"],
      arc_degrees: 120,
      output_path: "hold_smear.png",
    });
    assert.equal(result.method, "pixel_crescent");
    assert.ok(result.painted_pixels > 80, `MCP must paint pixels, got ${result.painted_pixels}`);
    assert.equal(result.preview.kind, "magenta");
    assert.match(result.brief, /target_path/);
    assert.match(result.brief, /Do not GenerateImage a smear PNG/);
    assert.match(result.brief, /Do not xsxb_place_image a smear PNG/);
    assert.doesNotMatch(result.brief, /Generate a hollow sickle on white/);
    const out = decodePngRgba(result.output_path);
    const blade = out.data[(32 * width + 40) * 4];
    assert.equal(blade, 24, "layer=behind must keep the blade in front of the smear");
    assert.ok(countCyan(out.data) > 40, "empty pixels around the tip must show the generated cyan arc");
    const preview = decodePngRgba(result.preview.path);
    assert.equal(preview.data[0], 255);
    assert.equal(preview.data[1], 0);
    assert.equal(preview.data[2], 255);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("xsxb_plan_smear paint refuses a still without overlay_id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-paint-smear-overlay-"));
  const rgba = new Uint8ClampedArray(32 * 32 * 4);
  const targetPath = path.join(root, "hold.png");
  fs.writeFileSync(targetPath, encodePngRgba(rgba, 32, 32));
  const service = createXsxbMcpService({ root });
  try {
    await assert.rejects(
      () =>
        service.call("xsxb_plan_smear", {
          motion: "horizontal ice slash across the hold",
          path_kind: "polyline",
          color: "#30c8ff",
          frames: [{ index: 0, start: "A1", end: "H5", head: "H5", weight: "solid" }],
          target_path: targetPath,
          view: { x: 0, y: 0, width: 32, height: 32, rows: 8, cols: 8 },
          pivot_cells: ["C5"],
        }),
      (error) => error.code === "MISSING_OVERLAY" || /overlay_id/.test(String(error.message)),
    );
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planSmear without target_path still returns only the brief", () => {
  const planned = planSmear({
    motion: "head scoops upward from H8 through G5 to D1",
    path_kind: "polyline",
    color: "#C41E1E",
    frames: [{ index: 4, start: "H8", end: "G4", head: "G5", weight: "solid" }],
  });
  assert.equal(planned.output_path, undefined);
  assert.equal(planned.painted_pixels, undefined);
  assert.match(planned.brief, /scoops upward/);
});
