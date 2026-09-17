"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { createTestWav, createXsxbMcpService } = require("../xsxb_mcp_service");
const { encodePngRgba } = require("../xsxb_mcp_cutout");
const { handleMessage } = require("../xsxb_mcp_server");

/**
 * Builds a 16x16 transparent PNG with one opaque body block.
 * @param {number} [shift=0] Horizontal body shift in pixels.
 * @returns {Buffer} Encoded PNG.
 */
function bodyFrame(shift = 0) {
  const width = 16;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y <= 12; y += 1) {
    for (let x = 6 + shift; x <= 9 + shift; x += 1) {
      rgba.set([200, 40, 40, 255], (y * width + x) * 4);
    }
  }
  return encodePngRgba(rgba, width, height);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-bind-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Bind Test"\n');
  const presetPath = path.join(
    root,
    "tools/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
  );
  fs.mkdirSync(path.dirname(presetPath), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "../animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png"),
    presetPath,
  );
  const store = createProjectStore(root);
  store.addProject({ id: "bind-test", label: "Bind Test", projectRoot: godotRoot });
  const sequenceDir = path.join(root, "seq");
  fs.mkdirSync(sequenceDir);
  fs.writeFileSync(path.join(sequenceDir, "a.png"), bodyFrame(0));
  fs.writeFileSync(path.join(sequenceDir, "b.png"), bodyFrame(2));
  return {
    root,
    store,
    sequenceDir,
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function importedFixture() {
  const current = fixture();
  await current.service.call("xsxb_import_animation", {
    source: "png_sequence",
    directory: current.sequenceDir,
    project_id: "bind-test",
    animation_id: "walk",
  });
  return current;
}

/**
 * Calls one MCP tool through JSON-RPC `tools/call` and returns receipt data.
 * @param {object} service XSXB service.
 * @param {string} name Tool name.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<object>} `structuredContent.data`.
 */
async function callTool(service, name, args = {}) {
  const response = await handleMessage(
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    },
    service,
  );
  const receipt = response.result.structuredContent;
  assert.equal(receipt.ok, true, receipt.error?.message || JSON.stringify(receipt));
  return receipt.data;
}

test("get_animation include reads back boxes, timing, sfx, attachments, and trails", async () => {
  const current = await importedFixture();
  try {
    await current.service.call("xsxb_update_frame_boxes", {
      frame: 0,
      hurtbox: { offset: { x: 1, y: 2 }, size: { x: 8, y: 9 } },
    });
    await current.service.call("xsxb_update_timing", { frame: 1, duration_ms: 250 });
    const wavPath = path.join(current.root, "hit.wav");
    fs.writeFileSync(wavPath, createTestWav());
    await current.service.call("xsxb_add_sfx", { file_path: wavPath, frame: 1, id: "hit-sound" });
    const attachmentPath = path.join(current.root, "glow.png");
    fs.writeFileSync(attachmentPath, bodyFrame(1));
    await current.service.call("xsxb_add_attachment", {
      file_path: attachmentPath,
      frame: 0,
      id: "glow",
    });
    await current.service.call("xsxb_add_attack_trail", { id: "slash-trail" });

    const full = await current.service.call("xsxb_get_animation", {
      animation_id: "walk",
      include: ["boxes", "timing", "sfx", "attachments", "trails"],
    });
    assert.ok(full.boxes["0"], "frame 0 box override is returned");
    assert.equal(full.boxes["0"].hurtbox.size.x, 8);
    assert.equal(full.timing.frameOverrides["1"].durationMs, 250);
    assert.equal(full.sfx.length, 1);
    assert.equal(full.sfx[0].id, "hit-sound");
    assert.equal(full.sfx[0].frame, 1);
    assert.equal(full.sfx[0].hasData, true);
    assert.equal(full.sfx[0].data, undefined, "sfx base64 payload is omitted");
    assert.equal(full.attachments.length, 1);
    assert.equal(full.attachments[0].id, "glow");
    assert.equal(full.attachments[0].frame, 0);
    assert.equal(full.trails.length, 1);
    assert.equal(full.trails[0].id, "slash-trail");

    const summary = await current.service.call("xsxb_get_animation", {
      animation_id: "walk",
      frames: "summary",
      include: ["sfx"],
    });
    assert.equal(summary.summary, true);
    assert.equal(summary.sfx.length, 1);

    const bare = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    assert.equal(bare.boxes, undefined, "sections stay opt-in");

    await assert.rejects(
      current.service.call("xsxb_get_animation", { animation_id: "walk", include: ["nope"] }),
      /include\[0\].*must be one of/,
    );
  } finally {
    current.cleanup();
  }
});

