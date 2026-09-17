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

/**
 * Builds a small unoptimized RGBA PNG so committed compress rewrites bytes.
 * @param {number} width Pixel width.
 * @param {number} height Pixel height.
 * @returns {Buffer} PNG encoded at zlib level 0.
 */
function bulkyWalkFramePng(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([offset % 250, 40, 200, 255], offset);
  return encodePngRgba(pixels, width, height, { level: 0 });
}

test("committed compression checkpoints walk frames and undo restores bytes", async () =>
  fixture(async ({ call, service }) => {
    const state = await call("xsxb_get_animation");
    const file = state.animation.frames[0].absolutePath;
    fs.writeFileSync(file, bulkyWalkFramePng(16, 16));
    const before = fs.readFileSync(file);
    const revisions = (await call("xsxb_list_revisions")).revisions.length;
    const result = await service.callMcp("xsxb_compress_frames", {
      animation_id: "walk",
      dry_run: false,
    });
    assert.equal(result.data.dryRun, false);
    assert.ok(result.data.rewritten >= 1, "level-0 walk frame must shrink on committed compress");
    assert.ok(!fs.readFileSync(file).equals(before), "committed compress must rewrite PNG bytes");
    assert.ok(
      (await call("xsxb_list_revisions")).revisions.length > revisions,
      "committed compress must create an undo checkpoint",
    );
    const undone = await call("xsxb_undo", { dry_run: false });
    assert.equal(undone.restored, true);
    assert.deepEqual(fs.readFileSync(file), before);
  }));

/** Reads walk-clip frameCount from the on-disk project manifest. */
function walkFrameCountOnDisk(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const profile = (manifest.profiles || []).find((entry) => entry.id === "hero");
  const animation = (profile?.animations || []).find((entry) => entry.id === "walk" || entry.name === "walk");
  return (animation?.frames || []).length;
}

test("reorganization with only order writes frames and changes on-disk frameCount", async () =>
  fixture(async ({ service, call, paths }) => {
    assert.equal(walkFrameCountOnDisk(paths.manifest), 3);
    const revisionsBefore = (await call("xsxb_list_revisions")).revisions.length;
    const snapshot = (await service.callMcp("xsxb_get_animation")).observation.snapshotId;
    const committed = await service.callMcp("xsxb_reorganize_frames", {
      order: [1, 0],
      basis_snapshot_id: snapshot,
    });
    assert.equal(committed.data.dryRun, false);
    assert.equal(committed.data.applied, true);
    assert.equal(committed.data.outputFrameCount, 2);
    assert.equal(walkFrameCountOnDisk(paths.manifest), 2);
    assert.ok(
      (await call("xsxb_list_revisions")).revisions.length > revisionsBefore,
      "committed reorder must create an undo checkpoint",
    );
    const undone = await call("xsxb_undo", { dry_run: false });
    assert.equal(undone.restored, true);
    assert.equal(walkFrameCountOnDisk(paths.manifest), 3);
  }));

test("reorganization previews by default and commits locally only when requested", async () =>
  fixture(async ({ call, service, paths }) => {
    const before = fs.readFileSync(paths.manifest);
    const revisions = (await call("xsxb_list_revisions")).revisions.length;
    const snapshot = (await service.callMcp("xsxb_get_animation")).observation.snapshotId;
    const identityPreview = await service.callMcp("xsxb_reorganize_frames", {
      sync: true,
      basis_snapshot_id: snapshot,
    });
    assert.equal(identityPreview.data.dryRun, true);
    assert.equal(identityPreview.data.applied, false);
    assert.equal(identityPreview.data.identityOrder, true);
    assert.equal(identityPreview.data.outputFrameCount, 3);
    assert.equal(identityPreview.data.sync.requested, false);
    assert.deepEqual(fs.readFileSync(paths.manifest), before);
    assert.equal((await call("xsxb_list_revisions")).revisions.length, revisions);
    const preview = await service.callMcp("xsxb_reorganize_frames", {
      order: [1, 0],
      dry_run: true,
      sync: true,
      basis_snapshot_id: snapshot,
    });
    assert.equal(preview.data.dryRun, true);
    assert.equal(preview.data.applied, false);
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
    assert.equal(committed.data.applied, true);
    assert.equal(committed.data.sync.requested, false);
    assert.equal((await call("xsxb_get_animation")).animation.frames.length, 2);
  }));

test("reorganize_frames dry_run:false without order still previews", async () =>
  fixture(async ({ service, call, paths }) => {
    const before = fs.readFileSync(paths.manifest);
    const revisions = (await call("xsxb_list_revisions")).revisions.length;
    const result = await service.callMcp("xsxb_reorganize_frames", { dry_run: false });
    assert.equal(result.data.dryRun, true);
    assert.equal(result.data.applied, false);
    assert.deepEqual(fs.readFileSync(paths.manifest), before);
    assert.equal((await call("xsxb_list_revisions")).revisions.length, revisions);
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
  assert.equal(definitions.get("xsxb_compress_frames").inputSchema.properties.dry_run.default, true);
  const estimateDryRun = definitions.get("xsxb_estimate_boxes").inputSchema.properties.dry_run;
  assert.equal(estimateDryRun.default, false);
  assert.match(estimateDryRun.description, /omitting dry_run writes/i);
  assert.match(estimateDryRun.description, /dry_run:\s*true preview/i);
  const reorganizeDryRun = definitions.get("xsxb_reorganize_frames").inputSchema.properties.dry_run;
  assert.equal(reorganizeDryRun.default, undefined);
  assert.match(reorganizeDryRun.description, /omit order always previews.*even dry_run:\s*false/i);
  assert.match(reorganizeDryRun.description, /non-empty order commits/i);
  assert.match(reorganizeDryRun.description, /unless dry_run:\s*true/i);
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
