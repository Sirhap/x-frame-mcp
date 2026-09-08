"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decodePngRgba, encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { placeImageOnTarget } = require("../../mcp/xsxb_mcp_place");

/** Creates a real PNG fixture with a fist, clothing and a crossing weapon. */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-local-cover-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  /** Writes fixture pixels without model or renderer mocks. */
  function write(name, width, height, pixel) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
    }
    const file = path.join(root, name);
    fs.writeFileSync(file, encodePngRgba(data, width, height));
    return file;
  }
  const view = { x: 0, y: 0, width: 8, height: 8, rows: 8, cols: 8 };
  const target = write("target.png", 8, 8, (x, y) =>
    x === 3 && y === 3 ? [200, 90, 70, 255] : [20, 40, 80, 255],
  );
  const weapon = write("weapon.png", 1, 5, () => [0, 220, 255, 255]);
  const mask = write("mask.png", 8, 8, (x, y) => [255, 255, 255, x === 3 && y === 3 ? 255 : 0]);
  return {
    root, write, mask,
    args: { target_path: target, object_path: weapon, target_anchor: { view, cells: ["D4"], derive: "center" }, object_anchor: { mode: "alpha_center" }, verify_overlay: false },
  };
}

/** Reads one RGBA pixel from a rendered PNG. */
function pixel(image, x, y) {
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}

test("local foreground covers the grip while the pommel remains above clothing", (t) => {
  const f = fixture(t);
  const result = placeImageOnTarget({ ...f.args, occlusion: { mask_path: f.mask } }, { root: f.root });
  const output = decodePngRgba(result.output_path);
  assert.deepEqual(pixel(output, 3, 3), [200, 90, 70, 255]);
  assert.deepEqual(pixel(output, 3, 5), [0, 220, 255, 255]);
  assert.equal(result.occlusion.occluded_object_pixels, 1);
  assert.equal(result.occlusion.visible_object_pixels, 4);
  assert.equal(result.verify.visual_status, "not_assessed");
});

test("occlusion rejects dimensions that do not match the target", (t) => {
  const f = fixture(t);
  const mask = f.write("wrong.png", 1, 1, () => [255, 255, 255, 255]);
  assert.throws(() => placeImageOnTarget({ ...f.args, occlusion: { mask_path: mask } }, { root: f.root }), /dimensions/i);
});

test("region anchors reject mixed cell addressing before using evidence", (t) => {
  const f = fixture(t);
  assert.throws(() => placeImageOnTarget({ ...f.args, target_anchor: { ...f.args.target_anchor, region_id: "hand", basis_snapshot_id: "snapshot" } }, { root: f.root }), /cannot combine/i);
});

test("rotation and scale keep local grip occlusion without hiding the remaining weapon", (t) => {
  const f = fixture(t);
  const result = placeImageOnTarget({ ...f.args, rotation: 90, scale: { mode: "relative", span: "height", ratio: 1.5, target: { view: f.args.target_anchor.view, cells: ["A1", "A5"] } }, occlusion: { mask_path: f.mask } }, { root: f.root });
  const output = decodePngRgba(result.output_path);
  assert.deepEqual(pixel(output, 3, 3), [200, 90, 70, 255]);
  assert.deepEqual(pixel(output, 5, 3), [0, 220, 255, 255]);
  assert.equal(result.scale, 1.5);
  assert.equal(result.clipping.possible_clipping, true);
});

test("behind composites translucent target edges over the weapon instead of replacing it", (t) => {
  const f = fixture(t);
  const target = f.write("soft-target.png", 8, 8, () => [200, 0, 0, 128]);
  const result = placeImageOnTarget({ ...f.args, target_path: target, layer: "behind" }, { root: f.root });
  assert.deepEqual(pixel(decodePngRgba(result.output_path), 3, 3), [100, 110, 127, 255]);
});

test("fractional downscale samples translucent object alpha once per output pixel", (t) => {
  const f = fixture(t);
  const target = f.write("clear-target.png", 8, 8, () => [0, 0, 0, 0]);
  const weapon = f.write("soft-weapon.png", 2, 6, () => [0, 220, 255, 128]);
  const result = placeImageOnTarget({ ...f.args, target_path: target, object_path: weapon, scale: { mode: "relative", span: "height", ratio: 3, target: { view: f.args.target_anchor.view, cells: ["A1"] } } }, { root: f.root });
  const output = decodePngRgba(result.output_path);
  const alphas = output.data.filter((value, i) => i % 4 === 3 && value);
  assert.ok(alphas.length > 0);
  assert.ok(alphas.every((alpha) => alpha === 128));
});

test("partial local alpha blends only selected foreground and preserves unselected clothing", (t) => {
  const f = fixture(t);
  const mask = f.write("partial-mask.png", 8, 8, (x, y) => [255, 255, 255, x === 3 && y === 3 ? 128 : 0]);
  const result = placeImageOnTarget({ ...f.args, occlusion: { mask_path: mask } }, { root: f.root });
  const output = decodePngRgba(result.output_path);
  assert.deepEqual(pixel(output, 3, 3), [100, 155, 162, 255]);
  assert.deepEqual(pixel(output, 0, 0), [20, 40, 80, 255]);
});
