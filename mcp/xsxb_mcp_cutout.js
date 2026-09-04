"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { parsePng, unfilterPng } = require("./lib/attachment_sequence_analysis");
const { NUMERIC_PARAMETER_LIMITS } = require("./lib/animation_tuner/public/batch_cutout_session_core");
const {
  REGULAR_AUTO_BACKGROUND_PARAMETERS,
  classifySmartBackground,
  referenceChromaKeyFor,
} = require("./lib/animation_tuner/public/smart_cutout_defaults");
const { applyProductCutout } = require("./lib/animation_tuner/public/batch_cutout_core");
const {
  createSmartCutoutOptions,
  detectBackgroundColor,
} = require("./lib/animation_tuner/public/scatter_slice_smart_cutout");

const REFERENCE_MODES = Object.freeze(["general", "blend", "chroma"]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALPHA_VISIBLE = 16;
/** Pixels darker than this count as body/boot rather than slash glow. */
const BODY_DARK_LUMA = 160;
/** A row below the torso is glow when it is at least this bright. */
const GLOW_LUMA_MIN = 170;
/** Glow must also outshine the torso median luma by this much. */
const GLOW_LUMA_DELTA = 36;
/** Glow rows have almost no dark body pixels. */
const GLOW_DARK_RATIO = 0.25;
/**
 * Share of border-ring pixels that must be transparent before a frame counts as
 * cut out. A frame that still carries its background leaves the ring almost
 * fully opaque, while an already-cut frame only touches the edge where a body
 * or an effect runs off it, so a simple majority separates the two with room to
 * spare in both directions.
 */
const CUT_BORDER_CLEAR_RATIO = 0.5;

/**
 * Labels a successful cutout receipt. All-skip still succeeds; rematch is work.
 * @param {{rematched?:boolean,processedFrameCount?:number,skippedFrameCount?:number,frameCount?:number}} receipt
 * @returns {"confirmed"|"suspected_noop"}
 */
function cutoutVerifyStatus(receipt = {}) {
  if (receipt.rematched === true) return "confirmed";
  if (receipt.keyed === true) return "confirmed";
  const processed = Number(receipt.processedFrameCount || 0);
  const skipped = Number(receipt.skippedFrameCount || 0);
  const frameCount = Number(receipt.frameCount);
  if (processed === 0) return "suspected_noop";
  if (Number.isFinite(frameCount) && frameCount > 0 && skipped === frameCount) return "suspected_noop";
  return "confirmed";
}

/**
 * Counts opaque dark, non-neutral pixels (navy trousers, not a black plate).
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @returns {number} Count.
 */
function countDarkClothes(rgba) {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] <= ALPHA_VISIBLE) continue;
    const maxc = Math.max(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
    const minc = Math.min(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
    if (maxc <= 80 && maxc - minc > 12) count += 1;
  }
  return count;
}

/**
 * Computes a PNG CRC32 checksum.
 * @param {Buffer} buffer Input bytes.
 * @returns {number} Unsigned checksum.
 */
function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encodes one PNG chunk.
 * @param {string} type Chunk type.
 * @param {Buffer} data Chunk payload.
 * @returns {Buffer} Length, type, payload, and CRC.
 */
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Encodes an 8-bit RGBA image as a PNG buffer.
 * @param {Uint8ClampedArray|Uint8Array} rgba Source pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @returns {Buffer} PNG file bytes.
 */
function encodePngRgba(rgba, width, height, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("PNG dimensions must be positive integers.");
  }
  if (rgba.length !== width * height * 4) throw new RangeError("RGBA length does not match the PNG size.");
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    filtered[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + rowStart, stride).copy(filtered, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const level =
    options && Number.isInteger(options.level) ? options.level : zlib.constants.Z_DEFAULT_COMPRESSION;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(filtered, { level })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Lossless-reencodes one PNG with max zlib. Pixels stay identical. Writes only
 * when the new file is strictly smaller.
 * @param {string} filePath PNG path.
 * @param {{dryRun?:boolean}} [options] When dryRun, skip the write.
 * @returns {{path:string,bytesBefore:number,bytesAfter:number,wrote:boolean,width:number,height:number}}
 */
function compressPngFile(filePath, options = {}) {
  const original = fs.readFileSync(filePath);
  const decoded = decodePngRgba(filePath);
  const recompressed = encodePngRgba(decoded.data, decoded.width, decoded.height, {
    level: zlib.constants.Z_BEST_COMPRESSION,
  });
  const smaller = recompressed.length < original.length;
  if (smaller && !options.dryRun) {
    const tempPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, recompressed);
    fs.renameSync(tempPath, filePath);
  }
  return {
    path: filePath,
    bytesBefore: original.length,
    bytesAfter: smaller ? recompressed.length : original.length,
    wrote: smaller && !options.dryRun,
    width: decoded.width,
    height: decoded.height,
  };
}

