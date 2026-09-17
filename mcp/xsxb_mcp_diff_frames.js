"use strict";

/**
 * Pixel compose for `xsxb_diff_frames`. Marks vacated and newly occupied
 * pixels so an agent can open a real PNG instead of treating import as a pass.
 */

const { ALPHA_VISIBLE } = require("./xsxb_mcp_cutout");
const { borderFloodKey, composeRbOverlay } = require("./xsxb_mcp_lock");

const MAGENTA = Object.freeze([255, 0, 255, 255]);
const COLOR_TOLERANCE = 18;
const INTERIOR_MISMATCH_RATIO = 0.25;
const INTERIOR_MISMATCH_ISSUE =
  "interior colors disagree (navy/key mismatch) — not a clean pose delta; re-key both frames from the same raw plate";

/**
 * True when a pixel is studio flatten magenta, not subject matter.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {boolean} Flatten chroma.
 */
function isFlattenMagenta(r, g, b, a) {
  return a > ALPHA_VISIBLE && r >= 250 && g <= 8 && b >= 250;
}

/**
 * Punches #FF00FF flatten leftovers to transparent.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @returns {Uint8ClampedArray} Copy with flatten cleared.
 */
function punchFlattenMagenta(rgba) {
  const dest = new Uint8ClampedArray(rgba);
  for (let offset = 0; offset < dest.length; offset += 4) {
    if (isFlattenMagenta(dest[offset], dest[offset + 1], dest[offset + 2], dest[offset + 3])) {
      dest[offset + 3] = 0;
    }
  }
  return dest;
}

/**
 * Subject occupancy: visible and not flatten magenta.
 * @param {Uint8ClampedArray|Uint8Array} data RGBA.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {Uint8Array} 1 when occupied.
 */
function occupancyMask(data, width, height) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    const offset = i * 4;
    const a = data[offset + 3];
    if (a <= ALPHA_VISIBLE) continue;
    if (isFlattenMagenta(data[offset], data[offset + 1], data[offset + 2], a)) continue;
    mask[i] = 1;
  }
  return mask;
}

/**
 * Dilates a binary mask by 1px (Chebyshev).
 * @param {Uint8Array} mask Occupancy.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {Uint8Array} Dilated mask.
 */
function dilateMask(mask, width, height) {
  const dest = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (mask[ny * width + nx]) {
            hit = 1;
            break;
          }
        }
      }
      dest[y * width + x] = hit;
    }
  }
  return dest;
}

/**
 * Occupancy XOR that ignores a 1px pad / AA fringe via dilation matching.
 * @param {Uint8Array} maskA First occupancy.
 * @param {Uint8Array} maskB Second occupancy.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {Uint8Array} Solid occupancy delta.
 */
function occupancyDeltaMask(maskA, maskB, width, height) {
  const dilA = dilateMask(maskA, width, height);
  const dilB = dilateMask(maskB, width, height);
  const delta = new Uint8Array(maskA.length);
  for (let i = 0; i < maskA.length; i += 1) {
    if ((maskA[i] && !dilB[i]) || (maskB[i] && !dilA[i])) delta[i] = 1;
  }
  return delta;
}

/**
 * Channel-max distance between two RGB samples.
 * @param {Uint8ClampedArray|Uint8Array} left First buffer.
 * @param {number} leftOffset First offset.
 * @param {Uint8ClampedArray|Uint8Array} right Second buffer.
 * @param {number} rightOffset Second offset.
 * @returns {number} Max channel delta.
 */
function maxChannelDelta(left, leftOffset, right, rightOffset) {
  return Math.max(
    Math.abs(left[leftOffset] - right[rightOffset]),
    Math.abs(left[leftOffset + 1] - right[rightOffset + 1]),
    Math.abs(left[leftOffset + 2] - right[rightOffset + 2]),
  );
}

/**
 * True when a nearby occupied pixel on `other` matches `sample` within tolerance.
 * @param {Uint8ClampedArray|Uint8Array} sampleBuf Sample RGBA.
 * @param {number} sampleOffset Sample offset.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} other Other frame.
 * @param {Uint8Array} otherMask Other occupancy.
 * @param {number} x Column.
 * @param {number} y Row.
 * @returns {boolean} Neighborhood color match.
 */
function hasNearbyColor(sampleBuf, sampleOffset, other, otherMask, x, y) {
  const { data, width, height } = other;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const index = ny * width + nx;
      if (!otherMask[index]) continue;
      if (maxChannelDelta(sampleBuf, sampleOffset, data, index * 4) <= COLOR_TOLERANCE) return true;
    }
  }
  return false;
}

/**
 * Detects a filled interior color mismatch on the shared occupancy.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameA Keyed A.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameB Keyed B.
 * @param {Uint8Array} maskA Occupancy A.
 * @param {Uint8Array} maskB Occupancy B.
 * @returns {string|null} Issue text, or null.
 */
