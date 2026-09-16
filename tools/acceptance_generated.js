#!/usr/bin/env node
"use strict";

/**
 * Real tools/call session on generated hero plates: import → cutout →
 * gameplay lock → Godot gate. Does not replace the pixel-hero session.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createXsxbMcpService } = require("../mcp/xsxb_mcp_service");
const { decodePngRgba, encodePngRgba } = require("../mcp/xsxb_mcp_cutout");
const { callTool, writeGameplayScene } = require("./acceptance_playbooks");
const { countPixels, isTrueMagenta } = require("./acceptance_sprites");

const PREFERRED_ROOT = path.join(__dirname, "fixtures", "generated_hero");
const ASSET_ROOT = "/opt/cursor/artifacts/assets";
const DEFAULT_KEEP = "/opt/cursor/artifacts/generated_session_evidence";
const REQUIRED_CLIPS = Object.freeze(["idle", "walk", "jump", "attack", "hit_vfx"]);
const ASSET_CANDIDATES = Object.freeze({
  idle: Object.freeze(["hero_idle_a.png", "hero_idle_b.png"]),
  walk: Object.freeze(["hero_walk.png", "hero_walk_b.png", "hero_walk.png"]),
  jump: Object.freeze(["hero_jump.png", "hero_jump_b.png", "hero_jump.png"]),
  attack: Object.freeze(["hero_attack.png", "hero_idle_b.png"]),
  hit_vfx: Object.freeze(["hero_vfx_burst.png", "hero_vfx_burst_b.png", "hero_vfx_burst.png"]),
  ink_idle: Object.freeze(["hero_idle_black.png", "hero_idle_black.png"]),
});

/**
 * Sleeps without spinning.
 * @param {number} ms Duration.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Lists PNG files in numeric name order.
 * @param {string} directory Folder.
 * @returns {string[]} Absolute paths.
 */
function listClipPngs(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
    .map((name) => path.join(directory, name));
}

/**
 * Reads preferred fixture folders when every required clip has frames.
 * @returns {Record<string,string>|null} Clip id to directory.
 */
function preferredClips() {
  const clips = {};
  for (const id of REQUIRED_CLIPS) {
    const directory = path.join(PREFERRED_ROOT, id);
    if (listClipPngs(directory).length < 1) return null;
    clips[id] = directory;
  }
  const ink = path.join(PREFERRED_ROOT, "ink_idle");
  if (listClipPngs(ink).length) clips.ink_idle = ink;
  return clips;
}

/**
 * Resolves one authored plate from known asset roots.
 * @param {string} name Basename.
 * @returns {string|null} Absolute path.
 */