/**
 * Copies one packed pixel into an RGBA buffer.
 * @param {Uint8Array} packed Decoded PNG samples.
 * @param {number} colorType PNG color type.
 * @param {number} index Pixel index.
 * @param {Uint8ClampedArray} rgba Destination RGBA.
 * @returns {void}
 */
function writeRgbaPixel(packed, colorType, index, rgba) {
  const dest = index * 4;
  if (colorType === 6) {
    rgba.set(packed.subarray(index * 4, index * 4 + 4), dest);
    return;
  }
  if (colorType === 2) {
    rgba[dest] = packed[index * 3];
    rgba[dest + 1] = packed[index * 3 + 1];
    rgba[dest + 2] = packed[index * 3 + 2];
    rgba[dest + 3] = 255;
    return;
  }
  if (colorType === 4) {
    rgba[dest] = packed[index * 2];
    rgba[dest + 1] = packed[index * 2];
    rgba[dest + 2] = packed[index * 2];
    rgba[dest + 3] = packed[index * 2 + 1];
    return;
  }
  rgba[dest] = packed[index];
  rgba[dest + 1] = packed[index];
  rgba[dest + 2] = packed[index];
  rgba[dest + 3] = 255;
}

/**
 * Reads one PNG file into 8-bit RGBA pixels.
 * @param {string} filePath PNG path.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Decoded image.
 */
function decodePngRgba(filePath) {
  const parsed = parsePng(fs.readFileSync(filePath));
  const packed = unfilterPng(parsed);
  const pixelCount = parsed.width * parsed.height;
  const data = new Uint8ClampedArray(pixelCount * 4);
  for (let index = 0; index < pixelCount; index += 1) {
    writeRgbaPixel(packed, parsed.colorType, index, data);
  }
  return { data, width: parsed.width, height: parsed.height };
}

/**
 * Parses an optional #RRGGBB or 0xRRGGBB color.
 * @param {string|undefined} value Color string.
 * @returns {{r:number,g:number,b:number}|null} RGB color, or null when omitted.
 */
function parseHexColor(value) {
  if (value == null || value === "") return null;
  const hex = String(value).trim().replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`Cutout key_color must be a 6-digit hex color: ${value}`);
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * Formats an RGB color as #rrggbb.
 * @param {{r:number,g:number,b:number}} color RGB color.
 * @returns {string} Hex color.
 */
function formatHexColor(color) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Parses one or many #RRGGBB protect-color values.
 * @param {unknown} value Hex string or array.
 * @returns {Array<{r:number,g:number,b:number}>} RGB colors.
 */
function parseProtectedColors(value) {
  const items = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return items.map((item) => parseHexColor(item)).filter(Boolean);
}

/**
 * True when a visible RGB sample looks like a studio plate (near-white, gray,
 * near-black, or chroma green) rather than a subject.
 * @param {number} red Red channel.
 * @param {number} green Green channel.
 * @param {number} blue Blue channel.
 * @returns {boolean} Whether the pixel is a keyable plate color.
 */
function isStudioPlatePixel(red, green, blue) {
  if (classifySmartBackground({ r: red, g: green, b: blue }) === "plate") return true;
  return green > red + 24 && green > blue + 24;
}

/**
 * True when the image border is already transparent, so a second cutout would chew the subject.
 *
 * A band several pixels deep is sampled rather than the 1px outer ring: a
 * still-plated frame with a 1px transparent pad would otherwise look 100%
 * clear on that ring and be skipped. Remaining studio-plate pixels in that
 * band mean the frame is still plated, unless the band is already majority
 * transparent (a body or pale slash on the edge). The outer ring is only a
 * fallback when no plate remains.
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @returns {boolean} Whether the frame looks already cut out.
 */
