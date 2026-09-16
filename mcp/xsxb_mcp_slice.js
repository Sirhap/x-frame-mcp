"use strict";

/**
 * Cut a packed sprite/contact sheet into a numbered PNG sequence (切表).
 * Walk-loop lock-ruler still prefers measure/register — this is for packed sheets.
 */

const fs = require("node:fs");
const path = require("node:path");
const { booleanFlag, PNG_NAME, requireExistingFile } = require("./xsxb_mcp_arguments");
const { decodePngRgba, encodePngRgba } = require("./xsxb_mcp_cutout");

const NUMBERED_PNG = /^\d+\.png$/i;

/**
 * Parses a positive integer argument or throws a named error.
 * @param {unknown} value Raw value.
 * @param {string} label Argument name.
 * @returns {number} Integer > 0.
 */
function positiveInt(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive integer. Received: ${value}`);
  }
  return numeric;
}

/**
 * Parses grid_divs like "8x8" into columns × rows.
 * @param {unknown} value Raw grid_divs.
 * @returns {{columns:number,rows:number}} Grid size.
 */
function parseSliceGridDivs(value) {
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+)\s*[x×*]\s*(\d+)$/u);
  if (!match) throw new Error(`grid_divs must look like "8x8". Received: ${value}`);
  return {
    columns: positiveInt(Number(match[1]), "columns"),
    rows: positiveInt(Number(match[2]), "rows"),
  };
}

/**
 * Reads pad / padding (pixels between cells). Omit means 0.
 * If both are present and Number() values differ, throws. Matching values are accepted.
 * @param {object} args Tool arguments.
 * @returns {number} Pad in pixels.
 */
function resolvePad(args) {
  const hasPad = argumentPresent(args.pad);
  const hasPadding = argumentPresent(args.padding);
  if (hasPad && hasPadding && Number(args.pad) !== Number(args.padding)) {
    throw new Error("pad and padding disagree. Pass only one.");
  }
  const raw = hasPad ? args.pad : args.padding;
  if (!argumentPresent(raw)) return 0;
  const pad = Number(raw);
  if (!Number.isInteger(pad) || pad < 0) {
    throw new Error(`pad must be an integer >= 0. Received: ${raw}`);
  }
  return pad;
}

/**
 * Reads an optional uniform or rectangular cell size.
 * @param {object} args Tool arguments.
 * @returns {{cellW:number,cellH:number}|null} Cell size, or null when omitted.
 */
function resolveCellSize(args) {
  const hasCell = args.cell !== undefined && args.cell !== null && args.cell !== "";
  const hasW = args.cell_w !== undefined && args.cell_w !== null && args.cell_w !== "";
  const hasH = args.cell_h !== undefined && args.cell_h !== null && args.cell_h !== "";
  if (hasCell) {
    const size = positiveInt(args.cell, "cell");
    return { cellW: size, cellH: size };
  }
  if (hasW || hasH) {
    if (!hasW || !hasH) throw new Error("cell_w and cell_h must be provided together.");
    return { cellW: positiveInt(args.cell_w, "cell_w"), cellH: positiveInt(args.cell_h, "cell_h") };
  }
  return null;
}

/**
 * Reads an optional positive integer, or undefined when omitted.
 * @param {unknown} value Raw value.
 * @param {string} label Argument name.
 * @returns {number|undefined} Integer > 0.
 */
function optionalPositiveInt(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  return positiveInt(value, label);
}

/**
 * Infers how many cells fit along one axis with pad between them.
 * @param {number} span Image width or height.
 * @param {number} cell Cell size along that axis.
 * @param {number} pad Gap between cells.
 * @returns {number} Cell count (may be 0).
 */
function countCells(span, cell, pad) {
  return Math.floor((span + pad) / (cell + pad));
}

/**
 * Resolves columns, rows, and cell size from one of the advertised grid specs.
 * @param {object} args Tool arguments.
 * @param {number} width Sheet width.
 * @param {number} height Sheet height.
 * @returns {{columns:number,rows:number,cellW:number,cellH:number,pad:number}} Grid.
 */
function resolveSliceGrid(args, width, height) {
  const pad = resolvePad(args);
  const hasColumns = argumentPresent(args.columns);
  const hasCols = argumentPresent(args.cols);
  if (hasColumns && hasCols && Number(args.columns) !== Number(args.cols)) {
    throw new Error("columns and cols disagree. Pass only one.");
  }
  let columns = optionalPositiveInt(args.columns ?? args.cols, "columns");
  let rows = optionalPositiveInt(args.rows, "rows");
  if (args.grid_divs !== undefined && args.grid_divs !== null && args.grid_divs !== "") {
    const parsed = parseSliceGridDivs(args.grid_divs);
    if (columns === undefined) columns = parsed.columns;
    if (rows === undefined) rows = parsed.rows;
  }
  const cellSize = resolveCellSize(args);
  if (columns === undefined || rows === undefined) {
    if (!cellSize) {
      throw new Error('Provide columns+rows, cell / cell_w+cell_h, or grid_divs like "8x8".');
    }
    if (columns === undefined) columns = countCells(width, cellSize.cellW, pad);
    if (rows === undefined) rows = countCells(height, cellSize.cellH, pad);
    if (columns <= 0) {
      throw new Error(
        `cell ${cellSize.cellW}×${cellSize.cellH} with pad ${pad} does not fit ${width}×${height} sheet (zero columns).`,
      );
    }
    if (rows <= 0) {
      throw new Error(
        `cell ${cellSize.cellW}×${cellSize.cellH} with pad ${pad} does not fit ${width}×${height} sheet (zero rows).`,
      );
    }
  }
  const cellW = cellSize ? cellSize.cellW : Math.floor((width - pad * Math.max(0, columns - 1)) / columns);
  const cellH = cellSize ? cellSize.cellH : Math.floor((height - pad * Math.max(0, rows - 1)) / rows);
  if (!Number.isInteger(cellW) || cellW <= 0 || !Number.isInteger(cellH) || cellH <= 0) {
    throw new Error(
      `Cell size must be positive. Computed ${cellW}x${cellH} from ${width}x${height} sheet with ${columns}x${rows} cells and pad ${pad}.`,
    );
  }
  const neededW = columns * cellW + Math.max(0, columns - 1) * pad;
  const neededH = rows * cellH + Math.max(0, rows - 1) * pad;
  if (neededW > width || neededH > height) {
    throw new Error(
      `Grid ${columns}x${rows} at cell ${cellW}x${cellH} with pad ${pad} does not fit ${width}x${height} sheet.`,
    );
  }
  return { columns, rows, cellW, cellH, pad };
}

/**
 * Copies one cell rectangle into a new RGBA buffer.
 * @param {Uint8ClampedArray} src Sheet pixels.
 * @param {number} srcW Sheet width.
 * @param {number} srcH Sheet height.
 * @param {number} x0 Cell left.
 * @param {number} y0 Cell top.
 * @param {number} cellW Cell width.
 * @param {number} cellH Cell height.
 * @returns {Uint8ClampedArray} Cell pixels.
 */
function blitCell(src, srcW, srcH, x0, y0, cellW, cellH) {
  const dest = new Uint8ClampedArray(cellW * cellH * 4);
  for (let y = 0; y < cellH; y += 1) {
    const srcY = y0 + y;
    if (srcY < 0 || srcY >= srcH) continue;
    const srcOffset = (srcY * srcW + x0) * 4;
    const destOffset = y * cellW * 4;
    const span = Math.min(cellW, Math.max(0, srcW - x0));
    if (span <= 0) continue;
    dest.set(src.subarray(srcOffset, srcOffset + span * 4), destOffset);
  }
  return dest;
}

/**
 * True when every pixel is fully transparent.
 * @param {Uint8ClampedArray} rgba Cell pixels.
 * @returns {boolean} Empty cell.
 */
function cellIsEmpty(rgba) {
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] !== 0) return false;
  }
  return true;
}

/**
 * Removes previous numbered slice outputs so a re-run cannot poison a sequence import.
 * @param {string} dest Output directory.
 * @returns {void}
 */
function clearNumberedPngs(dest) {
  if (!fs.existsSync(dest)) return;
  for (const name of fs.readdirSync(dest)) {
    if (!NUMBERED_PNG.test(name)) continue;
    const filePath = path.join(dest, name);
    if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
  }
}

/**
 * True when a tool argument was actually provided.
 * @param {unknown} value Raw value.
 * @returns {boolean} Present.
 */
function argumentPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Sibling sidecar path: `sheet.png` → `sheet.sheet.json`.
 * @param {string} pngPath Sheet PNG.
 * @returns {string} Sidecar path.
 */
function contactSheetSidecarPath(pngPath) {
  const parsed = path.parse(pngPath);
  return path.join(parsed.dir, `${parsed.name}.sheet.json`);
}

/**
 * Reads an export_sheet contact-sheet sidecar when present and well-kinded.
 * @param {string} pngPath Sheet PNG.
 * @returns {object|null} Parsed sidecar, or null when absent / other kind.
 */
function readContactSheetSidecar(pngPath) {
  const sidecarPath = contactSheetSidecarPath(pngPath);
  if (!fs.existsSync(sidecarPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  } catch {
    throw new Error(`Contact sheet sidecar is not valid JSON: ${sidecarPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.kind !== "xsxb_contact_sheet") return null;
  return parsed;
}