function findAsset(name) {
  const roots = [
    process.env.XSXB_GENERATED_ASSETS || "",
    ASSET_ROOT,
    path.join(PREFERRED_ROOT, "raw"),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Picks two source plates, duplicating the first when only one exists.
 * @param {readonly string[]} names Candidate basenames in preference order.
 * @returns {string[]|null} Two absolute paths.
 */
function pickAssetPair(names) {
  const found = [];
  for (const name of names) {
    const filePath = findAsset(name);
    if (filePath) found.push(filePath);
  }
  const unique = [...new Set(found)];
  if (unique.length >= 2) return unique.slice(0, 2);
  if (unique.length === 1) return [unique[0], unique[0]];
  return null;
}

/**
 * Nearest-neighbor shrink so a long edge is at most maxEdge.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image Source.
 * @param {number} maxEdge Long-edge cap.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Maybe-smaller image.
 */
function downsampleRgbaToMax(image, maxEdge) {
  const longest = Math.max(image.width, image.height);
  if (longest <= maxEdge) return image;
  const width = Math.max(1, Math.round((image.width * maxEdge) / longest));
  const height = Math.max(1, Math.round((image.height * maxEdge) / longest));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
      const source = (sourceY * image.width + sourceX) * 4;
      data.set(image.data.subarray(source, source + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

/**
 * Writes a two-frame PNG sequence, downsampling large authored plates.
 * @param {string} destDir Output folder.
 * @param {string[]} sourcePaths Source PNGs.
 * @param {number} [maxEdge=256] Long-edge cap.
 * @returns {string} destDir.
 */
function writeDownsampledSequence(destDir, sourcePaths, maxEdge = 256) {
  fs.mkdirSync(destDir, { recursive: true });
  sourcePaths.forEach((from, index) => {
    const image = downsampleRgbaToMax(decodePngRgba(from), maxEdge);
    fs.writeFileSync(
      path.join(destDir, `${String(index).padStart(2, "0")}.png`),
      encodePngRgba(image.data, image.width, image.height),
    );
  });
  return destDir;
}

/**
 * Builds clip folders from /opt/cursor/artifacts/assets (or raw/) plates.
 * @param {string} tempDir Incoming root.
 * @returns {Record<string,string>|null} Clip directories.
 */
function fallbackClipsFromAssets(tempDir) {
  const clips = {};
  for (const id of REQUIRED_CLIPS) {
    const pair = pickAssetPair(ASSET_CANDIDATES[id]);
    if (!pair) return null;
    clips[id] = writeDownsampledSequence(path.join(tempDir, id), pair);
  }
  const inkPair = pickAssetPair(ASSET_CANDIDATES.ink_idle);
  if (inkPair) clips.ink_idle = writeDownsampledSequence(path.join(tempDir, "ink_idle"), inkPair);
  return clips;
}

/**
 * Waits for preferred fixtures, then downsamples authored plates if needed.
 * @param {{tempDir:string,waitMs?:number}} options Incoming dir and wait budget.
 * @returns {Promise<{source:string,clips:Record<string,string>}>} Clip map.
 */
async function resolveGeneratedHeroDirs(options) {
  const waitMs = Number.isFinite(Number(options.waitMs))
    ? Number(options.waitMs)
    : Number(process.env.XSXB_GENERATED_WAIT_MS || 20000);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const preferred = preferredClips();
    if (preferred) return { source: "fixtures", clips: preferred };
    const fallback = fallbackClipsFromAssets(options.tempDir);
    if (fallback) return { source: "assets", clips: fallback };
    if (Date.now() >= deadline) break;
    await sleep(2000);
  }
  throw new Error(
    `Generated hero plates missing. Looked in ${PREFERRED_ROOT}/{${REQUIRED_CLIPS.join(",")}} and ${ASSET_ROOT}/hero_*.png`,
  );
}

/**
 * Copies a one-frame folder into a two-frame temp sequence.
 * @param {string} directory Source folder.
 * @param {string} incoming Session incoming root.
 * @param {string} id Clip id.
 * @returns {string} Directory with at least two PNGs.
 */
function ensureTwoFrames(directory, incoming, id) {
  const files = listClipPngs(directory);
  assert.ok(files.length >= 1, `No PNG frames for ${id} in ${directory}`);
  if (files.length >= 2) return directory;
  const dest = path.join(incoming, `${id}-dup`);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(files[0], path.join(dest, "00.png"));
  fs.copyFileSync(files[0], path.join(dest, "01.png"));
  return dest;
}

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
  return { snapshotId, receipt };
}

/**
 * True when a flatten pixel is a dark blue coat, not magenta.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Navy coat sample.
 */
function isNavyCoat(r, g, b, a) {
  if (a < 160) return false;
  if (r >= 200 && b >= 180 && g <= 60) return false;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  return b >= r + 8 && b >= g && maxc <= 160 && maxc - minc >= 10 && r <= 90;
}

/**
 * True when a flatten pixel is a near-black boot, not magenta.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Boot sample.
 */
function isBlackBoot(r, g, b, a) {
  if (a < 160) return false;
  if (r >= 200 && b >= 180 && g <= 60) return false;
  return Math.max(r, g, b) <= 48;
}

/**
 * True when a flatten pixel is a gold/yellow slash.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Gold sample.
 */
function isGoldSlash(r, g, b, a) {
  if (a < 160) return false;
  return r >= 200 && g >= 160 && b <= 160 && r - b >= 60;
}

/**
 * Opens a magenta flatten and checks the coat/boots were not keyed away.
 * @param {string} previewPath Cutout preview.path.
 * @param {string} label Step label.
 * @param {{requireBoots?:boolean,requireNavy?:boolean,requireGold?:boolean}} [options]
 *   Per-clip presence checks.
 * @returns {object} Pixel counts.
 */
function inspectMagentaPreview(previewPath, label, options = {}) {
  assert.ok(previewPath && fs.existsSync(previewPath), `${label} missing preview.path`);
  const image = decodePngRgba(previewPath);
  const magenta = countPixels(image, isTrueMagenta);
  let navy = 0;
  let boot = 0;
  let gold = 0;
  let subject = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const a = image.data[offset + 3];
      if (isTrueMagenta(r, g, b, a) || a < 160) continue;
      subject += 1;
      if (isNavyCoat(r, g, b, a)) navy += 1;
      if (y >= image.height * 0.4 && isBlackBoot(r, g, b, a)) boot += 1;
      if (isGoldSlash(r, g, b, a)) gold += 1;
    }
  }
  assert.ok(magenta >= 200, `${label} preview is not a magenta flatten (${magenta})`);
  assert.ok(subject >= 80, `${label} keyed the subject away (${subject})`);
  if (options.requireNavy !== false) {
    assert.ok(navy >= 30, `${label} navy coat vanished (${navy}) — keyed=true is not enough`);
  }
  if (options.requireBoots !== false) {
    assert.ok(boot >= 12, `${label} black boots vanished (${boot}) — keyed=true is not enough`);
  }
  if (options.requireGold) {
    assert.ok(gold >= 8, `${label} gold slash vanished (${gold})`);
  }
  return {
    magenta,
    navy,
    boot,
    gold,
    subject,
    width: image.width,
    height: image.height,
    path: previewPath,
  };
}

/**
 * Copies files into a keep directory.
 * @param {string} dest Destination.
 * @param {Record<string,string>} files Basename to path.
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
 * Reads one clip from a Godot validation receipt.
 * @param {object} receipt Validation receipt.
 * @param {string} id Animation id.
 * @returns {object|undefined} Scale-contract clip.
 */
function scaleClip(receipt, id) {
  return (receipt.data.scale_contract?.clips || []).find((clip) => clip.id === id);
}

/**
 * Pads every frame of a clip to the same canvas so diff_frames can run.
 * Plant can add different overhang rows per frame (AA under the sole).
 * @param {object} service MCP service.
 * @param {object} args Animation selection.
 * @param {{replant?:boolean}} [options] Re-plant soles after pad.
 * @returns {Promise<object>} Size receipt.
 */
async function equalizeClipCanvas(service, args, options = {}) {
  const got = await callTool(service, "xsxb_get_animation", args);
  assert.equal(got.ok, true, JSON.stringify(got.error || got));
  const images = (got.data.animation.frames || []).map((frame) => decodePngRgba(frame.absolutePath));
  assert.ok(images.length >= 2, `${args.animation_id} needs two frames to equalize`);
  const width = Math.max(...images.map((image) => image.width));
  const height = Math.max(...images.map((image) => image.height));
  if (images.every((image) => image.width === width && image.height === height)) {
    return { skipped: true, width, height };
  }
  const resized = await callTool(service, "xsxb_resize_canvas", {
    project_id: args.project_id,
    animation_id: args.animation_id,
    mode: "pad",
    width,
    height,
    dry_run: false,
  });
  assert.equal(resized.ok, true, JSON.stringify(resized.error || resized));
  if (options.replant) {
    const planted = await callTool(service, "xsxb_plant_feet", {
      project_id: args.project_id,
      animation_id: args.animation_id,
      target_y: -1,
      apply: true,
    });
    assert.equal(planted.ok, true, JSON.stringify(planted.error || planted));
  }
  return { skipped: false, width, height };
}

/**
 * Re-plants idle first, then locks grounded clips, after a scale review.
 * @param {object} service MCP service.
 * @param {string} projectId Project id.
 * @returns {Promise<object>} Second validation receipt.
 */
async function repairGroundedScale(service, projectId) {
  await callTool(service, "xsxb_plant_feet", {
    project_id: projectId,
    animation_id: "idle",
    target_y: -1,
    apply: true,
  });
  for (const animationId of ["walk", "attack"]) {
    await callTool(service, "xsxb_register_clip", {
      project_id: projectId,
      animation_id: animationId,
      reference_animation_id: "idle",
      mode: "shared_scale",
      metric: "bbox",
      apply: true,
    });
    await callTool(service, "xsxb_plant_feet", {
      project_id: projectId,
      animation_id: animationId,
      target_y: -1,
      apply: true,
    });
  }
  return callTool(service, "xsxb_validate_for_godot", {
    project_id: projectId,
    require_gameplay: true,
  });
}

/**
 * Runs one agent-shaped session against public tools/call.
 * @param {{keepDir?:string,waitMs?:number}} [options] Artifact directory.
 * @returns {Promise<object>} Step metrics.
 */
async function runGeneratedAcceptance(options = {}) {
  const keepDir = options.keepDir || process.env.XSXB_ACCEPTANCE_KEEP || DEFAULT_KEEP;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-generated-"));
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  const kept = {};
  const log = [];
  const visual = [];
  const report = {
    keepDir,
    log,
    visual,
    qa: null,
    feetY: { idle: null, walk: null },
    changedPixelCount: null,
    idlePreview: null,
    issues: [],
  };
  try {
    const incoming = path.join(root, "incoming");
    fs.mkdirSync(incoming, { recursive: true });
    const resolved = await resolveGeneratedHeroDirs({ tempDir: incoming, waitMs: options.waitMs });
    log.push(`plates source=${resolved.source}`);
    const clipDir = (id) => ensureTwoFrames(resolved.clips[id], incoming, id);

    const game = path.join(root, "game");
    fs.mkdirSync(game);
    fs.writeFileSync(path.join(game, "project.godot"), '[application]\nconfig/name="Generated"\n');

    const listed = await callTool(service, "xsxb_list_projects", {});
    assert.equal(listed.ok, true);
    log.push("list_projects");

    const created = await callTool(service, "xsxb_create_project", {
      project_id: "generated",
      label: "Generated",
    });
    assert.equal(created.ok, true);
    const bound = await callTool(service, "xsxb_bind_godot", {
      project_id: "generated",
      project_root: game,
    });
    assert.equal(bound.ok, true, JSON.stringify(bound.error || bound));
    log.push("create+bind generated");

    const idleImport = await callTool(service, "xsxb_import_animation", {
      project_id: "generated",
      source: "png_sequence",
      directory: clipDir("idle"),
      profile_id: "generated",
      animation_id: "idle",
      fps: 8,
    });
    assert.equal(idleImport.ok, true, JSON.stringify(idleImport.error || idleImport));
    const idleGot = await callTool(service, "xsxb_get_animation", {
      project_id: "generated",
      animation_id: "idle",
    });
    assert.equal(idleGot.ok, true);
    assert.ok(idleGot.data.frameCount >= 2);
    log.push("import idle");

    const idleCut = await callTool(service, "xsxb_cutout", {
      project_id: "generated",
      animation_id: "idle",
      key_mode: "border_flood",
      key_color: "#F8F8F8",
      receipt: "short",
      basis_snapshot_id: idleGot.observation.snapshotId,
    });
    assert.equal(idleCut.ok, true, JSON.stringify(idleCut.error || idleCut));
    report.idlePreview = inspectMagentaPreview(idleCut.data.preview.path, "idle cutout");
    kept["generated_cutout_idle_preview.png"] = idleCut.data.preview.path;
    const idleFrame = decodePngRgba(idleGot.data.animation.frames[0].absolutePath);
    assert.ok(idleFrame.data[3] <= 16, "idle plate corner must be transparent after cutout");
    if (idleCut.data.keyed !== true)
      visual.push("idle keyed flag was not true; magenta flatten still inspected");
    const idlePlant = await callTool(service, "xsxb_plant_feet", {
      project_id: "generated",
      animation_id: "idle",
      target_y: -1,
      apply: true,
    });
    assert.equal(idlePlant.ok, true, JSON.stringify(idlePlant.error || idlePlant));
    const idlePad = await equalizeClipCanvas(
      service,
      { project_id: "generated", animation_id: "idle" },
      { replant: true },
    );
    log.push(
      idlePad.skipped
        ? "cutout+plant idle y=-1"
        : `cutout+plant idle y=-1; pad ${idlePad.width}x${idlePad.height}`,
    );

    const walkImport = await callTool(service, "xsxb_import_animation", {
      project_id: "generated",
      source: "png_sequence",
      directory: clipDir("walk"),
      profile_id: "generated",
      animation_id: "walk",
      fps: 8,
    });
    assert.equal(walkImport.ok, true, JSON.stringify(walkImport.error || walkImport));
    const walkSnap = await observe(service, { project_id: "generated", animation_id: "walk" });
    const walkCut = await callTool(service, "xsxb_cutout", {
      project_id: "generated",
      animation_id: "walk",
      key_mode: "border_flood",
      key_color: "#F8F8F8",
      basis_snapshot_id: walkSnap.snapshotId,
    });
    assert.equal(walkCut.ok, true, JSON.stringify(walkCut.error || walkCut));
    inspectMagentaPreview(walkCut.data.preview.path, "walk cutout");
    kept["generated_cutout_walk_preview.png"] = walkCut.data.preview.path;
    log.push("import+cutout walk");

    const beforeLock = await callTool(service, "xsxb_measure_frames", {
      project_id: "generated",
      animation_id: "walk",
      reference_animation_id: "idle",
    });
    assert.equal(beforeLock.ok, true);
    log.push("measure walk before lock");

    const registerPreview = await callTool(service, "xsxb_register_clip", {
      project_id: "generated",
      animation_id: "walk",
      reference_animation_id: "idle",
      mode: "shared_scale",
      metric: "bbox",
    });
    assert.equal(registerPreview.ok, true);
    const registerApply = await callTool(service, "xsxb_register_clip", {
      project_id: "generated",
      animation_id: "walk",
      reference_animation_id: "idle",
      mode: "shared_scale",
      metric: "bbox",
      apply: true,
    });
    assert.equal(registerApply.ok, true, JSON.stringify(registerApply.error || registerApply));
    log.push("register_clip walk");

    const plantPreview = await callTool(service, "xsxb_plant_feet", {
      project_id: "generated",
      animation_id: "walk",
      target_y: -1,
    });
    assert.equal(plantPreview.ok, true);
    const plantApply = await callTool(service, "xsxb_plant_feet", {
      project_id: "generated",
      animation_id: "walk",
      target_y: -1,
      apply: true,
    });
    assert.equal(plantApply.ok, true, JSON.stringify(plantApply.error || plantApply));
    const walkPad = await equalizeClipCanvas(
      service,
      { project_id: "generated", animation_id: "walk" },
      { replant: true },
    );
    if (!walkPad.skipped) log.push(`pad walk ${walkPad.width}x${walkPad.height}`);
    const afterLock = await callTool(service, "xsxb_measure_frames", {
      project_id: "generated",
      animation_id: "walk",
      reference_animation_id: "idle",
    });
    assert.equal(afterLock.ok, true);
    const feetDrift = Math.max(...afterLock.data.frames.map((frame) => Math.abs(Number(frame.dFeet) || 0)));
    assert.ok(feetDrift <= 2, `after plant, walk dFeet vs idle must stay tight, got ${feetDrift}`);
    report.feetY.walk = afterLock.data.frames[0].feetY;
    report.feetY.idle = afterLock.data.reference?.feetY;
    log.push(`plant walk y=-1 dFeet<=${feetDrift}`);

    const diffed = await callTool(service, "xsxb_diff_frames", {
      project_id: "generated",
      animation_id: "idle",
      frame_a: 0,
      frame_b: 1,
      mode: "diff",
    });
    assert.equal(diffed.ok, true, JSON.stringify(diffed.error || diffed));
    assert.ok(fs.existsSync(diffed.data.preview.path), "idle diff missing preview.path");
    report.changedPixelCount = diffed.data.changedPixelCount;
    if (diffed.data.qa === "warn" || Number(diffed.data.changedPixelCount) === 0) {
      visual.push(
        `idle 0 vs 1 looked identical (qa=${diffed.data.qa} changed=${diffed.data.changedPixelCount})`,
      );
    }
    kept["generated_diff_idle.png"] = diffed.data.preview.path;
    const onion = await callTool(service, "xsxb_diff_frames", {
      project_id: "generated",
      animation_id: "walk",
      frame_a: 0,
      frame_b: 1,
      mode: "onion",
    });
    assert.equal(onion.ok, true, JSON.stringify(onion.error || onion));
    assert.ok(fs.existsSync(onion.data.preview.path), "walk onion missing preview.path");
    kept["generated_onion_walk.png"] = onion.data.preview.path;
    log.push("diff idle 0/1 + walk onion");

    const sheet = await callTool(service, "xsxb_export_sheet", {
      project_id: "generated",
      animation_id: "idle",
      normalize: "feet",
      grid: false,
      columns: 2,
    });
    assert.equal(sheet.ok, true, JSON.stringify(sheet.error || sheet));
    const sheetPath = sheet.data.outputPath || sheet.data.preview?.path || sheet.data.path;
    assert.ok(sheetPath && fs.existsSync(sheetPath), "export_sheet must write a PNG");
    kept["generated_idle_sheet.png"] = sheetPath;
    log.push("export_sheet grid=false normalize=feet");

    const jumpImport = await callTool(service, "xsxb_import_animation", {
      project_id: "generated",
      source: "png_sequence",
      directory: clipDir("jump"),
      profile_id: "generated",
      animation_id: "jump",
      fps: 8,
    });
    assert.equal(jumpImport.ok, true, JSON.stringify(jumpImport.error || jumpImport));
    const attackImport = await callTool(service, "xsxb_import_animation", {
      project_id: "generated",
      source: "png_sequence",
      directory: clipDir("attack"),
      profile_id: "generated",
      animation_id: "attack",
      fps: 8,
    });
    assert.equal(attackImport.ok, true, JSON.stringify(attackImport.error || attackImport));
    const fxImport = await callTool(service, "xsxb_import_animation", {
      project_id: "generated",
      source: "png_sequence",
      directory: clipDir("hit_vfx"),
      profile_id: "generated",
      animation_id: "hit_vfx",
      animation_type: "vfx",
      fps: 10,
    });
    assert.equal(fxImport.ok, true, JSON.stringify(fxImport.error || fxImport));
    assert.equal(fxImport.data.animationType, "vfx");
    log.push("import jump+attack+hit_vfx");

    const jumpSnap = await observe(service, { project_id: "generated", animation_id: "jump" });
    const jumpCut = await callTool(service, "xsxb_cutout", {
      project_id: "generated",
      animation_id: "jump",
      key_mode: "border_flood",
      key_color: "#F8F8F8",
      basis_snapshot_id: jumpSnap.snapshotId,
    });
    assert.equal(jumpCut.ok, true, JSON.stringify(jumpCut.error || jumpCut));
    inspectMagentaPreview(jumpCut.data.preview.path, "jump cutout");
    kept["generated_cutout_jump_preview.png"] = jumpCut.data.preview.path;

    const attackSnap = await observe(service, { project_id: "generated", animation_id: "attack" });
    const attackCut = await callTool(service, "xsxb_cutout", {
      project_id: "generated",
      animation_id: "attack",
      key_mode: "border_flood",
      key_color: "#F8F8F8",
      protected_colors: ["#ffe040", "#ffe080", "#ffd070"],
      basis_snapshot_id: attackSnap.snapshotId,
    });
    assert.equal(attackCut.ok, true, JSON.stringify(attackCut.error || attackCut));
    inspectMagentaPreview(attackCut.data.preview.path, "attack cutout", { requireGold: true });
    kept["generated_cutout_attack_preview.png"] = attackCut.data.preview.path;
    const attackLock = await callTool(service, "xsxb_register_clip", {
      project_id: "generated",
      animation_id: "attack",
      reference_animation_id: "idle",
      mode: "shared_scale",
      apply: true,
    });
    assert.equal(attackLock.ok, true, JSON.stringify(attackLock.error || attackLock));
    const attackPlant = await callTool(service, "xsxb_plant_feet", {
      project_id: "generated",
      animation_id: "attack",
      target_y: -1,
      apply: true,
    });
    assert.equal(attackPlant.ok, true, JSON.stringify(attackPlant.error || attackPlant));
    await equalizeClipCanvas(service, { project_id: "generated", animation_id: "attack" }, { replant: true });
    log.push("cutout jump; lock+plant attack");

    const fxSnap = await observe(service, { project_id: "generated", animation_id: "hit_vfx" });
    const fxCut = await callTool(service, "xsxb_cutout", {
      project_id: "generated",
      animation_id: "hit_vfx",
      key_mode: "border_flood",
      key_color: "#F8F8F8",
      basis_snapshot_id: fxSnap.snapshotId,
    });
    assert.equal(fxCut.ok, true, JSON.stringify(fxCut.error || fxCut));
    inspectMagentaPreview(fxCut.data.preview.path, "hit_vfx cutout", {
      requireNavy: false,
      requireBoots: false,
    });
    kept["generated_cutout_vfx_preview.png"] = fxCut.data.preview.path;
    log.push("cutout hit_vfx");

    for (const animationId of ["idle", "walk", "attack"]) {
      const boxes = await callTool(service, "xsxb_estimate_boxes", {
        project_id: "generated",
        animation_id: animationId,
        replace: true,
      });
      assert.equal(boxes.ok, true, JSON.stringify(boxes.error || boxes));
    }
    log.push("estimate_boxes");

    writeGameplayScene(game);
    const synced = await callTool(service, "xsxb_sync_godot", { project_id: "generated" });
    assert.equal(synced.ok, true, JSON.stringify(synced.error || synced));
    assert.equal(synced.data.godot?.runtime?.actorScript, true);
    log.push("sync_godot");

    let gate = await callTool(service, "xsxb_validate_for_godot", {
      project_id: "generated",
      require_gameplay: true,
    });
    if (!(gate.ok && gate.data.qa === "clean")) {
      report.issues = gate.data?.scale_contract?.issues || gate.data?.errors || [];
      process.stderr.write(
        `${JSON.stringify({ qa: gate.data?.qa, issues: report.issues, scale: gate.data?.scale_contract }, null, 2)}\n`,
      );
      log.push(`validate review; repairing plant-idle-first issues=${report.issues.join(" | ")}`);
      gate = await repairGroundedScale(service, "generated");
    }
    assert.equal(gate.ok, true, JSON.stringify(gate.data?.errors || gate.error || gate));
    assert.equal(gate.data.qa, "clean", JSON.stringify(gate.data?.scale_contract || gate.data));
    assert.equal(gate.data.scale_contract.ok, true);
    assert.ok(!(gate.data.scale_contract.issues || []).some((issue) => /hit_vfx/.test(issue)));
    const idleScale = scaleClip(gate, "idle");
    const walkScale = scaleClip(gate, "walk");
    if (idleScale) report.feetY.idle = idleScale.feetY;
    if (walkScale) report.feetY.walk = walkScale.feetY;
    report.qa = gate.data.qa;
    kept["generated_godot_evidence.png"] = gate.data.evidence.path;
    kept["generated_run_summary.json"] = gate.data.run_summary.path;
    log.push("validate_for_godot clean");

    return report;
  } catch (error) {
    report.issues.push(String(error && error.message ? error.message : error));
    throw error;
  } finally {
    keepFiles(keepDir, kept);
    if (keepDir) {
      fs.mkdirSync(keepDir, { recursive: true });
      fs.writeFileSync(
        path.join(keepDir, "session_log.json"),
        `${JSON.stringify(
          {
            log: report.log,
            qa: report.qa,
            feetY: report.feetY,
            changedPixelCount: report.changedPixelCount,
            idlePreview: report.idlePreview,
            issues: report.issues,
            visual: report.visual,
            kept: Object.keys(kept),
          },
          null,
          2,
        )}\n`,
      );
    }
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { resolveGeneratedHeroDirs, runGeneratedAcceptance };

if (require.main === module) {
  runGeneratedAcceptance()
    .then((report) => {
      process.stdout.write(
        `Generated session passed. qa=${report.qa} idleFeetY=${report.feetY.idle} walkFeetY=${report.feetY.walk} diff=${report.changedPixelCount} keep=${report.keepDir}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
