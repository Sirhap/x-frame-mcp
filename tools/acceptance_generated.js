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
const {
  flattenFrameBackground,
  measureSpriteGeometry,
  resolvePreviewBackground,
} = require("../mcp/xsxb_mcp_lock");
const { groupToCanvas } = require("../mcp/xsxb_mcp_visual_qa");
const { callTool, writeGameplayScene } = require("./acceptance_playbooks");
const { countPixels, isTrueMagenta } = require("./acceptance_sprites");

const HURT_LIME = Object.freeze([0, 255, 80, 255]);
const COLLISION_CYAN = Object.freeze([0, 255, 255, 255]);
const HIT_RED = Object.freeze([255, 0, 0, 255]);

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
 * True when a pixel is saturated yellow/gold glow, not brown hair or white plate.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Crescent gold sample.
 */
function isCrescentGold(r, g, b, a) {
  if (a < 160) return false;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return r >= 220 && g >= 180 && b <= 180 && r - b >= 50 && g - b >= 20 && sat >= 40;
}

/**
 * Restricts samples to the right-hand slash (below the head, away from hair).
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {number} width Frame width.
 * @param {number} height Frame height.
 * @returns {boolean} Inside the slash region.
 */
function inSlashRegion(x, y, width, height) {
  return x >= Math.round(width * 0.55) && y >= Math.round(height * 0.35);
}

/**
 * Finds 8-connected crescent-gold blobs in the slash region.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame.
 * @returns {Array<{count:number,width:number,height:number,minX:number,minY:number,maxX:number,maxY:number}>}
 */
function slashGoldBlobs(image) {
  const { data, width, height } = image;
  const seen = new Uint8Array(width * height);
  const blobs = [];
  const hit = (x, y) => {
    const offset = (y * width + x) * 4;
    return (
      inSlashRegion(x, y, width, height) &&
      isCrescentGold(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])
    );
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (seen[start] || !hit(x, y)) continue;
      const stack = [start];
      seen[start] = 1;
      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      while (stack.length) {
        const index = stack.pop();
        const px = index % width;
        const py = Math.floor(index / width);
        count += 1;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (seen[next] || !hit(nx, ny)) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      blobs.push({
        count,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        minX,
        minY,
        maxX,
        maxY,
      });
    }
  }
  return blobs.sort((left, right) => right.count - left.count);
}

/**
 * Counts slash-region gold on the steel highlight versus the crescent wings.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame.
 * @returns {{gold:number,onBlade:number,offBlade:number}} Counts.
 */
function goldVersusBladeBox(image) {
  const { data, width, height } = image;
  const boxX1 = Math.round((176 / 256) * width);
  const boxX2 = Math.round((224 / 256) * width);
  const boxY1 = Math.round((112 / 256) * height);
  const boxY2 = Math.round((160 / 256) * height);
  let gold = 0;
  let onBlade = 0;
  let offBlade = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (!inSlashRegion(x, y, width, height)) continue;
      if (!isCrescentGold(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) continue;
      gold += 1;
      if (x >= boxX1 && x <= boxX2 && y >= boxY1 && y <= boxY2) onBlade += 1;
      else offBlade += 1;
    }
  }
  return { gold, onBlade, offBlade };
}

/**
 * Asserts the keyed attack plate still has a gold crescent, not a blade sliver.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Keyed frame.
 * @param {string} label Step label.
 * @returns {{largest:object,versus:{gold:number,onBlade:number,offBlade:number}}} Metrics.
 */
function inspectGoldCrescent(image, label) {
  const blobs = slashGoldBlobs(image);
  const largest = blobs[0];
  const versus = goldVersusBladeBox(image);
  assert.ok(largest, `${label} left no slash-region gold`);
  assert.ok(
    largest.count >= 160,
    `${label} gold crescent collapsed to a sliver (${largest.count} px, bbox ${largest.width}x${largest.height}; off-blade ${versus.offBlade})`,
  );
  assert.ok(
    largest.width >= 28 && largest.height >= 20,
    `${label} gold remains a blade-line sliver, not an arc (bbox ${largest.width}x${largest.height} at ${largest.minX},${largest.minY})`,
  );
  assert.ok(
    versus.offBlade >= 200,
    `${label} gold off the steel box is ${versus.offBlade} (need crescent wings, not a blade highlight; on-blade ${versus.onBlade})`,
  );
  return { largest, versus };
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
  let crescent = null;
  if (options.requireGold) {
    crescent = inspectGoldCrescent(image, label);
  }
  return {
    magenta,
    navy,
    boot,
    gold,
    crescent,
    subject,
    width: image.width,
    height: image.height,
    path: previewPath,
  };
}