test("update_frame_boxes and update_timing apply many frames in one call", async () => {
  const current = await importedFixture();
  try {
    const boxResult = await current.service.call("xsxb_update_frame_boxes", {
      frames: [
        { frame: 0, hurtbox: { size: { x: 5, y: 5 } } },
        { frame: 1, hitbox: { size: { x: 6, y: 3 } } },
      ],
    });
    assert.equal(boxResult.updatedFrames, 2);
    assert.equal(boxResult.updates.length, 2);
    assert.equal(boxResult.frame, undefined, "batch response has no single-frame fields");

    const single = await current.service.call("xsxb_update_frame_boxes", {
      frame: 0,
      hitbox: { size: { x: 4, y: 4 } },
    });
    assert.equal(single.frame, 0, "single-frame response keeps its shape");
    assert.ok(single.boxes.hurtbox, "earlier hurtbox patch is preserved");

    const timingResult = await current.service.call("xsxb_update_timing", {
      frames: [
        { frame: 0, duration_ms: 100 },
        { frame: 1, disabled: true },
      ],
    });
    assert.equal(timingResult.playbackUpdates.length, 2);
    assert.equal(timingResult.playbackUpdates[0].durationMs, 100);
    assert.equal(timingResult.playbackUpdates[1].disabled, true);

    const readBack = await current.service.call("xsxb_get_animation", {
      include: ["boxes", "timing"],
    });
    assert.equal(readBack.boxes["0"].hitbox.size.x, 4);
    assert.equal(readBack.boxes["1"].hitbox.size.x, 6);
    assert.equal(readBack.timing.frameOverrides["0"].durationMs, 100);
    assert.equal(readBack.timing.frameOverrides["1"].disabled, true);

    await assert.rejects(
      current.service.call("xsxb_update_frame_boxes", { frames: [{ frame: 0 }] }),
      /at least one of hurtbox/,
    );
    await assert.rejects(
      current.service.call("xsxb_update_frame_boxes", { frames: [{ frame: 99, hitbox: {} }] }),
      /Frame must be an integer/,
    );
  } finally {
    current.cleanup();
  }
});

