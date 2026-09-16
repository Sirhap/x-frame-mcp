"use strict";

/**
 * Node-side loop-segment query that reuses the Tuner's FrameOrganizerCore
 * finder. The UI resamples to 256×256 via Canvas; MCP does the same size with
 * nearest-neighbor so the search can run without a browser.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  ORGANIZER_SIMILARITY_THRESHOLD,
  REFERENCE_SAMPLE_SIZE,
  analyzeDuplicateFrames,
  createSignature,
  findLoopCandidates,
} = require("./lib/animation_tuner/public/frame_organizer_core");
const { PNG_NAME, listPngSequence, requireExistingFile } = require("./xsxb_mcp_arguments");
const { decodePngRgba } = require("./xsxb_mcp_cutout");
const { findMotionWindow, measureFrame, median } = require("./xsxb_mcp_visual_qa");

const MINIMUM_LOOP_FRAMES = 4;
const MINIMUM_DUPLICATE_FRAMES = 3;
const DEFAULT_DUPLICATE_THRESHOLD = ORGANIZER_SIMILARITY_THRESHOLD.fallback;

/**
 * Builds an inclusive integer range.
 * @param {number} start First index.
 * @param {number} end Last index.
 * @returns {number[]} Indexes from start through end.
 */
function inclusiveRange(start, end) {
  const order = [];
  for (let index = start; index <= end; index += 1) order.push(index);
  return order;
}

/**
 * Resamples RGBA to a square analysis sample.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image Source pixels.
 * @param {number} sampleSize Destination edge length.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Signature sample.
 */
function downsampleRgba(image, sampleSize) {
  const size = Math.max(8, Math.round(sampleSize));
  if (image.width === size && image.height === size) {
    return createSignature(image.data, image.width, image.height);
  }
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / size));
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / size));
      const source = (sourceY * image.width + sourceX) * 4;
      const dest = (y * size + x) * 4;
      out[dest] = image.data[source];
      out[dest + 1] = image.data[source + 1];
      out[dest + 2] = image.data[source + 2];
      out[dest + 3] = image.data[source + 3];
    }
  }
  return createSignature(out, size, size);
}

/**
 * Decodes one PNG into a loop-finder signature.
 * @param {string} filePath Absolute PNG path.
 * @param {number} sampleSize Analysis sample edge.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Signature.
 */
function loadSignature(filePath, sampleSize) {
  if (!PNG_NAME.test(filePath)) throw new Error(`Loop frame must be a PNG: ${filePath}`);
  return downsampleRgba(decodePngRgba(filePath), sampleSize);
}

/**
 * Warns when the recommended loop is a short burst inside a longer clip.
 * Short repeating cycles stay unflagged. A solid interior gait in a long take
 * is also not a one-shot — coverage below half is normal for a source dump.
 * @param {number} frameCount Clip length.
 * @param {{coverage?:number,length?:number,period?:number,score?:number,smoothness?:number,similarity?:number}|null} recommended Ranked candidate, if any.
 * @returns {{oneShotLikely:boolean,note:string}} Advice for the receipt.
 */
function adviseLoopCandidate(frameCount, recommended) {
  if (!recommended) {
    return {
      oneShotLikely: true,
      note: "No loop candidate. Inspect sheets or use xsxb_find_motion.",
    };
  }
  if (!(frameCount >= 12)) {
    return { oneShotLikely: false, note: "" };
  }
  const coverage = Number(recommended.coverage);
  const length = Number(recommended.length);
  const period = Number(recommended.period);
  const score = Number(recommended.score);
  const smoothness = Number(recommended.smoothness);
  const similarity = Number(recommended.similarity);
  const coverageLow = !Number.isFinite(coverage) || coverage < 0.5;
  const burstLength = Number.isFinite(length) && length < 12;
  const solidCycle =
    Number.isFinite(period) &&
    Number.isFinite(length) &&
    period === length &&
    length >= 12 &&
    ((Number.isFinite(smoothness) && smoothness >= 0.7) ||
      (Number.isFinite(similarity) && similarity >= 70) ||
      (Number.isFinite(score) && score >= 0.45));
  if (solidCycle) {
    return {
      oneShotLikely: false,
      note: coverageLow
        ? "Recommended loop is an interior cycle in a longer take. Inspect the preview before applying."
        : "",
    };
  }
  const oneShotLikely = coverageLow && (burstLength || !Number.isFinite(length));
  return {
    oneShotLikely,
    note: oneShotLikely
      ? "Recommended loop looks like a burst inside a longer clip. Inspect sheets before applying; a one-shot should keep the full order or use xsxb_find_motion."
      : "",
  };
}

