"use strict";

/**
 * Scale-contract and Godot-gate helpers for `xsxb_validate_for_godot`.
 * Import/sync success is not a visual pass: grounded clips must keep idle feet.
 */

const fs = require("node:fs");
const path = require("node:path");
const { GODOT_SYNC_ROOT } = require("./lib/godot_sync");
const { ALPHA_VISIBLE } = require("./xsxb_mcp_cutout");
const { borderFloodKey, isYellowGoldFamily, measureSpriteGeometry } = require("./xsxb_mcp_lock");

const FX_TYPES = new Set(["vfx", "prop", "scene_prop_attachment", "overlay", "fx", "effect"]);
const FX_TOKENS = new Set(["vfx", "fx", "effect", "overlay", "prop", "airborne", "jump"]);
const ACTION_HEIGHT_TOKENS = new Set(["attack", "slash", "hurt"]);
const ATTACK_EVIDENCE_TOKENS = new Set(["attack", "slash"]);
const JUMP_EVIDENCE_TOKENS = new Set(["jump", "airborne"]);
const CRESCENT_MIN_PIXELS = 80;
const CRESCENT_MIN_WIDTH = 20;
const CRESCENT_MIN_HEIGHT = 8;
const DEFAULT_FEET_TOLERANCE = 2;
const JUMP_APEX_SOLE_BAND = 2;
const DEFAULT_HEIGHT_TOLERANCE = 2;
const ACTION_HEIGHT_TOLERANCE = 6;
const DEFAULT_CANVAS_TOLERANCE = 0;
const SYNC_ROOT_ALIASES = Object.freeze(["xsxb_frame_tuner", "x_frame"]);

/**
 * Splits an id or display name into lowercase alphanumeric tokens.
 * @param {unknown} value Raw label.
 * @returns {string[]} Tokens. "hit_vfx" → ["hit","vfx"]; "jumper" stays one token.
 */
function labelTokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when a clip is VFX, overlay, or airborne and must not lock to idle soles.
 * Type/kind match stored kinds. Id/name match whole tokens so jumper and
 * proposition stay grounded.
 * @param {{id?:string,name?:string,type?:string,kind?:string}} clip Animation or profile fields.
 * @returns {boolean} True for non-grounded clips.
 */
function isFxOrAirborne(clip) {
  const typeKind = [clip?.type, clip?.kind].map((value) => String(value || "").toLowerCase());
  if (typeKind.some((value) => FX_TYPES.has(value))) return true;
  return [...labelTokens(clip?.id), ...labelTokens(clip?.name)].some((token) => FX_TOKENS.has(token));
}

/**
 * True when a recovered combat pose may be a few pixels shorter than idle.
 * Walk/run stay on the tight default; only whole attack/slash/hurt tokens qualify.
 * @param {{id?:string,name?:string}} clip Animation or profile fields.
 * @returns {boolean} True for slash-like clips.
 */
function isActionHeightClip(clip) {
  return [...labelTokens(clip?.id), ...labelTokens(clip?.name)].some((token) =>
    ACTION_HEIGHT_TOKENS.has(token),
  );
}

/**
 * True when a clip is an attack or slash and its evidence cell should show the hit.
 * Hurt stays on frame 0; only whole attack/slash tokens qualify.
 * @param {{id?:string,name?:string}} clip Animation fields.
 * @returns {boolean} True for attack/slash clips.
 */
function isAttackEvidenceClip(clip) {
  return [...labelTokens(clip?.id), ...labelTokens(clip?.name)].some((token) =>
    ATTACK_EVIDENCE_TOKENS.has(token),
  );
}

/**
 * True when a clip is a jump or airborne and its evidence cell should show the apex.
 * Whole tokens only, same style as `isFxOrAirborne` — jumper does not qualify.
 * @param {{id?:string,name?:string}} clip Animation fields.
 * @returns {boolean} True for jump/airborne clips.
 */
function isJumpEvidenceClip(clip) {
  return [...labelTokens(clip?.id), ...labelTokens(clip?.name)].some((token) =>
    JUMP_EVIDENCE_TOKENS.has(token),
  );
}