test("remove_binding deletes sfx, attachments, and trails with dry_run preview", async () => {
  const current = await importedFixture();
  try {
    const wavPath = path.join(current.root, "hit.wav");
    fs.writeFileSync(wavPath, createTestWav());
    await current.service.call("xsxb_add_sfx", { file_path: wavPath, frame: 0, id: "hit-sound" });
    const attachmentPath = path.join(current.root, "glow.png");
    fs.writeFileSync(attachmentPath, bodyFrame(1));
    await current.service.call("xsxb_add_attachment", {
      file_path: attachmentPath,
      frame: 1,
      id: "glow",
    });
    await current.service.call("xsxb_add_attack_trail", { id: "slash-trail" });

    const preview = await current.service.call("xsxb_remove_binding", {
      kind: "sfx",
      id: "hit-sound",
      dry_run: true,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.removedCount, 1);
    let readBack = await current.service.call("xsxb_get_animation", { include: ["sfx"] });
    assert.equal(readBack.sfx.length, 1, "dry_run keeps the binding");

    const removedSfx = await current.service.call("xsxb_remove_binding", {
      kind: "sfx",
      id: "hit-sound",
      frame: 0,
    });
    assert.equal(removedSfx.removedCount, 1);
    assert.equal(removedSfx.remainingCount, 0);
    assert.equal(removedSfx.removed[0].data, undefined, "receipt omits base64 audio");

    const removedAttachment = await current.service.call("xsxb_remove_binding", {
      kind: "attachment",
      id: "glow",
    });
    assert.equal(removedAttachment.removedCount, 1);

    const removedTrail = await current.service.call("xsxb_remove_binding", {
      kind: "trail",
      id: "slash-trail",
    });
    assert.equal(removedTrail.removedCount, 1);

    readBack = await current.service.call("xsxb_get_animation", {
      include: ["sfx", "attachments", "trails"],
    });
    assert.equal(readBack.sfx.length, 0);
    assert.equal(readBack.attachments.length, 0);
    assert.equal(readBack.trails.length, 0);

    await assert.rejects(
      current.service.call("xsxb_remove_binding", { kind: "sfx", id: "missing" }),
      /binding not found: missing.*\(none\)/,
    );
    await assert.rejects(
      current.service.call("xsxb_remove_binding", { kind: "trail", id: "x", frame: 0 }),
      /frame is not applicable/,
    );
    await assert.rejects(
      current.service.call("xsxb_remove_binding", { kind: "bogus", id: "x" }),
      /"kind" must be one of: sfx, attachment, trail/,
    );
  } finally {
    current.cleanup();
  }
});

test("xsxb_add_attachment binds many frames in one call", async () => {
  const current = await importedFixture();
  try {
    const attachmentPath = path.join(current.root, "sword.png");
    fs.writeFileSync(attachmentPath, bodyFrame(0));
    const added = await current.service.call("xsxb_add_attachment", {
      file_path: attachmentPath,
      id: "ember_sword",
      scale: 0.13,
      frames: [
        { frame: 0, offset_x: 1, offset_y: -2 },
        { frame: 1, offset_x: 3, offset_y: -4 },
      ],
      sync: false,
    });
    assert.equal(added.updatedFrames, 2);
    assert.equal(added.bindings.length, 2);
    assert.equal(added.bindings[0].frame, 0);
    assert.equal(added.bindings[1].transform.offset.x, 3);
    const readBack = await current.service.call("xsxb_get_animation", { include: ["attachments"] });
    assert.equal(readBack.attachments.length, 2);
    assert.equal(readBack.attachments[0].id, "ember_sword");
    assert.equal(readBack.attachments[1].frame, 1);
    assert.equal(readBack.attachments[1].transform.offset.y, -4);
  } finally {
    current.cleanup();
  }
});

test("estimate_boxes fills every frame, previews with dry_run, and skips existing overrides", async () => {
  const current = await importedFixture();
  try {
    const project = current.store.activeProject("bind-test");
    const tuningPath = current.store.projectPaths(project).tuning;
    const tuning = JSON.parse(fs.readFileSync(tuningPath, "utf8"));
    tuning.frame_box_overrides = {};
    fs.writeFileSync(tuningPath, JSON.stringify(tuning, null, 2));

    const preview = await current.service.call("xsxb_estimate_boxes", { dry_run: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.estimatedFrames, 2);
    assert.ok(preview.frames[0].boxes.hurtbox, "preview returns estimated boxes");
    const untouched = JSON.parse(fs.readFileSync(tuningPath, "utf8"));
    assert.deepEqual(untouched.frame_box_overrides, {}, "dry_run does not persist");

    const applied = await current.service.call("xsxb_estimate_boxes", {});
    assert.equal(applied.estimatedFrames, 2);
    assert.equal(applied.skippedExistingFrames, 0);
    const readBack = await current.service.call("xsxb_get_animation", { include: ["boxes"] });
    assert.ok(readBack.boxes["0"].hurtbox);
    assert.ok(readBack.boxes["1"].collisionbox);

    const skipped = await current.service.call("xsxb_estimate_boxes", {});
    assert.equal(skipped.estimatedFrames, 0);
    assert.equal(skipped.skippedExistingFrames, 2);

    const replaced = await current.service.call("xsxb_estimate_boxes", { replace: true });
    assert.equal(replaced.estimatedFrames, 2);
  } finally {
    current.cleanup();
  }
});

test("add_attack_trail keeps stick layer and reverseDirection and spans the swing", async () => {
  const current = await importedFixture();
  try {
    const trail = await current.service.call("xsxb_add_attack_trail", {
      id: "cleave",
      sticks: [
        {
          frame: 0,
          top: { x: -10, y: -40 },
          bottom: { x: 10, y: -8 },
          layer: "behind",
          reverseDirection: true,
        },
        {
          frame: 1,
          top: { x: 40, y: -12 },
          bottom: { x: 8, y: -6 },
          layer: "front",
          reverseDirection: false,
        },
      ],
      sync: false,
    });
    assert.equal(trail.segment.sticks[0].layer, "behind");
    assert.equal(trail.segment.sticks[0].reverseDirection, true);
    assert.equal(trail.segment.sticks[1].layer, "front");
    assert.equal(trail.frameSpan, 1);
    assert.equal(trail.segment.sticks[0].framePhase, 0);
    assert.equal(trail.segment.sticks[1].framePhase, 1);
    assert.ok(trail.centerTravel > 20, "centers must move for this authored pair");
    assert.ok(trail.edgeTravel > 20, "blade edges must travel");
    assert.ok(
      trail.segment.beforeStopChaseMultiplier > 0.08 && trail.segment.beforeStopChaseMultiplier < 0.3,
    );
    assert.equal(trail.note, null);
  } finally {
    current.cleanup();
  }
});

test("remove_binding unlinks unreferenced workspace sfx and attachment copies", async () => {
  const current = await importedFixture();
  try {
    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "idle",
    });

    const wavPath = path.join(current.root, "hit.wav");
    fs.writeFileSync(wavPath, createTestWav());
    const walkSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "walk",
      file_path: wavPath,
      frame: 1,
      id: "hit-sound",
    });
    const idleSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "idle",
      file_path: wavPath,
      frame: 0,
      id: "hit-sound",
    });
    const attachmentPath = path.join(current.root, "glow.png");
    fs.writeFileSync(attachmentPath, bodyFrame(1));
    const walkAttachment = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "walk",
      file_path: attachmentPath,
      frame: 0,
      id: "glow",
    });

    const sfxAbs = path.resolve(current.root, walkSfx.binding.path);
    const idleSfxAbs = path.resolve(current.root, idleSfx.binding.path);
    const attachmentAbs = path.resolve(current.root, walkAttachment.binding.path);
    assert.equal(sfxAbs, idleSfxAbs, "same wav bytes share one workspace hash file");
    assert.equal(fs.existsSync(sfxAbs), true, "workspace sfx copy exists before remove");
    assert.equal(fs.existsSync(attachmentAbs), true, "workspace attachment copy exists before remove");

    await callTool(current.service, "xsxb_remove_binding", {
      animation_id: "walk",
      kind: "sfx",
      id: "hit-sound",
      dry_run: false,
    });
    await callTool(current.service, "xsxb_remove_binding", {
      animation_id: "walk",
      kind: "attachment",
      id: "glow",
      dry_run: false,
    });

    const walk = await current.service.call("xsxb_get_animation", {
      animation_id: "walk",
      include: ["sfx", "attachments"],
    });
    assert.equal(walk.sfx.length, 0, "walk sfx binding is gone");
    assert.equal(walk.attachments.length, 0, "walk attachment binding is gone");
    assert.equal(
      fs.existsSync(attachmentAbs),
      false,
      "unreferenced attachment workspace copy must be unlinked",
    );
    assert.equal(fs.existsSync(sfxAbs), true, "shared sfx hash file stays while idle still references it");

    const idle = await current.service.call("xsxb_get_animation", {
      animation_id: "idle",
      include: ["sfx"],
    });
    assert.equal(idle.sfx.length, 1, "idle sfx binding remains");

    await callTool(current.service, "xsxb_remove_binding", {
      animation_id: "idle",
      kind: "sfx",
      id: "hit-sound",
      dry_run: false,
    });
    const idleAfter = await current.service.call("xsxb_get_animation", {
      animation_id: "idle",
      include: ["sfx"],
    });
    assert.equal(idleAfter.sfx.length, 0, "idle sfx binding is gone");
    assert.equal(fs.existsSync(sfxAbs), false, "sfx workspace copy unlinks after last binding");
  } finally {
    current.cleanup();
  }
});

