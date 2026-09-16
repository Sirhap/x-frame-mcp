#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { handleMessage } = require("../mcp/xsxb_mcp_server");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { GODOT_SYNC_ROOT } = require("../mcp/lib/godot_sync");
const { decodePngRgba } = require("../mcp/xsxb_mcp_cutout");
const {
  HERO,
  HERO_COLORS,
  countPixels,
  heroFrame,
  isOnionCyan,
  isOnionRed,
  isTrueMagenta,
  paintBurst,
  paintCrate,
  paintGroundedActor,
  paintHero,
  writePngSequence,
} = require("./acceptance_sprites");

const BLACK_PLATE = Object.freeze([0, 0, 0, 255]);

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
 * Imports a PNG sequence and estimates boxes.
 * @param {object} service MCP service.
 * @param {object} args Import arguments.
 * @returns {Promise<object>} Import receipt.
 */
async function importClip(service, args) {
  const imported = await callTool(service, "xsxb_import_animation", {
    source: "png_sequence",
    fps: 8,
    sync: true,
    ...args,
  });
  assert.equal(imported.ok, true, JSON.stringify(imported.error || imported));
  await callTool(service, "xsxb_estimate_boxes", {
    project_id: args.project_id,
    profile_id: args.profile_id,
    animation_id: args.animation_id,
    sync: true,
  });
  return imported;
}

/**
 * Reads one clip from a Godot validation receipt.
 * @param {object} receipt Validation receipt.
 * @param {string} id Animation id.
 * @returns {object|undefined} Scale-contract clip.
 */
function scaleClip(receipt, id) {
  return (receipt.data.scale_contract?.clips || []).find((clip) => clip.id === id);
}

/**
 * Asserts hair and boot colors are still in a sheet, not a lone torso block.
 * @param {{data:Uint8ClampedArray}} image Decoded PNG.
 * @param {string} label Assertion label.
 * @returns {void}
 */
function assertHeroPresent(image, label) {
  const hair = countPixels(
    image,
    (r, g, b) => r === HERO_COLORS.hair[0] && g === HERO_COLORS.hair[1] && b === HERO_COLORS.hair[2],
  );
  const boot = countPixels(
    image,
    (r, g, b) => r === HERO_COLORS.boot[0] && g === HERO_COLORS.boot[1] && b === HERO_COLORS.boot[2],
  );
  const pant = countPixels(
    image,
    (r, g, b) => r === HERO_COLORS.pant[0] && g === HERO_COLORS.pant[1] && b === HERO_COLORS.pant[2],
  );
  assert.ok(hair >= 16, `${label} missing hair (${hair})`);
  assert.ok(boot >= 16, `${label} missing boots (${boot})`);
  assert.ok(pant >= 16, `${label} missing pants (${pant})`);
}

/**
 * Copies existing files into a keep directory.
 * @param {string} dest Destination.
 * @param {Record<string,string>} files Basename to source path.
 * @returns {void}
 */
function keepFiles(dest, files) {
  if (!dest) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, from] of Object.entries(files)) {
    if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name));
  }
}

/**
 * Runs playbook acceptance against disposable Godot projects.
 * Uses 64×64 heroes with hair, coat, two legs, and boots — not a single block.
 * @param {{keepDir?:string}} [options] When set, copies preview/evidence PNGs there.
 * @returns {Promise<object>} Paths and metrics for the caller.
 */