/**
 * Measured sole and crown rows for one decoded evidence frame.
 * Keys the studio plate first so plate pixels are not treated as boots or hair.
 * Same `bodyH`/`bboxH` guard as before: a sole without a body is unusable.
 * @param {{image?:{data:Uint8ClampedArray|Uint8Array,width?:number,height?:number}}} frame
 *   Clip frame with a decoded image.
 * @returns {{feetY:number,headY:number}} Rows, or NaN fields when the image or subject is missing.
 */
function measuredEvidenceFeetY(frame) {
  const missing = { feetY: Number.NaN, headY: Number.NaN };
  const image = frame?.image;
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!image?.data || !width || !height) return missing;
  const geometry = measureKeyedSubject(image);
  const feetY = Number(geometry?.feetY);
  const headY = Number(geometry?.headY);
  if (!Number.isFinite(feetY)) return missing;
  if (!(Number(geometry.bodyH) > 0 || Number(geometry.bboxH) > 0)) return missing;
  return { feetY, headY: Number.isFinite(headY) ? headY : Number.NaN };
}

/**
 * Picks the airborne apex: unique highest sole, or highest head among near-highest soles.
 * `bestFeet` is the unique minimum finite `feetY`. Frames within
 * `JUMP_APEX_SOLE_BAND` (2px) of that min are the sole-noise band. A unique
 * band member wins (keeps a unique-highest-sole apex). Several near-min soles
 * pick the unique smallest `headY`. Head ties or missing `headY` stay 0.
 * @param {Array<{image?:{data:Uint8ClampedArray|Uint8Array,width?:number,height?:number}}>} frames
 *   Decoded clip frames in order.
 * @returns {number} Index into `frames`, or 0 when empty, tied, or unmeasured.
 */
function pickJumpApexFrameIndex(frames) {
  const samples = frames.map((frame) => measuredEvidenceFeetY(frame));
  let bestFeet = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    if (Number.isFinite(sample.feetY) && sample.feetY < bestFeet) bestFeet = sample.feetY;
  }
  if (!Number.isFinite(bestFeet)) return 0;
  const band = [];
  for (let index = 0; index < samples.length; index += 1) {
    if (
      Number.isFinite(samples[index].feetY) &&
      Math.abs(samples[index].feetY - bestFeet) <= JUMP_APEX_SOLE_BAND
    ) {
      band.push(index);
    }
  }
  if (band.length === 1) return band[0];
  let bestHead = Number.POSITIVE_INFINITY;
  for (const index of band) {
    const headY = samples[index].headY;
    if (Number.isFinite(headY) && headY < bestHead) bestHead = headY;
  }
  if (!Number.isFinite(bestHead)) return 0;
  const winners = band.filter((index) => samples[index].headY === bestHead);
  return winners.length === 1 ? winners[0] : 0;
}

/**
 * Finds 8-connected yellow/gold blobs large enough to be a slash crescent.
 * Thresholds match `collectCrescentBlobs` in the box estimator; color uses lock
 * `isYellowGoldFamily` so pale glow next to a white plate still counts.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image RGBA frame.
 * @returns {Array<{count:number,minX:number,minY:number,maxX:number,maxY:number,width:number,height:number}>}
 */
function collectGoldCrescentBlobs(image) {
  const { data, width, height } = image;
  const goldAt = (x, y) => {
    const offset = (y * width + x) * 4;
    return (
      data[offset + 3] > ALPHA_VISIBLE && isYellowGoldFamily(data[offset], data[offset + 1], data[offset + 2])
    );
  };
  const seen = new Uint8Array(width * height);
  const blobs = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (seen[start] || !goldAt(x, y)) continue;
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
            if (seen[next] || !goldAt(nx, ny)) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      if (
        count >= CRESCENT_MIN_PIXELS &&
        maxX - minX + 1 >= CRESCENT_MIN_WIDTH &&
        maxY - minY + 1 >= CRESCENT_MIN_HEIGHT
      ) {
        blobs.push({
          count,
          minX,
          minY,
          maxX,
          maxY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        });
      }
    }
  }
  return blobs;
}

/**
 * Bounding box of visible non-gold pixels after the studio plate is keyed.
 * Used so a hair spark on the torso is not treated as a reaching slash arc.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Keyed RGBA frame.
 * @returns {{x:number,y:number,width:number,height:number}|null} Body span, or null.
 */
function nonGoldBodyBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3] <= ALPHA_VISIBLE) continue;
      if (isYellowGoldFamily(image.data[offset], image.data[offset + 1], image.data[offset + 2])) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * True when a decoded frame has a gold crescent that reaches past the body.
 * Hair or belt sparks on the torso do not count. Reuses lock `isYellowGoldFamily`.
 * @param {{data?:Uint8ClampedArray|Uint8Array,width?:number,height?:number}|null|undefined} image
 *   RGBA frame.
 * @returns {boolean} True when a reaching crescent blob is present.
 */
function frameHasGoldCrescent(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!image?.data || !width || !height) return false;
  const frame = { data: image.data, width, height };
  const blobs = collectGoldCrescentBlobs(frame);
  if (!blobs.length) return false;
  const keyed = borderFloodKey(frame.data, width, height, { mode: "any" });
  const body = nonGoldBodyBounds({ data: keyed.data, width, height });
  if (!body) return true;
  return blobs.some((blob) => blob.maxX >= body.x + body.width || blob.minX <= body.x);
}

/**
 * Picks the representative evidence frame index for one clip.
 * Attack/slash clips prefer the first stored/estimated hitbox with `enabled: true`,
 * else the first gold-crescent frame, else 0. Jump/airborne clips pick the apex:
 * unique highest sole (smallest `feetY` after `measureKeyedSubject`), or among
 * soles within 2px of that min the unique highest head (smallest `headY`).
 * Ties or missing measurements stay on 0. Idle/walk/hurt/vfx stay on 0. Whole
 * tokens only — jumper is not a jump clip.
 * @param {{id?:string,name?:string}} clip Animation fields.
 * @param {Array<{image?:{data:Uint8ClampedArray|Uint8Array},hitbox?:{enabled?:boolean}|null}>} frames
 *   Decoded frames plus stored or estimated hitboxes, in clip order.
 * @returns {number} Index into `frames`, or 0 when empty.
 */
function pickValidationEvidenceFrameIndex(clip, frames) {
  if (!Array.isArray(frames) || !frames.length) return 0;
  if (isAttackEvidenceClip(clip)) {
    const hitIndex = frames.findIndex((frame) => frame?.hitbox?.enabled === true);
    if (hitIndex >= 0) return hitIndex;
    const goldIndex = frames.findIndex((frame) => frameHasGoldCrescent(frame?.image));
    if (goldIndex >= 0) return goldIndex;
    return 0;
  }
  if (isJumpEvidenceClip(clip)) return pickJumpApexFrameIndex(frames);
  return 0;
}

/**
 * Keys a near-white or near-black studio plate, then measures body/feet geometry.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Decoded PNG.
 * @returns {object} Sprite geometry after the plate is removed.
 */
function measureKeyedSubject(image) {
  const keyed = borderFloodKey(image.data, image.width, image.height, { mode: "any" });
  return measureSpriteGeometry(keyed.data, image.width, image.height);
}

/**
 * Median of finite numbers, or 0 when the list is empty.
 * @param {number[]} values Samples.
 * @returns {number} Median.
 */