test("delete_animation unlinks unreferenced workspace sfx and attachment copies", async () => {
  const current = await importedFixture();
  try {
    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "idle",
    });

    const wavPath = path.join(current.root, "hit.wav");
    fs.writeFileSync(wavPath, createTestWav());
    const walkSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "walk",
      file_path: wavPath,
      frame: 1,
      id: "hit-sound",
    });
    const idleSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "idle",
      file_path: wavPath,
      frame: 0,
      id: "hit-sound",
    });
    const attachmentPath = path.join(current.root, "glow.png");
    fs.writeFileSync(attachmentPath, bodyFrame(1));
    const walkAttachment = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "walk",
      file_path: attachmentPath,
      frame: 0,
      id: "glow",
    });

    const sfxAbs = path.resolve(current.root, walkSfx.binding.path);
    const idleSfxAbs = path.resolve(current.root, idleSfx.binding.path);
    const attachmentAbs = path.resolve(current.root, walkAttachment.binding.path);
    assert.equal(sfxAbs, idleSfxAbs, "same wav bytes share one workspace hash file");
    assert.equal(fs.existsSync(sfxAbs), true, "workspace sfx copy exists before delete");
    assert.equal(fs.existsSync(attachmentAbs), true, "workspace attachment copy exists before delete");

    const removed = await callTool(current.service, "xsxb_delete_animation", {
      animation_id: "walk",
      dry_run: false,
    });
    assert.equal(removed.deleted, true);
    await assert.rejects(
      () => current.service.call("xsxb_get_animation", { animation_id: "walk" }),
      /not found/i,
    );
    assert.equal(
      fs.existsSync(attachmentAbs),
      false,
      "unreferenced attachment workspace copy must be unlinked",
    );
    assert.equal(fs.existsSync(sfxAbs), true, "shared sfx hash file stays while idle still references it");

    const removedIdle = await callTool(current.service, "xsxb_delete_animation", {
      animation_id: "idle",
      dry_run: false,
    });
    assert.equal(removedIdle.deleted, true);
    assert.equal(fs.existsSync(sfxAbs), false, "sfx workspace copy unlinks after last binding");
  } finally {
    current.cleanup();
  }
});