function alreadyCutOut(rgba, width, height) {
  if (width < 2 || height < 2) return false;
  const edgeDepth = Math.max(3, Math.min(12, Math.ceil(Math.min(width, height) * 0.04)));
  let ringPixels = 0;
  let clearPixels = 0;
  let platePixels = 0;
  let outerPixels = 0;
  let outerClear = 0;
  let interiorPixels = 0;
  let interiorClear = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onOuter = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const inBand = x < edgeDepth || x >= width - edgeDepth || y < edgeDepth || y >= height - edgeDepth;
      const offset = (y * width + x) * 4;
      if (onOuter) {
        outerPixels += 1;
        if (rgba[offset + 3] <= ALPHA_VISIBLE) outerClear += 1;
      }
      if (!inBand) {
        interiorPixels += 1;
        if (rgba[offset + 3] <= ALPHA_VISIBLE) interiorClear += 1;
        continue;
      }
      ringPixels += 1;
      if (rgba[offset + 3] <= ALPHA_VISIBLE) {
        clearPixels += 1;
        continue;
      }
      if (isStudioPlatePixel(rgba[offset], rgba[offset + 1], rgba[offset + 2])) platePixels += 1;
    }
  }
  if (ringPixels <= 0) return false;
  const interiorPunched = interiorPixels > 0 && interiorClear / interiorPixels >= CUT_BORDER_CLEAR_RATIO;
  if (platePixels / ringPixels >= CUT_BORDER_CLEAR_RATIO) {
    if (interiorPunched) return true;
    return false;
  }
  if (clearPixels / ringPixels >= CUT_BORDER_CLEAR_RATIO) return true;
  if (platePixels > 0 && !interiorPunched) return false;
  return outerPixels > 0 && outerClear / outerPixels >= CUT_BORDER_CLEAR_RATIO;
}

/**
 * Converts a workbench camelCase slider key to the MCP snake_case argument.
 * @param {string} name Workbench parameter key.
 * @returns {string} MCP argument name.
 */
function toSnake(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Reads a present argument that may arrive in camelCase or snake_case.
 * @param {object} source Argument bag.
 * @param {string} camel Workbench key.
 * @returns {unknown} Raw value, or undefined when omitted.
 */
function readAlias(source, camel) {
  const snake = toSnake(camel);
  if (Object.prototype.hasOwnProperty.call(source, camel) && source[camel] !== "") return source[camel];
  if (Object.prototype.hasOwnProperty.call(source, snake) && source[snake] !== "") return source[snake];
  return undefined;
}

/**
 * Parses an optional boolean the same way MCP handlers accept "true"/"1".
 * @param {unknown} value Raw argument.
 * @returns {boolean|undefined} Parsed flag, or undefined when omitted.
 */
function optionalBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "no") return false;
  }
  return undefined;
}

/**
 * Clamps one workbench slider to the tuner range.
 * @param {string} key Workbench parameter key.
 * @param {unknown} value Raw number.
 * @returns {number|undefined} Bounded value.
 */
function clampSlider(key, value) {
  const limits = NUMERIC_PARAMETER_LIMITS[key];
  const numeric = Number(value);
  if (!limits || !Number.isFinite(numeric)) return undefined;
  return Math.max(limits.minimum, Math.min(limits.maximum, numeric));
}

/**
 * Builds xsxb_cutout schema fields from the tuner slider table.
 * @returns {object} JSON schema properties.
 */
function workbenchSliderSchemaProperties() {
  const properties = {};
  for (const [key, limits] of Object.entries(NUMERIC_PARAMETER_LIMITS)) {
    properties[toSnake(key)] = {
      type: "number",
      minimum: limits.minimum,
      maximum: limits.maximum,
      description: `Same as the tuner ${key} slider. Omit to keep the shared smart-cutout profile.`,
    };
  }
  properties.connected = {
    type: "boolean",
    description:
      "Same as the tuner edge-only checkbox. Omit for the smart-cutout default (off; enclosed near-black plate pixels are keyed).",
  };
  properties.perceptual = {
    type: "boolean",
    description: "Same as the tuner OKLab / YCbCr checkbox.",
  };
  properties.blend_mode = {
    type: "string",
    enum: [...REFERENCE_MODES],
    default: REGULAR_AUTO_BACKGROUND_PARAMETERS.blendMode,
    description: "Same as the tuner blend-mode select.",
  };
  properties.despill_mode = {
    type: "string",
    enum: [...REFERENCE_MODES],
    default: REGULAR_AUTO_BACKGROUND_PARAMETERS.despillMode,
    description: "Same as the tuner despill-mode select.",
  };
  return properties;
}