/**
 * Formats sidecar cell for error text: `220` or `220x29`.
 * @param {{cellW?:number,cellH?:number}} packing Sidecar packing.
 * @returns {string} Cell text.
 */
function formatPackingCell(packing) {
  if (packing.cellW === undefined || packing.cellH === undefined) return "(unknown)";
  return packing.cellW === packing.cellH ? String(packing.cellW) : `${packing.cellW}x${packing.cellH}`;
}

/**
 * Reads columns/rows/cell/pad from a contact-sheet sidecar.
 * @param {object} sidecar Parsed sidecar.
 * @returns {{columns:number,rows:number,cellW?:number,cellH?:number,pad:number}} Packing.
 */
function packingFromSidecar(sidecar) {
  const columns = positiveInt(sidecar.columns, "sidecar.columns");
  const rows = positiveInt(sidecar.rows, "sidecar.rows");
  const cell = sidecar.cell;
  let cellW;
  let cellH;
  if (cell && typeof cell === "object" && !Array.isArray(cell)) {
    cellW = positiveInt(cell.w, "sidecar.cell.w");
    cellH = positiveInt(cell.h, "sidecar.cell.h");
  } else if (argumentPresent(cell)) {
    const size = positiveInt(cell, "sidecar.cell");
    cellW = size;
    cellH = size;
  }
  let pad = 0;
  if (argumentPresent(sidecar.pad)) {
    pad = Number(sidecar.pad);
    if (!Number.isInteger(pad) || pad < 0) {
      throw new Error(`sidecar.pad must be an integer >= 0. Received: ${sidecar.pad}`);
    }
  }
  return { columns, rows, cellW, cellH, pad };
}