function summarizeCandidate(candidate, options = {}) {
  const start = Number(candidate.start);
  const end = Number(candidate.end);
  const summary = {
    start,
    end,
    length: Number(candidate.length),
    period: Number(candidate.period),
    score: Number(candidate.score),
    rankScore: Number(candidate.rankScore),
    similarity: Number(candidate.similarity),
    coverage: Number(candidate.coverage),
    smoothness: Number(candidate.smoothness),
    acfScore: Number(candidate.acfScore),
  };
  if (options.includeOrder !== false) summary.order = inclusiveRange(start, end);
  return summary;
}

/**
 * Picks the analyze window agents should apply: loop unless oneShotLikely.
 * @param {{recommended?:{start:number,end:number,order?:number[]}|null,oneShotLikely?:boolean}} loop Loop receipt.
 * @param {{start:number,end:number,order?:number[]}} motion Motion window.
 * @returns {{kind:"loop"|"motion",start:number,end:number,order:number[]}} Window to slice.
 */
function chooseAnalyzeWindow(loop, motion) {
  const recommended = loop?.recommended;
  const useLoop = Boolean(recommended) && loop.oneShotLikely !== true;
  if (useLoop) {
    return {
      kind: "loop",
      start: recommended.start,
      end: recommended.end,
      order: Array.isArray(recommended.order)
        ? recommended.order
        : inclusiveRange(recommended.start, recommended.end),
    };
  }
  return {
    kind: "motion",
    start: motion.start,
    end: motion.end,
    order: Array.isArray(motion.order) ? motion.order : inclusiveRange(motion.start, motion.end),
  };
}

/**
 * Drops allowed holds, then keeps the recommended window indexes.
 * @param {number[]} windowOrder Loop or motion indexes into the full clip.
 * @param {number[]} [drop] Duplicate indexes that may be applied.
 * @returns {number[]} Merged keep-list for xsxb_reorganize_frames.
 */
function mergeApplyOrder(windowOrder, drop) {
  const dropped = new Set(Array.isArray(drop) ? drop : []);
  return (Array.isArray(windowOrder) ? windowOrder : []).filter((index) => !dropped.has(index));
}

/**
 * Duplicate-hold analysis on already-built signatures.
 * @param {object[]} signatures Loop signatures.
 * @param {{threshold?:number,autoAdjust?:boolean}} [options] Finder options.
 * @returns {object} Compact duplicate receipt.
 */
function duplicatesFromSignatures(signatures, options = {}) {
  const threshold = options.threshold === undefined ? DEFAULT_DUPLICATE_THRESHOLD : Number(options.threshold);
  if (
    !Number.isFinite(threshold) ||
    threshold < ORGANIZER_SIMILARITY_THRESHOLD.min ||
    threshold > ORGANIZER_SIMILARITY_THRESHOLD.max
  ) {
    throw new Error(
      `threshold must be a number between ${ORGANIZER_SIMILARITY_THRESHOLD.min} and ${ORGANIZER_SIMILARITY_THRESHOLD.max}.`,
    );
  }
  const analyzed = analyzeDuplicateFrames(signatures, threshold);
  const suggestedDrop = analyzed.matches.map((entry) => Number(entry.index));
  const applyAuto = Boolean(options.autoAdjust) && analyzed.autoAdjustedThreshold != null;
  const applyBlocked = analyzed.autoAdjustedThreshold != null && !applyAuto;
  const drop = applyBlocked ? [] : suggestedDrop;
  const dropped = new Set(drop);
  const suggestedDropped = new Set(suggestedDrop);
  const suggestedOrder = signatures.map((_, index) => index).filter((index) => !suggestedDropped.has(index));
  const receipt = {
    threshold,
    autoAdjustedThreshold: analyzed.autoAdjustedThreshold,
    applyBlocked,
    drop,
    order: applyBlocked ? [] : signatures.map((_, index) => index).filter((index) => !dropped.has(index)),
    suggestedDrop,
    suggestedOrder,
    matchCount: analyzed.matches.length,
    matches: analyzed.matches,
    applied: false,
  };
  if (applyBlocked) {
    receipt.note =
      "autoAdjustedThreshold is set; pass auto_adjust to apply suggestedOrder. duplicates.order is empty, not identity.";
  }
  return receipt;
}

