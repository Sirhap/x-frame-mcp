#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { handleMessage } = require("../mcp/xsxb_mcp_server");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { GODOT_SYNC_ROOT } = require("../mcp/lib/godot_sync");
const { decodePngRgba, encodePngRgba } = require("../mcp/xsxb_mcp_cutout");

const PLATE = Object.freeze([248, 248, 248, 255]);
const BODY = Object.freeze([24, 48, 96, 255]);
const BOOT = Object.freeze([12, 20, 40, 255]);

/**
 * Paints a navy body and darker boots on a light plate.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{originX:number,originY:number,bodyW?:number,bodyH?:number}} pose Body top-left and size.
 * @returns {Uint8ClampedArray} RGBA pixels.
 */
function paintGroundedActor(width, height, pose) {
  const data = new Uint8ClampedArray(width * height * 4);
  const bodyW = pose.bodyW || 8;
  const bodyH = pose.bodyH || 14;
  const plate = pose.plate || PLATE;
  for (let i = 0; i < width * height; i += 1) data.set(plate, i * 4);
  for (let y = pose.originY; y < pose.originY + bodyH; y += 1) {
    for (let x = pose.originX; x < pose.originX + bodyW; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const boot = y >= pose.originY + bodyH - 2;
      data.set(boot ? BOOT : BODY, (y * width + x) * 4);
    }
  }
  return data;
}

/**
 * Sends one public JSON-RPC tools/call and returns the v2 receipt.
 * @param {object} service MCP service.
 * @param {string} name Tool name.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<object>} Structured receipt.
 */