/**
 * Fills omitted slice packing from an export_sheet sidecar, or throws when
 * overlay `grid_divs` does not match the packed columns×rows.
 * @param {object} args Tool arguments.
 * @param {string} pngPath Sheet PNG.
 * @returns {object} Args, possibly with sidecar columns/rows/cell/pad filled in.
 */
function applyContactSheetSidecar(args, pngPath) {
  const sidecar = readContactSheetSidecar(pngPath);
  if (!sidecar) return args;
  const packing = packingFromSidecar(sidecar);
  const hasColumns = argumentPresent(args.columns) || argumentPresent(args.cols);
  const hasRows = argumentPresent(args.rows);
  const hasCell = argumentPresent(args.cell) || argumentPresent(args.cell_w) || argumentPresent(args.cell_h);
  const hasGridDivs = argumentPresent(args.grid_divs);
  if (hasGridDivs && !hasColumns && !hasRows && !hasCell) {
    const parsed = parseSliceGridDivs(args.grid_divs);
    if (parsed.columns !== packing.columns || parsed.rows !== packing.rows) {
      const err = new Error(
        `grid_divs "${args.grid_divs}" does not match contact-sheet packing ${packing.columns}x${packing.rows} (cell ${formatPackingCell(packing)}, pad ${packing.pad}). Pass columns/rows/cell/pad from the export_sheet receipt, not overlay grid_divs.`,
      );
      err.code = "SLICE_PACKING_MISMATCH";
      throw err;
    }
  }
  if (hasColumns || hasRows || hasCell || hasGridDivs) return args;
  const merged = { ...args, columns: packing.columns, rows: packing.rows };
  if (!argumentPresent(args.pad) && !argumentPresent(args.padding)) merged.pad = packing.pad;
  if (packing.cellW !== undefined && packing.cellH !== undefined) {
    if (packing.cellW === packing.cellH) merged.cell = packing.cellW;
    else {
      merged.cell_w = packing.cellW;
      merged.cell_h = packing.cellH;
    }
  }
  return merged;
}

