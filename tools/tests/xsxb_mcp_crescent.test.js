"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

test("crescent preset exports an open, tapered forward arc and ships its RGBA texture to Godot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-crescent-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ok = async (name, args = {}) => {
    const r = await service.callMcp(name, args);
    assert.ok(r.ok, JSON.stringify(r.error));
    return r.data;
  };
  const frame = path.join(root, "actor.png"),
    size = 96;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 30; y <= 70; y++)
    for (let x = 26; x <= 38; x++) rgba.set([50, 70, 85, 255], 4 * (size * y + x));
  fs.writeFileSync(frame, encodePngRgba(rgba, size, size));
  fs.writeFileSync(path.join(root, "project.godot"), "config_version=5\n");
  await ok("xsxb_create_project", { project_id: "test" });
  await ok("xsxb_import_animation", {
    source: "items",
    items: Array.from({ length: 6 }, () => ({ path: frame })),
    animation_id: "slash",
  });
  await ok("xsxb_bind_godot", { project_root: root });
  const args = { brush_preset: "crescent", start_frame: 0, end_frame: 3, sync: true };
  const trail = await ok("xsxb_add_attack_trail", args);
  assert.ok(trail.useMesh && trail.sync.ok);
  assert.equal(trail.segment.layer, "front");
  assert.equal(trail.segment.colorMode, "original");
  assert.deepEqual(
    trail.segment.sticks.map((s) => s.frame),
    [0, 3],
  );
  const synced = JSON.parse(
    fs.readFileSync(path.join(root, "xsxb_frame_tuner/data/projects/test/attack_trails.json")),
  );
  const segment = Object.values(synced.bindings)[0][0];
  const texture = decodePngRgba(path.join(root, segment.texture.path.slice(6)));
  const widthAt = (x) =>
    Array.from({ length: texture.height }, (_, y) => texture.data[(y * texture.width + x) * 4 + 3]).filter(
      (a) => a > 127,
    ).length;
  assert.ok(widthAt(256) > widthAt(6) * 8 && widthAt(256) > widthAt(505) * 8);
  const sheet = await ok("xsxb_export_sheet", {
    start_frame: 3,
    end_frame: 3,
    grid: false,
    cell: 96,
    pad: 1,
    columns: 1,
    normalize: "none",
  });
  const img = decodePngRgba(sheet.outputPath);
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    const xs = [];
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] > 180 && img.data[i] - img.data[i + 2] > 22) xs.push(x);
    }
    if (xs.length) rows.push(xs);
  }
  assert.ok(rows.length > 35);
  const middle = rows[Math.floor(rows.length / 2)];
  assert.ok(
    Math.min(...middle) > Math.min(...rows[1]) + 16 && Math.min(...middle) > Math.min(...rows.at(-2)) + 16,
    "middle bows forward, leaving actor side open",
  );
  for (const facing of ["right", "left"]) {
    const large = { ...args, sync: false, crescent_scale: 2, crescent_facing: facing };
    const overflow = await ok("xsxb_add_attack_trail", large);
    const kept = overflow.crescentFraming;
    assert.equal(kept.appliedScale, 2);
    assert.ok(kept.overflowPx[facing] > 0 && kept.overflowPx.top > 0);
    assert.match(overflow.warnings.join(" "), /crescent_fit=shrink/);
    const fitted = await ok("xsxb_add_attack_trail", { ...large, crescent_fit: "shrink" });
    assert.equal(fitted.segment.id, overflow.segment.id);
    assert.equal(fitted.crescentFraming.requestedScale, 2);
    assert.ok(fitted.crescentFraming.appliedScale < 2);
    assert.deepEqual(fitted.crescentFraming.overflowPx, { left: 0, right: 0, top: 0 });
    const { name, arguments: inputs } = fitted.previewCall;
    assert.deepEqual([inputs.start_frame, inputs.end_frame], [3, 3]);
    const rendered = decodePngRgba((await ok(name, inputs)).outputPath);
    let minX = rendered.width,
      maxX = 0;
    for (let y = 0; y < rendered.height; y++)
      for (let x = 0; x < rendered.width; x++) {
        const offset = 4 * (y * rendered.width + x);
        if (rendered.data[offset] > 180 && rendered.data[offset] - rendered.data[offset + 2] > 22) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    assert.ok(maxX - minX > 12);
    const pad = (rendered.width - size) / 2;
    const actorX = 32 + pad;
    assert.ok(facing === "right" ? maxX > actorX + 35 : minX < actorX - 18);
    assert.ok(minX > pad && maxX < pad + size - 1, "visible brush must clear the strike canvas edges");
  }
  const mirrored = await ok("xsxb_add_attack_trail", {
    ...args,
    crescent_facing: "left",
    crescent_direction: "up",
  });
  assert.ok(mirrored.segment.sticks[0].top.y > mirrored.segment.sticks[1].top.y);
  await ok("xsxb_update_timing", { frames: [{ frame: 3, disabled: true }] });
  await assert.rejects(() => service.callMcp("xsxb_add_attack_trail", args), /frame 3 is disabled/);
  await assert.rejects(
    () => service.callMcp("xsxb_add_attack_trail", { ...args, end_frame: 0 }),
    /later end_frame/,
  );
});
