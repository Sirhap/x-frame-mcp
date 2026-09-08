"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { measureLongAxis } = require("../../mcp/xsxb_mcp_visual_qa");
const { compositeAttackTrails } = require("../../mcp/xsxb_mcp_trail_preview");

/** Creates an imported clip and a sword with a colored, measurable grip. */
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-attachment-grip-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const hero = path.join(root, "hero.png");
  const pixels = new Uint8ClampedArray(128 * 128 * 4);
  pixels.set([80, 100, 130, 255], 0);
  fs.writeFileSync(hero, encodePngRgba(pixels, 128, 128));
  const weapon = path.join(root, "sword.png");
  const sword = new Uint8ClampedArray(24 * 48 * 4);
  for (let y = 4; y < 44; y++) {
    const half = y > 30 ? 5 : 2;
    for (let x = 12 - half; x <= 12 + half; x++) sword.set([20, 150, 240, 255], (y * 24 + x) * 4);
  }
  const measured = measureLongAxis(sword, 24, 48, { t: 0.2 });
  for (let y = Math.round(measured.at.y) - 2; y <= Math.round(measured.at.y) + 2; y++) {
    for (let x = Math.round(measured.at.x) - 2; x <= Math.round(measured.at.x) + 2; x++) {
      const at = (y * 24 + x) * 4;
      if (sword[at + 3]) sword.set([250, 20, 30, 255], at);
    }
  }
  fs.writeFileSync(weapon, encodePngRgba(sword, 24, 48));
  await service.call("xsxb_create_project", { project_id: "grip" });
  await service.call("xsxb_import_animation", {
    source: "items", items: [{ path: hero }, { path: hero }], profile_id: "hero", animation_id: "swing",
  });
  const store = createProjectStore(root);
  const paths = store.projectPaths(store.activeProject("grip"));
  return { root, hero, weapon, service, paths, measured };
}

test("attachment tool keeps the rendered grip on the hand through scale and rotation", async (t) => {
  const f = await setup(t);
  const hand = { x: 20, y: -60 };
  for (const [scale, rotation] of [[1, 0], [1.8, 90], [0.8, -135]]) {
    const result = await f.service.call("xsxb_add_attachment", { file_path: f.weapon, hand, t: 0.2, scale, rotation });
    const stored = JSON.parse(fs.readFileSync(f.paths.frameImageAttachments, "utf8"));
    assert.deepEqual(stored[0].transform, result.binding.transform);
    const render = await compositeAttackTrails({
      root: f.root, framePaths: [f.hero], frameIndexes: [0], bindingKey: "hero/swing", attachments: stored,
    });
    try {
      const image = decodePngRgba(render.framePaths[0]);
      const pixel = (68 * image.width + 84) * 4;
      assert.ok(image.data[pixel] > 220 && image.data[pixel + 1] < 50,
        `grip marker must cover hand at scale ${scale}, rotation ${rotation}`);
    } finally { if (render.tempDir) fs.rmSync(render.tempDir, { recursive: true, force: true }); }
  }
});

test("below attachment persists a negative layer order and invalid batches do not copy files", async (t) => {
  const f = await setup(t);
  const result = await f.service.call("xsxb_add_attachment", { file_path: f.weapon, layer: "below" });
  assert.equal(result.binding.layerOrder, -1);
  const before = fs.readFileSync(f.paths.frameImageAttachments);
  const another = path.join(f.root, "uncommitted.png");
  fs.copyFileSync(f.weapon, another);
  await assert.rejects(f.service.call("xsxb_add_attachment", {
    file_path: another, frames: [{ frame: 0, scale: 1 }, { frame: 1, scale: 0 }],
  }), /scale/);
  assert.deepEqual(fs.readFileSync(f.paths.frameImageAttachments), before);
  const copied = path.join(path.dirname(path.resolve(f.root, result.binding.path)), "uncommitted.png");
  assert.equal(fs.existsSync(copied), false);
});
