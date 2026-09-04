"use strict";

/**
 * Walk-loop sole planting and overlay cell-id write-back. Translate only —
 * lock height with xsxb_register_clip. Group coordinates match export_sheet
 * grid.cells / overlay A1 ids; do not OCR overlay digits.
 */

const { parseGroupPoint } = require("./xsxb_mcp_arguments");
const { shiftFrameRgba } = require("./xsxb_mcp_cutout");
const { measureSpriteGeometry } = require("./xsxb_mcp_lock");
const { parseCellId } = require("./xsxb_mcp_place");
const { canvasToGroup, describeGroupGrid } = require("./xsxb_mcp_visual_qa");

/** Contact-sheet cell edge used when export_sheet omits `cell`. */
const EXPORT_SHEET_CELL = 220;
const CELL_ID_PATTERN = /^[A-Za-z][0-9]+$/u;
const TRAIL_PATH_KINDS = new Set(["polyline", "smooth_arc"]);

/**
 * True when a Hermite mesh may be baked for this trail segment.
 * polyline forbids the mesh (sticks stay stored).
 * @param {object|null|undefined} segment Trail segment.
 * @returns {boolean} Whether GIF/sheet may emit the Hermite path.
 */
function trailUsesHermiteMesh(segment) {
  return normalizeTrailPathKind(segment?.pathKind || segment?.path_kind) !== "polyline";
}

/**
 * Normalizes path_kind. Omitted values keep the existing smooth_arc mesh.
 * @param {unknown} value Raw path_kind.
 * @returns {"polyline"|"smooth_arc"} Kind.
 */
function normalizeTrailPathKind(value) {
  if (value === undefined || value === null || value === "") return "smooth_arc";
  const kind = String(value).trim();
  if (!TRAIL_PATH_KINDS.has(kind)) {
    throw new Error('path_kind must be "polyline" or "smooth_arc".');
  }
  return kind;
}

/**
 * Extracts an overlay cell token from a write-tool point.
 * @param {unknown} value Raw point.
 * @returns {string|null} Token such as E5, or null when this is a group point.
 */
function cellIdToken(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return CELL_ID_PATTERN.test(trimmed) ? trimmed : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.cell === undefined || value.cell === null || value.cell === "") return null;
    return String(value.cell).trim();
  }
  return null;
}

/**
 * Maps an A1-style overlay cell onto the group coordinate of that square's
 * top-left corner (same numbers as export_sheet grid.cells[row][col]).
 * @param {unknown} cellId Speakable id.
 * @param {{width:number,height:number,anchorMode?:string,grid?:object,subject?:object|null,cell?:number}} options Frame + grid.
 * @returns {{x:number,y:number,id:string,row:number,col:number}} Group point.
 */
function resolveOverlayCell(cellId, options = {}) {
  const width = Math.max(1, Number(options.width) || 0);
  const height = Math.max(1, Number(options.height) || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    const error = new Error("Overlay cell ids need the frame PNG width and height.");
    error.code = "GRID_INVALID_CELL";
    throw error;
  }
  const cell = Math.max(EXPORT_SHEET_CELL, Number(options.cell) || EXPORT_SHEET_CELL);
  const described = describeGroupGrid(cell, width, height, options.anchorMode || "canvas_bottom_center", {
    ...(options.grid && typeof options.grid === "object" ? options.grid : {}),
    subject: options.subject,
  });
  const cells = described.cells;
  if (!described.enabled || !Array.isArray(cells) || !cells.length || !cells[0]?.length) {
    const error = new Error('Overlay grid has no cells for this frame; pass grid_divs such as "8x8".');
    error.code = "GRID_INVALID_CELL";
    throw error;
  }
  const rows = cells.length;
  const cols = cells[0].length;
  const parsed = parseCellId(cellId, { rows, cols, x: 0, y: 0, width, height });
  const square = cells[parsed.row - 1]?.[parsed.column];
  if (!square) {
    const error = new Error(`Cell id ${parsed.id} is outside the ${cols}×${rows} grid.`);
    error.code = "GRID_CELL_OUT_OF_RANGE";
    throw error;
  }
  return { x: square.x, y: square.y, id: parsed.id, row: parsed.row, col: parsed.column };
}

