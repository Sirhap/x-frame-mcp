"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService, toolDefinitions } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/** Runs a defaults check against an isolated, imported three-frame clip. */
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-defaults-test-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const call = (name, args = {}) => service.call(name, args);
  try {
    const png = path.join(root, "input.png");
    const pixels = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 4; y < 12; y++)
      for (let x = 4; x < 12; x++) pixels.set([80, 120, 60, 255], (y * 16 + x) * 4);
    fs.writeFileSync(png, encodePngRgba(pixels, 16, 16));
    await call("xsxb_create_project", { project_id: "defaults" });
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }, { path: png }, { path: png }],
      profile_id: "hero",
      animation_id: "walk",
    });
    const store = createProjectStore(root);
    const paths = store.projectPaths(store.activeProject("defaults"));
    await run({ call, service, paths, png, root });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const modes = [
  [{}, false],
  [{ apply: true }, true],
  [{ dry_run: false }, true],
  [{ apply: false }, false],
  [{ dry_run: true }, false],
  [{ apply: true, dry_run: true }, false],
  [{ apply: false, dry_run: false }, false],
  [{ apply: true, dry_run: false }, true],
];
for (const [name, options] of [
  ["xsxb_estimate_visual", { target_height: 12 }],
  ["xsxb_register_clip", { target_bbox: 12 }],
  ["xsxb_plant_feet", { target_y: -1 }],
]) {
  for (const [flags, committed] of modes) {
    test(`${name} commit precedence ${JSON.stringify(flags)}`, async () =>
      fixture(async ({ service, call, paths }) => {
        const state = await call("xsxb_get_animation");
        const file = name === "xsxb_estimate_visual" ? paths.tuning : state.animation.frames[0].absolutePath;
        const before = fs.readFileSync(file);
        const revisions = (await call("xsxb_list_revisions")).revisions.length;
        const result = await service.callMcp(name, { ...options, ...flags });
        assert.equal(result.data.applied, committed);
        assert.equal(result.data.dryRun, !committed);
        assert.equal(
          !fs.readFileSync(file).equals(before),
          committed,
          "actual stored bytes follow the commit decision",
        );
        assert.equal(
          (await call("xsxb_list_revisions")).revisions.length > revisions,
          committed,
          "only committed mutations create checkpoints",
        );
      }));
  }
}

test("compression defaults to preview and leaves imported files untouched", async () =>
  fixture(async ({ call }) => {
    const state = await call("xsxb_get_animation");
    const file = state.animation.frames[0].absolutePath;
    const before = fs.statSync(file).mtimeMs;
    const result = await call("xsxb_compress_frames");
    assert.equal(result.dryRun, true);
    assert.equal(result.rewritten, 0);
    assert.equal(fs.statSync(file).mtimeMs, before);
  }));

test("reorganization previews by default and commits locally only when requested", async () =>
  fixture(async ({ call, service, paths }) => {
    const before = fs.readFileSync(paths.manifest);
    const revisions = (await call("xsxb_list_revisions")).revisions.length;
    const snapshot = (await service.callMcp("xsxb_get_animation")).observation.snapshotId;
    const preview = await service.callMcp("xsxb_reorganize_frames", {
      order: [1, 0],
      sync: true,
      basis_snapshot_id: snapshot,
    });
    assert.equal(preview.data.dryRun, true);
    assert.equal(preview.data.outputFrameCount, 2);
    assert.equal(preview.data.sync.requested, false);
    assert.deepEqual(fs.readFileSync(paths.manifest), before);
    assert.equal((await call("xsxb_list_revisions")).revisions.length, revisions);
    const committed = await service.callMcp("xsxb_reorganize_frames", {
      order: [1, 0],
      dry_run: false,
      basis_snapshot_id: snapshot,
    });
    assert.equal(committed.data.dryRun, false);
    assert.equal(committed.data.sync.requested, false);
    assert.equal((await call("xsxb_get_animation")).animation.frames.length, 2);
  }));

test("attachment creation and removal do not synchronize unless requested", async () =>
  fixture(async ({ call, png }) => {
    const added = await call("xsxb_add_attachment", { file_path: png, id: "tag", frame: 0 });
    assert.equal(added.sync.requested, false);
    const removed = await call("xsxb_remove_binding", { kind: "attachment", id: "tag" });
    assert.equal(removed.sync.requested, false);
  }));

test("catalog preview and sync flags match runtime and avoid conflicting injected defaults", () => {
  const definitions = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  for (const name of ["xsxb_estimate_visual", "xsxb_register_clip", "xsxb_plant_feet"]) {
    const properties = definitions.get(name).inputSchema.properties;
    assert.equal(properties.dry_run.type, "boolean");
    assert.equal(properties.dry_run.default, undefined);
    assert.equal(properties.apply.default, undefined);
  }
  for (const name of ["xsxb_compress_frames", "xsxb_reorganize_frames"]) {
    assert.equal(definitions.get(name).inputSchema.properties.dry_run.default, true);
  }
  for (const name of [
    "xsxb_add_attachment",
    "xsxb_add_sfx",
    "xsxb_add_attack_trail",
    "xsxb_remove_binding",
    "xsxb_reorganize_frames",
  ]) {
    assert.equal(definitions.get(name).inputSchema.properties.sync.default, false);
  }
});