/**
 * Collects workbench slider overrides from MCP or camelCase callers.
 * @param {object} [args] Tool arguments.
 * @returns {object} Cutout extras.
 */
function collectWorkbenchExtras(args = {}) {
  const extras = {};
  const keyColor = args.key_color || args.color || args.keyColor;
  if (keyColor) extras.keyColor = keyColor;
  const protectedColors = args.protected_colors ?? args.protectedColors;
  if (protectedColors != null && protectedColors !== "") extras.protectedColors = protectedColors;
  for (const key of Object.keys(NUMERIC_PARAMETER_LIMITS)) {
    const raw = readAlias(args, key);
    if (raw === undefined) continue;
    const clamped = clampSlider(key, raw);
    if (clamped !== undefined) extras[key] = clamped;
  }
  const connected = optionalBoolean(args.connected);
  if (connected !== undefined) extras.connected = connected;
  const perceptual = optionalBoolean(args.perceptual);
  if (perceptual !== undefined) extras.perceptual = perceptual;
  const blendMode = args.blend_mode ?? args.blendMode;
  if (REFERENCE_MODES.includes(String(blendMode || ""))) extras.blendMode = String(blendMode);
  const despillMode = args.despill_mode ?? args.despillMode;
  if (REFERENCE_MODES.includes(String(despillMode || ""))) extras.despillMode = String(despillMode);
  return extras;
}

/**
 * Builds tuner smart-cutout options, plus optional workbench slider overrides.
 * @param {{r:number,g:number,b:number}} backgroundColor Background sample.
 * @param {object} [extras] Optional protect colors and slider overrides.
 * @returns {object} Product cutout options.
 */
function buildCutoutOptions(backgroundColor, extras = {}) {
  const options = createSmartCutoutOptions(backgroundColor);
  const overrides = collectWorkbenchExtras(extras);
  for (const key of Object.keys(NUMERIC_PARAMETER_LIMITS)) {
    if (overrides[key] !== undefined) options[key] = overrides[key];
  }
  if (overrides.connected !== undefined) options.connected = overrides.connected;
  if (overrides.perceptual !== undefined) {
    options.perceptual = overrides.perceptual;
    options.referenceChromaKey = referenceChromaKeyFor(backgroundColor, overrides.perceptual);
  }
  if (overrides.blendMode) options.blendMode = overrides.blendMode;
  if (overrides.despillMode) options.despillMode = overrides.despillMode;
  const protectedColors = parseProtectedColors(overrides.protectedColors ?? extras.protectedColors);
  if (protectedColors.length && overrides.protectionTolerance !== 0) {
    options.protectedColors = protectedColors;
  }
  return options;
}

/**
 * Runs the product smart-cutout path on one frame.
 * @param {Uint8ClampedArray} rgba Source pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {{r:number,g:number,b:number}} backgroundColor Shared background.
 * @param {object} [extras] Optional protect colors and slider overrides.
 * @returns {Uint8ClampedArray} Cutout pixels.
 */
/**
 * Drops leftover chroma fog. The product keyer can leave the plate at alpha 13,
 * which still looks keyed-out and trips alreadyCutOut, but counts as opaque in
 * metrics and rematch unless it is actually zeroed.
 * @param {Uint8ClampedArray|Uint8Array} rgba Cutout pixels.
 * @returns {Uint8ClampedArray} Same buffer with invisible pixels hard-cleared.
 */
function flattenResidualAlpha(rgba) {
  const pixels = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] > ALPHA_VISIBLE) continue;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = 0;
  }
  return pixels;
}

function applyProtectedSmartCutout(rgba, width, height, backgroundColor, extras = {}) {
  return flattenResidualAlpha(
    applyProductCutout(rgba, width, height, buildCutoutOptions(backgroundColor, extras), []).data,
  );
}

/**
 * Collects 4-connected opaque regions.
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {number} threshold Visible alpha threshold.
 * @returns {Array<{minX:number,maxX:number,minY:number,maxY:number,count:number,width:number,height:number,centerX:number}>}
 */