async function callTool(service, name, args = {}) {
  const handled = await handleMessage(
    { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
    service,
  );
  const receipt = handled?.result?.structuredContent;
  if (!receipt) {
    throw new Error(`${name} returned no structured receipt: ${JSON.stringify(handled)}`);
  }
  return receipt;
}

/**
 * Writes a gameplay scene that instances the generated actor and consumes runtime APIs.
 * @param {string} game Godot project root.
 * @returns {void}
 */
function writeGameplayScene(game) {
  const actor = `res://${GODOT_SYNC_ROOT}/runtime/xsxb_frame_actor.tscn`;
  fs.writeFileSync(
    path.join(game, "player.gd"),
    [
      "extends Node2D",
      `const ACTOR := preload("${actor}")`,
      "func _ready() -> void:",
      "\tvar actor = ACTOR.instantiate()",
      "\tadd_child(actor)",
      '\tactor.play_frame_animation("idle")',
      '\tvar _lock := actor.animation_duration("idle")',
      "\tvar _move := actor.scene_scale()",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(game, "player.tscn"),
    [
      "[gd_scene load_steps=3 format=3]",
      "",
      `[ext_resource type="Script" path="res://player.gd" id="1_script"]`,
      `[ext_resource type="PackedScene" path="${actor}" id="2_actor"]`,
      "",
      '[node name="Player" type="Node2D"]',
      'script = ExtResource("1_script")',
      "",
      '[node name="XFrameActor" parent="." instance=ExtResource("2_actor")]',
      "",
    ].join("\n"),
  );
}

/**
 * Runs the playbook acceptance against a disposable Godot project.
 * Writes preview and evidence PNGs, then asserts pixel and gate behavior.
 * @returns {Promise<object>} Paths and metrics for the caller.
 */
async function runPlaybookAcceptance() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-playbook-accept-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  try {
    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Accept"\n');
    const idleA = paintGroundedActor(32, 32, { originX: 8, originY: 10 });
    const idleB = paintGroundedActor(32, 32, { originX: 12, originY: 10 });
    const drifted = paintGroundedActor(32, 32, { originX: 10, originY: 4 });
    const idleDir = path.join(root, "idle-seq");
    const walkDir = path.join(root, "walk-seq");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    fs.writeFileSync(path.join(idleDir, "00.png"), encodePngRgba(idleA, 32, 32));
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idleB, 32, 32));
    fs.writeFileSync(path.join(walkDir, "00.png"), encodePngRgba(drifted, 32, 32));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(drifted, 32, 32));

    const created = await callTool(service, "xsxb_create_project", { project_id: "hero", label: "Hero" });
    assert.equal(created.ok, true);
    await callTool(service, "xsxb_bind_godot", { project_id: "hero", project_root: game });
    const imported = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: idleDir,
      profile_id: "hero",
      animation_id: "idle",
      fps: 8,
      sync: true,
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.data.importedFrameCount, 2);
    await callTool(service, "xsxb_estimate_boxes", {
      project_id: "hero",
      profile_id: "hero",
      animation_id: "idle",
      sync: true,
    });

    const diffed = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      profile_id: "hero",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 1,
      mode: "diff",
    });
    assert.equal(diffed.ok, true, JSON.stringify(diffed.error || diffed));
    const previewPath = diffed.data.preview.path;
    assert.ok(fs.existsSync(previewPath), "diff preview must be a real file");
    const preview = decodePngRgba(previewPath);
    assert.equal(preview.width, 32);
    assert.equal(preview.height, 32);
    let magenta = 0;
    for (let i = 0; i < preview.data.length; i += 4) {
      if (
        preview.data[i] >= 220 &&
        preview.data[i + 1] <= 40 &&
        preview.data[i + 2] >= 180 &&
        preview.data[i + 3] > 200
      )
        magenta += 1;
    }
    assert.ok(magenta >= 20, `diff must mark the 4px stride, got ${magenta} magenta pixels`);
    assert.ok(diffed.data.changedPixelCount >= 20);
    assert.equal(diffed.data.qa, "review");

    const onion = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 1,
      mode: "onion",
    });
    assert.equal(onion.ok, true);
    const onionImage = decodePngRgba(onion.data.preview.path);
    let onionRed = 0;
    let onionCyan = 0;
    for (let i = 0; i < onionImage.data.length; i += 4) {
      const r = onionImage.data[i];
      const g = onionImage.data[i + 1];
      const b = onionImage.data[i + 2];
      const a = onionImage.data[i + 3];
      if (r >= 180 && g <= 40 && b <= 40 && a > 200) onionRed += 1;
      if (r <= 40 && g >= 180 && b >= 180 && a > 200) onionCyan += 1;
    }
    assert.ok(onionRed >= 20, `onion must mark vacated columns red, got ${onionRed}`);
    assert.ok(onionCyan >= 20, `onion must mark new columns cyan, got ${onionCyan}`);

    const unfinished = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(unfinished.ok, false);
    assert.equal(unfinished.data.qa, "warn");
    assert.ok(
      (unfinished.data.errors || []).some((message) => /xsxb_frame_actor/.test(message)),
      "missing gameplay scene must fail validate_for_godot",
    );

    writeGameplayScene(game);
    const ready = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(ready.ok, true, JSON.stringify(ready.data?.errors || ready.error || ready));
    assert.equal(ready.data.qa, "clean");
    assert.ok(fs.existsSync(ready.data.evidence.path));
    assert.ok(ready.data.godot?.runtime?.actorScript);
    assert.ok(fs.existsSync(ready.data.run_summary.path));
    const runSummary = JSON.parse(fs.readFileSync(ready.data.run_summary.path, "utf8"));
    assert.equal(runSummary.ok, true);
    assert.equal(runSummary.qa, "clean");
    const evidence = decodePngRgba(ready.data.evidence.path);
    assert.ok(evidence.width >= 32 && evidence.height >= 32);

    const fxDir = path.join(root, "fx-seq");
    fs.mkdirSync(fxDir);
    const fxBurst = paintGroundedActor(32, 32, { originX: 6, originY: 2 });
    fs.writeFileSync(path.join(fxDir, "00.png"), encodePngRgba(fxBurst, 32, 32));
    fs.writeFileSync(path.join(fxDir, "01.png"), encodePngRgba(fxBurst, 32, 32));
    await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: fxDir,
      profile_id: "hero",
      animation_id: "hit_vfx",
      fps: 8,
      sync: true,
    });
    await callTool(service, "xsxb_estimate_boxes", { animation_id: "hit_vfx", sync: true });
    const withFx = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(withFx.ok, true, JSON.stringify(withFx.data?.errors || withFx.error || withFx));
    assert.equal(withFx.data.scale_contract.ok, true);
    assert.ok(!(withFx.data.scale_contract.issues || []).some((issue) => /hit_vfx/.test(issue)));

    await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: walkDir,
      profile_id: "hero",
      animation_id: "walk",
      fps: 8,
      sync: true,
    });
    await callTool(service, "xsxb_estimate_boxes", {
      project_id: "hero",
      animation_id: "walk",
      sync: true,
    });
    const driftedReceipt = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
      strict: true,
    });
    assert.equal(driftedReceipt.ok, false);
    assert.equal(driftedReceipt.data.qa, "warn");
    assert.equal(driftedReceipt.data.scale_contract.ok, false);
    assert.ok(
      driftedReceipt.data.scale_contract.issues.some((issue) => /feet/i.test(issue)),
      "walk planted on a different sole row must fail the scale contract",
    );

    return {
      root,
      previewPath,
      evidencePath: ready.data.evidence.path,
      magenta,
      changedPixelCount: diffed.data.changedPixelCount,
    };
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { paintGroundedActor, runPlaybookAcceptance, writeGameplayScene };

if (require.main === module) {
  runPlaybookAcceptance()
    .then((report) => {
      process.stdout.write(
        `Playbook acceptance passed. magenta=${report.magenta} changed=${report.changedPixelCount}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