/**
 * Parses a write-tool point: overlay cell id or a tuner-group point.
 * @param {unknown} value Raw point.
 * @param {{label?:string,width?:number,height?:number,anchorMode?:string,grid?:object,subject?:object|null}} [options] Frame + grid.
 * @returns {{x:number,y:number}|null} Group point, or null when omitted.
 */
function parseWritePoint(value, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  const token = cellIdToken(value);
  if (token) {
    const resolved = resolveOverlayCell(token, options);
    return { x: resolved.x, y: resolved.y };
  }
  return parseGroupPoint(value, options.label || "point");
}

/**
 * Plans a vertical translate that plants the opaque sole onto target group-Y.
 * Does not scale. metrics.feetY is the boot sole (glow below boots is ignored).
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {{targetY?:number,to?:unknown,anchorMode?:string,grid?:object,subject?:object|null}} [options] Plant target.
 * @returns {{feetY:number,dy:number,targetY:number}} Plant row.
 */
function planPlantFeet(rgba, width, height, options = {}) {
  const geometry = measureSpriteGeometry(rgba, width, height);
  const anchorMode = options.anchorMode || "canvas_bottom_center";
  let targetY =
    options.targetY === undefined || options.targetY === null || options.targetY === ""
      ? -1
      : Number(options.targetY);
  if (!Number.isFinite(targetY)) {
    throw new Error("target_y must be a finite group Y. Last pixel row is y=-1, not 0,0.");
  }
  if (options.to !== undefined && options.to !== null && options.to !== "") {
    const point = parseWritePoint(options.to, {
      ...options,
      width,
      height,
      anchorMode,
      label: "to",
    });
    if (point) targetY = point.y;
  }
  const overhang = Math.max(0, Number(geometry.maxY) - Number(geometry.feetY));
  const spaceBelowIce = height - 1 - Number(geometry.maxY);
  const lockHeight = overhang > 0 && spaceBelowIce <= 0 ? height - overhang : height;
  const feetGroupY = canvasToGroup(0, geometry.feetY, width, lockHeight, anchorMode).y;
  const dy = Math.trunc(targetY - feetGroupY);
  const destMaxY = Number(geometry.maxY) + dy;
  return {
    feetY: geometry.feetY,
    dy,
    targetY,
    outWidth: width,
    outHeight: Math.max(height, destMaxY + 1),
  };
}

/**
 * Translates one RGBA buffer by integer pixels (same pipeline as shift_frames).
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {number} dx Group/canvas X.
 * @param {number} dy Group/canvas Y. Positive plants down toward the foot origin.
 * @returns {Uint8ClampedArray} Shifted pixels, same size.
 */
function shiftPlantedRgba(rgba, width, height, dx, dy, outHeight = height) {
  const destHeight = Math.max(height, Math.trunc(Number(outHeight) || height));
  if (destHeight === height) return shiftFrameRgba(rgba, width, height, dx, dy);
  const dest = new Uint8ClampedArray(width * destHeight * 4);
  const shiftX = Math.trunc(Number(dx) || 0);
  const shiftY = Math.trunc(Number(dy) || 0);
  for (let y = 0; y < destHeight; y += 1) {
    const sourceY = y - shiftY;
    if (sourceY < 0 || sourceY >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      if (sourceX < 0 || sourceX >= width) continue;
      dest.set(
        rgba.subarray((sourceY * width + sourceX) * 4, (sourceY * width + sourceX) * 4 + 4),
        (y * width + x) * 4,
      );
    }
  }
  return dest;
}

module.exports = {
  EXPORT_SHEET_CELL,
  TRAIL_PATH_KINDS,
  cellIdToken,
  normalizeTrailPathKind,
  parseWritePoint,
  planPlantFeet,
  resolveOverlayCell,
  shiftPlantedRgba,
  trailUsesHermiteMesh,
};
