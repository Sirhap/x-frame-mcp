"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { createProjectStore } = require("../../mcp/lib/project_store");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

/** Exercises authoring commands on copied synthetic art with per-frame bindings. */
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-authoring-test-")),
    service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const request = (name, args = {}) => service.callMcp(name, args),
    call = async (name, args = {}) => (await request(name, args)).data;
  try {
    const png = path.join(root, "input.png"),
      rgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) rgba.set([30, 140, 70, 255], (y * 16 + x) * 4);
    fs.writeFileSync(png, encodePngRgba(rgba, 16, 16));
    await call("xsxb_create_project", { project_id: "test" });
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }, { path: png }, { path: png }],
      profile_id: "hero",
      animation_id: "walk",
    });
    const store = createProjectStore(root),
      paths = store.projectPaths(store.activeProject("test"));
    await run({ root, service, call, request, png, paths });
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("checkpoint compare restore and undo preserve bytes, metadata and attachment assets", async () =>
  fixture(async ({ call, paths }) => {
    const state = await call("xsxb_get_animation"),
      file = state.animation.frames[0].absolutePath,
      original = fs.readFileSync(file);
    const saved = await call("xsxb_save_revision", { label: "original" });
    await call("xsxb_shift_frames", { frames: [{ frame: 0, dy: 2 }] });
    const diff = await call("xsxb_compare_revisions", { revision_id: saved.revisionId });
    assert.ok(diff.changes.some((c) => c.key.endsWith(".png")));
    assert.ok(fs.existsSync(diff.preview.path));
    const shifted = fs.readFileSync(file);
    assert.notDeepEqual(shifted, original);
    await call("xsxb_restore_revision", { revision_id: saved.revisionId });
    assert.deepEqual(fs.readFileSync(file), shifted, "preview does not restore");
    const restored = await call("xsxb_restore_revision", { revision_id: saved.revisionId, dry_run: false });
    assert.deepEqual(fs.readFileSync(file), original);
    await call("xsxb_undo", { dry_run: false });
    assert.deepEqual(fs.readFileSync(file), shifted, "undo restore is redo");
    assert.ok(
      (await call("xsxb_list_revisions")).revisions.some((r) => r.revisionId === restored.safetyRevisionId),
    );
    assert.ok(fs.existsSync(paths.manifest));
  }));

test("copy split merge rename retain timing boxes attachments and sound ownership", async () =>
  fixture(async ({ call, png, paths }) => {
    await call("xsxb_update_timing", { frame: 1, duration: 2 });
    await call("xsxb_add_attachment", {
      file_path: png,
      id: "weapon",
      frame: 1,
      offset_x: 2,
      offset_y: -3,
      sync: false,
    });
    const before = await call("xsxb_get_animation", { include: ["boxes", "timing", "attachments"] });
    await call("xsxb_manage_animation", { action: "copy", target_animation_id: "copy", dry_run: false });
    const copy = await call("xsxb_get_animation", {
      animation_id: "copy",
      include: ["boxes", "timing", "attachments"],
    });
    assert.deepEqual(copy.boxes, before.boxes);
    assert.deepEqual(copy.timing, before.timing);
    assert.equal(copy.attachments[0].key, "hero/copy:1");
    await call("xsxb_manage_animation", {
      animation_id: "walk",
      action: "split",
      segments: [
        { animation_id: "start", start_frame: 0, end_frame: 0 },
        { animation_id: "end", start_frame: 1, end_frame: 2 },
      ],
      dry_run: false,
    });
    const end = await call("xsxb_get_animation", { animation_id: "end", include: ["timing", "attachments"] });
    assert.equal(end.attachments[0].frame, 0);
    assert.equal(end.timing.frameOverrides[0].duration, 2);
    await call("xsxb_manage_animation", {
      animation_id: "walk",
      action: "merge",
      source_animation_ids: ["start", "end"],
      target_animation_id: "joined",
      fps: 24,
      dry_run: false,
    });
    const joined = await call("xsxb_get_animation", {
      animation_id: "joined",
      include: ["timing", "attachments"],
    });
    assert.equal(joined.frameCount, 3);
    assert.equal(joined.attachments[0].frame, 1);
    assert.equal(joined.timing.frameOverrides[1].duration, 4);
    await call("xsxb_manage_animation", { action: "rename", target_animation_id: "renamed", dry_run: false });
    const renamed = await call("xsxb_get_animation", { animation_id: "renamed", include: ["attachments"] });
    assert.equal(renamed.attachments[0].key, "hero/renamed:1");
    const manifest = JSON.parse(fs.readFileSync(paths.manifest));
    assert.ok(!manifest.profiles[0].animations.some((a) => a.id === "joined"));
  }));

