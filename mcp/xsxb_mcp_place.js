"use strict";

/**
 * Speakable overlay addressing and generic PNG placement for XSXB MCP.
 * Cell ids are A1-style. Geometry stays in original-image pixels. No VLM.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ALPHA_VISIBLE, decodePngRgba, encodePngRgba } = require("./xsxb_mcp_cutout");
const {
  mcpArtifactDir,
  requireExistingFile,
  resolveMcpArtifactPath,
  booleanFlag,
} = require("./xsxb_mcp_arguments");
const { measureLongAxis } = require("./xsxb_mcp_visual_qa");
const {
  resolveRegionAnchor,
  resolveOcclusion,
  compositeOccludedObject,
  placementClipping,
} = require("./xsxb_mcp_place_occlusion");

const DEFAULT_GRID = 8;
const GRID_MIN = 2;
const GRID_MAX = 26;
const SUPPORT_BAND_RATIO = 0.1;
const LINE_DARK = Object.freeze([8, 8, 12, 230]);
const LINE_LIGHT = Object.freeze([245, 250, 255, 230]);
const LABEL_INK = Object.freeze([255, 214, 10, 255]);
const LABEL_PLATE = Object.freeze([8, 8, 12, 230]);
const DERIVE_MODES = Object.freeze([
  "center",
  "bottom_center",
  "top_center",
  "left_center",
  "right_center",
  "median_center",
]);
const ALPHA_MODES = Object.freeze(["alpha_center", "alpha_centroid", "alpha_bottom_center", "alpha_support"]);
const LAYER_MODES = Object.freeze(["front", "behind", "under_target"]);
const LABEL_MAX_SCALE = 2;

const DIGIT_GLYPHS = Object.freeze([
  ["111", "101", "101", "101", "111"],
  ["010", "110", "010", "010", "111"],
  ["111", "001", "111", "100", "111"],
  ["111", "001", "111", "001", "111"],
  ["101", "101", "111", "001", "001"],
  ["111", "100", "111", "001", "111"],
  ["111", "100", "111", "101", "111"],
  ["111", "001", "001", "001", "001"],
  ["111", "101", "111", "101", "111"],
  ["111", "101", "111", "001", "111"],
]);

const LETTER_GLYPHS = Object.freeze({
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "111", "100", "111"],
  F: ["111", "100", "111", "100", "100"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "111"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["111", "101", "101", "101", "111"],
  P: ["111", "101", "111", "100", "100"],
  Q: ["111", "101", "101", "111", "001"],
  R: ["111", "101", "111", "110", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"],
});

/**
 * Throws an error with a stable machine code.
 * @param {string} code Error code.
 * @param {string} message Human message.
 * @returns {never}
 */
function throwCode(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * Rejects unknown nested keys so typos are not silently dropped.
 * @param {object} value Nested object.
 * @param {readonly string[]} allowed Declared keys.
 * @param {string} label Path for the error.
 * @returns {void}
 */
function requireKnownKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const suggestion = allowed.find((name) => name.startsWith(key) || key.startsWith(name));
    throw new Error(
      `${label} unknown key "${key}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Accepted: ${allowed.join(", ")}.`,
    );
  }
}

/**
 * Looks up a 3×5 glyph that includes letters, unlike visual_qa.glyphFor.
 * @param {string} character One character.
 * @returns {readonly string[]|null} Glyph rows.
 */
function glyphForPlace(character) {
  if (character >= "0" && character <= "9") return DIGIT_GLYPHS[Number(character)];
  return LETTER_GLYPHS[character] || null;
}

/**
 * Parses one speakable cell id.
 * @param {unknown} raw Cell id.
 * @param {{rows?:number,cols?:number}} [view] Grid used for range checks.
 * @returns {{id:string,column:number,row:number}} Parsed id.
 */
function parseCellId(raw, view) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throwCode("GRID_INVALID_CELL", "Cell id is empty.");
  }
  const id = String(raw).trim().toUpperCase();
  const match = id.match(/^([A-Z])([0-9]+)$/u);
  if (!match) throwCode("GRID_INVALID_CELL", `Cell id is not a speakable token like A1. Received: ${raw}`);
  const column = match[1].charCodeAt(0) - 65;
  const row = Number(match[2]);
  if (!Number.isInteger(row) || row < 1 || column < 0) {
    throwCode("GRID_CELL_OUT_OF_RANGE", `Cell id ${id} is outside the grid.`);
  }
  if (view) {
    const rows = Number(view.rows);
    const cols = Number(view.cols);
    if (column >= cols || row > rows) {
      throwCode("GRID_CELL_OUT_OF_RANGE", `Cell id ${id} is outside the ${cols}×${rows} grid.`);
    }
  }
  return { id, column, row };
}

/**
 * Normalizes a view in original-image pixels.
 * @param {unknown} value Raw view.
 * @param {string} [label] Error label.
 * @returns {{x:number,y:number,width:number,height:number,rows:number,cols:number}} View.
 */
