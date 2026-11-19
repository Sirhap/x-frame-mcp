"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

test("pixel combo keeps the loop hollow, clears the recovery and retimes a mirrored hit in place", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-pixel-slash-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const r = await service.callMcp(name, args);
    assert.ok(r.ok, JSON.stringify(r.error));
    return r.data;
  };
  const size = 80,
    rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 32; y < 60; y++)
    for (let x = 34; x < 46; x++) rgba.set([31, 120, 51, 255], (y * size + x) * 4);
  const actor = path.join(root, "actor.png");
  fs.writeFileSync(actor, encodePngRgba(rgba, size, size));
  await call("xsxb_create_project", { project_id: "pixel" });
  await call("xsxb_import_animation", {
    source: "items",
    items: Array.from({ length: 9 }, () => ({ path: actor })),
    animation_id: "combo",
  });
  const combo = await call("xsxb_add_attack_trail", {
    hits: [
      { start_frame: 0, end_frame: 2, brush_preset: "pixel_cross" },
      { start_frame: 3, end_frame: 5, brush_preset: "pixel_spin", pixel_facing: "left" },
    ],
  });
  assert.equal(combo.hits.length, 2);
  const spin = combo.hits[1];
  assert.ok(spin.segment.sticks[0].top.x > spin.segment.sticks[1].top.x);
  const frameImage = async (frame) =>
    decodePngRgba(
      (
        await call("xsxb_export_sheet", {
          start_frame: frame,
          end_frame: frame,
          columns: 1,
          cell: size,
          grid: false,
          pad: 1,
          normalize: "none",
        })
      ).outputPath,
    );
  const strike = await frameImage(5),
    rest = await frameImage(6);
  const pink = (data, i) => data[i] > 160 && data[i] - data[i + 1] > 48 && data[i + 2] - data[i + 1] > 32;
  const pinkXs = (image, y) =>
    Array.from({ length: image.width }, (_, x) => x).filter((x) =>
      pink(image.data, 4 * (image.width * y + x)),
    );
  // On a row crossing the actor, pink is present on either side of visible green body pixels.
  assert.ok(
    Array.from({ length: strike.height }, (_, y) => y).some((y) => {
      const xs = pinkXs(strike, y);
      return (
        xs.length > 3 &&
        xs.some(
          (x, i) =>
            i > 0 &&
            x - xs[i - 1] > 3 &&
            strike.data[4 * (y * strike.width + Math.round((x + xs[i - 1]) / 2)) + 1] === 120,
        )
      );
    }),
  );
  assert.ok(!Array.from({ length: rest.height }, (_, y) => pinkXs(rest, y)).some((xs) => xs.length));
  const updated = await call("xsxb_add_attack_trail", {
    id: spin.id,
    start_frame: 4,
    end_frame: 7,
    preview: false,
  });
  assert.equal(updated.id, spin.id);
  assert.equal(updated.segment.brushSource, "pixel_spin");
  assert.equal(updated.segment.pixelFacing, "left");
});