function opaqueComponents(rgba, width, height, threshold) {
  const visited = new Uint8Array(width * height);
  const components = [];
  for (let start = 0; start < visited.length; start += 1) {
    if (visited[start] || rgba[start * 4 + 3] <= threshold) continue;
    const stack = [start];
    visited[start] = 1;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let count = 0;
    let sumX = 0;
    const rowCount = new Int32Array(height);
    const rowDark = new Int32Array(height);
    const rowMinX = new Int32Array(height);
    const rowMaxX = new Int32Array(height);
    const rowLuma = new Float64Array(height);
    const rowSumX = new Float64Array(height);
    rowMinX.fill(width);
    rowMaxX.fill(-1);
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = Math.floor(index / width);
      const offset = index * 4;
      const luma = 0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2];
      count += 1;
      sumX += x;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      rowCount[y] += 1;
      rowLuma[y] += luma;
      rowSumX[y] += x;
      rowMinX[y] = Math.min(rowMinX[y], x);
      rowMaxX[y] = Math.max(rowMaxX[y], x);
      if (luma < BODY_DARK_LUMA) rowDark[y] += 1;
      const neighbors = [];
      if (x > 0) neighbors.push(index - 1);
      if (x + 1 < width) neighbors.push(index + 1);
      if (y > 0) neighbors.push(index - width);
      if (y + 1 < height) neighbors.push(index + width);
      for (const neighbor of neighbors) {
        if (visited[neighbor] || rgba[neighbor * 4 + 3] <= threshold) continue;
        visited[neighbor] = 1;
        stack.push(neighbor);
      }
    }
    components.push({
      minX,
      maxX,
      minY,
      maxY,
      count,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      centerX: sumX / count,
      rowCount,
      rowDark,
      rowMinX,
      rowMaxX,
      rowLuma,
      rowSumX,
    });
  }
  return components;
}

/**
 * Prefers a standing character over a wide slash or leftover island.
 * @param {Array<object>} components Opaque regions.
 * @param {number} width Image width.
 * @returns {object|null} Chosen body region.
 */
function pickBodyComponent(components, width) {
  if (!components.length) return null;
  const largest = Math.max(...components.map((entry) => entry.count));
  const candidates = components.filter((entry) => entry.count >= largest * 0.25);
  return candidates.slice().sort((left, right) => {
    const leftTall = left.height - left.width;
    const rightTall = right.height - right.width;
    if (leftTall !== rightTall) return rightTall - leftTall;
    if (left.height !== right.height) return right.height - left.height;
    const leftCenter = Math.abs(left.centerX - (width - 1) / 2);
    const rightCenter = Math.abs(right.centerX - (width - 1) / 2);
    if (leftCenter !== rightCenter) return leftCenter - rightCenter;
    return right.count - left.count;
  })[0];
}

/**
 * Lowest body/boot row on one island, skipping connected bright slash/glow.
 * @param {object} component Connected opaque region with per-row luma stats.
 * @returns {number} Canvas y of the sole.
 */
function soleYFromRows(component) {
  let peakDark = 0;
  for (let y = component.minY; y <= component.maxY; y += 1) {
    peakDark = Math.max(peakDark, component.rowDark[y]);
  }
  const core = [];
  for (let y = component.minY; y <= component.maxY; y += 1) {
    if (peakDark > 0 && component.rowDark[y] >= peakDark * 0.5) {
      core.push(component.rowLuma[y] / component.rowCount[y]);
    }
  }
  core.sort((left, right) => left - right);
  const coreLuma = core.length ? core[Math.floor(core.length / 2)] : 0;
  const glowFloor = Math.max(coreLuma + GLOW_LUMA_DELTA, GLOW_LUMA_MIN);
  const midY = component.minY + Math.max(1, Math.floor(component.height * 0.5));
  const bodyWidths = [];
  for (let y = component.minY; y < midY; y += 1) {
    if (!component.rowCount[y]) continue;
    bodyWidths.push(component.rowMaxX[y] - component.rowMinX[y] + 1);
  }
  bodyWidths.sort((left, right) => left - right);
  const bodyWidth = bodyWidths.length ? bodyWidths[Math.floor(bodyWidths.length / 2)] : component.width;
  let fallback = component.maxY;
  let haveFallback = false;
  for (let y = component.maxY; y >= component.minY; y -= 1) {
    const count = component.rowCount[y];
    if (!count) continue;
    const mean = component.rowLuma[y] / count;
    const darkRatio = component.rowDark[y] / count;
    const rowWidth = component.rowMaxX[y] - component.rowMinX[y] + 1;
    const brightGlow = mean >= glowFloor && darkRatio < GLOW_DARK_RATIO;
    const wideVfx = bodyWidth > 0 && rowWidth >= Math.max(bodyWidth * 1.5, bodyWidth + 6) && darkRatio < 0.4;
    if (brightGlow || wideVfx) continue;
    if (!haveFallback) {
      fallback = y;
      haveFallback = true;
    }
    const belowMid = y > midY;
    const narrowDebris = belowMid && bodyWidth > 0 && rowWidth < bodyWidth * 0.55;
    const mixedIce = belowMid && darkRatio < 0.65 && mean >= coreLuma + 18;
    if (narrowDebris || mixedIce) continue;
    return y;
  }
  return fallback;
}