function requireView(value, label = "view") {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object.`);
  const view = {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    width: Number(value.width),
    height: Number(value.height),
    rows: Number(value.rows),
    cols: Number(value.cols),
  };
  if (!Number.isFinite(view.width) || view.width <= 0 || !Number.isFinite(view.height) || view.height <= 0) {
    throw new Error(`${label} width and height must be positive.`);
  }
  if (!Number.isInteger(view.rows) || view.rows < GRID_MIN || view.rows > GRID_MAX) {
    throw new Error(`${label} rows must be an integer from ${GRID_MIN} to ${GRID_MAX}.`);
  }
  if (!Number.isInteger(view.cols) || view.cols < GRID_MIN || view.cols > GRID_MAX) {
    throw new Error(`${label} cols must be an integer from ${GRID_MIN} to ${GRID_MAX}.`);
  }
  return view;
}

/**
 * Canonical JSON for an overlay view stamp. Key order is fixed.
 * @param {object} view Normalized view.
 * @returns {string} Canonical JSON.
 */
function canonicalOverlayView(view) {
  const grid = requireView(view);
  return JSON.stringify({
    x: grid.x,
    y: grid.y,
    width: grid.width,
    height: grid.height,
    rows: grid.rows,
    cols: grid.cols,
  });
}

/**
 * Content hash for one PNG + view. Not a session registry.
 * @param {Buffer|Uint8Array} pngBytes Source PNG file bytes.
 * @param {object} view Overlay view.
 * @returns {string} overlay_id.
 */
function overlayIdFor(pngBytes, view) {
  const digest = crypto.createHash("sha1").update(pngBytes).update(canonicalOverlayView(view)).digest("hex");
  return `ovl_${digest.slice(0, 12)}`;
}

/**
 * Hard-fails when a provided overlay_id does not match the current file+view.
 * @param {string} filePath PNG path.
 * @param {object} view Overlay view.
 * @param {unknown} overlayId Caller stamp.
 * @param {string} label Error label.
 * @returns {void}
 */
function assertOverlayId(filePath, view, overlayId, label) {
  if (overlayId === undefined || overlayId === null || String(overlayId).trim() === "") return;
  const expected = overlayIdFor(fs.readFileSync(filePath), view);
  const received = String(overlayId).trim();
  if (received !== expected) {
    throwCode(
      "STALE_OVERLAY",
      `${label} overlay_id is stale for the current PNG and view. Received ${received}.`,
    );
  }
}

/**
 * Pixel box of one cell in original-image space. Far edge is exclusive.
 * @param {object} view Parent view.
 * @param {unknown} cellId Speakable id.
 * @returns {{id:string,column:number,row:number,x1:number,y1:number,x2:number,y2:number}} Box.
 */
function cellBox(view, cellId) {
  const grid = requireView(view);
  const parsed = parseCellId(cellId, grid);
  const x1 = grid.x + (parsed.column * grid.width) / grid.cols;
  const x2 = grid.x + ((parsed.column + 1) * grid.width) / grid.cols;
  const y1 = grid.y + ((parsed.row - 1) * grid.height) / grid.rows;
  const y2 = grid.y + (parsed.row * grid.height) / grid.rows;
  return { id: parsed.id, column: parsed.column, row: parsed.row, x1, y1, x2, y2 };
}

/**
 * Union of named cells.
 * @param {object} view Parent view.
 * @param {unknown} cellIds Speakable ids.
 * @returns {{x1:number,y1:number,x2:number,y2:number}} Union box.
 */
function unionCells(view, cellIds) {
  if (!Array.isArray(cellIds) || cellIds.length === 0) {
    throwCode("GRID_INVALID_CELL", "cells must be a non-empty array of ids such as A1.");
  }
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const cellId of cellIds) {
    const box = cellBox(view, cellId);
    if (box.x1 < x1) x1 = box.x1;
    if (box.y1 < y1) y1 = box.y1;
    if (box.x2 > x2) x2 = box.x2;
    if (box.y2 > y2) y2 = box.y2;
  }
  return { x1, y1, x2, y2 };
}

/**
 * Integer crop from a possibly fractional box. Origin is floor; far edge is ceil.
 * @param {{x1:number,y1:number,x2:number,y2:number}} box Float box.
 * @returns {{x:number,y:number,width:number,height:number}} Integer crop.
 */
function integerCrop(box) {
  const x = Math.floor(box.x1);
  const y = Math.floor(box.y1);
  const x2 = Math.ceil(box.x2);
  const y2 = Math.ceil(box.y2);
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

/**
 * Derives a point from a pixel box.
 * @param {{x1:number,y1:number,x2:number,y2:number}} box Box.
 * @param {string} derive Derive mode.
 * @returns {{x:number,y:number}} Point.
 */
function derivePoint(box, derive) {
  const mode = derive || "center";
  if (!DERIVE_MODES.includes(mode)) {
    throw new Error(`derive must be one of: ${DERIVE_MODES.join(", ")}. Received: ${derive}`);
  }
  const midX = (box.x1 + box.x2) / 2;
  const midY = (box.y1 + box.y2) / 2;
  if (mode === "bottom_center") return { x: midX, y: box.y2 };
  if (mode === "top_center") return { x: midX, y: box.y1 };
  if (mode === "left_center") return { x: box.x1, y: midY };
  if (mode === "right_center") return { x: box.x2, y: midY };
  return { x: midX, y: midY };
}

/**
 * Median of a numeric list.
 * @param {number[]} values Numbers.
 * @returns {number} Median.
 */
function medianValue(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Point from view + cells + derive.
 * @param {object} spec Region spec.
 * @returns {{x:number,y:number}} Point.
 */
function deriveFromCells(spec) {
  const view = requireView(spec.view);
  const ids = spec.cells;
  const derive = spec.derive || "center";
  if (derive === "median_center" && Array.isArray(ids) && ids.length > 1) {
    const xs = [];
    const ys = [];
    for (const id of ids) {
      const box = cellBox(view, id);
      xs.push((box.x1 + box.x2) / 2);
      ys.push((box.y1 + box.y2) / 2);
    }
    return { x: medianValue(xs), y: medianValue(ys) };
  }
  return derivePoint(unionCells(view, ids), derive);
}

/**
 * Opaque bounding box.
 * @param {Uint8ClampedArray} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} Box.
 */
function opaqueBBox(rgba, width, height) {
  return opaqueBBoxClipped(rgba, width, height, null);
}

/**
 * Opaque bounding box, optionally clipped to a half-open region in image pixels.
 * @param {Uint8ClampedArray} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} [clip] Optional clip.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} Box.
 */
function opaqueBBoxClipped(rgba, width, height, clip = null) {
  const xStart = clip ? Math.max(0, Math.floor(clip.x1)) : 0;
  const yStart = clip ? Math.max(0, Math.floor(clip.y1)) : 0;
  const xEnd = clip ? Math.min(width, Math.ceil(clip.x2)) : width;
  const yEnd = clip ? Math.min(height, Math.ceil(clip.y2)) : height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= ALPHA_VISIBLE) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) {
    const error = new Error(
      clip
        ? "Snap region has no opaque pixels. Pick cells that cover the subject, or omit snap."
        : "Image has no opaque pixels to anchor.",
    );
    error.code = clip ? "SNAP_EMPTY_REGION" : "ALPHA_EMPTY";
    throw error;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Alpha-derived anchor. Foot y is maxY+1 so it plants on the exclusive bottom.
 * @param {Uint8ClampedArray} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {string} mode Alpha mode.
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} [clip] Optional cell-union clip.
 * @returns {{x:number,y:number,bbox:object}} Anchor.
 */
function alphaAnchor(rgba, width, height, mode, clip = null) {
  if (!ALPHA_MODES.includes(mode)) {
    throw new Error(`snap/object_anchor mode must be one of: ${ALPHA_MODES.join(", ")}. Received: ${mode}`);
  }
  const bbox = opaqueBBoxClipped(rgba, width, height, clip);
  const centerX = (bbox.minX + bbox.maxX + 1) / 2;
  const centerY = (bbox.minY + bbox.maxY + 1) / 2;
  if (mode === "alpha_center") return { x: centerX, y: centerY, bbox };
  if (mode === "alpha_centroid") {
    const xStart = clip ? Math.max(0, Math.floor(clip.x1)) : bbox.minX;
    const yStart = clip ? Math.max(0, Math.floor(clip.y1)) : bbox.minY;
    const xEnd = clip ? Math.min(width, Math.ceil(clip.x2)) : bbox.maxX + 1;
    const yEnd = clip ? Math.min(height, Math.ceil(clip.y2)) : bbox.maxY + 1;
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        if (rgba[(y * width + x) * 4 + 3] <= ALPHA_VISIBLE) continue;
        n += 1;
        sx += x;
        sy += y;
      }
    }
    if (!n) {
      const error = new Error("Snap region has no opaque pixels for alpha_centroid.");
      error.code = "SNAP_EMPTY_REGION";
      throw error;
    }
    return { x: sx / n, y: sy / n, bbox, samples: n };
  }
  if (mode === "alpha_bottom_center") return { x: centerX, y: bbox.maxY + 1, bbox };
  const bboxHeight = bbox.maxY - bbox.minY + 1;
  const band = Math.max(1, Math.round(bboxHeight * SUPPORT_BAND_RATIO));
  const bandTop = bbox.maxY - band + 1;
  let supportMinX = Infinity;
  let supportMaxX = -Infinity;
  for (let y = bandTop; y <= bbox.maxY; y += 1) {
    for (let x = bbox.minX; x <= bbox.maxX; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= ALPHA_VISIBLE) continue;
      if (x < supportMinX) supportMinX = x;
      if (x > supportMaxX) supportMaxX = x;
    }
  }
  if (!Number.isFinite(supportMinX)) {
    supportMinX = bbox.minX;
    supportMaxX = bbox.maxX;
  }
  return {
    x: (supportMinX + supportMaxX + 1) / 2,
    y: bbox.maxY + 1,
    bbox,
    support: { minX: supportMinX, maxX: supportMaxX, band },
  };
}

/**
 * Placement origin so objectAnchor*scale lands on target.
 * @param {{x:number,y:number}} target Target point.
 * @param {{x:number,y:number}} objectAnchor Object-local point.
 * @param {number} scale Uniform scale.
 * @returns {{left:number,top:number}} Destination origin.
 */
function placementOrigin(target, objectAnchor, scale) {
  return {
    left: target.x - objectAnchor.x * scale,
    top: target.y - objectAnchor.y * scale,
  };
}

/**
 * Writes one pixel when it sits inside the bitmap.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Width.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {readonly number[]} color RGBA.
 * @returns {void}
 */
function writePixel(rgba, width, x, y, color) {
  const height = rgba.length / (width * 4);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  const srcA = color[3] / 255;
  if (srcA >= 1) {
    rgba.set(color, offset);
    return;
  }
  if (srcA <= 0) return;
  const dstA = rgba[offset + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  rgba[offset] = Math.round((color[0] * srcA + rgba[offset] * dstA * (1 - srcA)) / outA);
  rgba[offset + 1] = Math.round((color[1] * srcA + rgba[offset + 1] * dstA * (1 - srcA)) / outA);
  rgba[offset + 2] = Math.round((color[2] * srcA + rgba[offset + 2] * dstA * (1 - srcA)) / outA);
  rgba[offset + 3] = Math.round(outA * 255);
}

/**
 * Dual-contrast grid line.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {number} x0 First x, or -1 when unused.
 * @param {number} y0 First y, or -1 when unused.
 * @returns {void}
 */
function paintContrastLine(rgba, width, height, x0, y0) {
  if (x0 >= 0) {
    const x = Math.round(x0);
    for (let y = 0; y < height; y += 1) {
      writePixel(rgba, width, x, y, LINE_DARK);
      writePixel(rgba, width, x + 1, y, LINE_LIGHT);
    }
  }
  if (y0 >= 0) {
    const y = Math.round(y0);
    for (let x = 0; x < width; x += 1) {
      writePixel(rgba, width, x, y, LINE_DARK);
      writePixel(rgba, width, x, y + 1, LINE_LIGHT);
    }
  }
}

/**
 * Paints one 3×5 glyph.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Width.
 * @param {readonly string[]} glyph Rows.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} scale Pixel scale.
 * @param {readonly number[]} color Ink.
 * @returns {void}
 */
function paintGlyph(rgba, width, glyph, x, y, scale, color) {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] !== "1") continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          writePixel(rgba, width, x + column * scale + dx, y + row * scale + dy, color);
        }
      }
    }
  }
}

/**
 * Pixel size of a speakable id at one glyph scale.
 * @param {string} text Label.
 * @param {number} scale Glyph scale.
 * @param {number} gap Space between characters.
 * @returns {{width:number,height:number}} Size.
 */
function labelTextSize(text, scale, gap) {
  const count = String(text).length;
  return {
    width: count * 3 * scale + Math.max(0, count - 1) * gap,
    height: 5 * scale,
  };
}

/**
 * Largest 3×5 layout that fits in a cell. Null when even scale 1 is too wide.
 * @param {string} text Label.
 * @param {number} cellW Cell width.
 * @param {number} cellH Cell height.
 * @returns {{scale:number,gap:number,pad:number,width:number,height:number}|null} Layout.
 */
function chooseLabelLayout(text, cellW, cellH) {
  const maxScale = Math.max(1, Math.min(LABEL_MAX_SCALE, Math.floor(Math.min(cellW, cellH) / 5)));
  for (let scale = maxScale; scale >= 1; scale -= 1) {
    for (const gap of [scale, 1, 0]) {
      for (const pad of [1, 0]) {
        const size = labelTextSize(text, scale, gap);
        if (size.width + pad * 2 <= cellW && size.height + pad * 2 <= cellH) {
          return { scale, gap, pad, width: size.width, height: size.height };
        }
      }
    }
  }
  return null;
}

/**
 * Paints a speakable id inside one cell when the glyphs fit.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Width.
 * @param {string} text Label.
 * @param {number} cellX Local left.
 * @param {number} cellY Local top.
 * @param {number} cellW Cell width.
 * @param {number} cellH Cell height.
 * @returns {void}
 */
function paintCellId(rgba, width, text, cellX, cellY, cellW, cellH) {
  const characters = String(text);
  const layout = chooseLabelLayout(characters, cellW, cellH);
  if (!layout) return;
  const originX = Math.round(cellX);
  const originY = Math.round(cellY);
  if (layout.pad > 0) {
    for (let py = originY; py < originY + layout.height + layout.pad * 2; py += 1) {
      for (let px = originX; px < originX + layout.width + layout.pad * 2; px += 1) {
        writePixel(rgba, width, px, py, LABEL_PLATE);
      }
    }
  }
  let cursor = originX + layout.pad;
  const glyphY = originY + layout.pad;
  for (const character of characters) {
    const glyph = glyphForPlace(character);
    if (glyph) paintGlyph(rgba, width, glyph, cursor, glyphY, layout.scale, LABEL_INK);
    cursor += 3 * layout.scale + layout.gap;
  }
}

/**
 * Last cell id on a grid, used to test whether in-cell labels fit.
 * @param {number} rows Rows.
 * @param {number} cols Columns.
 * @returns {string} Id such as H8.
 */
function farthestCellId(rows, cols) {
  return `${String.fromCharCode(64 + cols)}${rows}`;
}

/**
 * Adds a letter/number gutter when cells are too small for in-cell ids.
 * @param {Uint8ClampedArray} src Image with grid lines.
 * @param {number} srcW Source width.
 * @param {number} srcH Source height.
 * @param {number} rows Rows.
 * @param {number} cols Columns.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Framed overlay.
 */
function paintSpeakableGutters(src, srcW, srcH, rows, cols) {
  const left = rows >= 10 ? 9 : 5;
  const top = 6;
  const lastLetterX = Math.round(left + ((cols - 0.5) * srcW) / cols - 1.5);
  const lastDigitY = Math.round(top + ((rows - 0.5) * srcH) / rows - 2.5);
  const width = Math.max(srcW + left, lastLetterX + 4);
  const height = Math.max(srcH + top, lastDigitY + 6);
  const data = new Uint8ClampedArray(width * height * 4);
  const fill = [12, 12, 18, 255];
  for (let offset = 0; offset < data.length; offset += 4) data.set(fill, offset);
  for (let y = 0; y < srcH; y += 1) {
    data.set(src.subarray(y * srcW * 4, (y * srcW + srcW) * 4), ((y + top) * width + left) * 4);
  }
  for (let col = 0; col < cols; col += 1) {
    const letter = String.fromCharCode(65 + col);
    const glyph = glyphForPlace(letter);
    const x = Math.round(left + ((col + 0.5) * srcW) / cols - 1.5);
    if (glyph) paintGlyph(data, width, glyph, x, 0, 1, LABEL_INK);
  }
  for (let row = 1; row <= rows; row += 1) {
    const digits = String(row);
    const y = Math.round(top + ((row - 0.5) * srcH) / rows - 2.5);
    let x = rows >= 10 ? 0 : 1;
    for (const character of digits) {
      const glyph = glyphForPlace(character);
      if (glyph) paintGlyph(data, width, glyph, x, y, 1, LABEL_INK);
      x += 4;
    }
  }
  return { data, width, height };
}

/**
 * Paints grid lines and ids, adding gutters when in-cell glyphs cannot fit.
 * @param {Uint8ClampedArray} rgba Destination copy of the view.
 * @param {number} width Local width.
 * @param {number} height Local height.
 * @param {number} rows Rows.
 * @param {number} cols Columns.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Overlay bitmap.
 */
function paintLabeledOverlay(rgba, width, height, rows, cols) {
  paintOverlay(rgba, width, height, rows, cols);
  if (chooseLabelLayout(farthestCellId(rows, cols), width / cols, height / rows)) {
    return { data: rgba, width, height };
  }
  return paintSpeakableGutters(rgba, width, height, rows, cols);
}

/**
 * Paints dual-contrast lines and A1-style ids. No pixel x,y and no 0–1000 axis.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Local width.
 * @param {number} height Local height.
 * @param {number} rows Rows.
 * @param {number} cols Columns.
 * @returns {void}
 */
function paintOverlay(rgba, width, height, rows, cols) {
  for (let col = 0; col <= cols; col += 1) {
    paintContrastLine(rgba, width, height, (col * width) / cols, -1);
  }
  for (let row = 0; row <= rows; row += 1) {
    paintContrastLine(rgba, width, height, -1, (row * height) / rows);
  }
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const id = `${String.fromCharCode(65 + col)}${row}`;
      const x = (col * width) / cols;
      const y = ((row - 1) * height) / rows;
      paintCellId(rgba, width, id, x, y, width / cols, height / rows);
    }
  }
}

/**
 * Copies a half-open integer crop.
 * @param {Uint8ClampedArray} src Source.
 * @param {number} srcW Source width.
 * @param {number} srcH Source height.
 * @param {{x:number,y:number,width:number,height:number}} crop Integer crop.
 * @returns {Uint8ClampedArray} Cropped pixels.
 */
function extractCrop(src, srcW, srcH, crop) {
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y += 1) {
    const sy = crop.y + y;
    if (sy < 0 || sy >= srcH) continue;
    for (let x = 0; x < crop.width; x += 1) {
      const sx = crop.x + x;
      if (sx < 0 || sx >= srcW) continue;
      data.set(src.subarray((sy * srcW + sx) * 4, (sy * srcW + sx) * 4 + 4), (y * crop.width + x) * 4);
    }
  }
  return data;
}

/**
 * Straight-alpha src-over into one destination pixel.
 * @param {Uint8ClampedArray} dest Destination.
 * @param {number} dstOff Destination offset.
 * @param {Uint8ClampedArray} src Source.
 * @param {number} srcOff Source offset.
 * @returns {void}
 */
function blendOver(dest, dstOff, src, srcOff) {
  const srcA = src[srcOff + 3] / 255;
  if (srcA <= 0) return;
  if (srcA >= 1) {
    dest.set(src.subarray(srcOff, srcOff + 4), dstOff);
    return;
  }
  const dstA = dest[dstOff + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  dest[dstOff] = Math.round((src[srcOff] * srcA + dest[dstOff] * dstA * (1 - srcA)) / outA);
  dest[dstOff + 1] = Math.round((src[srcOff + 1] * srcA + dest[dstOff + 1] * dstA * (1 - srcA)) / outA);
  dest[dstOff + 2] = Math.round((src[srcOff + 2] * srcA + dest[dstOff + 2] * dstA * (1 - srcA)) / outA);
  dest[dstOff + 3] = Math.round(outA * 255);
}

/**
 * Uniform nearest-neighbor blit with straight alpha over.
 * @param {Uint8ClampedArray} dest Destination.
 * @param {number} destW Destination width.
 * @param {number} destH Destination height.
 * @param {Uint8ClampedArray} src Source.
 * @param {number} srcW Source width.
 * @param {number} srcH Source height.
 * @param {number} left Dest left of source origin.
 * @param {number} top Dest top of source origin.
 * @param {number} scale Uniform scale.
 * @returns {void}
 */
function blitScaled(dest, destW, destH, src, srcW, srcH, left, top, scale) {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("scale must be a positive finite number.");
  for (let sy = 0; sy < srcH; sy += 1) {
    for (let sx = 0; sx < srcW; sx += 1) {
      const srcOff = (sy * srcW + sx) * 4;
      if (src[srcOff + 3] <= 0) continue;
      const x0 = Math.max(0, Math.floor(left + sx * scale));
      const x1 = Math.min(destW, Math.ceil(left + (sx + 1) * scale));
      const y0 = Math.max(0, Math.floor(top + sy * scale));
      const y1 = Math.min(destH, Math.ceil(top + (sy + 1) * scale));
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          blendOver(dest, (y * destW + x) * 4, src, srcOff);
        }
      }
    }
  }
}

/**
 * Nearest-neighbor blit rotated clockwise around mapped, with screen y-down.
 * @param {Uint8ClampedArray} dest Destination.
 * @param {number} destW Destination width.
 * @param {number} destH Destination height.
 * @param {Uint8ClampedArray} src Source.
 * @param {number} srcW Source width.
 * @param {number} srcH Source height.
 * @param {number} left Unrotated dest left of source origin.
 * @param {number} top Unrotated dest top of source origin.
 * @param {number} scale Uniform scale.
 * @param {{x:number,y:number}} mapped Rotation pivot (object anchor on the target).
 * @param {number} degrees Clockwise degrees.
 * @returns {void}
 */
function blitRotated(dest, destW, destH, src, srcW, srcH, left, top, scale, mapped, degrees) {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("scale must be a positive finite number.");
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [left, top],
    [left + srcW * scale, top],
    [left, top + srcH * scale],
    [left + srcW * scale, top + srcH * scale],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    const vx = x - mapped.x;
    const vy = y - mapped.y;
    const dx = mapped.x + vx * cos - vy * sin;
    const dy = mapped.y + vx * sin + vy * cos;
    if (dx < minX) minX = dx;
    if (dy < minY) minY = dy;
    if (dx > maxX) maxX = dx;
    if (dy > maxY) maxY = dy;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(destW, Math.ceil(maxX));
  const y1 = Math.min(destH, Math.ceil(maxY));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const vx = x + 0.5 - mapped.x;
      const vy = y + 0.5 - mapped.y;
      const ux = vx * cos + vy * sin;
      const uy = -vx * sin + vy * cos;
      const sx = Math.floor((mapped.x + ux - left) / scale);
      const sy = Math.floor((mapped.y + uy - top) / scale);
      if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) continue;
      blendOver(dest, (y * destW + x) * 4, src, (sy * srcW + sx) * 4);
    }
  }
}

/**
 * Cell union that under_target restores, in original-image pixels.
 * @param {object} anchor Target anchor.
 * @returns {{x1:number,y1:number,x2:number,y2:number}} Cover box.
 */
function targetCoverBox(anchor) {
  if (anchor.x_from || anchor.y_from) {
    const xBox = unionCells(
      requireView(anchor.x_from.view, "target_anchor.x_from.view"),
      anchor.x_from.cells,
    );
    const yBox = unionCells(
      requireView(anchor.y_from.view, "target_anchor.y_from.view"),
      anchor.y_from.cells,
    );
    return { x1: xBox.x1, y1: yBox.y1, x2: xBox.x2, y2: yBox.y2 };
  }
  return unionCells(requireView(anchor.view, "target_anchor.view"), anchor.cells);
}

/**
 * Puts original opaque target pixels back on top inside an optional box.
 * @param {Uint8ClampedArray} dest Composite.
 * @param {Uint8ClampedArray} original Target before blit.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} box Cover box, or whole image.
 * @returns {void}
 */
function restoreOpaqueTarget(dest, original, width, height, box) {
  const x1 = box ? Math.max(0, Math.floor(box.x1)) : 0;
  const y1 = box ? Math.max(0, Math.floor(box.y1)) : 0;
  const x2 = box ? Math.min(width, Math.ceil(box.x2)) : width;
  const y2 = box ? Math.min(height, Math.ceil(box.y2)) : height;
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const off = (y * width + x) * 4;
      if (original[off + 3] > ALPHA_VISIBLE) dest.set(original.subarray(off, off + 4), off);
    }
  }
}

/**
 * Parses grid_divs like "8x8".
 * @param {unknown} value Raw value.
 * @returns {{rows:number,cols:number}} Size.
 */
function parseGridDivs(value) {
  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^(\d+)\s*[x×*]\s*(\d+)$/u);
  if (!match) throw new Error(`grid_divs must look like "8x8". Received: ${value}`);
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < GRID_MIN || rows < GRID_MIN) {
    throw new Error(`grid_divs axes must be integers from ${GRID_MIN} to ${GRID_MAX}.`);
  }
  if (cols > GRID_MAX || rows > GRID_MAX) {
    throw new Error(`grid_divs axes must be integers from ${GRID_MIN} to ${GRID_MAX}.`);
  }
  return { rows, cols };
}

/**
 * Resolves overlay rows and cols.
 * @param {object} args Tool arguments.
 * @returns {{rows:number,cols:number}} Grid size.
 */
function resolveGridSize(args = {}) {
  let rows = DEFAULT_GRID;
  let cols = DEFAULT_GRID;
  if (args.grid_divs !== undefined && args.grid_divs !== null && args.grid_divs !== "") {
    const parsed = parseGridDivs(args.grid_divs);
    rows = parsed.rows;
    cols = parsed.cols;
  }
  if (args.rows !== undefined && args.rows !== null && args.rows !== "") rows = Number(args.rows);
  if (args.cols !== undefined && args.cols !== null && args.cols !== "") cols = Number(args.cols);
  if (!Number.isInteger(rows) || rows < GRID_MIN || rows > GRID_MAX) {
    throw new Error(`rows must be an integer from ${GRID_MIN} to ${GRID_MAX}.`);
  }
  if (!Number.isInteger(cols) || cols < GRID_MIN || cols > GRID_MAX) {
    throw new Error(`cols must be an integer from ${GRID_MIN} to ${GRID_MAX}.`);
  }
  return { rows, cols };
}

/**
 * Resolves a PNG destination inside the service root.
 * @param {object} args Tool arguments.
 * @param {object} options Root and defaults.
 * @returns {string} Absolute output path.
 */
function resolveOutputPath(args, options) {
  const root = options.root;
  const parsed = path.parse(options.inputPath);
  return resolveMcpArtifactPath(args.output_path, {
    root,
    artifactDir: options.artifactDir || mcpArtifactDir("", root),
    defaultName: `${parsed.name}${options.suffix}.png`,
    extensionPattern: /\.png$/i,
    extensionLabel: ".png",
  });
}

/**
 * Builds the cells lookup for one view. Pixel boxes stay internal via cellBox.
 * @param {object} view View.
 * @returns {object} Id → {id}.
 */
function cellsLookup(view) {
  const cells = {};
  for (let row = 1; row <= view.rows; row += 1) {
    for (let col = 0; col < view.cols; col += 1) {
      const id = `${String.fromCharCode(65 + col)}${row}`;
      cells[id] = { id };
    }
  }
  return cells;
}

/**
 * Whether this overlay is the full PNG with coarse cells.
 * @param {object} view View.
 * @param {{width:number,height:number}} image Decoded image.
 * @param {object|null} crop Integer crop, if any.
 * @returns {{next?:string,reason?:string}} Optional next hint.
 */
function overlayNextHint(view, image, crop) {
  if (crop) return {};
  const full = view.x === 0 && view.y === 0 && view.width === image.width && view.height === image.height;
  const cellWidth = view.width / view.cols;
  const shortSide = Math.min(image.width, image.height);
  if (!full || shortSide <= 512 || !(cellWidth > 40)) return {};
  return {
    next: "crop_from",
    reason: "cell is coarse; crop_from the contact cells for a finer overlay",
  };
}

/**
 * Paints a speakable overlay. Source PNG is not written.
 * @param {object} args Tool arguments.
 * @param {{root:string}} options Service root.
 * @returns {object} Overlay receipt.
 */
function overlayGridImage(args = {}, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const absolute = requireExistingFile(args.file_path, "Overlay image");
  if (!/\.png$/i.test(absolute)) throw new Error("file_path must be a PNG.");
  const pngBytes = fs.readFileSync(absolute);
  const image = decodePngRgba(absolute);
  const { rows, cols } = resolveGridSize(args);
  let view = { x: 0, y: 0, width: image.width, height: image.height, rows, cols };
  let crop = null;
  let local = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  if (args.crop_from) {
    requireKnownKeys(args.crop_from, ["parent_view", "cells", "padding_cells", "overlay_id"], "crop_from");
    const parentView = requireView(args.crop_from.parent_view, "crop_from.parent_view");
    assertOverlayId(absolute, parentView, args.crop_from.overlay_id, "crop_from");
    const union = unionCells(parentView, args.crop_from.cells);
    const padding = Number(args.crop_from.padding_cells || 0);
    const padded = {
      x1: union.x1 - padding * (parentView.width / parentView.cols),
      y1: union.y1 - padding * (parentView.height / parentView.rows),
      x2: union.x2 + padding * (parentView.width / parentView.cols),
      y2: union.y2 + padding * (parentView.height / parentView.rows),
    };
    crop = integerCrop(padded);
    if (crop.width <= 0 || crop.height <= 0) throw new Error("crop_from produced an empty rectangle.");
    local = {
      data: extractCrop(image.data, image.width, image.height, crop),
      width: crop.width,
      height: crop.height,
    };
    view = { x: crop.x, y: crop.y, width: crop.width, height: crop.height, rows, cols };
  }
  const overlay = paintLabeledOverlay(local.data, local.width, local.height, view.rows, view.cols);
  const overlayPath = resolveOutputPath(args, {
    root,
    artifactDir: options.artifactDir,
    inputPath: absolute,
    suffix: crop ? "_grid_crop" : "_grid",
  });
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, encodePngRgba(overlay.data, overlay.width, overlay.height));
  const hint = overlayNextHint(view, image, crop);
  return {
    overlay_id: overlayIdFor(pngBytes, view),
    view,
    cell_width_px: view.width / view.cols,
    cell_height_px: view.height / view.rows,
    overlay_path: overlayPath,
    cells: cellsLookup(view),
    crop: crop || undefined,
    ...hint,
  };
}

/**
 * Resolves the target placement point. Agent speaks cells; MCP emits pixels.
 * @param {object} anchor Target anchor.
 * @param {{data:Uint8ClampedArray,width:number,height:number}|null} [image] Target image (required for snap).
 * @returns {{x:number,y:number,resolved:object}} Point plus provenance.
 */
function resolveTargetAnchor(anchor, image = null, context = {}) {
  if (!anchor || typeof anchor !== "object") throw new Error("target_anchor is required.");
  const regionPoint = resolveRegionAnchor(anchor, context.sourcePath, context.root, "target_anchor");
  if (regionPoint) return regionPoint;
  requireKnownKeys(
    anchor,
    ["view", "cells", "derive", "snap", "nudge", "x_from", "y_from", "overlay_id"],
    "target_anchor",
  );
  if (anchor.x !== undefined || anchor.y !== undefined) {
    throwCode(
      "UNGROUNDED_POINT",
      "target_anchor cannot take freehand x,y. Report speakable cells (and optional snap/nudge); MCP resolves pixel coordinates in the receipt.",
    );
  }
  /**
   * Applies optional pixel nudge after cell/snap grounding.
   * @param {{x:number,y:number,resolved:object}} grounded Point.
   * @returns {{x:number,y:number,resolved:object}} Nudged point.
   */
  function applyNudge(grounded) {
    if (anchor.nudge === undefined || anchor.nudge === null || anchor.nudge === "") return grounded;
    requireKnownKeys(anchor.nudge, ["dx", "dy"], "target_anchor.nudge");
    const dx = Number(anchor.nudge.dx);
    const dy = Number(anchor.nudge.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error("target_anchor.nudge.dx and dy must be finite pixel numbers.");
    }
    const x = grounded.x + dx;
    const y = grounded.y + dy;
    return {
      x,
      y,
      resolved: {
        ...grounded.resolved,
        before_nudge: { x: grounded.x, y: grounded.y },
        nudge: { dx, dy },
        x,
        y,
      },
    };
  }
  if (anchor.x_from || anchor.y_from) {
    if (!anchor.x_from || !anchor.y_from) {
      throw new Error("target_anchor x_from and y_from must both be provided.");
    }
    if (anchor.snap) {
      throw new Error(
        "target_anchor.snap cannot combine with x_from/y_from; snap on a single cells union instead.",
      );
    }
    const point = { x: deriveFromCells(anchor.x_from).x, y: deriveFromCells(anchor.y_from).y };
    return applyNudge({
      ...point,
      resolved: {
        mode: "derive_axes",
        cells: [...(anchor.x_from.cells || []), ...(anchor.y_from.cells || [])],
        x: point.x,
        y: point.y,
        space: "image_pixels",
      },
    });
  }
  if (!Array.isArray(anchor.cells) || !anchor.cells.length) {
    throw new Error(
      "target_anchor requires speakable cells (and view), or x_from/y_from. Do not invent pixel x,y.",
    );
  }
  const view = requireView(anchor.view, "target_anchor.view");
  const snapMode =
    anchor.snap !== undefined && anchor.snap !== null && String(anchor.snap).trim() !== ""
      ? String(anchor.snap).trim()
      : anchor.derive
        ? ""
        : "alpha_centroid";
  if (snapMode) {
    if (!image) throw new Error("target_anchor.snap requires the target image.");
    const box = unionCells(view, anchor.cells);
    const snapped = alphaAnchor(image.data, image.width, image.height, snapMode, box);
    return applyNudge({
      x: snapped.x,
      y: snapped.y,
      resolved: {
        mode: "snap",
        snap: snapMode,
        cells: [...anchor.cells],
        x: snapped.x,
        y: snapped.y,
        space: "image_pixels",
        bbox: snapped.bbox,
      },
    });
  }
  const point = deriveFromCells(anchor);
  return applyNudge({
    ...point,
    resolved: {
      mode: "derive",
      derive: anchor.derive || "center",
      cells: [...anchor.cells],
      x: point.x,
      y: point.y,
      space: "image_pixels",
    },
  });
}

/**
 * Resolves the object-local anchor.
 * @param {object} anchor Object anchor.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image Object image.
 * @returns {{x:number,y:number,bbox?:object}} Point.
 */
function resolveObjectAnchor(anchor, image, context = {}) {
  if (!anchor || typeof anchor !== "object") throw new Error("object_anchor is required.");
  const regionPoint = resolveRegionAnchor(anchor, context.sourcePath, context.root, "object_anchor");
  if (regionPoint) return regionPoint;
  requireKnownKeys(
    anchor,
    ["mode", "view", "cells", "derive", "snap", "measure_t", "overlay_id"],
    "object_anchor",
  );
  if (anchor.measure_t !== undefined && anchor.measure_t !== null && anchor.measure_t !== "") {
    if (anchor.cells || anchor.mode || anchor.snap) {
      throw new Error("object_anchor.measure_t cannot combine with mode/cells/snap.");
    }
    const measured = measureLongAxis(image.data, image.width, image.height, { t: anchor.measure_t });
    return { x: measured.at.x, y: measured.at.y, measure_t: measured.t };
  }
  if (Array.isArray(anchor.cells) && anchor.cells.length) {
    if (!anchor.view || typeof anchor.view !== "object") {
      throw new Error("object_anchor.cells requires view (the overlay that produced those ids).");
    }
    const view = requireView(anchor.view, "object_anchor.view");
    const snapMode =
      anchor.snap !== undefined && anchor.snap !== null && String(anchor.snap).trim() !== ""
        ? String(anchor.snap).trim()
        : anchor.derive
          ? ""
          : "alpha_centroid";
    if (snapMode) {
      const box = unionCells(view, anchor.cells);
      const snapped = alphaAnchor(image.data, image.width, image.height, snapMode, box);
      return { x: snapped.x, y: snapped.y, bbox: snapped.bbox, snap: snapMode };
    }
    return deriveFromCells({
      view,
      cells: anchor.cells,
      derive: anchor.derive || "center",
    });
  }
  if (anchor.snap) {
    throw new Error(
      "object_anchor.snap requires cells (and view) naming the grip region on the object overlay.",
    );
  }
  return alphaAnchor(image.data, image.width, image.height, anchor.mode || "alpha_center");
}

/**
 * Span in pixels along one edge of a cell union.
 * @param {object} spec Target cells.
 * @param {string} span width or height.
 * @returns {number} Pixel span.
 */
function spanPixels(spec, span) {
  const box = unionCells(requireView(spec.view, "scale.target.view"), spec.cells);
  return span === "height" ? box.y2 - box.y1 : box.x2 - box.x1;
}

/**
 * Uniform scale from relative or physical span. Never image-width-per-meter.
 * @param {unknown} scale Scale spec.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox Opaque box.
 * @param {{component?:{minX:number,minY:number,maxX:number,maxY:number}}|null} [targetRegion]
 * Fresh perception region used when scale.target is intentionally omitted.
 * @returns {{value:number,warning?:string}} Scale.
 */
function resolveScale(scale, bbox, targetRegion = null) {
  if (scale === undefined || scale === null || scale === "" || scale === "none" || scale.mode === "none") {
    return { value: 1 };
  }
  if (!scale || typeof scale !== "object") throw new Error("scale must be none or an object with mode.");
  const boxW = bbox.maxX - bbox.minX + 1;
  const boxH = bbox.maxY - bbox.minY + 1;
  /**
   * Resolves one source span from a cell view or a fresh detected region.
   * A region cannot be mixed with a grid target: each names a different
   * source of truth for the same scale span.
   * @param {"width"|"height"} span Requested source edge.
   * @returns {number} Source-pixel length.
   */
  const targetSpan = (span) => {
    if (targetRegion?.component) {
      const component = targetRegion.component;
      return span === "height" ? component.maxY - component.minY + 1 : component.maxX - component.minX + 1;
    }
    if (!scale.target || typeof scale.target !== "object") {
      throw new Error("scale.target is required unless target_anchor is a fresh perception region.");
    }
    return spanPixels(scale.target, span);
  };
  if (scale.mode === "relative") {
    const ratio = Number(scale.ratio);
    if (!(ratio > 0)) throw new Error("scale.ratio must be greater than 0.");
    const targetPx = targetSpan(scale.span || "width");
    const objectPx = (scale.span || "width") === "height" ? boxH : boxW;
    const otherTarget = targetSpan((scale.span || "width") === "height" ? "width" : "height");
    const otherObject = (scale.span || "width") === "height" ? boxW : boxH;
    const value = (targetPx * ratio) / objectPx;
    const other = (otherTarget * ratio) / otherObject;
    return {
      value,
      warning:
        Math.abs(value - other) > 1e-6 ? "aspect mismatch: scaled by one edge, not stretched" : undefined,
    };
  }
  if (scale.mode === "physical") {
    const targetM = Number(scale.target_m);
    const objectM = Number(scale.object_m);
    if (!(targetM > 0) || !(objectM > 0)) throw new Error("target_m and object_m must be greater than 0.");
    const span = scale.span || "width";
    const objectSpan = scale.object_span || (span === "height" ? "bbox_height" : "bbox_width");
    const targetPx = targetSpan(span);
    const objectPx = objectSpan === "bbox_width" ? boxW : boxH;
    const otherObject = objectSpan === "bbox_width" ? boxH : boxW;
    const value = (targetPx / targetM) * (objectM / objectPx);
    const other = (targetPx / targetM) * (objectM / otherObject);
    return {
      value,
      warning:
        Math.abs(value - other) > 1e-6 ? "aspect mismatch: scaled by one edge, not stretched" : undefined,
    };
  }
  throw new Error(`scale.mode must be none, relative, or physical. Received: ${scale.mode}`);
}

/**
 * Whether two speakable cell lists name the same set.
 * @param {unknown} expected Plan cells.
 * @param {unknown} actual Place cells.
 * @returns {boolean} Same set.
 */
function sameCellSet(expected, actual) {
  if (!Array.isArray(expected) || !expected.length) return true;
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const left = expected.map((id) => parseCellId(id).id).sort();
  const right = actual.map((id) => parseCellId(id).id).sort();
  return left.every((id, index) => id === right[index]);
}

/**
 * Effective snap used by an anchor after defaulting.
 * @param {object} anchor Target or object anchor.
 * @returns {{kind:string,snap?:string}} Kind.
 */
function placeSnapKind(anchor) {
  if (!anchor || typeof anchor !== "object") return { kind: "none" };
  if (anchor.x_from || anchor.y_from) return { kind: "axes" };
  if (anchor.snap !== undefined && anchor.snap !== null && String(anchor.snap).trim() !== "") {
    return { kind: "snap", snap: String(anchor.snap).trim() };
  }
  if (anchor.derive) return { kind: "derive" };
  if (Array.isArray(anchor.cells) && anchor.cells.length) return { kind: "snap", snap: "alpha_centroid" };
  return { kind: "none" };
}

/**
 * Loads a sibling-written place plan JSON.
 * @param {unknown} planId Plan id.
 * @param {string} artifactDir Artifact directory.
 * @returns {object} Plan body.
 */
function loadPlacePlan(planId, artifactDir) {
  const id = String(planId || "").trim();
  if (!id) return null;
  const filePath = path.join(artifactDir, "place-plans", `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throwCode("STALE_PLAN", `plan_id ${id} was not found in this workspace.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throwCode("STALE_PLAN", `plan_id ${id} could not be read.`);
  }
  if (!parsed || typeof parsed !== "object") {
    throwCode("STALE_PLAN", `plan_id ${id} is not a JSON object.`);
  }
  return parsed;
}

/**
 * Rejects a place call that disagrees with a stored brief.
 * @param {object} plan Stored plan.
 * @param {{targetPath:string,objectPath:string,layer:string,targetAnchor:object,objectAnchor:object}} call Place call.
 * @returns {void}
 */
function assertPlanMatches(plan, call) {
  const storedTarget = path.resolve(String(plan.target_path || ""));
  const storedObject = path.resolve(String(plan.object_path || ""));
  if (storedTarget !== call.targetPath || storedObject !== call.objectPath) {
    throwCode("PLAN_MISMATCH", "plan_id target_path/object_path do not match this place call.");
  }
  const targetCells = plan.read?.target_cells;
  if (
    Array.isArray(targetCells) &&
    targetCells.length &&
    !sameCellSet(targetCells, call.targetAnchor?.cells)
  ) {
    throwCode("PLAN_MISMATCH", "plan_id target cells do not match target_anchor.cells.");
  }
  const objectCells = plan.read?.object_cells;
  const objectUsesMeasureT =
    call.objectAnchor?.measure_t !== undefined &&
    call.objectAnchor?.measure_t !== null &&
    String(call.objectAnchor.measure_t).trim() !== "";
  if (
    Array.isArray(objectCells) &&
    objectCells.length &&
    !objectUsesMeasureT &&
    !sameCellSet(objectCells, call.objectAnchor?.cells)
  ) {
    throwCode("PLAN_MISMATCH", "plan_id object cells do not match object_anchor.cells.");
  }
  const proposedLayer = plan.proposed?.layer ? String(plan.proposed.layer).trim() : "";
  if (proposedLayer && proposedLayer !== call.layer) {
    throwCode("PLAN_MISMATCH", `plan_id proposed.layer is ${proposedLayer}, place used ${call.layer}.`);
  }
  const proposedSnap = plan.proposed?.snap ? String(plan.proposed.snap).trim() : "";
  if (proposedSnap) {
    for (const [label, anchor] of [
      ["target_anchor", call.targetAnchor],
      ["object_anchor", call.objectAnchor],
    ]) {
      const kind = placeSnapKind(anchor);
      if (kind.kind === "none" || kind.kind === "axes") continue;
      if (kind.kind === "snap" && kind.snap === proposedSnap) continue;
      throwCode(
        "PLAN_MISMATCH",
        `plan_id proposed.snap is ${proposedSnap}, ${label} used ${kind.kind === "derive" ? "derive" : kind.snap || kind.kind}.`,
      );
    }
  }
}

/**
 * Warns when speakable cells were used without an overlay stamp.
 * @param {object} anchor Anchor.
 * @param {string} label target_anchor or object_anchor.
 * @param {string[]} warnings Warning list.
 * @returns {void}
 */
function warnMissingOverlayId(anchor, label, warnings) {
  if (!Array.isArray(anchor?.cells) || !anchor.cells.length || !anchor.view) return;
  if (
    anchor.overlay_id !== undefined &&
    anchor.overlay_id !== null &&
    String(anchor.overlay_id).trim() !== ""
  ) {
    return;
  }
  warnings.push(`${label}.overlay_id omitted: overlay freshness was not checked`);
}

/**
 * Whether a (possibly fractional) point sits on an opaque pixel.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} image Image.
 * @param {number} x X.
 * @param {number} y Y.
 * @returns {boolean} Opaque.
 */
function pixelOpaqueAt(image, x, y) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return false;
  return image.data[(py * image.width + px) * 4 + 3] > ALPHA_VISIBLE;
}

/**
 * Geometric place verify. Does not claim a visual grip-in-palm.
 * @param {{targetPoint:object,image:object,layer:string,anchor:object,scaleWarning?:string,wantVerify:boolean}} spec Spec.
 * @returns {{status:string,checks:object[]}} Verify receipt.
 */
function buildPlaceVerify(spec) {
  const snapMode = spec.targetPoint.resolved?.snap;
  const footEdge = snapMode === "alpha_bottom_center" || snapMode === "alpha_support";
  const snapOpaque =
    !snapMode || footEdge || pixelOpaqueAt(spec.image, spec.targetPoint.x, spec.targetPoint.y);
  let coverOk = true;
  if (spec.layer === "under_target") {
    coverOk = Boolean(spec.occlusion?.mask?.some((alpha) => alpha > 0));
  }
  const checks = [
    { id: "anchor_mapped", ok: true },
    { id: "snap_opaque", ok: snapOpaque },
    { id: "under_target_cover", ok: coverOk },
  ];
  let status = "confirmed";
  if (!spec.wantVerify) status = "unverified";
  else if (!checks.every((check) => check.ok)) status = "unverifiable";
  return { status, scope: "geometry", visual_status: "not_assessed", checks };
}

/**
 * Composites one PNG onto another using generic anchors.
 * @param {object} args Tool arguments.
 * @param {{root:string,artifactDir?:string}} options Service root.
 * @returns {object} Placement receipt.
 */
function placeImageOnTarget(args = {}, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const artifactDir = options.artifactDir || mcpArtifactDir("", root);
  const targetPath = requireExistingFile(args.target_path, "Target image");
  const objectPath = requireExistingFile(args.object_path, "Object image");
  if (!/\.png$/i.test(targetPath) || !/\.png$/i.test(objectPath)) {
    throw new Error("target_path and object_path must be PNG files.");
  }
  const rotation = Number(args.rotation === undefined || args.rotation === "" ? 0 : args.rotation);
  if (!Number.isFinite(rotation)) throw new Error("rotation must be a finite number of degrees.");
  const layer = String(args.layer === undefined || args.layer === "" ? "front" : args.layer).trim();
  if (!LAYER_MODES.includes(layer)) {
    throw new Error(`layer must be ${LAYER_MODES.join("|")}. Received: ${args.layer}`);
  }
  if (args.plan_id !== undefined && args.plan_id !== null && String(args.plan_id).trim() !== "") {
    const plan = loadPlacePlan(args.plan_id, artifactDir);
    assertPlanMatches(plan, {
      targetPath,
      objectPath,
      layer,
      targetAnchor: args.target_anchor,
      objectAnchor: args.object_anchor,
    });
  }
  if (args.target_anchor?.overlay_id && args.target_anchor?.view) {
    assertOverlayId(targetPath, args.target_anchor.view, args.target_anchor.overlay_id, "target_anchor");
  }
  if (args.object_anchor?.overlay_id && args.object_anchor?.view) {
    assertOverlayId(objectPath, args.object_anchor.view, args.object_anchor.overlay_id, "object_anchor");
  }
  const warnings = [];
  warnMissingOverlayId(args.target_anchor, "target_anchor", warnings);
  warnMissingOverlayId(args.object_anchor, "object_anchor", warnings);
  const target = decodePngRgba(targetPath);
  const object = decodePngRgba(objectPath);
  const targetPoint = resolveTargetAnchor(args.target_anchor, target, { sourcePath: targetPath, root });
  const objectPoint = resolveObjectAnchor(args.object_anchor, object, { sourcePath: objectPath, root });
  const bbox = objectPoint.bbox || opaqueBBox(object.data, object.width, object.height);
  const scaleRegion =
    args.scale?.target && typeof args.scale.target === "object"
      ? resolveRegionAnchor(args.scale.target, targetPath, root, "scale.target")
      : null;
  const scaled = resolveScale(args.scale, bbox, scaleRegion?.region || targetPoint.region);
  const origin = placementOrigin(targetPoint, objectPoint, scaled.value);
  const objectLayer = new Uint8ClampedArray(target.data.length);
  const mapped = {
    x: origin.left + objectPoint.x * scaled.value,
    y: origin.top + objectPoint.y * scaled.value,
  };
  if (Math.hypot(mapped.x - targetPoint.x, mapped.y - targetPoint.y) > 1) {
    throwCode(
      "PLACE_ANCHOR_MISMATCH",
      `Mapped object anchor (${mapped.x}, ${mapped.y}) missed target (${targetPoint.x}, ${targetPoint.y}).`,
    );
  }
  // Inverse mapping samples each destination once, including fractional scales.
  blitRotated(
    objectLayer,
    target.width,
    target.height,
    object.data,
    object.width,
    object.height,
    origin.left,
    origin.top,
    scaled.value,
    mapped,
    rotation,
  );
  const occlusion = resolveOcclusion(
    args.occlusion,
    target,
    targetPath,
    root,
    layer,
    targetPoint.region,
    () => targetCoverBox(args.target_anchor),
  );
  const composite = compositeOccludedObject(target, objectLayer, occlusion);
  const dest = composite.data;
  const outputPath = resolveOutputPath(args, { root, artifactDir, inputPath: targetPath, suffix: "_placed" });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, encodePngRgba(dest, target.width, target.height));
  const wantVerify = booleanFlag(args.verify_overlay, true);
  let verifyOverlayPath;
  if (wantVerify) {
    const verifyArgs = {
      file_path: outputPath,
      rows: args.target_anchor?.view?.rows,
      cols: args.target_anchor?.view?.cols,
    };
    if (args.verify_overlay_path) verifyArgs.output_path = args.verify_overlay_path;
    else {
      verifyArgs.output_path = resolveOutputPath(
        {},
        { root, artifactDir, inputPath: outputPath, suffix: "_verify" },
      );
    }
    if (!Number.isInteger(verifyArgs.rows)) delete verifyArgs.rows;
    if (!Number.isInteger(verifyArgs.cols)) delete verifyArgs.cols;
    verifyOverlayPath = overlayGridImage(verifyArgs, { root, artifactDir }).overlay_path;
  }
  const verify = buildPlaceVerify({
    targetPoint,
    image: target,
    layer,
    anchor: args.target_anchor,
    scaleWarning: scaled.warning,
    wantVerify,
    occlusion,
  });
  return {
    output_path: outputPath,
    scale: scaled.value,
    warning: scaled.warning,
    rotation,
    layer,
    target: { x: targetPoint.x, y: targetPoint.y },
    resolved: targetPoint.resolved,
    object_anchor: { x: objectPoint.x, y: objectPoint.y, resolved: objectPoint.resolved },
    occlusion: composite.receipt,
    clipping: placementClipping(
      opaqueBBox(object.data, object.width, object.height),
      objectPoint,
      targetPoint,
      scaled.value,
      rotation,
      target,
    ),
    mapped,
    left: origin.left,
    top: origin.top,
    verify_overlay_path: verifyOverlayPath,
    verify,
    warnings,
  };
}

/**
 * Opaque-foot geometry for measure_image anchor=alpha_bottom.
 * @param {Uint8ClampedArray} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {object} Foot receipt.
 */
function measureAlphaBottom(rgba, width, height) {
  const support = alphaAnchor(rgba, width, height, "alpha_support");
  const bottom = alphaAnchor(rgba, width, height, "alpha_bottom_center");
  return {
    anchor: "alpha_bottom",
    space: "image_pixels",
    at: { x: support.x, y: support.y },
    alpha_bottom_center: { x: bottom.x, y: bottom.y },
    alpha_support: { x: support.x, y: support.y, support: support.support },
    bbox: support.bbox,
    image: { width, height },
  };
}

module.exports = {
  DERIVE_MODES,
  LABEL_INK,
  LAYER_MODES,
  alphaAnchor,
  assertOverlayId,
  cellBox,
  deriveFromCells,
  integerCrop,
  measureAlphaBottom,
  overlayGridImage,
  parseCellId,
  placeImageOnTarget,
  placementOrigin,
  overlayIdFor,
  unionCells,
};