test("add_attachment rebind unlinks leftover workspace hash png", async () => {
  const current = await importedFixture();
  try {
    const glowA = path.join(current.root, "glow-a.png");
    fs.writeFileSync(glowA, bodyFrame(1));
    const walkFirst = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "walk",
      file_path: glowA,
      frame: 0,
      id: "glow",
      sync: false,
    });
    const oldRel = walkFirst.binding.path;
    const oldAbs = path.resolve(current.root, oldRel);
    assert.equal(fs.existsSync(oldAbs), true, "first glow hash png exists");

    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "idle",
    });
    const idleFirst = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "idle",
      file_path: glowA,
      frame: 0,
      id: "glow",
      sync: false,
    });
    assert.equal(path.basename(idleFirst.binding.path), path.basename(oldRel), "shared hash must stay");
    assert.equal(fs.existsSync(oldAbs), true, "walk hash png stays after idle bind");

    const glowB = path.join(current.root, "glow-b.png");
    fs.writeFileSync(glowB, bodyFrame(3));
    const walkRebound = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "walk",
      file_path: glowB,
      frame: 0,
      id: "glow",
      sync: false,
    });
    assert.notEqual(walkRebound.binding.path, oldRel, "walk binding.path must change");
    const walkNewAbs = path.resolve(current.root, walkRebound.binding.path);
    assert.equal(fs.existsSync(walkNewAbs), true, "new walk hash file exists");
    assert.equal(fs.existsSync(oldAbs), true, "old hash stays while idle still references it");

    const idleRebound = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "idle",
      file_path: glowB,
      frame: 0,
      id: "glow",
      sync: false,
    });
    assert.equal(fs.existsSync(oldAbs), false, "old hash unlinks after last rebind");
    assert.equal(
      path.basename(idleRebound.binding.path),
      path.basename(walkRebound.binding.path),
      "idle and walk now point at the new hash",
    );
    assert.equal(
      fs.existsSync(path.resolve(current.root, idleRebound.binding.path)),
      true,
      "new idle hash file exists",
    );
    assert.equal(fs.existsSync(walkNewAbs), true, "new walk hash file still exists");
  } finally {
    current.cleanup();
  }
});

