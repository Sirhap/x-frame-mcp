"use strict";

/**
 * Scale-contract and Godot-gate helpers for `xsxb_validate_for_godot`.
 * Import/sync success is not a visual pass: grounded clips must keep idle feet.
 */

const fs = require("node:fs");
const path = require("node:path");
const { GODOT_SYNC_ROOT } = require("./lib/godot_sync");
const { ALPHA_VISIBLE } = require("./xsxb_mcp_cutout");
const { borderFloodKey, measureSpriteGeometry } = require("./xsxb_mcp_lock");

const FX_TYPES = new Set(["vfx", "prop", "scene_prop_attachment", "overlay", "fx", "effect"]);
const FX_TOKENS = new Set(["vfx", "fx", "effect", "overlay", "prop", "airborne", "jump"]);
const ACTION_HEIGHT_TOKENS = new Set(["attack", "slash", "hurt"]);
const DEFAULT_FEET_TOLERANCE = 2;
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
 * @param {{path:string,width:number,height:number}} evidence Written PNG.
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
  resolveGodotSyncRoot,
};
