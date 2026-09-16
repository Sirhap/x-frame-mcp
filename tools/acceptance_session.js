#!/usr/bin/env node
"use strict";

/**
 * Simulates the public agent playbook: import idle first, cutout, lock walk
 * to idle, plant soles, diff, boxes, sync, then validate_for_godot.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { decodePngRgba } = require("../mcp/xsxb_mcp_cutout");
const { callTool, writeGameplayScene } = require("./acceptance_playbooks");
const { keepFiles } = require("./acceptance_keep");
const {
  HERO,
  HERO_COLORS,
  countPixels,
  heroFrame,
  isTrueMagenta,
  paintBurst,
  writePngSequence,
} = require("./acceptance_sprites");

/**
 * Reads a cutout snapshot id from get_animation.
 * @param {object} service MCP service.
 * @param {object} args Animation selection.
 * @returns {Promise<string>} Snapshot id.
 */
async function observe(service, args) {
  const receipt = await callTool(service, "xsxb_get_animation", args);
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error || receipt));
  const snapshotId = receipt.observation?.snapshotId;
  assert.ok(snapshotId, "get_animation must mint basis_snapshot_id");
  return snapshotId;
}

/**
 * Asserts a magenta flatten still has hair and boots.
 * @param {string} previewPath Cutout preview.path.
 * @param {string} label Step label.
 * @returns {object} Pixel counts.
 */
function assertMagentaPreview(previewPath, label) {
  assert.ok(fs.existsSync(previewPath), `${label} missing preview`);
  const image = decodePngRgba(previewPath);
  const magenta = countPixels(image, isTrueMagenta);
  const hair = countPixels(
    image,
    (r, g, b) => r === HERO_COLORS.hair[0] && g === HERO_COLORS.hair[1] && b === HERO_COLORS.hair[2],
  );
  const boot = countPixels(
    image,
    (r, g, b) => r === HERO_COLORS.boot[0] && g === HERO_COLORS.boot[1] && b === HERO_COLORS.boot[2],
  );
  assert.ok(magenta >= 200, `${label} preview is not a magenta flatten (${magenta})`);
  assert.ok(hair >= 8, `${label} keyed the hair away (${hair})`);
  assert.ok(boot >= 8, `${label} keyed the boots away (${boot})`);
  return { magenta, hair, boot, width: image.width, height: image.height };
}

/**
 * Runs one agent-shaped session against public tools/call.
 * @param {{keepDir?:string}} [options] Artifact directory.
 * @returns {Promise<object>} Step metrics.
 */