test("add_sfx rebind unlinks leftover workspace hash wav", async () => {
  const current = await importedFixture();
  try {
    const hitA = path.join(current.root, "hit-a.wav");
    fs.writeFileSync(hitA, createTestWav());
    const walkFirst = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "walk",
      file_path: hitA,
      frame: 1,
      id: "hit-sound",
      sync: false,
    });
    const oldRel = walkFirst.binding.path;
    const oldAbs = path.resolve(current.root, oldRel);
    assert.equal(fs.existsSync(oldAbs), true, "first hit hash wav exists");

    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "idle",
    });
    const idleFirst = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "idle",
      file_path: hitA,
      frame: 0,
      id: "hit-sound",
      sync: false,
    });
    assert.equal(idleFirst.binding.path, oldRel, "same wav bytes share one workspace hash file");
    assert.equal(fs.existsSync(oldAbs), true, "walk hash wav stays after idle bind");

    const hitB = path.join(current.root, "hit-b.wav");
    fs.writeFileSync(hitB, createTestWav({ frequency: 880 }));
    const walkRebound = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "walk",
      file_path: hitB,
      frame: 1,
      id: "hit-sound",
      sync: false,
    });
    assert.notEqual(walkRebound.binding.path, oldRel, "walk binding.path must change");
    const walkNewAbs = path.resolve(current.root, walkRebound.binding.path);
    assert.equal(fs.existsSync(walkNewAbs), true, "new walk hash file exists");
    assert.equal(fs.existsSync(oldAbs), true, "old hash stays while idle still references it");

    const idleRebound = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "idle",
      file_path: hitB,
      frame: 0,
      id: "hit-sound",
      sync: false,
    });
    assert.equal(fs.existsSync(oldAbs), false, "old hash unlinks after last rebind");
    assert.equal(
      idleRebound.binding.path,
      walkRebound.binding.path,
      "idle and walk now point at the new hash",
    );
    assert.equal(
      fs.existsSync(path.resolve(current.root, idleRebound.binding.path)),
      true,
      "new idle hash file exists",
    );
    assert.equal(fs.existsSync(walkNewAbs), true, "new walk hash file still exists");
  } finally {
    current.cleanup();
  }
});

test("add_attack_trail rebind unlinks leftover workspace texture png", async () => {
  const current = await importedFixture();
  try {
    const trailA = path.join(current.root, "trail-a.png");
    const trailB = path.join(current.root, "trail-b.png");
    fs.writeFileSync(trailA, bodyFrame(1));
    fs.writeFileSync(trailB, bodyFrame(3));
    const sticks = [
      { frame: 0, top: { x: -10, y: -40 }, bottom: { x: 10, y: -8 } },
      { frame: 1, top: { x: 40, y: -12 }, bottom: { x: 8, y: -6 } },
    ];
    const slash = await callTool(current.service, "xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "slash",
      texture_path: trailA,
      sticks,
      sync: false,
    });
    const oldRel = slash.segment.texture.path;
    const oldAbs = path.resolve(current.root, oldRel);
    assert.equal(fs.existsSync(oldAbs), true, "first slash workspace texture exists");
    assert.match(oldRel, /[/\\]attack_trails[/\\]/);
    assert.ok(!oldRel.includes("presets"), "must not be the preset texture");
    assert.match(path.basename(oldRel), /^[0-9a-f]{64}\.png$/);

    const glow = await callTool(current.service, "xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "glow",
      texture_path: trailA,
      sticks,
      sync: false,
    });
    assert.equal(glow.segment.texture.path, slash.segment.texture.path, "same dest");
    assert.equal(fs.existsSync(oldAbs), true, "old dest stays after glow bind");

    const slashRebound = await callTool(current.service, "xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "slash",
      texture_path: trailB,
      sticks,
      sync: false,
    });
    assert.notEqual(slashRebound.segment.texture.path, oldRel, "slash path must change");
    const newAbs = path.resolve(current.root, slashRebound.segment.texture.path);
    assert.equal(fs.existsSync(newAbs), true, "new slash hash file exists");
    assert.equal(fs.existsSync(oldAbs), true, "old hash stays while glow still references it");

    const glowRebound = await callTool(current.service, "xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "glow",
      texture_path: trailB,
      sticks,
      sync: false,
    });
    assert.equal(fs.existsSync(oldAbs), false, "old hash unlinks after last rebind");
    assert.equal(
      glowRebound.segment.texture.path,
      slashRebound.segment.texture.path,
      "both point at new hash file",
    );
    assert.equal(
      fs.existsSync(path.resolve(current.root, glowRebound.segment.texture.path)),
      true,
      "new hash file exists",
    );
  } finally {
    current.cleanup();
  }
});