/**
 * Bounding box and centroid of the standing body, excluding glow below the sole.
 * @param {object} component Connected opaque region.
 * @returns {{minX:number,minY:number,maxX:number,feetY:number,width:number,height:number,centerX:number}}
 */
function bodyAnchorFromComponent(component) {
  const feetY = soleYFromRows(component);
  let minX = component.minX;
  let maxX = component.maxX;
  let sumX = 0;
  let count = 0;
  let started = false;
  for (let y = component.minY; y <= feetY; y += 1) {
    if (!component.rowCount[y]) continue;
    if (!started) {
      minX = component.rowMinX[y];
      maxX = component.rowMaxX[y];
      started = true;
    } else {
      minX = Math.min(minX, component.rowMinX[y]);
      maxX = Math.max(maxX, component.rowMaxX[y]);
    }
    sumX += component.rowSumX[y];
    count += component.rowCount[y];
  }
  if (!count) {
    return {
      minX: component.minX,
      minY: component.minY,
      maxX: component.maxX,
      feetY: component.maxY,
      width: component.width,
      height: component.height,
      centerX: component.centerX,
    };
  }
  return {
    minX,
    minY: component.minY,
    maxX,
    feetY,
    width: maxX - minX + 1,
    height: feetY - component.minY + 1,
    centerX: sumX / count,
  };
}

/**
 * Finds the standing subject. Disconnected islands and connected bright slash/glow
 * below the boots are ignored. Dark cloth hanging below the boots still counts.
 * @param {Uint8ClampedArray|Uint8Array} rgba RGBA pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {number} [threshold=16] Visible alpha threshold.
 * @returns {{minX:number,minY:number,maxX:number,feetY:number,width:number,height:number,centerX:number}|null}
 */
function subjectAnchor(rgba, width, height, threshold = ALPHA_VISIBLE) {
  const body = pickBodyComponent(opaqueComponents(rgba, width, height, threshold), width);
  if (!body) return null;
  return bodyAnchorFromComponent(body);
}

/**
 * Places every frame with one shared scale and the body feet on the canvas bottom.
 * @param {Array<{data:Uint8ClampedArray,width:number,height:number}>} frames Cutout frames.
 * @param {number} canvasWidth Destination width.
 * @param {number} canvasHeight Destination height.
 * @returns {Array<{data:Uint8ClampedArray,width:number,height:number}>} Rematched frames.
 */
function placeFramesOnCanvas(frames, canvasWidth, canvasHeight, options = {}) {
  const anchors = frames.map((frame) => subjectAnchor(frame.data, frame.width, frame.height));
  const usable = anchors.filter(Boolean);
  const maxWidth = Math.max(1, ...usable.map((anchor) => anchor.width));
  const maxHeight = Math.max(1, ...usable.map((anchor) => anchor.height));
  const fill = options.fit === "fill_canvas" || options.fillCanvas === true;
  const sharedScale = fill ? Math.min(canvasWidth / maxWidth, canvasHeight / maxHeight) : 1;
  const destFeetX = (canvasWidth - 1) / 2;
  const destFeetY = canvasHeight - 1;
  const frameScales = Array.isArray(options.frameScales) ? options.frameScales : null;
  return frames.map((frame, index) => {
    const dest = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
    const anchor = anchors[index];
    const requested = Number(frameScales?.[index]);
    const scale = Number.isFinite(requested) && requested > 0 ? requested : sharedScale;
    if (!anchor || scale <= 0) return { data: dest, width: canvasWidth, height: canvasHeight };
    for (let y = 0; y < canvasHeight; y += 1) {
      const sourceY = Math.round(anchor.feetY + (y - destFeetY) / scale);
      if (sourceY < 0 || sourceY >= frame.height) continue;
      for (let x = 0; x < canvasWidth; x += 1) {
        const sourceX = Math.round(anchor.centerX + (x - destFeetX) / scale);
        if (sourceX < 0 || sourceX >= frame.width) continue;
        const sourceOffset = (sourceY * frame.width + sourceX) * 4;
        if (frame.data[sourceOffset + 3] <= ALPHA_VISIBLE) continue;
        dest.set(frame.data.subarray(sourceOffset, sourceOffset + 4), (y * canvasWidth + x) * 4);
      }
    }
    return { data: dest, width: canvasWidth, height: canvasHeight };
  });
}