function detectInteriorMismatch(frameA, frameB, maskA, maskB) {
  const { width, height, data: left } = frameA;
  const right = frameB.data;
  let overlap = 0;
  let mismatch = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!maskA[index] || !maskB[index]) continue;
      overlap += 1;
      const offset = index * 4;
      if (hasNearbyColor(left, offset, frameB, maskB, x, y)) continue;
      if (hasNearbyColor(right, offset, frameA, maskA, x, y)) continue;
      mismatch += 1;
    }
  }
  if (overlap > 0 && mismatch / overlap >= INTERIOR_MISMATCH_RATIO) return INTERIOR_MISMATCH_ISSUE;
  return null;
}

/**
 * Keys both plates and measures a 1px-tolerant occupancy delta.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameA First frame.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameB Second frame.
 * @returns {{
 *   keyedA:{data:Uint8ClampedArray,width:number,height:number},
 *   keyedB:{data:Uint8ClampedArray,width:number,height:number},
 *   delta:Uint8Array,
 *   changedPixelCount:number,
 *   issues:string[],
 *   qa:"warn"|"review",
 *   width:number,
 *   height:number,
 * }} Occupancy analysis.
 */
function analyzeFrameDiff(frameA, frameB) {
  const width = Number(frameA.width);
  const height = Number(frameA.height);
  const keyedA = keyStudioPlate(frameA);
  const keyedB = keyStudioPlate(frameB);
  const maskA = occupancyMask(keyedA.data, width, height);
  const maskB = occupancyMask(keyedB.data, width, height);
  const delta = occupancyDeltaMask(maskA, maskB, width, height);
  let changedPixelCount = 0;
  for (let i = 0; i < delta.length; i += 1) if (delta[i]) changedPixelCount += 1;
  const interiorIssue = detectInteriorMismatch(keyedA, keyedB, maskA, maskB);
  const issues = interiorIssue ? [interiorIssue] : [];
  const qa = issues.length || changedPixelCount === 0 ? "warn" : "review";
  return { keyedA, keyedB, delta, changedPixelCount, issues, qa, width, height };
}

/**
 * Counts occupancy pixels that differ after keying, ignoring flatten and 1px pad.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameA First frame.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameB Second frame.
 * @returns {number} Changed pixel count.
 */
function countChangedPixels(frameA, frameB) {
  return analyzeFrameDiff(frameA, frameB).changedPixelCount;
}

/**
 * Floods a studio plate so onion-skin uses subject occupancy, not opaque fill.
 * True-magenta flatten leftovers are punched first so #FF00FF is never content.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frame Decoded PNG.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Keyed frame.
 */
function keyStudioPlate(frame) {
  const punched = punchFlattenMagenta(frame.data);
  const keyed = borderFloodKey(punched, frame.width, frame.height, { mode: "any" });
  return { data: keyed.data, width: frame.width, height: frame.height };
}

/**
 * Composites two decoded frames as a magenta change map or a red/cyan onion.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameA First frame.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameB Second frame.
 * @param {{mode?:string}} [options] `diff` (default) or `onion`.
 * @returns {{
 *   data:Uint8ClampedArray,
 *   width:number,
 *   height:number,
 *   changedPixelCount:number,
 *   mode:string,
 *   qa:"warn"|"review",
 *   issues:string[],
 * }} Compose result.
 */
function composeFrameDiff(frameA, frameB, options = {}) {
  const width = Number(frameA?.width);
  const height = Number(frameA?.height);
  if (!width || !height || width !== Number(frameB?.width) || height !== Number(frameB?.height)) {
    throw new Error("xsxb_diff_frames requires two frames of the same width and height.");
  }
  const mode = String(options.mode || "diff") === "onion" ? "onion" : "diff";
  const analysis = analyzeFrameDiff(frameA, frameB);
  if (mode === "onion") {
    const onion = composeRbOverlay(analysis.keyedA, analysis.keyedB);
    return {
      data: onion.data,
      width: onion.width,
      height: onion.height,
      changedPixelCount: analysis.changedPixelCount,
      mode,
      qa: analysis.qa,
      issues: analysis.issues,
    };
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const left = analysis.keyedA.data;
  for (let index = 0; index < analysis.delta.length; index += 1) {
    const offset = index * 4;
    if (analysis.delta[index]) data.set(MAGENTA, offset);
    else data.set(left.subarray(offset, offset + 4), offset);
  }
  return {
    data,
    width,
    height,
    changedPixelCount: analysis.changedPixelCount,
    mode,
    qa: analysis.qa,
    issues: analysis.issues,
  };
}

module.exports = { composeFrameDiff, countChangedPixels, keyStudioPlate };