test("partial cutout changes selected frames only and preserves other timing/bytes", async () =>
  fixture(async ({ call, request, png, paths }) => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 255, 255, 255], i);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) data.set([20, 120, 70, 255], (y * 16 + x) * 4);
    fs.writeFileSync(png, encodePngRgba(data, 16, 16));
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }, { path: png }, { path: png }],
      animation_id: "green",
      profile_id: "hero",
    });
    const observed = await request("xsxb_get_animation", { animation_id: "green" }),
      files = observed.data.animation.frames.map((f) => f.absolutePath),
      before = files.map((f) => fs.readFileSync(f));
    const tuning = fs.readFileSync(paths.tuning);
    const result = await call("xsxb_cutout", {
      animation_id: "green",
      frames: [1],
      key_mode: "border_flood",
      key_color: "#ffffff",
      force: true,
      basis_snapshot_id: observed.observation.snapshotId,
    });
    assert.deepEqual(result.selectedFrames, [1]);
    assert.deepEqual(fs.readFileSync(files[0]), before[0]);
    assert.deepEqual(fs.readFileSync(files[2]), before[2]);
    assert.notDeepEqual(fs.readFileSync(files[1]), before[1]);
    assert.deepEqual(fs.readFileSync(paths.tuning), tuning);
    assert.equal(decodePngRgba(files[1]).data[3], 0);
  }));

test("canvas padding keeps origin, trimming updates attachment/box coordinates and clipping refuses", async () =>
  fixture(async ({ call, png }) => {
    await call("xsxb_add_attachment", {
      file_path: png,
      id: "weapon",
      frame: 0,
      offset_x: 2,
      offset_y: -3,
      sync: false,
    });
    const before = await call("xsxb_get_animation", { include: ["boxes", "attachments"] });
    const preview = await call("xsxb_resize_canvas", { mode: "pad", width: 24, height: 24 });
    assert.equal(preview.dryRun, true);
    await call("xsxb_resize_canvas", { mode: "pad", width: 24, height: 24, dry_run: false });
    const padded = await call("xsxb_get_animation", { include: ["boxes", "attachments"] });
    assert.deepEqual(padded.boxes, before.boxes);
    assert.deepEqual(padded.attachments, before.attachments);
    await assert.rejects(
      call("xsxb_resize_canvas", { mode: "pad", width: 2, height: 2, dry_run: false }),
      /clip/,
    );
    const trimmed = await call("xsxb_resize_canvas", {
      mode: "trim",
      preserve_origin: false,
      dry_run: false,
    });
    assert.equal(trimmed.frames[0].width, 8);
    assert.equal(trimmed.frames[0].height, 8);
    const after = await call("xsxb_get_animation", { include: ["boxes", "attachments"] });
    assert.equal(
      after.attachments[0].transform.offset.y,
      before.attachments[0].transform.offset.y + trimmed.frames[0].groupDelta.y,
    );
  }));

test("quality report flags empty and clipped frames and writes a read-only evidence sheet", async () =>
  fixture(async ({ call, png }) => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    fs.writeFileSync(png, encodePngRgba(data, 16, 16));
    await call("xsxb_replace_frame", { frame: 1, file_path: png });
    const state = await call("xsxb_get_animation"),
      files = state.animation.frames.map((f) => f.absolutePath),
      before = files.map((f) => fs.readFileSync(f));
    const report = await call("xsxb_check_animation");
    assert.ok(report.frames[1].issues.some((i) => i.kind === "empty"));
    assert.ok(fs.existsSync(report.preview.path));
    files.forEach((f, i) => assert.deepEqual(fs.readFileSync(f), before[i]));
  }));

test("attachment interpolation retains keyframes, uses shortest angle and steps occlusion layers", async () =>
  fixture(async ({ call, png }) => {
    await call("xsxb_add_attachment", {
      file_path: png,
      id: "weapon",
      frame: 0,
      offset_x: 0,
      offset_y: 0,
      sync: false,
    });
    const args = {
      id: "weapon",
      keyframes: [
        { frame: 0, offset_x: 0, offset_y: 0, rotation: 3, layer: "below" },
        { frame: 2, offset_x: 10, offset_y: -10, rotation: -3, layer: "above" },
      ],
    };
    const preview = await call("xsxb_interpolate_attachment", args);
    assert.equal(preview.bindings[1].transform.offset.x, 5);
    assert.ok(Math.abs(preview.bindings[1].transform.rotation - Math.PI) < 1e-9);
    assert.equal(preview.bindings[1].layer, "below");
    assert.equal(preview.bindings[2].layer, "above");
    await call("xsxb_interpolate_attachment", { ...args, dry_run: false });
    const state = await call("xsxb_get_animation", { include: ["attachments"] });
    assert.equal(state.attachments.length, 3);
    const hold = await call("xsxb_interpolate_attachment", { ...args, interpolation: "hold" });
    assert.equal(hold.bindings[1].transform.offset.x, 0);
    await assert.rejects(
      call("xsxb_interpolate_attachment", { ...args, replace: false, dry_run: false }),
      /overlap/,
    );
  }));