/**
 * Integer-translates one RGBA frame. Positive dy moves pixels down (toward canvas feet).
 * Pixels that leave the canvas are clipped; vacated area is transparent.
 * @param {Uint8ClampedArray|Uint8Array} rgba Source pixels.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {number} dx Horizontal shift in pixels.
 * @param {number} dy Vertical shift in pixels.
 * @returns {Uint8ClampedArray} Shifted copy.
 */
function shiftFrameRgba(rgba, width, height, dx, dy) {
  const dest = new Uint8ClampedArray(width * height * 4);
  const shiftX = Math.trunc(Number(dx) || 0);
  const shiftY = Math.trunc(Number(dy) || 0);
  if (shiftX === 0 && shiftY === 0) return new Uint8ClampedArray(rgba);
  for (let y = 0; y < height; y += 1) {
    const sourceY = y - shiftY;
    if (sourceY < 0 || sourceY >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      if (sourceX < 0 || sourceX >= width) continue;
      const sourceOffset = (sourceY * width + sourceX) * 4;
      dest.set(rgba.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4);
    }
  }
  return dest;
}

/**
 * Runs the tuner smart-cutout path on every PNG and optionally rematches a shared canvas.
 * @param {string[]} filePaths Frame files written in place.
 * @param {{keyColor?:string,outputWidth?:number,outputHeight?:number,protectedColors?:unknown,protectionTolerance?:number,force?:boolean,frameScales?:number[]}} [options] Cutout options.
 * @returns {{
 *   pipeline:string,
 *   rematched:boolean,
 *   keyed:boolean,
 *   backgroundColor:string|null,
 *   outputWidth:number,
 *   outputHeight:number,
 *   processedFrameCount:number,
 *   skippedFrameCount:number,
 *   options:object
 * }} Receipt.
 */
