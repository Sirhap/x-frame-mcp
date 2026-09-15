"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { GODOT_SYNC_ROOT } = require("../../mcp/lib/godot_sync");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/**
 * Writes a one-pixel PNG used as a bind and sync fixture.
 * @param {string} filePath Destination PNG path.
 * @returns {void}
 */
function writePixel(filePath) {
  fs.writeFileSync(filePath, encodePngRgba(new Uint8ClampedArray([210, 30, 40, 255]), 1, 1));
}

test("Godot sync writes the X-Frame workbench root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-godot-root-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  try {
    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Root"\n');
    const png = path.join(root, "frame.png");
    writePixel(png);
    await service.callMcp("xsxb_create_project", { project_id: "hero", label: "Hero" });
    await service.callMcp("xsxb_bind_godot", { project_id: "hero", project_root: game });
    const imported = await service.callMcp("xsxb_import_animation", {
      project_id: "hero",
      source: "items",
      items: [{ path: png }],
      profile_id: "hero",
      animation_id: "idle",
      sync: true,
    });
    assert.equal(imported.data.sync.ok, true);
    assert.equal(GODOT_SYNC_ROOT, "x_frame");
    assert.ok(
      fs.existsSync(path.join(game, GODOT_SYNC_ROOT, "data", "projects", "hero", "animation_manifest.json")),
    );
    assert.equal(fs.existsSync(path.join(game, "xsxb_frame_tuner")), false);
    const actor = fs.readFileSync(
      path.join(game, GODOT_SYNC_ROOT, "runtime", "xsxb_frame_actor.tscn"),
      "utf8",
    );
    assert.match(actor, /res:\/\/x_frame\/runtime\/xsxb_frame_actor\.gd/);
    assert.match(actor, /\[node name="XFrameActor"/);
    const script = fs.readFileSync(path.join(game, GODOT_SYNC_ROOT, "runtime", "xsxb_frame_actor.gd"), "utf8");
    assert.match(script, /res:\/\/x_frame\/data\/projects\/%s/);
    const trail = fs.readFileSync(
      path.join(game, GODOT_SYNC_ROOT, "runtime", "xsxb_attack_trail_renderer.gd"),
      "utf8",
    );
    assert.match(trail, /res:\/\/x_frame\/runtime\/xsxb_attack_trail\.gdshader/);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