function median(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Reads a clip canvas edge from a scalar or per-frame list.
 * @param {object} clip Measured clip.
 * @param {"W"|"H"} axis Width or height.
 * @returns {number|null} Pixel size, or null when unknown.
 */
function resolveClipCanvas(clip, axis) {
  const scalarKey = axis === "W" ? "canvasW" : "canvasH";
  const listKey = axis === "W" ? "canvasWs" : "canvasHs";
  const scalar = Number(clip?.[scalarKey]);
  if (Number.isFinite(scalar) && scalar > 0) return scalar;
  const list = Array.isArray(clip?.[listKey]) ? clip[listKey] : [];
  const values = list.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? median(values) : null;
}

/**
 * Compares grounded clips to idle (or the first grounded clip) for feet, height, and canvas size.
 * Canvas mismatch uses 0px slop so a 256-tall walk against a 264-tall idle cannot pass as clean.
 * Attack/slash/hurt clips may be a few pixels shorter than idle; walk/run stay at 2px.
 * @param {Array<{id:string,name?:string,grounded?:boolean,feetY?:number,bodyH?:number,feetYs?:number[],bodyHs?:number[],canvasW?:number,canvasH?:number,canvasWs?:number[],canvasHs?:number[]}>} clips
 *   Measured animations.
 * @param {{feetTolerance?:number,heightTolerance?:number,canvasTolerance?:number}} [options] Pixel slop.
 * @returns {{ok:boolean,reference:string|null,issues:string[],clips:object[]}} Contract.
 */
function evaluateScaleContract(clips, options = {}) {
  const feetTolerance = Number.isFinite(Number(options.feetTolerance))
    ? Number(options.feetTolerance)
    : DEFAULT_FEET_TOLERANCE;
  const heightTolerance = Number.isFinite(Number(options.heightTolerance))
    ? Number(options.heightTolerance)
    : DEFAULT_HEIGHT_TOLERANCE;
  const canvasTolerance = Number.isFinite(Number(options.canvasTolerance))
    ? Number(options.canvasTolerance)
    : DEFAULT_CANVAS_TOLERANCE;
  const grounded = (Array.isArray(clips) ? clips : [])
    .filter((clip) => clip && clip.grounded !== false)
    .map((clip) => {
      const feetYs = Array.isArray(clip.feetYs) ? clip.feetYs : [clip.feetY];
      const bodyHs = Array.isArray(clip.bodyHs) ? clip.bodyHs : [clip.bodyH];
      const feetY = Number.isFinite(Number(clip.feetY)) ? Number(clip.feetY) : median(feetYs);
      const bodyH = Number.isFinite(Number(clip.bodyH)) ? Number(clip.bodyH) : median(bodyHs);
      const finiteFeet = feetYs.map((value) => Number(value)).filter((value) => Number.isFinite(value));
      return {
        ...clip,
        feetY,
        bodyH,
        canvasW: resolveClipCanvas(clip, "W"),
        canvasH: resolveClipCanvas(clip, "H"),
        feetSpan: finiteFeet.length ? Math.max(...finiteFeet) - Math.min(...finiteFeet) : 0,
      };
    });
  const reference = grounded.find((clip) => /idle/i.test(String(clip.id || ""))) || grounded[0] || null;
  const issues = [];
  if (!reference) {
    return { ok: true, reference: null, issues, clips: [] };
  }
  for (const clip of grounded) {
    if (clip.feetSpan > feetTolerance) {
      issues.push(`${clip.id}: feet row spans ${clip.feetSpan}px inside the clip`);
    }
    if (clip.id === reference.id) continue;
    const dFeet = Math.abs(Number(clip.feetY || 0) - Number(reference.feetY || 0));
    const dHeight = Math.abs(Number(clip.bodyH || 0) - Number(reference.bodyH || 0));
    const clipHeightTolerance = isActionHeightClip(clip)
      ? Math.max(heightTolerance, ACTION_HEIGHT_TOLERANCE)
      : heightTolerance;
    const dCanvasW =
      clip.canvasW != null && reference.canvasW != null ? Math.abs(clip.canvasW - reference.canvasW) : 0;
    const dCanvasH =
      clip.canvasH != null && reference.canvasH != null ? Math.abs(clip.canvasH - reference.canvasH) : 0;
    if (dFeet > feetTolerance) {
      issues.push(
        `${clip.id}: feet row drifted ${dFeet}px from ${reference.id} (sole ${clip.feetY} vs ${reference.feetY})`,
      );
    }
    if (dHeight > clipHeightTolerance) {
      issues.push(
        `${clip.id}: body height drifted ${dHeight}px from ${reference.id} (${clip.bodyH} vs ${reference.bodyH})`,
      );
    }
    if (clip.canvasW != null && reference.canvasW != null && dCanvasW > canvasTolerance) {
      issues.push(
        `${clip.id}: canvas width differs ${dCanvasW}px from ${reference.id} (${clip.canvasW} vs ${reference.canvasW})`,
      );
    }
    if (clip.canvasH != null && reference.canvasH != null && dCanvasH > canvasTolerance) {
      issues.push(
        `${clip.id}: canvas height differs ${dCanvasH}px from ${reference.id} (${clip.canvasH} vs ${reference.canvasH})`,
      );
    }
  }
  return {
    ok: issues.length === 0,
    reference: reference.id,
    issues,
    clips: grounded.map((clip) => ({
      id: clip.id,
      feetY: clip.feetY,
      bodyH: clip.bodyH,
      feetSpan: clip.feetSpan,
      canvasW: clip.canvasW,
      canvasH: clip.canvasH,
      dFeet: Number(clip.feetY || 0) - Number(reference.feetY || 0),
      dBody: Number(clip.bodyH || 0) - Number(reference.bodyH || 0),
      dCanvasW: clip.canvasW != null && reference.canvasW != null ? clip.canvasW - reference.canvasW : 0,
      dCanvasH: clip.canvasH != null && reference.canvasH != null ? clip.canvasH - reference.canvasH : 0,
    })),
  };
}

/**
 * Classifies a disk-mutating inspect step so agents stop on warn.
 * @param {{errors?:string[],warnings?:string[],scaleOk?:boolean,changedPixelCount?:number}} signal
 *   Gate or diff evidence.
 * @returns {"clean"|"review"|"warn"} Verdict.
 */
function classifyInspectQa(signal = {}) {
  if (Array.isArray(signal.errors) && signal.errors.length) return "warn";
  if (Number.isFinite(Number(signal.changedPixelCount))) {
    return Number(signal.changedPixelCount) === 0 ? "warn" : "review";
  }
  if (signal.scaleOk === false || (Array.isArray(signal.warnings) && signal.warnings.length)) return "review";
  return "clean";
}

/**
 * Paints a magenta-backed strip of decoded frames for the Godot evidence PNG.
 * Only visible pixels (`a > ALPHA_VISIBLE`) are copied so pad and shorter cells keep magenta.
 * @param {Array<{data:Uint8ClampedArray|Uint8Array,width:number,height:number}>} images Frames.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Evidence bitmap.
 */
function composeValidationEvidence(images) {
  const frames = Array.isArray(images) && images.length ? images : [];
  const cellW = Math.max(32, ...frames.map((frame) => Number(frame.width) || 0));
  const cellH = Math.max(32, ...frames.map((frame) => Number(frame.height) || 0));
  const width = Math.max(32, cellW * Math.max(1, frames.length));
  const height = cellH;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([255, 0, 255, 255], offset);
  frames.forEach((frame, index) => {
    const originX = index * cellW;
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const source = (y * frame.width + x) * 4;
        if (frame.data[source + 3] <= ALPHA_VISIBLE) continue;
        data.set(frame.data.subarray(source, source + 4), (y * width + originX + x) * 4);
      }
    }
  });
  return { data, width, height };
}