async function runSessionAcceptance(options = {}) {
  const keepDir = options.keepDir || process.env.XSXB_ACCEPTANCE_KEEP || "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-session-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const kept = {};
  const log = [];
  try {
    const idleDir = writePngSequence(path.join(root, "incoming", "idle"), [
      heroFrame({ stride: -1, arm: 0 }),
      heroFrame({ stride: 0, arm: 1 }),
      heroFrame({ stride: 1, arm: 2, sword: true }),
      heroFrame({ stride: 0, arm: -1 }),
    ]);
    const walkDir = writePngSequence(path.join(root, "incoming", "walk"), [
      heroFrame({ stride: 2, arm: 2 }),
      heroFrame({ stride: 3, arm: 0 }),
      heroFrame({ stride: 5, arm: -2 }),
      heroFrame({ stride: 4, arm: 1 }),
    ]);
    const slashDir = writePngSequence(path.join(root, "incoming", "attack"), [
      heroFrame({ stride: 2, arm: 2, sword: true }),
      heroFrame({ stride: 2, arm: 2, sword: true, slash: true }),
    ]);
    const burstDir = writePngSequence(path.join(root, "incoming", "hit_vfx"), [
      { width: HERO.width, height: HERO.height, data: paintBurst(HERO.width, HERO.height, { cy: 16 }) },
      {
        width: HERO.width,
        height: HERO.height,
        data: paintBurst(HERO.width, HERO.height, { cy: 20, radius: 13 }),
      },
    ]);

    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Session"\n');

    const listed = await callTool(service, "xsxb_list_projects", {});
    assert.equal(listed.ok, true);
    log.push("list_projects");

    const created = await callTool(service, "xsxb_create_project", {
      project_id: "hero",
      label: "Hero",
    });
    assert.equal(created.ok, true);
    await callTool(service, "xsxb_bind_godot", { project_id: "hero", project_root: game });
    log.push("create+bind");

    const idleImport = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: idleDir,
      profile_id: "hero",
      animation_id: "idle",
      fps: 8,
    });
    assert.equal(idleImport.ok, true);
    assert.equal(idleImport.data.importedFrameCount, 4);
    const idleGot = await callTool(service, "xsxb_get_animation", {
      project_id: "hero",
      animation_id: "idle",
    });
    assert.equal(idleGot.data.frameCount, 4);
    log.push("import idle");

    const idleCut = await callTool(service, "xsxb_cutout", {
      project_id: "hero",
      animation_id: "idle",
      key_mode: "border_flood",
      key_color: "#f8f8f8",
      receipt: "short",
      basis_snapshot_id: idleGot.observation.snapshotId,
    });
    assert.equal(idleCut.ok, true, JSON.stringify(idleCut.error || idleCut));
    const idlePreview = assertMagentaPreview(idleCut.data.preview.path, "idle cutout");
    kept["session_cutout_idle_preview.png"] = idleCut.data.preview.path;
    const idleFrame = decodePngRgba(idleGot.data.animation.frames[0].absolutePath);
    assert.ok(idleFrame.data[3] <= 16, "idle plate corner must be transparent after cutout");
    const idlePlant = await callTool(service, "xsxb_plant_feet", {
      project_id: "hero",
      animation_id: "idle",
      target_y: -1,
      apply: true,
    });
    assert.equal(idlePlant.ok, true, JSON.stringify(idlePlant.error || idlePlant));
    log.push("cutout+plant idle y=-1");

    const walkImport = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: walkDir,
      profile_id: "hero",
      animation_id: "walk",
      fps: 8,
    });
    assert.equal(walkImport.ok, true);
    const walkSnap = await observe(service, { project_id: "hero", animation_id: "walk" });
    const walkCut = await callTool(service, "xsxb_cutout", {
      project_id: "hero",
      animation_id: "walk",
      key_mode: "border_flood",
      key_color: "#f8f8f8",
      basis_snapshot_id: walkSnap,
    });
    assert.equal(walkCut.ok, true, JSON.stringify(walkCut.error || walkCut));
    assertMagentaPreview(walkCut.data.preview.path, "walk cutout");
    kept["session_cutout_walk_preview.png"] = walkCut.data.preview.path;
    log.push("import+cutout walk");

    const beforeLock = await callTool(service, "xsxb_measure_frames", {
      project_id: "hero",
      animation_id: "walk",
      reference_animation_id: "idle",
    });
    assert.equal(beforeLock.ok, true);
    log.push("measure walk before lock");

    const registerPreview = await callTool(service, "xsxb_register_clip", {
      project_id: "hero",
      animation_id: "walk",
      reference_animation_id: "idle",
      mode: "shared_scale",
      metric: "bbox",
    });
    assert.equal(registerPreview.ok, true);
    assert.equal(registerPreview.data.dryRun !== false || registerPreview.data.apply === false, true);
    const registerApply = await callTool(service, "xsxb_register_clip", {
      project_id: "hero",
      animation_id: "walk",
      reference_animation_id: "idle",
      mode: "shared_scale",
      metric: "bbox",
      apply: true,
    });
    assert.equal(registerApply.ok, true, JSON.stringify(registerApply.error || registerApply));
    log.push("register_clip walk");

    const plantPreview = await callTool(service, "xsxb_plant_feet", {
      project_id: "hero",
      animation_id: "walk",
      target_y: -1,
    });
    assert.equal(plantPreview.ok, true);
    const plantApply = await callTool(service, "xsxb_plant_feet", {
      project_id: "hero",
      animation_id: "walk",
      target_y: -1,
      apply: true,
    });
    assert.equal(plantApply.ok, true, JSON.stringify(plantApply.error || plantApply));
    const afterLock = await callTool(service, "xsxb_measure_frames", {
      project_id: "hero",
      animation_id: "walk",
      reference_animation_id: "idle",
    });
    assert.equal(afterLock.ok, true);
    const feetDrift = Math.max(...afterLock.data.frames.map((frame) => Math.abs(Number(frame.dFeet) || 0)));
    assert.ok(feetDrift <= 2, `after plant, walk dFeet vs idle must stay tight, got ${feetDrift}`);
    log.push(`plant walk y=-1 dFeet<=${feetDrift}`);

    const diffed = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 2,
      mode: "diff",
    });
    assert.equal(diffed.ok, true);
    assert.equal(diffed.data.qa, "review");
    assert.ok(diffed.data.changedPixelCount >= 40);
    kept["session_diff_idle.png"] = diffed.data.preview.path;
    const onion = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      animation_id: "walk",
      frame_a: 0,
      frame_b: 2,
      mode: "onion",
    });
    assert.equal(onion.ok, true);
    kept["session_onion_walk.png"] = onion.data.preview.path;
    log.push("diff+onion");

    const sheet = await callTool(service, "xsxb_export_sheet", {
      project_id: "hero",
      animation_id: "idle",
      normalize: "feet",
      grid: false,
      columns: 4,
    });
    assert.equal(sheet.ok, true);
    const sheetPath = sheet.data.outputPath || sheet.data.preview?.path || sheet.data.path;
    assert.ok(sheetPath && fs.existsSync(sheetPath), "export_sheet must write a PNG");
    kept["session_idle_sheet.png"] = sheetPath;
    log.push("export_sheet grid=false");

    const attackImport = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: slashDir,
      profile_id: "hero",
      animation_id: "attack",
      fps: 8,
    });
    assert.equal(attackImport.ok, true);
    const attackSnap = await observe(service, { project_id: "hero", animation_id: "attack" });
    const attackCut = await callTool(service, "xsxb_cutout", {
      project_id: "hero",
      animation_id: "attack",
      key_mode: "border_flood",
      key_color: "#f8f8f8",
      protected_colors: ["#ffe040"],
      basis_snapshot_id: attackSnap,
    });
    assert.equal(attackCut.ok, true, JSON.stringify(attackCut.error || attackCut));
    kept["session_cutout_attack_preview.png"] = attackCut.data.preview.path;
    const attackLock = await callTool(service, "xsxb_register_clip", {
      project_id: "hero",
      animation_id: "attack",
      reference_animation_id: "idle",
      mode: "shared_scale",
      apply: true,
    });
    assert.equal(attackLock.ok, true, JSON.stringify(attackLock.error || attackLock));
    const attackPlant = await callTool(service, "xsxb_plant_feet", {
      project_id: "hero",
      animation_id: "attack",
      target_y: -1,
      apply: true,
    });
    assert.equal(attackPlant.ok, true, JSON.stringify(attackPlant.error || attackPlant));
    log.push("lock+plant attack");

    const fxImport = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: burstDir,
      profile_id: "hero",
      animation_id: "hit_spark",
      animation_type: "vfx",
      fps: 10,
    });
    assert.equal(fxImport.ok, true);
    assert.equal(fxImport.data.animationType, "vfx");
    const fxSnap = await observe(service, { project_id: "hero", animation_id: "hit_spark" });
    const fxCut = await callTool(service, "xsxb_cutout", {
      project_id: "hero",
      animation_id: "hit_spark",
      key_mode: "border_flood",
      key_color: "#f8f8f8",
      basis_snapshot_id: fxSnap,
    });
    assert.equal(fxCut.ok, true, JSON.stringify(fxCut.error || fxCut));
    kept["session_cutout_vfx_preview.png"] = fxCut.data.preview.path;
    log.push("import+cutout vfx");

    for (const animationId of ["idle", "walk", "attack"]) {
      const boxes = await callTool(service, "xsxb_estimate_boxes", {
        project_id: "hero",
        animation_id: animationId,
        replace: true,
      });
      assert.equal(boxes.ok, true, JSON.stringify(boxes.error || boxes));
    }
    log.push("estimate_boxes");

    writeGameplayScene(game);
    const synced = await callTool(service, "xsxb_sync_godot", { project_id: "hero" });
    assert.equal(synced.ok, true);
    assert.equal(synced.data.godot?.runtime?.actorScript, true);
    log.push("sync_godot");

    const gate = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(gate.ok, true, JSON.stringify(gate.data?.errors || gate.error || gate));
    assert.equal(gate.data.qa, "clean");
    assert.equal(gate.data.scale_contract.ok, true);
    assert.ok(!(gate.data.scale_contract.issues || []).some((issue) => /hit_spark/.test(issue)));
    kept["session_godot_evidence.png"] = gate.data.evidence.path;
    kept["session_run_summary.json"] = gate.data.run_summary.path;
    log.push("validate_for_godot clean");

    keepFiles(keepDir, kept);
    if (keepDir) {
      fs.writeFileSync(
        path.join(keepDir, "session_log.json"),
        `${JSON.stringify({ log, idlePreview }, null, 2)}\n`,
      );
    }
    return {
      keepDir,
      log,
      idlePreview,
      changedPixelCount: diffed.data.changedPixelCount,
      qa: gate.data.qa,
    };
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { runSessionAcceptance };

if (require.main === module) {
  runSessionAcceptance()
    .then((report) => {
      process.stdout.write(
        `Session acceptance passed. qa=${report.qa} diff=${report.changedPixelCount} steps=${report.log.length}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
