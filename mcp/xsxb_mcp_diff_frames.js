"use strict";

/**
 * Pixel compose for `xsxb_diff_frames`. Marks vacated and newly occupied
 * pixels so an agent can open a real PNG instead of treating import as a pass.
 */

const { composeRbOverlay } = require("./xsxb_mcp_lock");

const MAGENTA = Object.freeze([255, 0, 255, 255]);

/**
 * Counts RGBA pixels that differ between two same-size frames.
 * @param {{data:Uint8ClampedArray|Uint8Array}} frameA First frame.
 * @param {{data:Uint8ClampedArray|Uint8Array}} frameB Second frame.
 * @returns {number} Changed pixel count.
 */
function countChangedPixels(frameA, frameB) {
  const left = frameA.data;
  const right = frameB.data;
  const limit = Math.min(left.length, right.length);
  let changed = 0;
  for (let offset = 0; offset < limit; offset += 4) {
    if (
      left[offset] !== right[offset] ||
      left[offset + 1] !== right[offset + 1] ||
      left[offset + 2] !== right[offset + 2] ||
      left[offset + 3] !== right[offset + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * Composites two decoded frames as a magenta change map or a red/cyan onion.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameA First frame.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} frameB Second frame.
 * @param {{mode?:string}} [options] `diff` (default) or `onion`.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,changedPixelCount:number,mode:string}} Compose result.
 */
function composeFrameDiff(frameA, frameB, options = {}) {
  const width = Number(frameA?.width);
  const height = Number(frameA?.height);
  if (!width || !height || width !== Number(frameB?.width) || height !== Number(frameB?.height)) {
    throw new Error("xsxb_diff_frames requires two frames of the same width and height.");
  }
  const mode = String(options.mode || "diff") === "onion" ? "onion" : "diff";
  const changedPixelCount = countChangedPixels(frameA, frameB);
  if (mode === "onion") {
    const onion = composeRbOverlay(frameA, frameB);
    return { data: onion.data, width: onion.width, height: onion.height, changedPixelCount, mode };
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const left = frameA.data;
  const right = frameB.data;
  for (let offset = 0; offset < data.length; offset += 4) {
    const same =
      left[offset] === right[offset] &&
      left[offset + 1] === right[offset + 1] &&
      left[offset + 2] === right[offset + 2] &&
      left[offset + 3] === right[offset + 3];
    if (same) data.set(left.subarray(offset, offset + 4), offset);
    else data.set(MAGENTA, offset);
  }
  return { data, width, height, changedPixelCount, mode };
}

module.exports = { composeFrameDiff, countChangedPixels };