/**
 * Reads a uniform on-disk canvas from get_animation.
 * @param {object} receipt Animation receipt.
 * @returns {{width:number,height:number}} Shared frame size.
 */
function readClipCanvas(receipt) {
  const frames = (receipt.data.animation.frames || []).map((frame) => decodePngRgba(frame.absolutePath));
  assert.ok(frames.length, "clip has no frames to measure canvas");
  const width = frames[0].width;
  const height = frames[0].height;
  assert.ok(
    frames.every((frame) => frame.width === width && frame.height === height),
    `clip frames differ in canvas (${frames.map((frame) => `${frame.width}x${frame.height}`).join(",")})`,
  );
  return { width, height };
}

/**
 * Asserts grounded clip canvases match idle after plant-to-reference.
 * @param {object} service MCP service.
 * @param {string} projectId Project id.
 * @param {readonly string[]} [animationIds] Clips already imported.
 * @returns {Promise<Record<string,{width:number,height:number}>>} Measured canvases.
 */
async function assertGroundedCanvasesMatchIdle(service, projectId, animationIds = ["walk", "attack"]) {
  const idle = readClipCanvas(
    await callTool(service, "xsxb_get_animation", { project_id: projectId, animation_id: "idle" }),
  );
  const matched = { idle };
  for (const animationId of animationIds) {
    const listed = await callTool(service, "xsxb_get_animation", {
      project_id: projectId,
      animation_id: animationId,
    });
    const canvas = readClipCanvas(listed);
    assert.equal(
      canvas.width,
      idle.width,
      `${animationId} canvas width ${canvas.width} != idle ${idle.width}`,
    );
    assert.equal(
      canvas.height,
      idle.height,
      `${animationId} canvas height ${canvas.height} != idle ${idle.height}`,
    );
    matched[animationId] = canvas;
  }
  return matched;
}

/**
 * Plants a grounded clip onto idle's canvas and idle's measured sole row.
 * @param {object} service MCP service.
 * @param {string} projectId Project id.
 * @param {string} animationId Clip to plant.
 * @returns {Promise<object>} Plant receipt.
 */
async function plantToIdleCanvas(service, projectId, animationId) {
  const planted = await callTool(service, "xsxb_plant_feet", {
    project_id: projectId,
    animation_id: animationId,
    reference_animation_id: "idle",
    apply: true,
  });
  assert.equal(planted.ok, true, JSON.stringify(planted.error || planted));
  return planted;
}

/**
 * Opens the idle occupancy-diff flatten and asserts a sword-scale delta.
 * Interior navy mismatch may set qa=warn; that is recorded, not a session fail.
 * @param {string} previewPath Diff preview.path.
 * @param {object} diffed Diff receipt.
 * @returns {{magenta:number,navy:number,subject:number,interiorMagenta:number,changed:number,qa:string,issues:string[]}}
 */
function inspectIdleOccupancyDiff(previewPath, diffed) {
  assert.ok(previewPath && fs.existsSync(previewPath), "idle diff missing preview.path");
  const image = decodePngRgba(previewPath);
  const magenta = countPixels(image, isTrueMagenta);
  let navy = 0;
  let subject = 0;
  let interiorMagenta = 0;
  const x0 = Math.round(image.width * 0.32);
  const x1 = Math.round(image.width * 0.62);
  const y0 = Math.round(image.height * 0.22);
  const y1 = Math.round(image.height * 0.78);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const a = image.data[offset + 3];
      if (isTrueMagenta(r, g, b, a)) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) interiorMagenta += 1;
        continue;
      }
      if (a < 160) continue;
      subject += 1;
      if (isNavyCoat(r, g, b, a)) navy += 1;
    }
  }
  const changed = Number(diffed.changedPixelCount);
  const occupancy = Math.max(1, subject + magenta);
  const fillBudget = Math.max(2500, Math.round(occupancy * 0.18));
  assert.ok(changed < fillBudget, `idle occupancy delta is a full-body fill (${changed} of ${occupancy})`);
  assert.ok(magenta < fillBudget, `idle diff preview filled the coat (${magenta} of ${occupancy})`);
  assert.ok(navy >= 30, `idle diff preview is a filled magenta silhouette (navy=${navy})`);
  assert.ok(
    interiorMagenta < fillBudget * 0.5,
    `idle diff painted the coat interior magenta (${interiorMagenta})`,
  );
  if (diffed.qa !== "warn" && changed > 0) {
    assert.ok(changed >= 20, `idle occupancy delta vanished (${changed})`);
  }
  return {
    magenta,
    navy,
    subject,
    interiorMagenta,
    changed,
    qa: diffed.qa,
    issues: Array.isArray(diffed.issues) ? diffed.issues : [],
  };
}