async function runPlaybookAcceptance(options = {}) {
  const keepDir = options.keepDir || process.env.XSXB_ACCEPTANCE_KEEP || "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-playbook-accept-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const kept = {};
  try {
    const idleFrames = [
      heroFrame({ stride: -1, arm: 0 }),
      heroFrame({ stride: 0, arm: 1 }),
      heroFrame({ stride: 1, arm: 2, sword: true }),
      heroFrame({ stride: 0, arm: -1 }),
    ];
    const walkFrames = [
      heroFrame({ stride: -3, arm: 2 }),
      heroFrame({ stride: 0, arm: 0 }),
      heroFrame({ stride: 3, arm: -2 }),
      heroFrame({ stride: 1, arm: 1 }),
    ];
    const jumpFrames = [
      heroFrame({ stride: 0, arm: 1, lift: 0 }),
      heroFrame({ stride: 1, arm: 2, lift: 10 }),
    ];
    const slashFrames = [
      heroFrame({ stride: 1, arm: 2, sword: true }),
      heroFrame({ stride: 1, arm: 2, sword: true, slash: true }),
    ];
    const burstFrames = [
      {
        width: HERO.width,
        height: HERO.height,
        data: paintBurst(HERO.width, HERO.height, { cy: 16, radius: 10 }),
      },
      {
        width: HERO.width,
        height: HERO.height,
        data: paintBurst(HERO.width, HERO.height, { cy: 18, radius: 13 }),
      },
    ];
    const idleDir = writePngSequence(path.join(root, "idle-seq"), idleFrames);
    const walkDir = writePngSequence(path.join(root, "walk-seq"), walkFrames);
    const jumpDir = writePngSequence(path.join(root, "jump-seq"), jumpFrames);
    const slashDir = writePngSequence(path.join(root, "slash-seq"), slashFrames);
    const burstDir = writePngSequence(path.join(root, "burst-seq"), burstFrames);

    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Accept"\n');
    assert.equal(
      (await callTool(service, "xsxb_create_project", { project_id: "hero", label: "Hero" })).ok,
      true,
    );
    await callTool(service, "xsxb_bind_godot", { project_id: "hero", project_root: game });
    const imported = await importClip(service, {
      project_id: "hero",
      directory: idleDir,
      profile_id: "hero",
      animation_id: "idle",
    });
    assert.equal(imported.data.importedFrameCount, 4);
    assert.equal(imported.data.animationType, "actor");
    const synced = await callTool(service, "xsxb_sync_godot", { project_id: "hero" });
    assert.equal(synced.ok, true);
    assert.equal(synced.data.godot?.runtime?.actorScript, true);
    assert.ok((synced.data.godot?.animations || []).some((clip) => clip.id === "idle"));

    const diffed = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      profile_id: "hero",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 2,
      mode: "diff",
    });
    assert.equal(diffed.ok, true, JSON.stringify(diffed.error || diffed));
    const previewPath = diffed.data.preview.path;
    assert.ok(fs.existsSync(previewPath));
    const preview = decodePngRgba(previewPath);
    assert.equal(preview.width, 64);
    assert.equal(preview.height, 64);
    const magenta = countPixels(preview, isTrueMagenta);
    assert.ok(magenta >= 40, `arm/stride motion must mark real magenta, got ${magenta}`);
    assert.equal(diffed.data.changedPixelCount, magenta);
    assert.equal(diffed.data.qa, "review");
    kept["playbook_diff_magenta.png"] = previewPath;

    const onion = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 2,
      mode: "onion",
    });
    assert.equal(onion.ok, true);
    const onionImage = decodePngRgba(onion.data.preview.path);
    const onionRed = countPixels(onionImage, isOnionRed);
    const onionCyan = countPixels(onionImage, isOnionCyan);
    assert.ok(onionRed >= 20, `onion vacated must be red, got ${onionRed}`);
    assert.ok(onionCyan >= 20, `onion new must be cyan, got ${onionCyan}`);
    kept["playbook_onion_red_cyan.png"] = onion.data.preview.path;

    const identical = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 0,
      mode: "diff",
    });
    assert.equal(identical.ok, true);
    assert.equal(identical.data.qa, "warn");
    assert.equal(identical.data.changedPixelCount, 0);

    const unfinished = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(unfinished.ok, false);
    assert.equal(unfinished.data.qa, "warn");
    assert.ok((unfinished.data.errors || []).some((message) => /xsxb_frame_actor/.test(message)));

    writeGameplayScene(game);
    const ready = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(ready.ok, true, JSON.stringify(ready.data?.errors || ready.error || ready));
    assert.equal(ready.data.qa, "clean");
    assertHeroPresent(decodePngRgba(ready.data.evidence.path), "hero evidence");
    assert.ok(ready.data.godot?.runtime?.actorScript);
    assert.equal(JSON.parse(fs.readFileSync(ready.data.run_summary.path, "utf8")).qa, "clean");
    kept["playbook_evidence_hero.png"] = ready.data.evidence.path;
    kept["playbook_run_summary_hero.json"] = ready.data.run_summary.path;

    await importClip(service, {
      project_id: "hero",
      directory: walkDir,
      profile_id: "hero",
      animation_id: "walk",
    });
    const planted = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(planted.ok, true, JSON.stringify(planted.data?.errors || planted.error || planted));
    assert.equal(planted.data.scale_contract.ok, true);
    assert.equal(scaleClip(planted, "idle").feetY, HERO.feetY);
    assert.equal(scaleClip(planted, "walk").feetY, HERO.feetY);

    await importClip(service, {
      project_id: "hero",
      directory: jumpDir,
      profile_id: "hero",
      animation_id: "jump",
    });
    const withJump = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(withJump.ok, true, JSON.stringify(withJump.data?.errors || withJump.error || withJump));
    assert.equal(withJump.data.scale_contract.ok, true);
    assert.ok(!(withJump.data.scale_contract.issues || []).some((issue) => /jump/.test(issue)));

    await importClip(service, {
      project_id: "hero",
      directory: slashDir,
      profile_id: "hero",
      animation_id: "attack",
    });
    const withSlash = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(withSlash.ok, true, JSON.stringify(withSlash.data?.errors || withSlash.error || withSlash));
    assert.equal(withSlash.data.scale_contract.ok, true);
    assert.equal(scaleClip(withSlash, "attack").feetY, HERO.feetY);

    await importClip(service, {
      project_id: "hero",
      directory: burstDir,
      profile_id: "hero",
      animation_id: "hit_vfx",
    });
    const withFx = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "hero",
      require_gameplay: true,
    });
    assert.equal(withFx.ok, true, JSON.stringify(withFx.data?.errors || withFx.error || withFx));
    assert.equal(withFx.data.scale_contract.ok, true);
    assert.ok(!(withFx.data.scale_contract.issues || []).some((issue) => /hit_vfx/.test(issue)));

    const mixedDir = writePngSequence(path.join(root, "mixed-seq"), [
      heroFrame({ stride: 0 }),
      {
        width: 32,
        height: 32,
        data: paintGroundedActor(32, 32, { originX: 8, originY: 10 }),
      },
    ]);
    await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: mixedDir,
      profile_id: "hero",
      animation_id: "mixed_size",
      fps: 8,
    });
    const mismatched = await callTool(service, "xsxb_diff_frames", {
      project_id: "hero",
      animation_id: "mixed_size",
      frame_a: 0,
      frame_b: 1,
      mode: "diff",
    });
    assert.equal(mismatched.ok, false);
    assert.match(String(mismatched.error?.message || ""), /same width and height/);

    const badType = await callTool(service, "xsxb_import_animation", {
      project_id: "hero",
      source: "png_sequence",
      directory: idleDir,
      animation_id: "bad_type",
      animation_type: "jumper",
    });
    assert.equal(badType.ok, false);
    assert.match(String(badType.error?.message || ""), /animation_type/);

    const driftGame = path.join(root, "game-drift");
    fs.mkdirSync(driftGame);
    fs.writeFileSync(path.join(driftGame, "project.godot"), '[application]\nconfig/name="Drift"\n');
    const bounceDir = writePngSequence(path.join(root, "bounce-seq"), [
      heroFrame({ stride: -2, arm: 1, lift: 0 }),
      heroFrame({ stride: 2, arm: -1, lift: 8 }),
    ]);
    const tallDir = writePngSequence(path.join(root, "tall-seq"), [
      heroFrame({ stride: 2, arm: 1, tall: 6 }),
      heroFrame({ stride: -2, arm: -1, tall: 6 }),
    ]);
    const jumperDir = writePngSequence(path.join(root, "jumper-seq"), [
      heroFrame({ stride: 1, lift: 8 }),
      heroFrame({ stride: -1, lift: 8 }),
    ]);
    const propositionDir = writePngSequence(path.join(root, "proposition-seq"), [
      heroFrame({ stride: 0, lift: 8 }),
      heroFrame({ stride: 1, lift: 8 }),
    ]);
    await callTool(service, "xsxb_create_project", { project_id: "drift", label: "Drift" });
    await callTool(service, "xsxb_bind_godot", { project_id: "drift", project_root: driftGame });
    writeGameplayScene(driftGame);
    await importClip(service, {
      project_id: "drift",
      directory: idleDir,
      profile_id: "drift",
      animation_id: "idle",
    });
    await importClip(service, {
      project_id: "drift",
      directory: bounceDir,
      profile_id: "drift",
      animation_id: "walk",
    });
    const bounceSoft = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "drift",
      require_gameplay: true,
    });
    assert.equal(bounceSoft.ok, true);
    assert.equal(bounceSoft.data.qa, "review");
    assert.equal(bounceSoft.data.scale_contract.ok, false);
    assert.ok(
      bounceSoft.data.scale_contract.issues.some((issue) => /walk/.test(issue) && /spans/.test(issue)),
    );
    const bounceStrict = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "drift",
      require_gameplay: true,
      strict: true,
    });
    assert.equal(bounceStrict.ok, false);
    assert.equal(bounceStrict.data.qa, "warn");

    await importClip(service, {
      project_id: "drift",
      directory: tallDir,
      profile_id: "drift",
      animation_id: "run",
    });
    const tallReceipt = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "drift",
      require_gameplay: true,
      strict: true,
    });
    assert.equal(tallReceipt.ok, false);
    assert.ok(
      tallReceipt.data.scale_contract.issues.some((issue) => /run/.test(issue) && /height/.test(issue)),
    );

    await importClip(service, {
      project_id: "drift",
      directory: jumperDir,
      profile_id: "drift",
      animation_id: "jumper",
    });
    await importClip(service, {
      project_id: "drift",
      directory: propositionDir,
      profile_id: "drift",
      animation_id: "proposition",
    });
    const named = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "drift",
      require_gameplay: true,
      strict: true,
    });
    assert.equal(named.ok, false);
    assert.ok(named.data.scale_contract.issues.some((issue) => /jumper/.test(issue) && /feet/i.test(issue)));
    assert.ok(
      named.data.scale_contract.issues.some((issue) => /proposition/.test(issue) && /feet/i.test(issue)),
    );
    kept["playbook_run_summary_drift.json"] = named.data.run_summary.path;

    const inkGame = path.join(root, "game-ink");
    fs.mkdirSync(inkGame);
    fs.writeFileSync(path.join(inkGame, "project.godot"), '[application]\nconfig/name="Ink"\n');
    const blackIdle = writePngSequence(path.join(root, "ink-idle"), [
      heroFrame({ plate: BLACK_PLATE, stride: -1, arm: 0 }),
      heroFrame({ plate: BLACK_PLATE, stride: 1, arm: 2, sword: true }),
    ]);
    const sparkDir = writePngSequence(path.join(root, "ink-spark"), [
      {
        width: HERO.width,
        height: HERO.height,
        data: paintBurst(HERO.width, HERO.height, { plate: BLACK_PLATE, cy: 14, radius: 9 }),
      },
      {
        width: HERO.width,
        height: HERO.height,
        data: paintBurst(HERO.width, HERO.height, { plate: BLACK_PLATE, cy: 20, radius: 12 }),
      },
    ]);
    const crateDir = writePngSequence(path.join(root, "ink-crate"), [
      {
        width: HERO.width,
        height: HERO.height,
        data: paintCrate(HERO.width, HERO.height, { plate: BLACK_PLATE, y: 18 }),
      },
      {
        width: HERO.width,
        height: HERO.height,
        data: paintCrate(HERO.width, HERO.height, { plate: BLACK_PLATE, y: 22 }),
      },
    ]);
    await callTool(service, "xsxb_create_project", { project_id: "ink", label: "Ink" });
    await callTool(service, "xsxb_bind_godot", { project_id: "ink", project_root: inkGame });
    writeGameplayScene(inkGame);
    await importClip(service, {
      project_id: "ink",
      directory: blackIdle,
      profile_id: "ink",
      animation_id: "idle",
    });
    const blackReady = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "ink",
      require_gameplay: true,
    });
    assert.equal(
      blackReady.ok,
      true,
      JSON.stringify(blackReady.data?.errors || blackReady.error || blackReady),
    );
    assert.equal(blackReady.data.qa, "clean");
    assertHeroPresent(decodePngRgba(blackReady.data.evidence.path), "black evidence");
    kept["playbook_evidence_ink.png"] = blackReady.data.evidence.path;

    const spark = await importClip(service, {
      project_id: "ink",
      directory: sparkDir,
      profile_id: "ink",
      animation_id: "spark",
      animation_type: "vfx",
    });
    assert.equal(spark.data.animationType, "vfx");
    await importClip(service, {
      project_id: "ink",
      directory: crateDir,
      profile_id: "ink",
      animation_id: "barrel",
      animation_type: "prop",
    });
    const inkFx = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "ink",
      require_gameplay: true,
    });
    assert.equal(inkFx.ok, true, JSON.stringify(inkFx.data?.errors || inkFx.error || inkFx));
    assert.equal(inkFx.data.scale_contract.ok, true);
    assert.ok(!(inkFx.data.scale_contract.issues || []).some((issue) => /spark|barrel/.test(issue)));
    kept["playbook_run_summary_ink.json"] = inkFx.data.run_summary.path;
    keepFiles(keepDir, kept);
    keepFiles(keepDir, {
      "source_idle_00.png": path.join(idleDir, "00.png"),
      "source_idle_02.png": path.join(idleDir, "02.png"),
      "source_walk_00.png": path.join(walkDir, "00.png"),
      "source_jump_01.png": path.join(jumpDir, "01.png"),
      "source_slash_01.png": path.join(slashDir, "01.png"),
      "source_burst_00.png": path.join(burstDir, "00.png"),
      "source_black_idle_01.png": path.join(blackIdle, "01.png"),
    });

    return {
      root,
      keepDir,
      previewPath,
      evidencePath: ready.data.evidence.path,
      magenta,
      onionRed,
      onionCyan,
      changedPixelCount: diffed.data.changedPixelCount,
      idleFeetY: HERO.feetY,
    };
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = {
  paintGroundedActor,
  paintHero,
  runPlaybookAcceptance,
  writeGameplayScene,
};

if (require.main === module) {
  runPlaybookAcceptance()
    .then((report) => {
      process.stdout.write(
        `Playbook acceptance passed. magenta=${report.magenta} changed=${report.changedPixelCount} onion=${report.onionRed}/${report.onionCyan} feetY=${report.idleFeetY}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