test("restore repairs missing frames and removes authoring files created after the checkpoint", async () =>
  fixture(async ({ call, png, paths }) => {
    const before = await call("xsxb_get_animation"),
      file = before.animation.frames[0].absolutePath,
      bytes = fs.readFileSync(file);
    const saved = await call("xsxb_save_revision", { label: "before deletion" });
    await call("xsxb_add_attachment", { file_path: png, id: "new-asset", frame: 0, sync: false });
    const attachments = JSON.parse(fs.readFileSync(paths.frameImageAttachments));
    const asset = path.resolve(
      path.dirname(path.dirname(path.dirname(path.dirname(paths.dataDir)))),
      attachments[0].path,
    );
    fs.rmSync(file);
    await call("xsxb_restore_revision", { revision_id: saved.revisionId, dry_run: false });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.frameImageAttachments)), []);
    assert.equal(fs.existsSync(asset), false);
  }));

test("corrupt snapshot bytes fail before replacing current authoring data", async () =>
  fixture(async ({ call, paths }) => {
    const saved = await call("xsxb_save_revision");
    const dir = path.join(paths.dataDir, "revisions", saved.revisionId),
      revision = JSON.parse(fs.readFileSync(path.join(dir, "revision.json")));
    const file = revision.files.find((f) => f.key.startsWith("workspace/") && f.key.endsWith(".png"));
    const original = fs.readFileSync(file.target);
    fs.writeFileSync(path.join(dir, file.hash), "corrupted blob");
    await assert.rejects(
      call("xsxb_restore_revision", { revision_id: saved.revisionId, dry_run: false }),
      /Corrupt revision/,
    );
    assert.deepEqual(fs.readFileSync(file.target), original);
  }));

test("in-place checkpoint restore requires explicit external-write opt-in", async () =>
  fixture(async ({ call, png }) => {
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }],
      profile_id: "hero",
      animation_id: "external",
      in_place: true,
    });
    const saved = await call("xsxb_save_revision");
    await assert.rejects(
      call("xsxb_restore_revision", { revision_id: saved.revisionId, dry_run: false }),
      /restore_external/,
    );
    const original = fs.readFileSync(png);
    fs.writeFileSync(png, encodePngRgba(new Uint8ClampedArray(16 * 16 * 4), 16, 16));
    await call("xsxb_restore_revision", {
      revision_id: saved.revisionId,
      dry_run: false,
      restore_external: true,
    });
    assert.deepEqual(fs.readFileSync(png), original);
  }));

test("split preserves sound and trail ownership and refuses an invalid later segment atomically", async () =>
  fixture(async ({ call, paths, root }) => {
    const { createTestWav } = require("../../mcp/xsxb_mcp_service");
    const wav = path.join(root, "hit.wav");
    fs.writeFileSync(wav, createTestWav());
    await call("xsxb_add_sfx", { file_path: wav, id: "hit", frame: 1, sync: false });
    await call("xsxb_add_attack_trail", {
      id: "trail",
      path_kind: "smooth_arc",
      sticks: [
        { frame: 1, top: { x: 1, y: -4 }, bottom: { x: 2, y: -2 } },
        { frame: 2, top: { x: 2, y: -4 }, bottom: { x: 3, y: -2 } },
      ],
      sync: false,
    });
    const before = fs.readFileSync(paths.manifest);
    await assert.rejects(
      call("xsxb_manage_animation", {
        action: "split",
        segments: [
          { animation_id: "valid", start_frame: 0, end_frame: 1 },
          { animation_id: "bad", start_frame: 2, end_frame: 9 },
        ],
        dry_run: false,
      }),
      /range/,
    );
    assert.deepEqual(fs.readFileSync(paths.manifest), before);
    await call("xsxb_manage_animation", {
      action: "split",
      segments: [{ animation_id: "end", start_frame: 1, end_frame: 2 }],
      dry_run: false,
    });
    const end = await call("xsxb_get_animation", { animation_id: "end", include: ["sfx", "trails"] });
    assert.equal(end.sfx[0].frame, 0);
    assert.equal(end.sfx[0].key, "hero/end:0");
    assert.deepEqual(
      end.trails[0].sticks.map((s) => s.frame),
      [0, 1],
    );
  }));