/**
 * Reads a finite pixel count from a scale/measure receipt.
 * `Number(dFeet) || 0` would hide a missing field as a perfect plant.
 * @param {unknown} value Raw feetY or dFeet.
 * @param {string} label Field name for the assertion.
 * @returns {number} Finite pixel value.
 */
function requireFinitePixel(value, label) {
  const pixel = Number(value);
  assert.ok(Number.isFinite(pixel), `${label} must be a finite pixel count, got ${value}`);
  return pixel;
}

/**
 * Median of finite numbers. Same mid-index as the Godot scale contract.
 * @param {number[]} values Samples.
 * @returns {number} Median, or NaN when empty.
 */
function medianPixel(values) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Measures each on-disk frame sole. Used so plant asserts against the clip
 * sole, not measure_frames' default reference_frame=0 (the hang-heavier idle).
 * @param {object} receipt get_animation receipt.
 * @returns {{frames:Array<{index:number,feetY:number,maxY:number}>,median:number}}
 */
function measureClipSoles(receipt) {
  const frames = (receipt.data.animation.frames || []).map((frame, index) => {
    const image = decodePngRgba(frame.absolutePath);
    const geometry = measureSpriteGeometry(image.data, image.width, image.height);
    return {
      index,
      feetY: requireFinitePixel(
        geometry.feetY,
        `${receipt.data.animation.id || "clip"} frame ${index} feetY`,
      ),
      maxY: geometry.maxY,
    };
  });
  return { frames, median: medianPixel(frames.map((frame) => frame.feetY)) };
}

/**
 * Asserts idle/walk/attack sit on idle's measured sole after validate_for_godot.
 * Prefer |dFeet|===0. A 1px AA fringe may use <=1 with a canvas comment; do
 * not keep a silent <=2 (that hid walk/attack one row above the idle sole).
 * @param {{idle:object,walk:object,attack:object}} scaleCanvases Scale rows.
 * @returns {{feetY:{idle:number,walk:number,attack:number},dFeet:{idle:number,walk:number,attack:number}}}
 */
function assertScaleFeetOnIdleSole(scaleCanvases) {
  const feetY = {};
  const dFeet = {};
  for (const id of ["idle", "walk", "attack"]) {
    const clip = scaleCanvases[id];
    feetY[id] = requireFinitePixel(clip.feetY, `${id} feetY`);
    dFeet[id] = requireFinitePixel(clip.dFeet, `${id} dFeet`);
    assert.equal(
      dFeet[id],
      0,
      `${id} dFeet=${dFeet[id]} feetY=${feetY[id]} vs idle ${feetY.idle} (want idle sole, not hang pad)`,
    );
  }
  return { feetY, dFeet };
}

/**
 * Asserts Godot scale clips share idle/walk/attack canvas height.
 * @param {object} receipt Validation receipt.
 * @returns {{idle:object,walk:object,attack:object}} Scale rows.
 */
function assertScaleCanvasesMatch(receipt) {
  const idleScale = scaleClip(receipt, "idle");
  const walkScale = scaleClip(receipt, "walk");
  const attackScale = scaleClip(receipt, "attack");
  assert.ok(idleScale && walkScale && attackScale, "scale_contract missing idle/walk/attack");
  assert.equal(Number(walkScale.dCanvasH) || 0, 0, `walk dCanvasH=${walkScale.dCanvasH}`);
  assert.equal(Number(attackScale.dCanvasH) || 0, 0, `attack dCanvasH=${attackScale.dCanvasH}`);
  if (idleScale.canvasH != null) {
    assert.equal(walkScale.canvasH, idleScale.canvasH, "walk canvasH != idle");
    assert.equal(attackScale.canvasH, idleScale.canvasH, "attack canvasH != idle");
  }
  if (walkScale.dCanvasW != null) {
    assert.equal(Number(walkScale.dCanvasW) || 0, 0, `walk dCanvasW=${walkScale.dCanvasW}`);
    assert.equal(Number(attackScale.dCanvasW) || 0, 0, `attack dCanvasW=${attackScale.dCanvasW}`);
  }
  return { idle: idleScale, walk: walkScale, attack: attackScale };
}

