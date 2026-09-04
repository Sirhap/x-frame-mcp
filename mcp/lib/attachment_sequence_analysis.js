"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });
const MAX_PNG_PIXELS = 16_777_216;
const MAX_INFLATED_BYTES = MAX_PNG_PIXELS * 4 + 16_384;

/**
 * Clamps a finite number to an inclusive range.
 * @param {number} value Input value.
 * @param {number} minimum Minimum value.
 * @param {number} maximum Maximum value.
 * @returns {number} Clamped value.
 */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Computes the PNG Paeth predictor.
 * @param {number} left Left byte.
 * @param {number} above Above byte.
 * @param {number} upperLeft Upper-left byte.
 * @returns {number} Predicted byte.
 */
function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

/**
 * Parses the image header and concatenated PNG data chunks.
 * Only non-interlaced 8-bit grayscale, RGB, grayscale-alpha, and RGBA images
 * are accepted because attachment analysis requires deterministic pixels.
 * @param {Buffer} buffer PNG file bytes.
 * @returns {{width:number,height:number,colorType:number,channels:number,compressed:Buffer}} Parsed data.
 */
function parsePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature.");
  }
  let offset = 8;
  let header = null;
  const dataChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error("Truncated PNG chunk.");
    if (type === "IHDR") {
      header = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      };
    } else if (type === "IDAT") {
      dataChunks.push(buffer.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  const channels = CHANNELS_BY_COLOR_TYPE[header?.colorType];
  if (!header || !header.width || !header.height || !dataChunks.length) {
    throw new Error("PNG is missing IHDR or IDAT data.");
  }
  if (header.bitDepth !== 8 || header.interlace !== 0 || !channels) {
    throw new Error(
      `Unsupported PNG format: bit depth ${header.bitDepth}, color type ${header.colorType}, interlace ${header.interlace}.`,
    );
  }
  if (header.width * header.height > MAX_PNG_PIXELS) {
    const error = new Error(
      `PNG exceeds the ${MAX_PNG_PIXELS} decoded-pixel limit: ${header.width}x${header.height}.`,
    );
    error.code = "PNG_PIXEL_LIMIT";
    throw error;
  }
  return {
    width: header.width,
    height: header.height,
    colorType: header.colorType,
    channels,
    compressed: Buffer.concat(dataChunks),
  };
}

/**
 * Restores PNG scanline filters.
 * @param {{width:number,height:number,channels:number,compressed:Buffer}} png Parsed PNG data.
 * @returns {Uint8Array} Unfiltered packed pixels.
 */
function unfilterPng(png) {
  const stride = png.width * png.channels;
  const expected = png.height * (stride + 1);
  if (expected > MAX_INFLATED_BYTES) throw new Error("PNG decoded payload exceeds the memory limit.");
  const inflated = zlib.inflateSync(png.compressed, { maxOutputLength: expected });
  if (inflated.length !== expected) {
    throw new Error(`Unexpected PNG payload size: ${inflated.length}, expected ${expected}.`);
  }
  const pixels = new Uint8Array(stride * png.height);
  for (let y = 0; y < png.height; y += 1) {
    const inputStart = y * (stride + 1);
    const filter = inflated[inputStart];
    const outputStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputStart + x + 1];
      const left = x >= png.channels ? pixels[outputStart + x - png.channels] : 0;
      const above = y > 0 ? pixels[outputStart + x - stride] : 0;
      const upperLeft = y > 0 && x >= png.channels ? pixels[outputStart + x - stride - png.channels] : 0;
      let value = raw;
      if (filter === 1) value += left;
      else if (filter === 2) value += above;
      else if (filter === 3) value += Math.floor((left + above) / 2);
      else if (filter === 4) value += paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}.`);
      pixels[outputStart + x] = value & 0xff;
    }
  }
  return pixels;
}

/**
 * Returns one packed pixel's alpha component.
 * @param {Uint8Array} pixels Packed pixels.
 * @param {number} offset Pixel offset.
 * @param {number} colorType PNG color type.
 * @returns {number} Alpha in the range 0-255.
 */
function pixelAlpha(pixels, offset, colorType) {
  if (colorType === 6) return pixels[offset + 3];
  if (colorType === 4) return pixels[offset + 1];
  return 255;
}

/**
 * Finds a weighted projection quantile.
 * @param {Float64Array} projection Per-axis alpha weights.
 * @param {number} total Total weight.
 * @param {number} quantile Quantile in the range 0-1.
 * @returns {number} Axis coordinate.
 */
function projectionQuantile(projection, total, quantile) {
  const target = total * clamp(quantile, 0, 1);
  let cumulative = 0;
  for (let index = 0; index < projection.length; index += 1) {
    cumulative += projection[index];
    if (cumulative >= target) return index;
  }
  return Math.max(0, projection.length - 1);
}

/**
 * Analyzes visible alpha mass, bounds, and centroid for one PNG attachment.
 * @param {string} filePath PNG path.
 * @param {{alphaThreshold?:number}} [options] Analysis options.
 * @returns {{width:number,height:number,visiblePixels:number,alphaMass:number,bounds:object|null,coreBounds:object|null,centroid:object|null}} Analysis.
 */
function analyzePngAlpha(filePath, options = {}) {
  const png = parsePng(fs.readFileSync(filePath));
  const pixels = unfilterPng(png);
  const threshold = clamp(Number(options.alphaThreshold ?? 8), 0, 254);
  let visiblePixels = 0;
  let alphaSum = 0;
  let visibleAlphaSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  let minimumX = png.width;
  let minimumY = png.height;
  let maximumX = -1;
  let maximumY = -1;
  const horizontalAlpha = new Float64Array(png.width);
  const verticalAlpha = new Float64Array(png.height);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * png.channels;
      const alpha = pixelAlpha(pixels, offset, png.colorType);
      alphaSum += alpha;
      if (alpha <= threshold) continue;
      visiblePixels += 1;
      visibleAlphaSum += alpha;
      weightedX += x * alpha;
      weightedY += y * alpha;
      horizontalAlpha[x] += alpha;
      verticalAlpha[y] += alpha;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  const bounds = visiblePixels
    ? {
        x: minimumX,
        y: minimumY,
        width: maximumX - minimumX + 1,
        height: maximumY - minimumY + 1,
        centerX: (minimumX + maximumX) / 2,
        centerY: (minimumY + maximumY) / 2,
      }
    : null;
  const coreMinimumX = visiblePixels ? projectionQuantile(horizontalAlpha, visibleAlphaSum, 0.08) : 0;
  const coreMaximumX = visiblePixels ? projectionQuantile(horizontalAlpha, visibleAlphaSum, 0.92) : -1;
  const coreMinimumY = visiblePixels ? projectionQuantile(verticalAlpha, visibleAlphaSum, 0.04) : 0;
  const coreMaximumY = visiblePixels ? projectionQuantile(verticalAlpha, visibleAlphaSum, 0.96) : -1;
  const coreBounds = visiblePixels
    ? {
        x: coreMinimumX,
        y: coreMinimumY,
        width: coreMaximumX - coreMinimumX + 1,
        height: coreMaximumY - coreMinimumY + 1,
        centerX: (coreMinimumX + coreMaximumX) / 2,
        centerY: (coreMinimumY + coreMaximumY) / 2,
      }
    : null;
  return {
    width: png.width,
    height: png.height,
    visiblePixels,
    alphaMass: alphaSum / (255 * png.width * png.height),
    bounds,
    coreBounds,
    centroid: visibleAlphaSum ? { x: weightedX / visibleAlphaSum, y: weightedY / visibleAlphaSum } : null,
  };
}

/**
 * Produces endpoint-preserving sequence indexes.
 * @param {number} start Inclusive start index.
 * @param {number} end Inclusive end index.
 * @param {number} count Required output count.
 * @returns {number[]} Selected indexes.
 */
function evenlySpacedIndexes(start, end, count) {
  if (!Number.isInteger(count) || count < 1 || start < 0 || end < start) {
    throw new Error("Invalid sequence sampling range.");
  }
  if (count === 1) return [Math.round((start + end) / 2)];
  const available = end - start + 1;
  const indexes = [];
  for (let index = 0; index < count; index += 1) {
    let selected = Math.round(start + (index * (end - start)) / (count - 1));
    if (available >= count) {
      const minimum = index ? indexes[index - 1] + 1 : start;
      const maximum = end - (count - index - 1);
      selected = clamp(selected, minimum, maximum);
    }
    indexes.push(selected);
  }
  return indexes;
}

/**
 * Selects an exact target count using strict, normalized, or alpha-active sampling.
 * @param {{assets:object[],targetCount:number,strategy?:string,analyzeAsset?:(asset:object)=>object}} options Selection options.
 * @returns {{assets:object[],sourceIndexes:number[],analysis:object}} Selection result.
 */
function selectSequenceAssets(options) {
  const assets = Array.isArray(options?.assets) ? options.assets : [];
  const targetCount = Number(options?.targetCount);
  const strategy = String(options?.strategy || "strict").toLowerCase();
  if (!assets.length || !Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error("Attachment sequence selection requires assets and a positive target count.");
  }
  if (strategy === "strict") {
    if (assets.length !== targetCount) {
      throw new Error(
        `Unsafe one-to-one mapping (count_mismatch): ${assets.length} assets for ${targetCount} frames.`,
      );
    }
    const sourceIndexes = assets.map((_asset, index) => index);
    return {
      assets: [...assets],
      sourceIndexes,
      analysis: { strategy, sourceCount: assets.length, targetCount, confidence: 1 },
    };
  }
  if (strategy === "resample") {
    const sourceIndexes = evenlySpacedIndexes(0, assets.length - 1, targetCount);
    return {
      assets: sourceIndexes.map((index) => assets[index]),
      sourceIndexes,
      analysis: { strategy, sourceCount: assets.length, targetCount, confidence: 0.9 },
    };
  }
  if (strategy !== "active") throw new Error(`Unknown attachment mapping strategy: ${strategy}`);
  const analyzeAsset = options.analyzeAsset || ((asset) => analyzePngAlpha(asset.sourcePath));
  const frameAnalyses = assets.map(analyzeAsset);
  const scores = frameAnalyses.map((analysis) => Number(analysis.alphaMass || 0));
  const peakScore = Math.max(...scores);
  if (!(peakScore > 0)) throw new Error("Attachment sequence has no visible alpha activity.");
  const activityThreshold = peakScore * 0.12;
  let activeStart = scores.findIndex((score) => score >= activityThreshold);
  let activeEnd = scores.findLastIndex((score) => score >= activityThreshold);
  if (activeStart < 0 || activeEnd < activeStart) {
    activeStart = 0;
    activeEnd = assets.length - 1;
  }
  if (activeEnd - activeStart + 1 < Math.min(targetCount, assets.length)) {
    activeStart = 0;
    activeEnd = assets.length - 1;
  }
  const sourceIndexes = evenlySpacedIndexes(activeStart, activeEnd, targetCount);
  const outsideScores = scores.filter((_score, index) => index < activeStart || index > activeEnd);
  const outsideMaximum = outsideScores.length ? Math.max(...outsideScores) : peakScore * 0.5;
  const contrast = clamp((peakScore - outsideMaximum) / peakScore, 0, 1);
  const confidence = Number(clamp(0.62 + contrast * 0.3, 0.62, 0.92).toFixed(3));
  return {
    assets: sourceIndexes.map((index) => assets[index]),
    sourceIndexes,
    analysis: {
      strategy,
      sourceCount: assets.length,
      targetCount,
      confidence,
      activeRange: [activeStart + 1, activeEnd + 1],
      selectedSourceFrames: sourceIndexes.map((index) => index + 1),
      activityScores: scores.map((score) => Number(score.toFixed(6))),
    },
  };
}

/**
 * Recommends a conservative local transform from visible owner/effect bounds.
 * The returned transform is a reviewable proposal and never bypasses plan confirmation.
 * @param {{owner:object,attachment:object,direction?:string}} options Spatial analysis input.
 * @returns {{transform:object,confidence:number,direction:string,diagnostics:object}} Recommendation.
 */
function recommendSpatialTransform(options) {
  const owner = options?.owner;
  const attachment = options?.attachment;
  if (!owner?.bounds || !attachment?.bounds) {
    throw new Error("Spatial recommendation requires visible owner and attachment bounds.");
  }
  const requestedDirection = String(options?.direction || "auto").toLowerCase();
  if (!new Set(["auto", "left", "right"]).has(requestedDirection)) {
    throw new Error(`Unknown attachment direction: ${requestedDirection}`);
  }
  const ownerBounds = owner.coreBounds || owner.bounds;
  const ownerCenterDelta = ownerBounds.centerX - owner.width / 2;
  const directionSign =
    requestedDirection === "left" ? -1 : requestedDirection === "right" ? 1 : ownerCenterDelta >= 0 ? 1 : -1;
  const direction = directionSign > 0 ? "right" : "left";
  const scale = clamp((ownerBounds.width * 1.15) / attachment.bounds.width, 0.25, 1.25);
  const targetCenterX = ownerBounds.centerX + directionSign * ownerBounds.width * 0.45;
  const targetCenterY = ownerBounds.centerY + ownerBounds.height * 0.08;
  const scaledAttachmentCenterX =
    attachment.width / 2 + (attachment.bounds.centerX - attachment.width / 2) * scale;
  const scaledAttachmentCenterY =
    attachment.height / 2 + (attachment.bounds.centerY - attachment.height / 2) * scale;
  const automaticDirectionConfidence = clamp(
    Math.abs(ownerCenterDelta) / Math.max(1, ownerBounds.width * 0.2),
    0.2,
    0.75,
  );
  const directionConfidence = requestedDirection === "auto" ? automaticDirectionConfidence : 0.95;
  const sharedCanvas = owner.width === attachment.width && owner.height === attachment.height;
  const confidence = Number(
    clamp((sharedCanvas ? 0.72 : 0.58) + directionConfidence * 0.2, 0.6, 0.91).toFixed(3),
  );
  const roundedScale = Number(scale.toFixed(3));
  return {
    transform: {
      scale: roundedScale,
      scaleX: roundedScale,
      scaleY: roundedScale,
      offset: {
        x: Math.round(targetCenterX - scaledAttachmentCenterX),
        y: Math.round(targetCenterY - scaledAttachmentCenterY),
      },
      rotation: 0,
    },
    confidence,
    direction,
    diagnostics: {
      sharedCanvas,
      ownerBounds: owner.bounds,
      ownerCoreBounds: ownerBounds,
      attachmentBounds: attachment.bounds,
    },
  };
}

module.exports = {
  MAX_INFLATED_BYTES,
  MAX_PNG_PIXELS,
  analyzePngAlpha,
  evenlySpacedIndexes,
  parsePng,
  recommendSpatialTransform,
  selectSequenceAssets,
  unfilterPng,
};