/**
 * Finds the sync folder that actually contains the generated runtime.
 * @param {string} projectRoot Bound Godot root.
 * @returns {string} Directory name under the Godot project.
 */
function resolveGodotSyncRoot(projectRoot) {
  const candidates = [...new Set([GODOT_SYNC_ROOT, ...SYNC_ROOT_ALIASES])];
  if (!projectRoot) return GODOT_SYNC_ROOT;
  for (const name of candidates) {
    if (fs.existsSync(path.join(projectRoot, name, "runtime", "xsxb_frame_actor.gd"))) return name;
  }
  return GODOT_SYNC_ROOT;
}

/**
 * Lists runtime files and game-local animation counts after sync.
 * @param {string} projectRoot Bound Godot root.
 * @param {string} projectId XSXB project id.
 * @returns {object} Disk snapshot an editor MCP can verify against.
 */
function describeGodotHandoff(projectRoot, projectId) {
  const syncRoot = resolveGodotSyncRoot(projectRoot);
  const runtimeDir = projectRoot ? path.join(projectRoot, syncRoot, "runtime") : "";
  const dataDir = projectRoot ? path.join(projectRoot, syncRoot, "data", "projects", projectId) : "";
  const runtimeFiles = [
    "xsxb_frame_actor.gd",
    "xsxb_frame_actor.tscn",
    "xsxb_runtime_test.tscn",
    "xsxb_attack_trail_renderer.gd",
    "xsxb_attack_trail.gdshader",
  ].map((fileName) => ({
    name: fileName,
    path: runtimeDir ? path.join(runtimeDir, fileName) : "",
    present: Boolean(runtimeDir && fs.existsSync(path.join(runtimeDir, fileName))),
  }));
  let animations = [];
  let frameCount = 0;
  const manifestPath = dataDir ? path.join(dataDir, "animation_manifest.json") : "";
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const profile of Array.isArray(manifest.profiles) ? manifest.profiles : []) {
        for (const animation of Array.isArray(profile.animations) ? profile.animations : []) {
          const frames = Array.isArray(animation.frames) ? animation.frames.length : 0;
          frameCount += frames;
          animations.push({
            id: String(animation.id || animation.name),
            frames,
            type: animation.type || "actor",
          });
        }
      }
    } catch {
      animations = [];
    }
  }
  return {
    syncRoot,
    runtimeDir,
    dataDir,
    runtime: {
      actorScript: runtimeFiles.find((file) => file.name === "xsxb_frame_actor.gd")?.present === true,
      actorScene: runtimeFiles.find((file) => file.name === "xsxb_frame_actor.tscn")?.present === true,
      files: runtimeFiles,
    },
    animations,
    frameCount,
    present: runtimeFiles.every((file) => file.present),
  };
}