/**
 * True when a group-space box is present and enabled.
 * @param {object|null|undefined} box Override.
 * @returns {boolean} Usable box.
 */
function boxPresent(box) {
  return Boolean(box && box.enabled !== false && Number(box.size?.x) > 0 && Number(box.size?.y) > 0);
}

/**
 * Maps a group-space box (foot 0,0, body negative Y) onto canvas pixels.
 * Offset is the box center, same as `estimateFrameBoxes`.
 * @param {{offset?:{x?:number,y?:number},size?:{x?:number,y?:number}}} box Group box.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} Inclusive-edge rect.
 */
function boxRectOnCanvas(box, width, height) {
  const sizeX = Number(box?.size?.x || 0);
  const sizeY = Number(box?.size?.y || 0);
  const center = groupToCanvas(Number(box?.offset?.x || 0), Number(box?.offset?.y || 0), width, height);
  return {
    minX: center.x - sizeX / 2,
    minY: center.y - sizeY / 2,
    maxX: center.x + sizeX / 2,
    maxY: center.y + sizeY / 2,
  };
}

/**
 * True when two group boxes share offset and size.
 * @param {object} left First box.
 * @param {object} right Second box.
 * @returns {boolean} Identical geometry.
 */
function boxesIdentical(left, right) {
  return (
    Number(left?.offset?.x) === Number(right?.offset?.x) &&
    Number(left?.offset?.y) === Number(right?.offset?.y) &&
    Number(left?.size?.x) === Number(right?.size?.x) &&
    Number(left?.size?.y) === Number(right?.size?.y)
  );
}

/**
 * Writes one opaque pixel.
 * @param {Uint8ClampedArray} rgba Buffer.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {readonly number[]} color RGBA.
 * @returns {void}
 */
function setCanvasPixel(rgba, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  rgba.set(color, (y * width + x) * 4);
}

/**
 * Strokes a canvas rect with a 1px outline.
 * @param {Uint8ClampedArray} rgba Buffer.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect Canvas rect.
 * @param {readonly number[]} color RGBA.
 * @returns {void}
 */
function strokeCanvasRect(rgba, width, height, rect, color) {
  const x0 = Math.round(rect.minX);
  const x1 = Math.round(rect.maxX);
  const y0 = Math.round(rect.minY);
  const y1 = Math.round(rect.maxY);
  for (let x = x0; x <= x1; x += 1) {
    setCanvasPixel(rgba, width, height, x, y0, color);
    setCanvasPixel(rgba, width, height, x, y1, color);
  }
  for (let y = y0; y <= y1; y += 1) {
    setCanvasPixel(rgba, width, height, x0, y, color);
    setCanvasPixel(rgba, width, height, x1, y, color);
  }
}

/**
 * Dark-cloth torso span, excluding gold slash/crescent. Used so attack reach
 * is measured past the body, not past a weapon-inflated hurtbox.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} Torso pixels.
 */