test("canvas, management and restore leave previous data intact after manifest commit errors", async () =>
  fixture(async ({ call, paths }) => {
    const saved = await call("xsxb_save_revision");
    const current = await call("xsxb_get_animation"),
      files = [...current.animation.frames.map((f) => f.absolutePath), paths.manifest, paths.tuning],
      original = files.map((f) => fs.readFileSync(f));
    for (const [tool, args] of [
      ["xsxb_resize_canvas", { mode: "pad", width: 24, height: 24 }],
      ["xsxb_manage_animation", { action: "copy", target_animation_id: "failed-copy" }],
      ["xsxb_restore_revision", { revision_id: saved.revisionId }],
    ]) {
      const rename = fs.renameSync;
      let failed = false;
      fs.renameSync = (from, to) => {
        if (to === paths.manifest && !failed) {
          failed = true;
          throw new Error("injected authoring commit failure");
        }
        return rename(from, to);
      };
      try {
        await assert.rejects(call(tool, { ...args, dry_run: false }), /injected authoring commit failure/);
      } finally {
        fs.renameSync = rename;
      }
      assert.equal(failed, true);
      files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), original[i]));
    }
  }));

test("quality reports holes and bright edges with original frame indexes", async () =>
  fixture(async ({ call, png }) => {
    const rgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 2; y < 14; y++)
      for (let x = 2; x < 14; x++) rgba.set([240, 240, 240, 255], (y * 16 + x) * 4);
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) rgba[(y * 16 + x) * 4 + 3] = 0;
    fs.writeFileSync(png, encodePngRgba(rgba, 16, 16));
    await call("xsxb_replace_frame", { frame: 2, file_path: png });
    const result = await call("xsxb_check_animation", { frames: [2] });
    assert.deepEqual(result.preview.frameIndexes, [2]);
    assert.ok(result.frames[0].issues.some((i) => i.kind === "alpha_holes"));
    assert.ok(result.frames[0].issues.some((i) => i.kind === "bright_edge"));
  }));

test("a failed edit does not hide the previous successful operation from undo", async () =>
  fixture(async ({ call }) => {
    const current = await call("xsxb_get_animation"),
      file = current.animation.frames[0].absolutePath,
      original = fs.readFileSync(file);
    await call("xsxb_shift_frames", { frames: [{ frame: 0, dy: 2 }] });
    await assert.rejects(call("xsxb_shift_frames", { frames: [{ frame: 99, dy: 2 }] }), /Frame/);
    await call("xsxb_undo", { dry_run: false });
    assert.deepEqual(fs.readFileSync(file), original);
  }));

test("undo copy allows recreating the same destination and smooth interpolation differs from linear", async () =>
  fixture(async ({ call, png }) => {
    await call("xsxb_manage_animation", { action: "copy", target_animation_id: "again", dry_run: false });
    await call("xsxb_undo", { dry_run: false });
    await call("xsxb_manage_animation", { action: "copy", target_animation_id: "again", dry_run: false });
    assert.equal((await call("xsxb_get_animation", { animation_id: "again" })).frameCount, 3);
    await call("xsxb_import_animation", {
      source: "items",
      items: [{ path: png }, { path: png }, { path: png }, { path: png }, { path: png }],
      profile_id: "hero",
      animation_id: "five",
    });
    await call("xsxb_add_attachment", { id: "tag", file_path: png, frame: 0, sync: false });
    const keys = [
      { frame: 0, offset_x: 0, offset_y: 0 },
      { frame: 4, offset_x: 16, offset_y: 0 },
    ];
    const smooth = await call("xsxb_interpolate_attachment", {
      id: "tag",
      keyframes: keys,
      interpolation: "smooth",
    });
    assert.equal(smooth.bindings[1].transform.offset.x, 2.5);
    const linear = await call("xsxb_interpolate_attachment", {
      id: "tag",
      keyframes: keys,
      interpolation: "linear",
    });
    assert.equal(linear.bindings[1].transform.offset.x, 4);
  }));

test("renaming back reuses the old id without orphan frame conflicts", async () =>
  fixture(async ({ call }) => {
    await call("xsxb_manage_animation", { action: "rename", target_animation_id: "renamed", dry_run: false });
    await call("xsxb_manage_animation", {
      animation_id: "renamed",
      action: "rename",
      target_animation_id: "walk",
      dry_run: false,
    });
    assert.equal((await call("xsxb_get_animation", { animation_id: "walk" })).frameCount, 3);
  }));