const GAMEPLAY_ACTOR_GAP = "No non-runtime gameplay scene or script uses xsxb_frame_actor.";
const ANIMATION_DURATION_GAP = /does not appear to consume animation_duration/;
const GAMEPLAY_STUB_NEXT =
  "Add a non-runtime gameplay .gd/.tscn that instances xsxb_frame_actor and calls animation_duration.";

/**
 * True when import validation is missing a gameplay actor stub or animation_duration consume.
 * @param {{errors?:string[],warnings?:string[]}} importResult validateImport payload.
 * @returns {boolean} True when `next` should name the gameplay stub.
 */
function hasGameplayStubGap(importResult) {
  const messages = [...(importResult?.errors || []), ...(importResult?.warnings || [])];
  return messages.some(
    (message) => message === GAMEPLAY_ACTOR_GAP || ANIMATION_DURATION_GAP.test(String(message)),
  );
}

/**
 * Merges import validation, the scale contract, written evidence, and a Godot snapshot.
 * Scale drift is a warning unless `strict` is set. A missing gameplay actor or unused
 * `animation_duration` sets `next` to the stub sentence without changing the gate.
 * @param {{ok?:boolean,errors?:string[],warnings?:string[],summary?:object}} importResult validateImport payload.
 * @param {{ok:boolean,issues:string[]}} scaleContract Feet/height contract.
 * @param {{path:string,width:number,height:number,cells?:Array<{id:string,frame:number}>}} evidence
 *   Written PNG plus sheet-order `{id,frame}` for every clip that contributed a cell.
 * @param {{strict?:boolean,godot?:object,summaryPath?:string}} [options] Strict and snapshot extras.
 * @returns {object} Public `data` payload for `xsxb_validate_for_godot`.
 */
function assembleGodotValidation(importResult, scaleContract, evidence, options = {}) {
  const errors = [...(importResult.errors || [])];
  const warnings = [...(importResult.warnings || [])];
  const issues = Array.isArray(scaleContract?.issues) ? scaleContract.issues : [];
  if (scaleContract && scaleContract.ok === false) {
    if (options.strict) errors.push(...issues);
    else warnings.push(...issues);
  }
  const ok = errors.length === 0 && (!options.strict || warnings.length === 0);
  const qa = classifyInspectQa({
    errors,
    warnings,
    scaleOk: scaleContract ? scaleContract.ok !== false : true,
  });
  return {
    ok,
    qa,
    next: hasGameplayStubGap(importResult)
      ? GAMEPLAY_STUB_NEXT
      : qa === "warn"
        ? "stop; open evidence.path and fix errors before sync or playbook continue"
        : qa === "review"
          ? "open evidence.path; scale or gameplay warnings are not a visual pass"
          : "open evidence.path; gate passed, still confirm the sheet",
    errors,
    warnings,
    summary: importResult.summary || {},
    scale_contract: scaleContract,
    godot: options.godot || null,
    evidence: {
      path: evidence.path,
      width: evidence.width,
      height: evidence.height,
      cells: Array.isArray(evidence.cells) ? evidence.cells : [],
    },
    run_summary: options.summaryPath ? { path: options.summaryPath } : null,
  };
}

module.exports = {
  assembleGodotValidation,
  classifyInspectQa,
  composeValidationEvidence,
  describeGodotHandoff,
  evaluateScaleContract,
  isFxOrAirborne,
  measureKeyedSubject,
  pickValidationEvidenceFrameIndex,
  resolveGodotSyncRoot,
};