test("replace import unlinks leftover workspace binding copies", async () => {
  const current = await importedFixture();
  try {
    const wavPath = path.join(current.root, "hit.wav");
    fs.writeFileSync(wavPath, createTestWav());
    const walkSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "walk",
      file_path: wavPath,
      frame: 1,
      id: "hit-sound",
    });

    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "idle",
    });
    const idleSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "idle",
      file_path: wavPath,
      frame: 0,
      id: "hit-sound",
    });

    const attachmentPath = path.join(current.root, "glow.png");
    fs.writeFileSync(attachmentPath, bodyFrame(1));
    const walkAttachment = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "walk",
      file_path: attachmentPath,
      frame: 0,
      id: "glow",
    });

    const trailA = path.join(current.root, "trail-a.png");
    fs.writeFileSync(trailA, bodyFrame(3));
    const slash = await callTool(current.service, "xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "slash",
      texture_path: trailA,
      sticks: [
        { frame: 0, top: { x: -10, y: -40 }, bottom: { x: 10, y: -8 } },
        { frame: 1, top: { x: 40, y: -12 }, bottom: { x: 8, y: -6 } },
      ],
      sync: false,
    });

    const sfxAbs = path.resolve(current.root, walkSfx.binding.path);
    const idleSfxAbs = path.resolve(current.root, idleSfx.binding.path);
    const attachmentAbs = path.resolve(current.root, walkAttachment.binding.path);
    const trailAbs = path.resolve(current.root, slash.segment.texture.path);
    assert.equal(sfxAbs, idleSfxAbs, "same wav bytes share one workspace hash file");
    assert.equal(fs.existsSync(sfxAbs), true, "shared sfx hash exists before replace");
    assert.equal(fs.existsSync(attachmentAbs), true, "attachment hash exists before replace");
    assert.equal(fs.existsSync(trailAbs), true, "trail texture exists before replace");
    assert.match(slash.segment.texture.path, /[/\\]attack_trails[/\\]/);
    assert.ok(!slash.segment.texture.path.includes("presets"), "trail path under attack_trails, not presets");

    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "walk",
      replace: true,
      sync: false,
    });

    const walk = await callTool(current.service, "xsxb_get_animation", {
      animation_id: "walk",
      include: ["sfx", "attachments", "trails"],
    });
    assert.equal(walk.sfx.length, 0, "walk sfx stripped");
    assert.equal(walk.attachments.length, 0, "walk attachments stripped");
    assert.equal(
      !walk.trails?.length || !walk.trails.some((trail) => trail.id === "slash"),
      true,
      "walk slash trail stripped",
    );

    const idle = await callTool(current.service, "xsxb_get_animation", {
      animation_id: "idle",
      include: ["sfx"],
    });
    assert.equal(idle.sfx.length, 1, "idle sfx remains");
    assert.equal(fs.existsSync(sfxAbs), true, "shared sfx hash stays while idle refs it");
    assert.equal(
      fs.existsSync(attachmentAbs),
      false,
      "unreferenced attachment workspace copy must be unlinked",
    );
    assert.equal(fs.existsSync(trailAbs), false, "unreferenced trail workspace copy must be unlinked");

    await callTool(current.service, "xsxb_remove_binding", {
      animation_id: "idle",
      kind: "sfx",
      id: "hit-sound",
      dry_run: false,
    });
    assert.equal(fs.existsSync(sfxAbs), false, "sfx workspace copy unlinks after last binding");
  } finally {
    current.cleanup();
  }
});