/**
 * Ranks loop segments on an ordered PNG sequence.
 * @param {string[]} filePaths Absolute PNG paths in playback order.
 * @param {{minPeriod?:number,maxPeriod?:number,startFrame?:number,preference?:string,boundaryFactor?:number,sampleSize?:number}} [options] Search options.
 * @returns {{frameCount:number,sampleSize:number,candidates:object[],recommended:object|null,oneShotLikely:boolean,note?:string}} Ranked loops.
 */
function findLoopInPngFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length < MINIMUM_LOOP_FRAMES) {
    throw new Error(
      `Loop search needs at least ${MINIMUM_LOOP_FRAMES} PNG frames; received ${filePaths?.length || 0}.`,
    );
  }
  const sampleSize = Math.max(8, Math.round(options.sampleSize || REFERENCE_SAMPLE_SIZE));
  const signatures = filePaths.map((filePath) => loadSignature(filePath, sampleSize));
  const candidates = findLoopCandidates(signatures, {
    minPeriod: options.minPeriod,
    maxPeriod: options.maxPeriod,
    startFrame: options.startFrame,
    preference: options.preference,
    boundaryFactor: options.boundaryFactor,
  }).map(summarizeCandidate);
  const recommended = candidates[0] || null;
  const advice = adviseLoopCandidate(filePaths.length, recommended);
  return {
    frameCount: filePaths.length,
    sampleSize,
    candidates,
    recommended,
    oneShotLikely: advice.oneShotLikely,
    note: advice.note || undefined,
  };
}

/**
 * Finds near-duplicate holds with the same Tuner duplicate finder.
 * Does not mutate frames; apply the keep-order with xsxb_reorganize_frames.
 * @param {string[]} filePaths Absolute PNG paths in playback order.
 * @param {{threshold?:number,sampleSize?:number}} [options] Search options.
 * @returns {{frameCount:number,sampleSize:number,threshold:number,autoAdjustedThreshold:number|null,applyBlocked:boolean,drop:number[],order:number[],suggestedDrop:number[],suggestedOrder:number[],matches:object[],applied:boolean,note?:string}}
 */
function findDuplicatesInPngFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length < MINIMUM_DUPLICATE_FRAMES) {
    throw new Error(
      `Duplicate search needs at least ${MINIMUM_DUPLICATE_FRAMES} PNG frames; received ${filePaths?.length || 0}.`,
    );
  }
  const sampleSize = Math.max(8, Math.round(options.sampleSize || REFERENCE_SAMPLE_SIZE));
  const signatures = filePaths.map((filePath) => loadSignature(filePath, sampleSize));
  return {
    frameCount: filePaths.length,
    sampleSize,
    ...duplicatesFromSignatures(signatures, options),
  };
}

/**
 * One-pass duplicate, loop, and motion analysis. Decodes each PNG once.
 * `images` is for the caller to render a preview; strip it before an MCP receipt.
 * @param {string[]} filePaths Absolute PNG paths in playback order.
 * @param {{minPeriod?:number,maxPeriod?:number,startFrame?:number,preference?:string,boundaryFactor?:number,sampleSize?:number,threshold?:number,autoAdjust?:boolean,decodePngRgba?:Function}} [options] Analysis options.
 * @returns {object} Compact analysis plus decoded frames.
 */
function analyzePngFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length < MINIMUM_LOOP_FRAMES) {
    throw new Error(
      `Clip analysis needs at least ${MINIMUM_LOOP_FRAMES} PNG frames; received ${filePaths?.length || 0}.`,
    );
  }
  const sampleSize = Math.max(8, Math.round(options.sampleSize || REFERENCE_SAMPLE_SIZE));
  const decode = options.decodePngRgba || decodePngRgba;
  const images = filePaths.map((filePath) => {
    if (!PNG_NAME.test(filePath)) throw new Error(`Loop frame must be a PNG: ${filePath}`);
    const image = decode(filePath);
    return { data: image.data, width: image.width, height: image.height };
  });
  const signatures = images.map((image) => downsampleRgba(image, sampleSize));
  const measured = images.map((image, index) => ({
    index,
    ...measureFrame(image.data, image.width, image.height),
  }));
  const loopCandidates = findLoopCandidates(signatures, {
    minPeriod: options.minPeriod,
    maxPeriod: options.maxPeriod,
    startFrame: options.startFrame,
    preference: options.preference,
    boundaryFactor: options.boundaryFactor,
  }).map((candidate) => summarizeCandidate(candidate, { includeOrder: false }));
  const recommended = loopCandidates[0]
    ? {
        ...loopCandidates[0],
        order: inclusiveRange(loopCandidates[0].start, loopCandidates[0].end),
      }
    : null;
  const advice = adviseLoopCandidate(filePaths.length, recommended);
  const duplicates = duplicatesFromSignatures(signatures, options);
  duplicates.matches = duplicates.matches.slice(0, 12);
  const motionFound = findMotionWindow(
    measured.map((frame) => ({
      opaque: frame.opaque,
      height: frame.bodyHeight,
      cy: frame.cy,
    })),
  );
  const heights = measured.map((frame) => Number(frame.bodyHeight || 0));
  const feet = measured.map((frame) => Number(frame.feetY || 0));
  const loop = {
    candidates: loopCandidates.slice(0, 5),
    recommended,
    oneShotLikely: advice.oneShotLikely,
    note: advice.note || undefined,
  };
  const motion = {
    start: motionFound.start,
    end: motionFound.end,
    order: motionFound.order,
  };
  const window = chooseAnalyzeWindow(loop, motion);
  const applyOrder = mergeApplyOrder(window.order, duplicates.drop);
  return {
    frameCount: filePaths.length,
    sampleSize,
    decodeCount: images.length,
    applyOrder,
    recommended: {
      applyOrder,
      kind: window.kind,
      start: window.start,
      end: window.end,
    },
    duplicates,
    loop,
    motion,
    metrics: {
      bodyHeight: {
        min: heights.length ? Math.min(...heights) : 0,
        max: heights.length ? Math.max(...heights) : 0,
        median: median(heights),
      },
      feetY: {
        min: feet.length ? Math.min(...feet) : 0,
        max: feet.length ? Math.max(...feet) : 0,
        median: median(feet),
      },
    },
    images,
  };
}

/**
 * Resolves PNG paths from explicit files or a directory of numbered frames.
 * @param {{file_paths?:string[],directory?:string}} args Tool arguments.
 * @returns {{source:string,filePaths:string[]}|null} Resolved files, or null when neither source is set.
 */
function resolveExternalLoopFrames(args = {}) {
  if (Array.isArray(args.file_paths) && args.file_paths.length) {
    return {
      source: "files",
      filePaths: args.file_paths.map((filePath) => requireExistingFile(filePath, "Loop frame")),
    };
  }
  if (args.directory) {
    const directory = path.resolve(String(args.directory));
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error(`PNG sequence directory not found: ${args.directory}`);
    }
    return { source: "directory", filePaths: listPngSequence(directory) };
  }
  return null;
}

module.exports = {
  DEFAULT_DUPLICATE_THRESHOLD,
  ORGANIZER_SIMILARITY_THRESHOLD,
  MINIMUM_DUPLICATE_FRAMES,
  MINIMUM_LOOP_FRAMES,
  adviseLoopCandidate,
  analyzePngFiles,
  chooseAnalyzeWindow,
  downsampleRgba,
  findDuplicatesInPngFiles,
  findLoopInPngFiles,
  mergeApplyOrder,
  resolveExternalLoopFrames,
};