function measureDarkBodySpan(image) {
  const { data, width, height } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      if (a <= 16) continue;
      if (isGoldSlash(r, g, b, a) || isCrescentGold(r, g, b, a)) continue;
      if (Math.max(r, g, b) > 160) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) {
    const geometry = measureSpriteGeometry(data, width, height);
    return { minX: geometry.minX, minY: geometry.minY, maxX: geometry.maxX, maxY: geometry.maxY };
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Asserts idle/walk/attack boxes cover the torso and sit on the soles.
 * Attack also needs a hitbox that is not a hurtbox clone and reaches past the body.
 * @param {string} animationId Clip id.
 * @param {number} frameIndex Frame index.
 * @param {object} boxes Group-space overrides.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Frame.
 * @returns {void}
 */
function assertFrameBoxes(animationId, frameIndex, boxes, image) {
  const { width, height } = image;
  const geometry = measureSpriteGeometry(image.data, width, height);
  const label = `${animationId} frame ${frameIndex}`;
  const grounded = animationId === "idle" || animationId === "walk" || animationId === "attack";
  if (grounded) {
    assert.ok(boxPresent(boxes?.hurtbox), `${label} missing hurtbox`);
    assert.ok(boxPresent(boxes?.collisionbox), `${label} missing collisionbox`);
    const hurtW = Number(boxes.hurtbox.size.x);
    const hurtH = Number(boxes.hurtbox.size.y);
    assert.ok(hurtW >= 8 && hurtH >= 8, `${label} hurtbox is a ${hurtW}x${hurtH} stamp, not a torso`);
    assert.ok(
      hurtW >= geometry.bodyW * 0.2 && hurtH >= geometry.bodyH * 0.25,
      `${label} hurtbox ${hurtW}x${hurtH} is too small for torso ${geometry.bodyW}x${geometry.bodyH}`,
    );
    const hurt = boxRectOnCanvas(boxes.hurtbox, width, height);
    const torsoY = Math.round((geometry.headY + geometry.feetY) / 2);
    assert.ok(
      hurt.minY <= torsoY && torsoY <= hurt.maxY,
      `${label} hurtbox misses torso row ${torsoY} (rect ${hurt.minY}..${hurt.maxY})`,
    );
    const collision = boxRectOnCanvas(boxes.collisionbox, width, height);
    assert.ok(
      collision.maxY <= height,
      `${label} collision extends past the canvas (maxY=${collision.maxY} height=${height})`,
    );
    const soleGap = Math.abs(collision.maxY - geometry.feetY);
    assert.ok(
      soleGap <= 16,
      `${label} collision bottom ${collision.maxY} is ${soleGap}px from soles ${geometry.feetY} (mid-torso float)`,
    );
  }
  if (animationId === "attack") {
    assert.ok(boxPresent(boxes?.hitbox), `${label} missing hitbox`);
    assert.ok(!boxesIdentical(boxes.hitbox, boxes.hurtbox), `${label} hitbox is identical to the hurtbox`);
    const hit = boxRectOnCanvas(boxes.hitbox, width, height);
    const hurt = boxRectOnCanvas(boxes.hurtbox, width, height);
    const body = measureDarkBodySpan(image);
    const pastHurt = hit.maxX > hurt.maxX + 4 || hit.minX < hurt.minX - 4;
    const pastBody = hit.maxX > body.maxX + 4 || hit.minX < body.minX - 4;
    assert.ok(
      pastHurt || pastBody,
      `${label} hitbox does not reach 4px past the body (hit=${JSON.stringify(hit)} hurt=${JSON.stringify(hurt)} body=${JSON.stringify(body)})`,
    );
  }
}

/**
 * Flattens the subject onto magenta and strokes hurt/collision/hit outlines.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frame Source.
 * @param {object} boxes Group-space overrides.
 * @param {string} dest Output PNG path.
 * @returns {string} dest.
 */
function drawBoxesOnMagenta(frame, boxes, dest) {
  const flat = flattenFrameBackground(frame, resolvePreviewBackground("magenta"));
  const strokes = [
    ["hurtbox", HURT_LIME],
    ["collisionbox", COLLISION_CYAN],
    ["hitbox", HIT_RED],
  ];
  for (const [name, color] of strokes) {
    const box = boxes?.[name];
    if (!boxPresent(box)) continue;
    strokeCanvasRect(
      flat.data,
      flat.width,
      flat.height,
      boxRectOnCanvas(box, flat.width, flat.height),
      color,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, encodePngRgba(flat.data, flat.width, flat.height));
  return dest;
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
    await plantToIdleCanvas(service, projectId, animationId);
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
    feetY: { idle: null, walk: null, attack: null },
    canvas: { idle: null, walk: null, attack: null },
    boxes: { idle: [], walk: [], attack: [] },
    changedPixelCount: null,
    idleDiff: null,
    goldCrescent: null,
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
      reference_animation_id: "idle",
      target_y: -1,
    });
    assert.equal(plantPreview.ok, true);
    const plantApply = await plantToIdleCanvas(service, "generated", "walk");
    const walkPad = await equalizeClipCanvas(
      service,
      { project_id: "generated", animation_id: "walk" },
      { replant: false },
    );
    if (!walkPad.skipped) log.push(`pad walk ${walkPad.width}x${walkPad.height}`);
    const groundedAfterWalk = await assertGroundedCanvasesMatchIdle(service, "generated", ["walk"]);
    report.canvas.idle = groundedAfterWalk.idle;
    report.canvas.walk = groundedAfterWalk.walk;
    const afterLock = await callTool(service, "xsxb_measure_frames", {
      project_id: "generated",
      animation_id: "walk",
      reference_animation_id: "idle",
    });
    assert.equal(afterLock.ok, true);
    const idleSoles = measureClipSoles(
      await callTool(service, "xsxb_get_animation", { project_id: "generated", animation_id: "idle" }),
    );
    const walkSoles = measureClipSoles(
      await callTool(service, "xsxb_get_animation", { project_id: "generated", animation_id: "walk" }),
    );
    const plantedIdleFeetY = requireFinitePixel(idleSoles.median, "idle clip sole");
    const plantedWalkDeltas = walkSoles.frames.map((frame) => frame.feetY - plantedIdleFeetY);
    const feetDrift = Math.max(...plantedWalkDeltas.map((delta) => Math.abs(delta)));
    assert.equal(
      feetDrift,
      0,
      `after plant, walk must sit on idle clip sole ${plantedIdleFeetY} (frames ${idleSoles.frames.map((frame) => frame.feetY).join(",")}), got walk ${walkSoles.frames.map((frame) => frame.feetY).join(",")} dFeet=${plantedWalkDeltas.join(",")}`,
    );
    report.feetY.walk = walkSoles.median;
    report.feetY.idle = plantedIdleFeetY;
    log.push(
      `plant walk idleFeetY=${idleSoles.frames.map((frame) => frame.feetY).join(",")} sole=${plantedIdleFeetY} walkFeetY=${walkSoles.frames.map((frame) => frame.feetY).join(",")} dFeet=${plantedWalkDeltas.join(",")}`,
    );

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
    report.idleDiff = inspectIdleOccupancyDiff(diffed.data.preview.path, diffed.data);
    if (diffed.data.qa === "warn") {
      visual.push(
        `idle 0 vs 1 qa=warn occupancy=${diffed.data.changedPixelCount} issues=${(diffed.data.issues || []).join("; ")}`,
      );
    } else if (Number(diffed.data.changedPixelCount) === 0) {
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
    inspectMagentaPreview(attackCut.data.preview.path, "attack cutout");
    kept["generated_cutout_attack_preview.png"] = attackCut.data.preview.path;
    const attackKeyed = await callTool(service, "xsxb_get_animation", {
      project_id: "generated",
      animation_id: "attack",
    });
    assert.equal(attackKeyed.ok, true, JSON.stringify(attackKeyed.error || attackKeyed));
    report.goldCrescent = inspectGoldCrescent(
      decodePngRgba(attackKeyed.data.animation.frames[0].absolutePath),
      "attack keyed frame 0",
    );
    const attackLock = await callTool(service, "xsxb_register_clip", {
      project_id: "generated",
      animation_id: "attack",
      reference_animation_id: "idle",
      mode: "shared_scale",
      apply: true,
    });
    assert.equal(attackLock.ok, true, JSON.stringify(attackLock.error || attackLock));
    const attackPlant = await plantToIdleCanvas(service, "generated", "attack");
    assert.equal(attackPlant.ok, true, JSON.stringify(attackPlant.error || attackPlant));
    await equalizeClipCanvas(
      service,
      { project_id: "generated", animation_id: "attack" },
      { replant: false },
    );
    const groundedAfterAttack = await assertGroundedCanvasesMatchIdle(service, "generated", [
      "walk",
      "attack",
    ]);
    report.canvas = { ...report.canvas, ...groundedAfterAttack };
    log.push("cutout jump; lock+plant attack to idle canvas");

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

    if (resolved.clips.ink_idle) {
      const inkImport = await callTool(service, "xsxb_import_animation", {
        project_id: "generated",
        source: "png_sequence",
        directory: clipDir("ink_idle"),
        profile_id: "generated",
        animation_id: "ink_idle",
        animation_type: "vfx",
        fps: 8,
      });
      assert.equal(inkImport.ok, true, JSON.stringify(inkImport.error || inkImport));
      const inkSnap = await observe(service, { project_id: "generated", animation_id: "ink_idle" });
      const inkCut = await callTool(service, "xsxb_cutout", {
        project_id: "generated",
        animation_id: "ink_idle",
        key_mode: "border_flood",
        key_color: "#000000",
        basis_snapshot_id: inkSnap.snapshotId,
      });
      assert.equal(inkCut.ok, true, JSON.stringify(inkCut.error || inkCut));
      inspectMagentaPreview(inkCut.data.preview.path, "ink_idle cutout");
      kept["generated_cutout_ink_idle_preview.png"] = inkCut.data.preview.path;
      log.push("cutout ink_idle (vfx, not planted into Godot gate)");
    }

    for (const animationId of ["idle", "walk", "attack"]) {
      const estimated = await callTool(service, "xsxb_estimate_boxes", {
        project_id: "generated",
        animation_id: animationId,
        replace: true,
      });
      assert.equal(estimated.ok, true, JSON.stringify(estimated.error || estimated));
      const listed = await callTool(service, "xsxb_get_animation", {
        project_id: "generated",
        animation_id: animationId,
        include: ["boxes"],
      });
      assert.equal(listed.ok, true, JSON.stringify(listed.error || listed));
      const frames = listed.data.animation.frames || [];
      const boxMap = listed.data.boxes || {};
      report.boxes[animationId] = [];
      for (let index = 0; index < frames.length; index += 1) {
        const frameBoxes = boxMap[index] || boxMap[String(index)];
        const image = decodePngRgba(frames[index].absolutePath);
        assertFrameBoxes(animationId, index, frameBoxes, image);
        const dest = path.join(root, `generated_boxes_${animationId}_${index}.png`);
        drawBoxesOnMagenta(image, frameBoxes, dest);
        kept[`generated_boxes_${animationId}_${index}.png`] = dest;
        const hurt = boxRectOnCanvas(frameBoxes?.hurtbox || {}, image.width, image.height);
        const collision = boxRectOnCanvas(frameBoxes?.collisionbox || {}, image.width, image.height);
        const hit = frameBoxes?.hitbox ? boxRectOnCanvas(frameBoxes.hitbox, image.width, image.height) : null;
        report.boxes[animationId].push({
          index,
          hurtbox: frameBoxes?.hurtbox?.size || null,
          collisionbox: frameBoxes?.collisionbox?.size || null,
          hitbox: frameBoxes?.hitbox?.size || null,
          hurtRect: hurt,
          collisionRect: collision,
          hitRect: hit,
        });
      }
    }
    log.push("estimate_boxes + assert + overlays");

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
    assert.ok(!(gate.data.scale_contract.issues || []).some((issue) => /hit_vfx|ink_idle/.test(issue)));
    const scaleCanvases = assertScaleCanvasesMatch(gate);
    report.feetY.idle = scaleCanvases.idle.feetY;
    report.feetY.walk = scaleCanvases.walk.feetY;
    report.feetY.attack = scaleCanvases.attack.feetY;
    report.canvas.idle = {
      width: scaleCanvases.idle.canvasW,
      height: scaleCanvases.idle.canvasH,
    };
    report.canvas.walk = {
      width: scaleCanvases.walk.canvasW,
      height: scaleCanvases.walk.canvasH,
    };
    report.canvas.attack = {
      width: scaleCanvases.attack.canvasW,
      height: scaleCanvases.attack.canvasH,
    };
    report.qa = gate.data.qa;
    kept["generated_godot_evidence.png"] = gate.data.evidence.path;
    kept["generated_run_summary.json"] = gate.data.run_summary.path;
    log.push(
      `validate_for_godot clean idleFeetY=${report.feetY.idle} walkFeetY=${report.feetY.walk} attackFeetY=${report.feetY.attack} dFeet=${scaleCanvases.idle.dFeet}/${scaleCanvases.walk.dFeet}/${scaleCanvases.attack.dFeet}`,
    );
    assertScaleFeetOnIdleSole(scaleCanvases);

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
            canvas: report.canvas,
            boxes: report.boxes,
            changedPixelCount: report.changedPixelCount,
            idleDiff: report.idleDiff,
            goldCrescent: report.goldCrescent,
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

module.exports = {
  assertFrameBoxes,
  boxRectOnCanvas,
  drawBoxesOnMagenta,
  resolveGeneratedHeroDirs,
  runGeneratedAcceptance,
};

if (require.main === module) {
  runGeneratedAcceptance()
    .then((report) => {
      process.stdout.write(
        `Generated session passed. qa=${report.qa} idleFeetY=${report.feetY.idle} walkFeetY=${report.feetY.walk} canvas=${JSON.stringify(report.canvas)} diff=${report.changedPixelCount} keep=${report.keepDir}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