test("reorganize drop-frame unlinks leftover workspace binding copies", async () => {
  const current = await importedFixture();
  try {
    const wavPath = path.join(current.root, "hit.wav");
    fs.writeFileSync(wavPath, createTestWav());
    const walkSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "walk",
      file_path: wavPath,
      frame: 1,
      id: "hit-sound",
    });

    await callTool(current.service, "xsxb_import_animation", {
      source: "png_sequence",
      directory: current.sequenceDir,
      project_id: "bind-test",
      animation_id: "idle",
    });
    const idleSfx = await callTool(current.service, "xsxb_add_sfx", {
      animation_id: "idle",
      file_path: wavPath,
      frame: 0,
      id: "hit-sound",
    });

    const attachmentPath = path.join(current.root, "glow.png");
    fs.writeFileSync(attachmentPath, bodyFrame(1));
    const walkAttachment = await callTool(current.service, "xsxb_add_attachment", {
      animation_id: "walk",
      file_path: attachmentPath,
      frame: 1,
      id: "glow",
    });

    const sfxAbs = path.resolve(current.root, walkSfx.binding.path);
    const idleSfxAbs = path.resolve(current.root, idleSfx.binding.path);
    const attachmentAbs = path.resolve(current.root, walkAttachment.binding.path);
    assert.equal(sfxAbs, idleSfxAbs, "same wav bytes share one workspace hash file");
    assert.equal(fs.existsSync(sfxAbs), true, "shared sfx hash exists before reorganize");
    assert.equal(fs.existsSync(attachmentAbs), true, "attachment hash exists before reorganize");

    const observed = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    await callTool(current.service, "xsxb_reorganize_frames", {
      animation_id: "walk",
      order: [0],
      basis_snapshot_id: observed.observation.snapshotId,
      sync: false,
    });

    const walk = await callTool(current.service, "xsxb_get_animation", {
      animation_id: "walk",
      include: ["sfx", "attachments"],
    });
    assert.equal(
      !walk.attachments?.length || !walk.attachments.some((attachment) => attachment.id === "glow"),
      true,
      "walk glow attachment dropped with frame 1",
    );
    assert.equal(walk.sfx.length, 0, "walk sfx empty after dropping frame 1");

    const idle = await callTool(current.service, "xsxb_get_animation", {
      animation_id: "idle",
      include: ["sfx"],
    });
    assert.equal(idle.sfx.length, 1, "idle sfx remains");
    assert.equal(fs.existsSync(sfxAbs), true, "shared sfx hash stays while idle refs it");
    assert.equal(
      fs.existsSync(attachmentAbs),
      false,
      "unreferenced attachment workspace copy must be unlinked",
    );
  } finally {
    current.cleanup();
  }
});

test("reorganize drop-frame removes empty trail segment and texture", async () => {
  const current = await importedFixture();
  try {
    const trailA = path.join(current.root, "trail-a.png");
    fs.writeFileSync(trailA, bodyFrame(3));
    const slash = await callTool(current.service, "xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "slash",
      texture_path: trailA,
      sticks: [
        { frame: 1, top: { x: -10, y: -40 }, bottom: { x: 10, y: -8 } },
        { frame: 1, top: { x: 40, y: -12 }, bottom: { x: 8, y: -6 } },
      ],
      sync: false,
    });
    const trailAbs = path.resolve(current.root, slash.segment.texture.path);
    assert.equal(fs.existsSync(trailAbs), true, "trail texture exists before reorganize");
    assert.match(slash.segment.texture.path, /[/\\]attack_trails[/\\]/);
    assert.ok(!slash.segment.texture.path.includes("presets"), "trail path under attack_trails, not presets");

    const observed = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    await callTool(current.service, "xsxb_reorganize_frames", {
      animation_id: "walk",
      order: [0],
      basis_snapshot_id: observed.observation.snapshotId,
      sync: false,
    });

    const walk = await callTool(current.service, "xsxb_get_animation", {
      animation_id: "walk",
      include: ["trails"],
    });
    assert.equal(
      !walk.trails?.length || !walk.trails.some((trail) => trail.id === "slash"),
      true,
      "walk slash trail dropped with frame 1",
    );
    assert.equal(fs.existsSync(trailAbs), false, "unreferenced trail workspace copy must be unlinked");
  } finally {
    current.cleanup();
  }
});