function cutoutFrameFiles(filePaths, options = {}) {
  const requested = Array.isArray(filePaths) ? filePaths : [];
  const missing = requested.find((filePath) => !fs.existsSync(filePath));
  if (missing) throw new Error(`Cutout refused missing on-disk frame: ${missing}`);
  const paths = requested;
  if (!paths.length) throw new Error("Cutout found no on-disk frames to process.");
  const { borderFloodKey } = require("./xsxb_mcp_lock");
  const keyMode = String(options.keyMode || options.key_mode || "smart");
  let frames = paths.map((filePath) => decodePngRgba(filePath));
  const darkClothesBefore = frames.reduce((sum, frame) => sum + countDarkClothes(frame.data), 0);
  const alreadyBefore = frames.map((frame) => alreadyCutOut(frame.data, frame.width, frame.height));
  let floodKeyedTotal = 0;
  if (keyMode === "border_flood") {
    frames = frames.map((frame, index) => {
      if (alreadyBefore[index] && !options.force) return frame;
      const flooded = borderFloodKey(frame.data, frame.width, frame.height, options);
      floodKeyedTotal += flooded.keyed;
      return { data: flooded.data, width: frame.width, height: frame.height };
    });
  }
  const requestedBackground = parseHexColor(options.keyColor);
  const uncut = frames.filter((frame) => !alreadyCutOut(frame.data, frame.width, frame.height));
  const shouldKey = uncut.length > 0 || (Boolean(options.force) && Boolean(requestedBackground));
  const sample = uncut[0] || frames[0];
  const backgroundColor = shouldKey
    ? requestedBackground || detectBackgroundColor(sample.data, sample.width, sample.height)
    : floodKeyedTotal > 0
      ? requestedBackground
      : null;
  const cutoutOptions = backgroundColor ? buildCutoutOptions(backgroundColor, options) : {};
  let skippedFrameCount = 0;
  const cutFrames = frames.map((frame, index) => {
    if (alreadyBefore[index] && !options.force) {
      skippedFrameCount += 1;
      return frame;
    }
    const already = alreadyCutOut(frame.data, frame.width, frame.height);
    if (!shouldKey || (!options.force && already)) {
      if (alreadyBefore[index] || floodKeyedTotal === 0) skippedFrameCount += 1;
      return frame;
    }
    const smartExtras =
      keyMode === "border_flood" && options.connected === undefined
        ? { ...options, connected: true }
        : options;
    return {
      data: applyProtectedSmartCutout(frame.data, frame.width, frame.height, backgroundColor, smartExtras),
      width: frame.width,
      height: frame.height,
    };
  });
  const canvasWidth = Number.isInteger(Number(options.outputWidth))
    ? Math.max(8, Number(options.outputWidth))
    : 0;
  const canvasHeight = Number.isInteger(Number(options.outputHeight))
    ? Math.max(8, Number(options.outputHeight))
    : canvasWidth;
  const frameScales = Array.isArray(options.frameScales) ? options.frameScales : [];
  const applyVisual = frameScales.some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  const fit = String(options.fit || (applyVisual ? "visual" : canvasWidth ? "fill_canvas" : "none"));
  const rematched = (canvasWidth > 0 && canvasHeight > 0) || applyVisual;
  const destWidth = canvasWidth || cutFrames[0].width;
  const destHeight = canvasHeight || cutFrames[0].height;
  const outputFrames = rematched
    ? placeFramesOnCanvas(cutFrames, destWidth, destHeight, {
        frameScales: applyVisual ? frameScales : undefined,
        fit: applyVisual ? "none" : fit,
        fillCanvas: fit === "fill_canvas" && !applyVisual,
      })
    : cutFrames;
  outputFrames.forEach((frame, index) => {
    fs.writeFileSync(paths[index], encodePngRgba(frame.data, frame.width, frame.height));
  });
  const processedFrameCount = outputFrames.length - skippedFrameCount;
  const darkClothesAfter = outputFrames.reduce((sum, frame) => sum + countDarkClothes(frame.data), 0);
  const keyed = floodKeyedTotal > 0 || (shouldKey && processedFrameCount > 0);
  return {
    pipeline: "smart_product",
    rematched,
    rematchMode: applyVisual ? "visual" : rematched ? fit : "none",
    fit: applyVisual ? "visual" : rematched ? fit : "none",
    frameScales: applyVisual ? frameScales : undefined,
    keyed,
    floodKeyed: floodKeyedTotal,
    darkClothes: { before: darkClothesBefore, after: darkClothesAfter },
    backgroundColor: backgroundColor ? formatHexColor(backgroundColor) : null,
    outputWidth: outputFrames[0].width,
    outputHeight: outputFrames[0].height,
    frameSizes: outputFrames.map((frame) => ({ width: frame.width, height: frame.height })),
    processedFrameCount,
    skippedFrameCount,
    options: cutoutOptions,
    verify: {
      status: cutoutVerifyStatus({
        rematched,
        keyed,
        processedFrameCount,
        skippedFrameCount,
        frameCount: outputFrames.length,
      }),
    },
  };
}

/**
 * Applies the product cutout to one PNG. Used when a caller still processes files one at a time.
 * @param {string} inputPath Source PNG.
 * @param {string} outputPath Destination PNG.
 * @param {{keyColor?:string,outputWidth?:number,outputHeight?:number}} [options] Cutout options.
 * @returns {object} Cutout receipt.
 */
function cutoutPngFile(inputPath, outputPath, options = {}) {
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    return cutoutFrameFiles([inputPath], options);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(inputPath, outputPath);
  return cutoutFrameFiles([outputPath], options);
}

module.exports = {
  ALPHA_VISIBLE,
  alreadyCutOut,
  collectWorkbenchExtras,
  compressPngFile,
  cutoutFrameFiles,
  cutoutPngFile,
  cutoutVerifyStatus,
  decodePngRgba,
  encodePngRgba,
  parseHexColor,
  parseProtectedColors,
  placeFramesOnCanvas,
  shiftFrameRgba,
  subjectAnchor,
  workbenchSliderSchemaProperties,
};