/**
 * Cuts one sheet PNG into a numbered PNG sequence.
 * @param {object} args Tool arguments.
 * @returns {object} Short slice receipt.
 */
function sliceSheet(args = {}) {
  const absolute = requireExistingFile(args.file_path, "Sprite sheet");
  if (!PNG_NAME.test(absolute)) throw new Error("file_path must be a PNG.");
  const resolvedArgs = applyContactSheetSidecar(args, absolute);
  const image = decodePngRgba(absolute);
  const grid = resolveSliceGrid(resolvedArgs, image.width, image.height);
  const startIndexRaw = args.start_index;
  const startIndex =
    startIndexRaw === undefined || startIndexRaw === null || startIndexRaw === "" ? 0 : Number(startIndexRaw);
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error(`start_index must be an integer >= 0. Received: ${startIndexRaw}`);
  }
  const skipEmpty = booleanFlag(args.skip_empty, true);
  const parsedSheet = path.parse(absolute);
  const dest = args.dest
    ? path.resolve(String(args.dest))
    : path.join(parsedSheet.dir, `${parsedSheet.name}_cells`);
  if (dest === absolute || (fs.existsSync(dest) && fs.statSync(dest).isFile())) {
    throw new Error("dest must be a directory, not the sheet PNG.");
  }
  fs.mkdirSync(dest, { recursive: true });
  clearNumberedPngs(dest);
  const paths = [];
  const skipped = [];
  let nextName = startIndex;
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const index = row * grid.columns + column;
      const x0 = column * (grid.cellW + grid.pad);
      const y0 = row * (grid.cellH + grid.pad);
      const rgba = blitCell(image.data, image.width, image.height, x0, y0, grid.cellW, grid.cellH);
      if (skipEmpty && cellIsEmpty(rgba)) {
        skipped.push({ index, column, row });
        continue;
      }
      const outputPath = path.join(dest, `${nextName}.png`);
      fs.writeFileSync(outputPath, encodePngRgba(rgba, grid.cellW, grid.cellH));
      paths.push(outputPath);
      nextName += 1;
    }
  }
  const square = grid.cellW === grid.cellH;
  return {
    outputDir: dest,
    paths,
    columns: grid.columns,
    rows: grid.rows,
    cell: square ? grid.cellW : { w: grid.cellW, h: grid.cellH },
    pad: grid.pad,
    frameCount: paths.length,
    skipped,
  };
}

module.exports = { parseSliceGridDivs, resolveSliceGrid, sliceSheet };
