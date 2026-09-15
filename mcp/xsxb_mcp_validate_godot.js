"use strict";

/**
 * Scale-contract and Godot-gate helpers for `xsxb_validate_for_godot`.
 * Import/sync success is not a visual pass: grounded clips must keep idle feet.
 */

const { borderFloodKey, measureSpriteGeometry } = require("./xsxb_mcp_lock");

const FX_KIND = /vfx|effect|overlay|prop|\bfx\b|airborne|jump/i;
const DEFAULT_FEET_TOLERANCE = 2;
const DEFAULT_HEIGHT_TOLERANCE = 2;

/**
 * True when a clip is VFX, overlay, or airborne and must not lock to idle soles.
 * @param {{id?:string,name?:string,type?:string,kind?:string}} clip Animation or profile fields.
 * @returns {boolean} True for non-grounded clips.
 */
function isFxOrAirborne(clip) {
  return FX_KIND.test(`${clip?.type || ""} ${clip?.kind || ""} ${clip?.id || ""} ${clip?.name || ""}`);
}

/**
 * Keys a near-white studio plate, then measures body/feet geometry.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Decoded PNG.
 * @returns {object} Sprite geometry after the plate is removed.
 */
function measureKeyedSubject(image) {
  const keyed = borderFloodKey(image.data, image.width, image.height, { mode: "near_white" });
  return measureSpriteGeometry(keyed.data, image.width, image.height);
}

/**
 * Compares grounded clips to idle (or the first grounded clip) for feet/height drift.
 * @param {Array<{id:string,grounded?:boolean,feetY:number,bodyH:number}>} clips Measured animations.
 * @param {{feetTolerance?:number,heightTolerance?:number}} [options] Pixel slop.
 * @returns {{ok:boolean,reference:string|null,issues:string[],clips:object[]}} Contract.
 */
function evaluateScaleContract(clips, options = {}) {
  const feetTolerance = Number.isFinite(Number(options.feetTolerance))
    ? Number(options.feetTolerance)
    : DEFAULT_FEET_TOLERANCE;
  const heightTolerance = Number.isFinite(Number(options.heightTolerance))
    ? Number(options.heightTolerance)
    : DEFAULT_HEIGHT_TOLERANCE;
  const grounded = (Array.isArray(clips) ? clips : []).filter((clip) => clip && clip.grounded !== false);
  const reference = grounded.find((clip) => /idle/i.test(String(clip.id || ""))) || grounded[0] || null;
  const issues = [];
  if (!reference) {
    return { ok: true, reference: null, issues, clips: [] };
  }
  for (const clip of grounded) {
    if (clip.id === reference.id) continue;
    const dFeet = Math.abs(Number(clip.feetY || 0) - Number(reference.feetY || 0));
    const dHeight = Math.abs(Number(clip.bodyH || 0) - Number(reference.bodyH || 0));
    if (dFeet > feetTolerance) {
      issues.push(
        `${clip.id}: feet row drifted ${dFeet}px from ${reference.id} (sole ${clip.feetY} vs ${reference.feetY})`,
      );
    }
    if (dHeight > heightTolerance) {
      issues.push(
        `${clip.id}: body height drifted ${dHeight}px from ${reference.id} (${clip.bodyH} vs ${reference.bodyH})`,
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
      dFeet: Number(clip.feetY || 0) - Number(reference.feetY || 0),
      dBody: Number(clip.bodyH || 0) - Number(reference.bodyH || 0),
    })),
  };
}

/**
 * Paints a magenta-backed strip of decoded frames for the Godot evidence PNG.
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
        data.set(frame.data.subarray(source, source + 4), (y * width + originX + x) * 4);
      }
    }
  });
  return { data, width, height };
}

/**
 * Merges import validation, the scale contract, and written evidence.
 * Scale drift is a warning unless `strict` is set.
 * @param {{ok?:boolean,errors?:string[],warnings?:string[],summary?:object}} importResult validateImport payload.
 * @param {{ok:boolean,issues:string[]}} scaleContract Feet/height contract.
 * @param {{path:string,width:number,height:number}} evidence Written PNG.
 * @param {{strict?:boolean}} [options] Strict treats warnings as failure.
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
  return {
    ok: errors.length === 0 && (!options.strict || warnings.length === 0),
    errors,
    warnings,
    summary: importResult.summary || {},
    scale_contract: scaleContract,
    evidence: {
      path: evidence.path,
      width: evidence.width,
      height: evidence.height,
    },
  };
}

module.exports = {
  assembleGodotValidation,
  composeValidationEvidence,
  evaluateScaleContract,
  isFxOrAirborne,
  measureKeyedSubject,
};
