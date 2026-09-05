"use strict";

const { ALPHA_VISIBLE, decodePngRgba, subjectAnchor } = require("./xsxb_mcp_cutout");

const NEAR_WHITE_LUMA = 240;
const NEAR_WHITE_ALPHA = 200;

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

const INDEX_BADGE = Object.freeze({
  inset: 1,
  pad: 1,
  ink: Object.freeze([255, 255, 255, 255]),
  plate: Object.freeze([8, 8, 12, 255]),
});

const MARK_BORDER = Object.freeze({
  color: Object.freeze([255, 220, 0, 255]),
  width: 2,
});

const GROUP_GRID = Object.freeze({
  axis: Object.freeze([255, 196, 74, 255]),
  line: Object.freeze([145, 215, 255, 72]),
  originInk: Object.freeze([255, 224, 150, 255]),
  label: Object.freeze([203, 238, 255, 255]),
  plate: Object.freeze([8, 8, 12, 255]),
  labelPad: 2,
});

const LABEL_GLYPHS = Object.freeze({
  "-": Object.freeze(["000", "000", "111", "000", "000"]),
  ",": Object.freeze(["011", "111", "111", "011", "110"]),
  ".": Object.freeze(["000", "000", "000", "000", "010"]),
});

const OVERLAY_LABEL_GUTTER = 2;

const HANDLE_FRACTIONS = Object.freeze([0, 0.5, 2 / 3, 1]);
const GROUP_GRID_MIN_CELL = 24;
const GRID_DENSITY_DIVS = Object.freeze({
  sparse: 4,
  normal: 8,
  dense: 16,
});

/**
 * Parses a grip fraction. Accepts 0.666… or "2/3".
 * @param {unknown} value Raw t.
 * @param {number} [fallback=0.5] Default.
 * @returns {number} Fraction in 0–1, or NaN when unusable.
 */
function parseGripT(value, fallback = 0.5) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    const fraction = value.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
    if (fraction) {
      const parsed = Number(fraction[1]) / Number(fraction[2]);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Returns the median of finite numbers.
 * @param {number[]} values Sample.
 * @returns {number} Median, or 0 when empty.
 */
function median(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Builds an inclusive index range.
 * @param {number} start First index.
 * @param {number} end Last index.
 * @returns {number[]} Indexes.
 */
function inclusiveRange(start, end) {
  const order = [];
  for (let index = start; index <= end; index += 1) order.push(index);
  return order;
}

/**
 * Returns the source-canvas foot origin used by tuner/Godot.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {string} [anchorMode] Animation anchor.
 * @returns {{x:number,y:number}} Source pixel of group (0,0).
 */
function canvasAnchor(width, height, anchorMode = "canvas_bottom_center") {
  if (anchorMode === "canvas_left_bottom") return { x: 0, y: height };
  return { x: width / 2, y: height };
}

/**
 * Converts a source-canvas pixel into group/runtime coordinates.
 * @param {number} x Source column.
 * @param {number} y Source row.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {string} [anchorMode] Animation anchor.
 * @returns {{x:number,y:number}} Group point. +x right, +y down; body is negative y.
 */
function canvasToGroup(x, y, width, height, anchorMode = "canvas_bottom_center") {
  const origin = canvasAnchor(width, height, anchorMode);
  return { x: x - origin.x, y: y - origin.y };
}

/**
 * Converts a group/runtime point back onto the source canvas.
 * @param {number} x Group X.
 * @param {number} y Group Y.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {string} [anchorMode] Animation anchor.
 * @returns {{x:number,y:number}} Source pixel.
 */
function groupToCanvas(x, y, width, height, anchorMode = "canvas_bottom_center") {
  const origin = canvasAnchor(width, height, anchorMode);
  return { x: origin.x + x, y: origin.y + y };
}

/**
 * Maps a source pixel into a contact-sheet cell.
 * @param {number} x Source column.
 * @param {number} y Source row.
 * @param {number} sourceWidth Source width.
 * @param {number} sourceHeight Source height.
 * @param {number} cell Cell edge.
 * @returns {{x:number,y:number}} Cell-local pixel.
 */
function canvasToCell(x, y, sourceWidth, sourceHeight, cell) {
  return {
    x: (x * cell) / Math.max(1, sourceWidth),
    y: (y * cell) / Math.max(1, sourceHeight),
  };
}

/**
 * Maps the foot origin onto a painted cell pixel.
 * @param {number} sourceWidth Source width.
 * @param {number} sourceHeight Source height.
 * @param {number} cell Cell edge.
 * @param {string} [anchorMode] Animation anchor.
 * @returns {{x:number,y:number}} Clamped cell-local pixel.
 */
function paintedOriginCell(sourceWidth, sourceHeight, cell, anchorMode) {
  const raw = canvasToCell(
    canvasAnchor(sourceWidth, sourceHeight, anchorMode).x,
    canvasAnchor(sourceWidth, sourceHeight, anchorMode).y,
    sourceWidth,
    sourceHeight,
    cell,
  );
  return {
    x: Math.max(0, Math.min(cell - 1, Math.round(raw.x))),
    y: Math.max(0, Math.min(cell - 1, Math.round(raw.y))),
  };
}

/**
 * Chooses a readable group-grid step in source units.
 * @param {number} cell Cell edge.
 * @param {number} sourceWidth Source width.
 * @returns {number} Step.
 */
function groupGridStep(cell, sourceWidth) {
  const sourcePerPixel = Math.max(1, sourceWidth) / Math.max(1, cell);
  const raw = Math.max(1, (cell / 5) * sourcePerPixel);
  const base = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of [1, 2, 5, 10]) {
    const step = base * multiplier;
    if (step >= raw) return step;
  }
  return base * 10;
}

/**
 * Digit scale used for index badges.
 * @param {number} cell Cell edge.
 * @returns {number} Pixel scale.
 */
function glyphScale(cell) {
  return Math.max(1, Math.floor(cell / 40));
}

/**
 * Overlay tick-number scale. Origin 0,0 uses one step larger.
 * @param {number} cell Cell edge.
 * @returns {number} Pixel scale.
 */
function overlayLabelScale(cell) {
  if (cell < 64) return 1;
  return Math.max(2, Math.min(3, Math.floor(cell / 160) + 1));
}

/**
 * Origin 0,0 is larger than axis ticks so it stays readable in the middle.
 * @param {number} tickScale Axis-tick scale.
 * @returns {number} Origin scale.
 */
function overlayOriginScale(tickScale) {
  const tick = Math.max(1, Number(tickScale) || 1);
  if (tick <= 1) return 1;
  return Math.min(4, tick + 1);
}

/**
 * Glyph box including the dark plate pad.
 * @param {string} text Glyphs.
 * @param {number} scale Pixel scale.
 * @returns {{width:number,height:number}} Plate size.
 */
function overlayPlateSize(text, scale) {
  const size = glyphTextSize(text, scale);
  const pad = GROUP_GRID.labelPad;
  return { width: size.width + 2 * pad, height: size.height + 2 * pad };
}

/**
 * Pixel size of a bitmap label.
 * @param {string} text Glyphs.
 * @param {number} scale Pixel scale.
 * @returns {{width:number,height:number}} Size.
 */
function glyphTextSize(text, scale) {
  const characters = String(text);
  const glyphWidth = 3 * scale;
  const gap = scale;
  return {
    width: characters.length * glyphWidth + Math.max(0, characters.length - 1) * gap,
    height: 5 * scale,
  };
}

/**
 * Looks up a 3×5 glyph.
 * @param {string} character One character.
 * @returns {readonly string[]|null} Glyph rows.
 */
function glyphFor(character) {
  if (character === "-" || character === "," || character === ".") return LABEL_GLYPHS[character];
  if (character >= "0" && character <= "9") return DIGIT_GLYPHS[Number(character)];
  return null;
}

/**
 * Parses an NxN overlay request.
 * @param {unknown} value Raw grid_divs.
 * @returns {{x:number,y:number}|null} Divisions.
 */
function parseGridDivs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 2 || count > 64) {
      throw new Error(`grid_divs axes must be integers from 2 to 64. Received: ${value}`);
    }
    return { x: count, y: count };
  }
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+)\s*[x×*]\s*(\d+)$/u);
  if (!match) throw new Error(`grid_divs must look like "8x8". Received: ${value}`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 2 || y < 2 || x > 64 || y > 64) {
    throw new Error(`grid_divs axes must be integers from 2 to 64. Received: ${value}`);
  }
  return { x, y };
}

/**
 * Normalizes overlay density, divisions, and scope from MCP or renderer options.
 * @param {object} [options] Raw options.
 * @returns {{density:string|null,divs:{x:number,y:number}|null,scope:string,explicit:boolean,subject:object|null}}
 */
function resolveGridSpec(options = {}) {
  const raw = options && typeof options === "object" ? options : {};
  const scope =
    String(raw.scope || raw.gridScope || raw.grid_scope || "canvas").toLowerCase() === "subject"
      ? "subject"
      : "canvas";
  const densityRaw = raw.density || raw.gridDensity || raw.grid_density;
  let density = null;
  if (densityRaw !== undefined && densityRaw !== null && densityRaw !== "") {
    density = String(densityRaw).toLowerCase();
    if (!GRID_DENSITY_DIVS[density]) {
      throw new Error(`grid_density must be one of: sparse, normal, dense. Received: ${densityRaw}`);
    }
  }
  let divs = parseGridDivs(raw.divs || raw.gridDivs || raw.grid_divs);
  const gridXRaw = raw.gridX ?? raw.grid_x;
  const gridYRaw = raw.gridY ?? raw.grid_y;
  const gridX = gridXRaw === undefined || gridXRaw === null || gridXRaw === "" ? null : Number(gridXRaw);
  const gridY = gridYRaw === undefined || gridYRaw === null || gridYRaw === "" ? null : Number(gridYRaw);
  if (Number.isInteger(gridX) || Number.isInteger(gridY)) {
    const x = Number.isInteger(gridX) ? gridX : gridY;
    const y = Number.isInteger(gridY) ? gridY : gridX;
    if (x < 2 || y < 2 || x > 64 || y > 64) {
      throw new Error("grid_x and grid_y must be integers from 2 to 64.");
    }
    divs = { x, y };
  }
  if (!divs && density) divs = { x: GRID_DENSITY_DIVS[density], y: GRID_DENSITY_DIVS[density] };
  const subject = raw.subject && typeof raw.subject === "object" ? raw.subject : null;
  return { density, divs, scope, explicit: Boolean(divs), subject };
}

/**
 * Group-coordinate span covered by the overlay.
 * @param {number} sourceWidth Canvas width.
 * @param {number} sourceHeight Canvas height.
 * @param {string} anchorMode Animation anchor.
 * @param {string} scope canvas or subject.
 * @param {object|null} subject Opaque body box.
 * @returns {{minX:number,maxX:number,minY:number,maxY:number}}
 */
function gridSpan(sourceWidth, sourceHeight, anchorMode, scope, subject) {
  const origin = canvasAnchor(sourceWidth, sourceHeight, anchorMode);
  if (scope === "subject" && subject && Number.isFinite(Number(subject.minX))) {
    return {
      minX: Number(subject.minX) - origin.x,
      maxX: Number(subject.maxX) - origin.x,
      minY: Number(subject.minY) - origin.y,
      maxY: Number(subject.feetY ?? subject.maxY) - origin.y,
    };
  }
  return {
    minX: -origin.x,
    maxX: sourceWidth - origin.x,
    minY: -origin.y,
    maxY: sourceHeight - origin.y,
  };
}

/**
 * Rounds a tick label without turning -0 into a minus.
 * @param {number} group Group coordinate.
 * @returns {number} Rounded value.
 */
function roundTick(group) {
  const rounded = Math.round(Number(group) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * True when a tick sits inside the requested span.
 * @param {string} axis x or y.
 * @param {number} group Group coordinate.
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} span Span.
 * @returns {boolean} Inside.
 */
function tickInSpan(axis, group, span) {
  const slop = 1e-6;
  if (axis === "x") return group >= span.minX - slop && group <= span.maxX + slop;
  return group >= span.minY - slop && group <= span.maxY + slop;
}

/**
 * True when two axis-aligned boxes overlap, optionally with a gutter.
 * @param {{x:number,y:number,width:number,height:number}} left First box.
 * @param {{x:number,y:number,width:number,height:number}} right Second box.
 * @param {number} [gap=0] Extra clearance.
 * @returns {boolean} Overlap.
 */
function boxesOverlap(left, right, gap = 0) {
  const pad = Number(gap) || 0;
  return (
    left.x < right.x + right.width + pad &&
    left.x + left.width + pad > right.x &&
    left.y < right.y + right.height + pad &&
    left.y + left.height + pad > right.y
  );
}

/**
 * Clamps a plate box into the cell without changing its size.
 * @param {{x:number,y:number,width:number,height:number}} box Box.
 * @param {number} cell Cell edge.
 * @returns {{x:number,y:number,width:number,height:number}} Clamped box.
 */
function clampOverlayBox(box, cell) {
  return {
    x: Math.max(0, Math.min(box.x, Math.max(0, cell - box.width))),
    y: Math.max(0, Math.min(box.y, Math.max(0, cell - box.height))),
    width: box.width,
    height: box.height,
  };
}

/**
 * True when a glyph box stays inside the cell.
 * @param {{x:number,y:number,width:number,height:number}} box Box.
 * @param {number} cell Cell edge.
 * @returns {boolean} Inside.
 */
function boxInsideCell(box, cell) {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= cell && box.y + box.height <= cell;
}

/**
 * Maps a group grid line onto a cell pixel. Origin 0 uses the painted axis.
 * @param {object[]} ticks Axis ticks.
 * @param {{x:number,y:number}} originCell Axis pixel.
 * @param {string} axis x or y.
 * @param {number} group Group coordinate.
 * @returns {number|null} Cell pixel, or null when the line is missing.
 */
function linePixel(ticks, originCell, axis, group) {
  const rounded = roundTick(group);
  if (Math.abs(rounded) < 1e-9) return axis === "x" ? originCell.x : originCell.y;
  const tick = ticks.find((entry) => entry.axis === axis && roundTick(entry.group) === rounded);
  if (!tick) return null;
  return axis === "x" ? tick.cell.x : tick.cell.y;
}

/**
 * Builds the AI lookup table: one square per grid cell.
 * cells[row][col] is the top-left group corner. Row 0 is the top of the overlay
 * (most negative y). Col 0 is the left. Origin x=0 and y=0 are inserted so the
 * foot row exists even though ticks skip 0.
 * @param {object[]} ticks Axis ticks.
 * @returns {{xLines:number[],yLines:number[],cells:object[][]}} Map.
 */
function buildOverlayCells(ticks) {
  /**
   * Unique sorted group lines plus the origin.
   * @param {string} axis x or y.
   * @returns {number[]} Lines.
   */
  function linesFor(axis) {
    const lines = [
      ...new Set(ticks.filter((tick) => tick.axis === axis).map((tick) => roundTick(tick.group))),
    ].filter((group) => group !== 0);
    lines.push(0);
    lines.sort((left, right) => left - right);
    return lines;
  }
  const xLines = linesFor("x");
  const yLines = linesFor("y");
  const cells = [];
  for (let row = 0; row < yLines.length - 1; row += 1) {
    const y0 = yLines[row];
    const y1 = yLines[row + 1];
    const line = [];
    for (let col = 0; col < xLines.length - 1; col += 1) {
      const x0 = xLines[col];
      const x1 = xLines[col + 1];
      line.push({
        row,
        col,
        x: x0,
        y: y0,
        x0,
        x1,
        y0,
        y1,
      });
    }
    cells.push(line);
  }
  return { xLines, yLines, cells };
}

/**
 * Last-pixel plant label: white -1 left of the origin, above the foot axis.
 * @param {{x:number,y:number}} originCell Axis pixel.
 * @param {{x:number,y:number}} lastCell Last on-canvas pixel in the cell.
 * @param {{cell:{x:number,y:number},width:number,height:number}} originLabel 0,0 plate.
 * @param {number} cell Cell edge.
 * @param {number} scale Glyph scale.
 * @returns {{axis:string,group:number,text:string,cell:{x:number,y:number},width:number,height:number,scale:number}|null}
 */
function placeLastPixelLabel(originCell, lastCell, originLabel, cell, scale) {
  const text = "-1";
  const size = overlayPlateSize(text, scale);
  let x = originCell.x - size.width - OVERLAY_LABEL_GUTTER;
  let y = lastCell.y - size.height - 1;
  if (y < 0) y = Math.max(0, originCell.y - size.height - 1);
  if (x < 0) x = originLabel.cell.x + originLabel.width + OVERLAY_LABEL_GUTTER;
  const box = clampOverlayBox({ x, y, width: size.width, height: size.height }, cell);
  if (!boxInsideCell(box, cell)) return null;
  const originBox = {
    x: originLabel.cell.x,
    y: originLabel.cell.y,
    width: originLabel.width,
    height: originLabel.height,
  };
  if (boxesOverlap(box, originBox, OVERLAY_LABEL_GUTTER)) return null;
  return {
    axis: "y",
    group: -1,
    text,
    cell: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    scale,
  };
}

/**
 * Places last-pixel -1 plus row/col indices that match grid.cells[row][col].
 * Group coordinates stay in the JSON lookup, not as OCR digits on the overlay.
 * @param {object[]} ticks Grid-line ticks.
 * @param {{x:number,y:number}} originCell Axis pixel.
 * @param {{text:string,cell:{x:number,y:number},width:number,height:number}} originLabel Origin glyph.
 * @param {{x:number,y:number}} lastCell Last on-canvas pixel.
 * @param {number} cell Cell edge.
 * @param {number} scale Glyph scale.
 * @param {{cells:object[][],xLines:number[],yLines:number[]}} overlayCells Code-generated map.
 * @returns {object[]} Painted labels.
 */
function placeOverlayLabels(ticks, originCell, originLabel, lastCell, cell, scale, overlayCells) {
  const occupied = [
    {
      x: originLabel.cell.x,
      y: originLabel.cell.y,
      width: originLabel.width,
      height: originLabel.height,
    },
  ];
  const labels = [];
  /**
   * Accepts one plate when it stays in-cell and clear of occupied boxes.
   * @param {string} axis row, col, or y.
   * @param {number} group Index or group value.
   * @param {string} text Glyphs.
   * @param {{x:number,y:number,width:number,height:number}} box Plate.
   * @returns {void}
   */
  function pushLabel(axis, group, text, box) {
    if (!boxInsideCell(box, cell)) return;
    if (occupied.some((other) => boxesOverlap(box, other, OVERLAY_LABEL_GUTTER))) return;
    occupied.push(box);
    labels.push({
      axis,
      group,
      text,
      cell: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      scale,
    });
  }
  const lastPixel = placeLastPixelLabel(originCell, lastCell, originLabel, cell, scale);
  if (lastPixel) {
    occupied.push({
      x: lastPixel.cell.x,
      y: lastPixel.cell.y,
      width: lastPixel.width,
      height: lastPixel.height,
    });
    labels.push(lastPixel);
  }
  const cells = overlayCells && Array.isArray(overlayCells.cells) ? overlayCells.cells : [];
  if (cell < 160 || !cells.length) return labels;
  const yLines = overlayCells.yLines || [];
  const xLines = overlayCells.xLines || [];
  for (let row = 0; row < cells.length; row += 1) {
    const y0 = linePixel(ticks, originCell, "y", yLines[row]);
    const y1 = linePixel(ticks, originCell, "y", yLines[row + 1]);
    if (y0 == null || y1 == null) continue;
    const text = String(row);
    const size = overlayPlateSize(text, scale);
    const box = clampOverlayBox(
      {
        x: cell - size.width - 2,
        y: Math.round((y0 + y1) / 2 - size.height / 2),
        width: size.width,
        height: size.height,
      },
      cell,
    );
    if (box.x <= originCell.x && originCell.x < box.x + box.width) continue;
    pushLabel("row", row, text, box);
  }
  const colCount = cells[0].length;
  const rowReserve =
    overlayPlateSize(String(Math.max(0, cells.length - 1)), scale).width + OVERLAY_LABEL_GUTTER + 2;
  const colMaxX = Math.max(0, cell - rowReserve);
  for (let col = 0; col < colCount; col += 1) {
    const x0 = linePixel(ticks, originCell, "x", xLines[col]);
    const x1 = linePixel(ticks, originCell, "x", xLines[col + 1]);
    if (x0 == null || x1 == null) continue;
    const text = String(col);
    const size = overlayPlateSize(text, scale);
    let placed = false;
    for (let stagger = 0; stagger < 8 && !placed; stagger += 1) {
      const before = labels.length;
      const box = clampOverlayBox(
        {
          x: Math.round((x0 + x1) / 2 - size.width / 2),
          y: cell - size.height - 2 - stagger * (size.height + 2),
          width: size.width,
          height: size.height,
        },
        cell,
      );
      if (box.x + box.width > colMaxX) box.x = Math.max(0, colMaxX - box.width);
      pushLabel("col", col, text, box);
      placed = labels.length > before;
    }
  }
  return labels;
}

/**
 * 0,0 plate at the axis crossing, above the bottom X-number band.
 * @param {{x:number,y:number}} originCell Axis pixel.
 * @param {number} cell Cell edge.
 * @param {number} originScale Origin glyph scale.
 * @param {number} tickScale Axis-tick scale.
 * @returns {{text:string,cell:{x:number,y:number},width:number,height:number,scale:number}} Label.
 */
function placeOriginLabel(originCell, cell, originScale, tickScale, staggerRows = 2) {
  const originText = "0,0";
  const originSize = overlayPlateSize(originText, originScale);
  const tickH = overlayPlateSize("0", tickScale).height;
  const rows = Math.max(1, Number(staggerRows) || 1);
  const band = rows * (tickH + 2) + 2;
  let originLabelX = originCell.x + 3;
  let originLabelY = cell - band - originSize.height;
  if (originLabelY < 0) originLabelY = Math.max(0, originCell.y - originSize.height - 1);
  if (originLabelX + originSize.width >= cell) originLabelX = originCell.x - originSize.width - 1;
  originLabelX = Math.max(0, Math.min(originLabelX, Math.max(0, cell - originSize.width)));
  originLabelY = Math.max(0, Math.min(originLabelY, Math.max(0, cell - originSize.height)));
  if (
    originLabelX <= originCell.x &&
    originCell.x < originLabelX + originSize.width &&
    originLabelY <= originCell.y &&
    originCell.y < originLabelY + originSize.height
  ) {
    originLabelY = Math.max(0, originCell.y - originSize.height - 1);
  }
  return {
    text: originText,
    cell: { x: originLabelX, y: originLabelY },
    width: originSize.width,
    height: originSize.height,
    scale: originScale,
  };
}

/**
 * Tuner-group overlay metadata for one sheet cell. Overlay only; source frames stay unchanged.
 * @param {number} cell Cell edge.
 * @param {number} sourceWidth Source width.
 * @param {number} sourceHeight Source height.
 * @param {string} [anchorMode] Animation anchor.
 * @param {object} [options] Density, divisions, scope, subject box.
 * @returns {object} Grid descriptor.
 */
function describeGroupGrid(
  cell,
  sourceWidth,
  sourceHeight,
  anchorMode = "canvas_bottom_center",
  options = {},
) {
  const spec = resolveGridSpec(options);
  if (cell < GROUP_GRID_MIN_CELL) {
    return {
      enabled: false,
      overlayOnly: true,
      reason: `cell ${cell} is below ${GROUP_GRID_MIN_CELL}`,
      density: spec.density,
      divs: spec.divs,
      scope: spec.scope,
    };
  }
  const originCanvas = canvasAnchor(sourceWidth, sourceHeight, anchorMode);
  const originCell = paintedOriginCell(sourceWidth, sourceHeight, cell, anchorMode);
  const span = gridSpan(sourceWidth, sourceHeight, anchorMode, spec.scope, spec.subject);
  const ticks = [];
  let step = groupGridStep(cell, sourceWidth);
  let stepX = step;
  let stepY = step;
  /**
   * Pushes one axis tick when it lands inside the painted cell.
   * @param {string} axis x or y.
   * @param {number} group Group coordinate.
   * @returns {void}
   */
  function pushTick(axis, group) {
    if (Math.abs(group) < 1e-9) return;
    if (!tickInSpan(axis, group, span)) return;
    if (axis === "x") {
      const xCanvas = groupToCanvas(group, 0, sourceWidth, sourceHeight, anchorMode);
      const xCell = canvasToCell(xCanvas.x, xCanvas.y, sourceWidth, sourceHeight, cell);
      const x = Math.max(0, Math.min(cell - 1, Math.round(xCell.x)));
      ticks.push({ axis: "x", group: roundTick(group), cell: { x, y: originCell.y } });
      return;
    }
    const yCanvas = groupToCanvas(0, group, sourceWidth, sourceHeight, anchorMode);
    const yCell = canvasToCell(yCanvas.x, yCanvas.y, sourceWidth, sourceHeight, cell);
    const y = Math.max(0, Math.min(cell - 1, Math.round(yCell.y)));
    ticks.push({ axis: "y", group: roundTick(group), cell: { x: originCell.x, y } });
  }
  if (spec.explicit && spec.divs) {
    stepX = (span.maxX - span.minX) / spec.divs.x;
    stepY = (span.maxY - span.minY) / spec.divs.y;
    step = stepX;
    for (let index = 0; index <= spec.divs.x; index += 1) pushTick("x", span.minX + index * stepX);
    for (let index = 0; index <= spec.divs.y; index += 1) pushTick("y", span.minY + index * stepY);
  } else {
    const reach = Math.max(sourceWidth, sourceHeight);
    for (let group = -reach; group <= reach; group += step) {
      pushTick("x", group);
      pushTick("y", group);
    }
  }
  const lastCell = {
    x: originCell.x,
    y: Math.max(
      0,
      Math.min(
        cell - 1,
        Math.round(canvasToCell(originCanvas.x, sourceHeight - 1, sourceWidth, sourceHeight, cell).y),
      ),
    ),
  };
  const overlayCells = buildOverlayCells(ticks);
  let labelScale = overlayLabelScale(cell);
  let originLabel;
  let labels;
  /**
   * Col-index stagger so 0..N plates fit on the bottom edge.
   * @returns {number} Rows.
   */
  function indexStagger() {
    const cells = overlayCells.cells || [];
    if (!cells.length) return 1;
    const colCount = cells[0].length;
    const sample = overlayPlateSize(String(Math.max(0, colCount - 1)), labelScale);
    let step = cell;
    for (let col = 0; col < colCount; col += 1) {
      const x0 = linePixel(ticks, originCell, "x", overlayCells.xLines[col]);
      const x1 = linePixel(ticks, originCell, "x", overlayCells.xLines[col + 1]);
      if (x0 == null || x1 == null) continue;
      const gap = Math.abs(x1 - x0);
      if (gap > 0) step = Math.min(step, gap);
    }
    return Math.max(1, Math.ceil((sample.width + OVERLAY_LABEL_GUTTER) / Math.max(1, step)));
  }
  /**
   * Places 0,0, last-pixel -1, and row/col indices at the current scale.
   * @returns {void}
   */
  function placeAll() {
    const originScale = overlayOriginScale(labelScale);
    originLabel = placeOriginLabel(
      originCell,
      cell,
      originScale,
      labelScale,
      cell >= 160 ? indexStagger() : 1,
    );
    labels = placeOverlayLabels(ticks, originCell, originLabel, lastCell, cell, labelScale, overlayCells);
  }
  /**
   * True when any two painted plates collide including gutter.
   * @returns {boolean} Collision.
   */
  function labelsCollide() {
    const boxes = [
      {
        x: originLabel.cell.x,
        y: originLabel.cell.y,
        width: originLabel.width,
        height: originLabel.height,
      },
      ...labels.map((label) => ({
        x: label.cell.x,
        y: label.cell.y,
        width: label.width,
        height: label.height,
      })),
    ];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (boxesOverlap(boxes[i], boxes[j], OVERLAY_LABEL_GUTTER)) return true;
      }
    }
    return false;
  }
  /**
   * Fraction of row and col indices that received a painted number.
   * @returns {number} 0–1.
   */
  function indexCoverage() {
    const cells = overlayCells.cells || [];
    if (cell < 160 || !cells.length) return 1;
    const rowCount = cells.length;
    const colCount = cells[0].length;
    const rowSet = new Set(labels.filter((label) => label.axis === "row").map((label) => label.text));
    const colSet = new Set(labels.filter((label) => label.axis === "col").map((label) => label.text));
    let rowsHit = 0;
    for (let row = 0; row < rowCount; row += 1) {
      if (rowSet.has(String(row))) rowsHit += 1;
    }
    let colsHit = 0;
    for (let col = 0; col < colCount; col += 1) {
      if (colSet.has(String(col))) colsHit += 1;
    }
    return Math.min(rowsHit / rowCount, colsHit / colCount);
  }
  placeAll();
  const minScale = cell >= 160 ? 2 : 1;
  while (labelScale > minScale) {
    const hasMinus1 = labels.some((label) => label.text === "-1");
    if (!labelsCollide() && hasMinus1 && indexCoverage() >= 1) break;
    labelScale -= 1;
    placeAll();
  }
  const legend = overlayCells.cells.map((row) =>
    row.map((square) => `${square.row},${square.col}=${square.x},${square.y}`).join(" "),
  );
  return {
    enabled: true,
    overlayOnly: true,
    anchorMode,
    ySign: "down",
    density: spec.density,
    divs: spec.divs,
    scope: spec.scope,
    step,
    stepX,
    stepY,
    labelScale,
    origin: {
      group: { x: 0, y: 0 },
      canvas: { x: originCanvas.x, y: originCanvas.y },
      cell: originCell,
    },
    lastPixel: {
      group: { x: 0, y: -1 },
      canvas: { y: sourceHeight - 1 },
    },
    originCell,
    originLabel,
    ticks,
    labels,
    xLines: overlayCells.xLines,
    yLines: overlayCells.yLines,
    cells: overlayCells.cells,
    legend,
    note: "Overlay on the contact sheet only. Source animation PNGs are unchanged. Group (0,0) is the canvas foot origin, same as the tuner stage, but yellow 0,0 is outside the bitmap (canvas y=height). Last pixel row is group y=-1; do not plant soles to 0,0. +x right, +y down; the body is negative y. Grid lines follow density. Overlay paints row/col indices that match grid.cells[row][col] (row 0 = top, col 0 = left). Group x,y are code-generated in cells and legend — do not OCR overlay digits for write-back. Look at boots to pick a square, then use that cell's x,y. metrics.feetY is the boot sole and ignores connected bright slash/glow below it.",
  };
}

/**
 * Estimates group and per-frame visual scales that match a target standing height.
 * Frames shorter than the native median are treated as camera zoom-out.
 * Taller frames (VFX, poses) keep the group scale.
 * @param {number[]} frameHeights Body heights in pixels.
 * @param {number} targetHeight Desired standing height.
 * @param {{zoomRatio?:number}} [options] Zoom detection ratio.
 * @returns {{targetHeight:number,nativeHeight:number,groupScale:number,frames:object[]}}
 */
function estimateVisualScales(frameHeights, targetHeight, options = {}) {
  const heights = (Array.isArray(frameHeights) ? frameHeights : []).map((value) =>
    Math.max(1, Number(value) || 1),
  );
  const nativeHeight = median(heights) || 1;
  const target = Math.max(1, Number(targetHeight) || nativeHeight);
  const equalize = options.equalize === true || options.mode === "equalize";
  if (equalize) {
    const frames = heights.map((height, index) => ({
      index,
      bodyHeight: height,
      scale: Number((target / height).toFixed(3)),
      reason: "equalize",
    }));
    return { targetHeight: target, nativeHeight, groupScale: 1, mode: "equalize", frames };
  }
  const zoomRatio = Math.max(1, Number(options.zoomRatio || 1.12));
  const groupScale = Number((target / nativeHeight).toFixed(3));
  const frames = heights.map((height, index) => {
    if (height * zoomRatio < nativeHeight) {
      return {
        index,
        bodyHeight: height,
        scale: Number((target / height).toFixed(3)),
        reason: "zoom",
      };
    }
    return { index, bodyHeight: height, scale: groupScale, reason: "group" };
  });
  return { targetHeight: target, nativeHeight, groupScale, mode: "shared", frames };
}

/**
 * True when a frame still looks like the opening rest pose.
 * @param {{opaque:number,height:number,cy:number}} frame Frame metrics.
 * @param {{opaque:number,height:number,cy:number}} rest Opening pose.
 * @returns {boolean} Whether the frame matches rest.
 */
function matchesRest(frame, rest) {
  const opaqueSlop = Math.max(1, Math.max(Number(rest.opaque || 0), Number(frame.opaque || 0)) * 0.08);
  const heightSlop = Math.max(1, Math.max(Number(rest.height || 0), Number(frame.height || 0)) * 0.08);
  const cySlop = Math.max(
    1,
    Math.max(Math.abs(Number(rest.cy || 0)), Math.abs(Number(frame.cy || 0))) * 0.08,
  );
  return (
    Math.abs(Number(frame.opaque || 0) - Number(rest.opaque || 0)) <= opaqueSlop &&
    Math.abs(Number(frame.height || 0) - Number(rest.height || 0)) <= heightSlop &&
    Math.abs(Number(frame.cy || 0) - Number(rest.cy || 0)) <= cySlop
  );
}

/**
 * Finds the interior motion window by trimming a leading rest hold and, when
 * the clip returns to that rest, the trailing hold.
 * @param {Array<{opaque:number,height:number,cy:number}>} series Per-frame metrics.
 * @returns {{start:number,end:number,order:number[],activity:number[]}} Window.
 */
function findMotionWindow(series) {
  const frames = Array.isArray(series) ? series : [];
  if (frames.length < 2) {
    return {
      start: 0,
      end: Math.max(0, frames.length - 1),
      order: inclusiveRange(0, frames.length - 1),
      activity: [],
    };
  }
  const rest = frames[0];
  const active = frames.map((frame) => !matchesRest(frame, rest));
  const activity = frames.map((frame, index) => {
    if (index === 0) return 0;
    const previous = frames[index - 1];
    return (
      Math.abs(Number(frame.opaque || 0) - Number(previous.opaque || 0)) +
      Math.abs(Number(frame.height || 0) - Number(previous.height || 0)) +
      Math.abs(Number(frame.cy || 0) - Number(previous.cy || 0))
    );
  });
  let start = active.indexOf(true);
  if (start < 0) {
    return { start: 0, end: frames.length - 1, order: inclusiveRange(0, frames.length - 1), activity };
  }
  let end = frames.length - 1;
  if (matchesRest(frames[frames.length - 1], rest)) {
    end = active.lastIndexOf(true);
  }
  return { start, end, order: inclusiveRange(start, end), activity };
}

/**
 * Measures the standing body and leftover studio white on one RGBA frame.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {{bodyHeight:number,bodyWidth:number,feetY:number,cy:number,opaque:number,nearWhite:number}}
 */
function measureFrame(rgba, width, height) {
  const anchor = subjectAnchor(rgba, width, height);
  let opaque = 0;
  let nearWhite = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset + 3];
    if (alpha <= ALPHA_VISIBLE) continue;
    opaque += 1;
    const luma = 0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2];
    if (luma >= NEAR_WHITE_LUMA && alpha >= NEAR_WHITE_ALPHA) nearWhite += 1;
  }
  return {
    bodyHeight: anchor ? anchor.height : 0,
    bodyWidth: anchor ? anchor.width : 0,
    feetY: anchor ? anchor.feetY : 0,
    cy: anchor ? (anchor.minY + anchor.feetY) / 2 : 0,
    opaque,
    nearWhite,
  };
}

/**
 * Writes one RGBA pixel.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Width.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} a Alpha.
 * @returns {void}
 */
function writePixel(rgba, width, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width) return;
  const height = rgba.length / (width * 4);
  if (y >= height) return;
  const offset = (y * width + x) * 4;
  rgba[offset] = r;
  rgba[offset + 1] = g;
  rgba[offset + 2] = b;
  rgba[offset + 3] = a;
}

/**
 * Fills a rectangle clipped to a cell.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Sheet width.
 * @param {number} left Inclusive left.
 * @param {number} top Inclusive top.
 * @param {number} right Exclusive right.
 * @param {number} bottom Exclusive bottom.
 * @param {readonly number[]} color RGBA color.
 * @param {{x:number,y:number,size:number}} clip Cell clip.
 * @returns {void}
 */
function fillRect(rgba, width, left, top, right, bottom, color, clip) {
  const minX = Math.max(clip.x, left);
  const minY = Math.max(clip.y, top);
  const maxX = Math.min(clip.x + clip.size, right);
  const maxY = Math.min(clip.y + clip.size, bottom);
  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1)
      writePixel(rgba, width, x, y, color[0], color[1], color[2], color[3]);
  }
}

/**
 * Paints one 3×5 glyph.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Sheet width.
 * @param {readonly string[]} glyph Rows of 0/1.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} scale Pixel scale.
 * @param {readonly number[]} color RGBA.
 * @param {{x:number,y:number,size:number}} clip Cell clip.
 * @returns {void}
 */
function drawGlyph(rgba, width, glyph, x, y, scale, color, clip) {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] !== "1") continue;
      fillRect(
        rgba,
        width,
        x + column * scale,
        y + row * scale,
        x + (column + 1) * scale,
        y + (row + 1) * scale,
        color,
        clip,
      );
    }
  }
}

/**
 * Paints a bitmap string.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Sheet width.
 * @param {string} text Glyphs.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} scale Pixel scale.
 * @param {readonly number[]} color RGBA.
 * @param {{x:number,y:number,size:number}} clip Cell clip.
 * @returns {void}
 */
function drawGlyphText(rgba, width, text, x, y, scale, color, clip) {
  let cursorX = x;
  const glyphWidth = 3 * scale;
  const gap = scale;
  for (const character of String(text)) {
    const glyph = glyphFor(character);
    if (glyph) drawGlyph(rgba, width, glyph, cursorX, y, scale, color, clip);
    cursorX += glyphWidth + gap;
  }
}

/**
 * Paints a 0-based index badge into the top-left of one cell.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Sheet width.
 * @param {number} originX Cell left.
 * @param {number} originY Cell top.
 * @param {number} cell Cell edge.
 * @param {number} value Absolute frame index.
 * @returns {void}
 */
function drawIndexBadge(rgba, width, originX, originY, cell, value) {
  const scale = glyphScale(cell);
  const digits = String(Math.max(0, Math.floor(Number(value) || 0)));
  const size = glyphTextSize(digits, scale);
  const plateWidth = INDEX_BADGE.pad * 2 + size.width;
  const plateHeight = INDEX_BADGE.pad * 2 + size.height;
  const plateX = originX + INDEX_BADGE.inset;
  const plateY = originY + INDEX_BADGE.inset;
  const clip = { x: originX, y: originY, size: cell };
  fillRect(rgba, width, plateX, plateY, plateX + plateWidth, plateY + plateHeight, INDEX_BADGE.plate, clip);
  drawGlyphText(
    rgba,
    width,
    digits,
    plateX + INDEX_BADGE.pad,
    plateY + INDEX_BADGE.pad,
    scale,
    INDEX_BADGE.ink,
    clip,
  );
}

/**
 * Projects opaque pixels onto their longest axis (PCA when the mass is diagonal).
 * Axis-aligned mass (small covariance) may follow the AABB major axis so a wide
 * pommel does not flip a vertical blade. The pommel is the end closer to the
 * widest cross-section (guard or forte); the far end is the tip. Endpoints and
 * t stations are opaque pixels.
 * @param {Uint8ClampedArray|Uint8Array} rgba Pixels.
 * @param {number} width Width.
 * @param {number} height Height.
 * @param {{t?:number}} [options] Grip fraction from pommel (0) to tip (1).
 * @returns {object} Axis, fractions, and the requested grip.
 */
function measureLongAxis(rgba, width, height, options = {}) {
  const points = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= ALPHA_VISIBLE) continue;
      points.push({ x, y });
    }
  }
  if (points.length < 8) {
    throw new Error("Image has too few opaque pixels to measure a weapon axis.");
  }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const offAxis = Math.abs(xy) > 0.15 * Math.max(xx, yy, 1);
  let axisX;
  let axisY;
  if (!offAxis && extentY >= extentX * 1.15) {
    axisX = 0;
    axisY = 1;
  } else if (!offAxis && extentX >= extentY * 1.15) {
    axisX = 1;
    axisY = 0;
  } else {
    const trace = xx + yy;
    const det = xx * yy - xy * xy;
    const eigenvalue = trace / 2 + Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
    axisX = xy === 0 && yy >= xx ? 0 : eigenvalue - yy;
    axisY = xy === 0 && yy >= xx ? 1 : xy;
    if (xy === 0 && xx >= yy) {
      axisX = 1;
      axisY = 0;
    }
  }
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength < 1e-9) {
    axisX = extentX >= extentY ? 1 : 0;
    axisY = extentX >= extentY ? 0 : 1;
  } else {
    axisX /= axisLength;
    axisY /= axisLength;
  }
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const point of points) {
    const projection = (point.x - meanX) * axisX + (point.y - meanY) * axisY;
    if (projection < minProj) minProj = projection;
    if (projection > maxProj) maxProj = projection;
  }
  /**
   * Snaps a point onto the nearest opaque pixel toward the centroid.
   * @param {number} x Start x.
   * @param {number} y Start y.
   * @returns {{x:number,y:number}} Integer opaque sample.
   */
  function clampToOpaque(x, y) {
    const dist = Math.hypot(meanX - x, meanY - y);
    const steps = Math.max(1, Math.ceil(dist * 2));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const ix = Math.round(x + (meanX - x) * t);
      const iy = Math.round(y + (meanY - y) * t);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
      if (rgba[(iy * width + ix) * 4 + 3] > ALPHA_VISIBLE) return { x: ix, y: iy };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }
  const minEnd = clampToOpaque(meanX + minProj * axisX, meanY + minProj * axisY);
  const maxEnd = clampToOpaque(meanX + maxProj * axisX, meanY + maxProj * axisY);
  const span = Math.max(0.0001, maxProj - minProj);
  const binCount = 24;
  const binMin = new Array(binCount).fill(Infinity);
  const binMax = new Array(binCount).fill(-Infinity);
  for (const point of points) {
    const projection = (point.x - meanX) * axisX + (point.y - meanY) * axisY;
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor(((projection - minProj) / span) * binCount)));
    const perp = (point.x - meanX) * -axisY + (point.y - meanY) * axisX;
    if (perp < binMin[bin]) binMin[bin] = perp;
    if (perp > binMax[bin]) binMax[bin] = perp;
  }
  let maxWidth = -1;
  let maxBin = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    if (!Number.isFinite(binMin[bin])) continue;
    const widthAt = binMax[bin] - binMin[bin];
    if (widthAt > maxWidth) {
      maxWidth = widthAt;
      maxBin = bin;
    }
  }
  const maxStation = minProj + ((maxBin + 0.5) / binCount) * span;
  const minIsPommel = Math.abs(minProj - maxStation) <= Math.abs(maxProj - maxStation);
  const pommel = minIsPommel ? minEnd : maxEnd;
  const tip = minIsPommel ? maxEnd : minEnd;
  /**
   * Interpolates along the pommel→tip axis.
   * @param {number} t Fraction from pommel.
   * @returns {{x:number,y:number}} Pixel.
   */
  function along(t) {
    const phase = Math.min(1, Math.max(0, Number(t) || 0));
    return clampToOpaque(pommel.x + (tip.x - pommel.x) * phase, pommel.y + (tip.y - pommel.y) * phase);
  }
  const gripT = parseGripT(options.t);
  if (!Number.isFinite(gripT) || gripT < 0 || gripT > 1) {
    throw new Error("t must be a number between 0 and 1.");
  }
  const at = along(gripT);
  const fractions = {};
  for (const fraction of HANDLE_FRACTIONS) {
    fractions[fraction === 2 / 3 ? "2/3" : String(fraction)] = along(fraction);
  }
  return {
    width,
    height,
    center: { x: width / 2, y: height / 2 },
    pommel: { x: pommel.x, y: pommel.y },
    tip: { x: tip.x, y: tip.y },
    length: Math.hypot(tip.x - pommel.x, tip.y - pommel.y),
    direction: {
      x: (tip.x - pommel.x) / Math.max(0.0001, Math.hypot(tip.x - pommel.x, tip.y - pommel.y)),
      y: (tip.y - pommel.y) / Math.max(0.0001, Math.hypot(tip.x - pommel.x, tip.y - pommel.y)),
    },
    t: gripT,
    at,
    localFromCenter: { x: at.x - width / 2, y: at.y - height / 2 },
    fractions,
  };
}

/**
 * Paints workbench-style group axes into one sheet cell.
 * @param {Uint8ClampedArray} rgba Destination.
 * @param {number} width Sheet width.
 * @param {number} originX Cell left.
 * @param {number} originY Cell top.
 * @param {number} cell Cell edge.
 * @param {number} sourceWidth Source width.
 * @param {number} sourceHeight Source height.
 * @param {string} anchorMode Animation anchor.
 * @returns {void}
 */
function drawGroupGrid(
  rgba,
  width,
  originX,
  originY,
  cell,
  sourceWidth,
  sourceHeight,
  anchorMode,
  gridOptions,
) {
  const described = describeGroupGrid(cell, sourceWidth, sourceHeight, anchorMode, gridOptions);
  if (!described.enabled) return;
  const clip = { x: originX, y: originY, size: cell };
  const axisX = originX + described.origin.cell.x;
  const axisY = originY + described.origin.cell.y;
  const scale = described.labelScale || overlayLabelScale(cell);
  const pad = GROUP_GRID.labelPad;
  /**
   * Paints one overlay number with a dark plate behind the glyph.
   * @param {{text:string,cell:{x:number,y:number},width:number,height:number}} label Label.
   * @param {readonly number[]} color Glyph color.
   * @returns {void}
   */
  function drawPlatedLabel(label, color) {
    const glyphScaleUsed = Number(label.scale) || scale;
    fillRect(
      rgba,
      width,
      originX + label.cell.x,
      originY + label.cell.y,
      originX + label.cell.x + label.width,
      originY + label.cell.y + label.height,
      GROUP_GRID.plate,
      clip,
    );
    drawGlyphText(
      rgba,
      width,
      label.text,
      originX + label.cell.x + pad,
      originY + label.cell.y + pad,
      glyphScaleUsed,
      color,
      clip,
    );
  }
  for (const tick of described.ticks) {
    if (tick.axis === "x") {
      const x = originX + tick.cell.x;
      fillRect(rgba, width, x, originY, x + 1, originY + cell, GROUP_GRID.line, clip);
    } else {
      const y = originY + tick.cell.y;
      fillRect(rgba, width, originX, y, originX + cell, y + 1, GROUP_GRID.line, clip);
    }
  }
  fillRect(rgba, width, axisX, originY, axisX + 1, originY + cell, GROUP_GRID.axis, clip);
  fillRect(rgba, width, originX, axisY, originX + cell, axisY + 1, GROUP_GRID.axis, clip);
  for (const label of described.labels || []) {
    drawPlatedLabel(label, GROUP_GRID.label);
  }
  if (described.originLabel) drawPlatedLabel(described.originLabel, GROUP_GRID.originInk);
  writePixel(
    rgba,
    width,
    axisX,
    axisY,
    GROUP_GRID.originInk[0],
    GROUP_GRID.originInk[1],
    GROUP_GRID.originInk[2],
    GROUP_GRID.originInk[3],
  );
}

function drawMarkBorder(rgba, width, originX, originY, cell) {
  const thickness = Math.max(1, Math.min(MARK_BORDER.width, Math.floor(cell / 4)));
  const color = MARK_BORDER.color;
  for (let t = 0; t < thickness; t += 1) {
    for (let x = 0; x < cell; x += 1) {
      writePixel(rgba, width, originX + x, originY + t, color[0], color[1], color[2], color[3]);
      writePixel(rgba, width, originX + x, originY + cell - 1 - t, color[0], color[1], color[2], color[3]);
    }
    for (let y = 0; y < cell; y += 1) {
      writePixel(rgba, width, originX + t, originY + y, color[0], color[1], color[2], color[3]);
      writePixel(rgba, width, originX + cell - 1 - t, originY + y, color[0], color[1], color[2], color[3]);
    }
  }
}

/**
 * Renders a contact sheet that scales every source canvas into a shared cell.
 * @param {Array<{data:Uint8ClampedArray,width:number,height:number}>} frames Source frames.
 * @param {{cell?:number,pad?:number,columns?:number,startIndex?:number,frameIndexes?:number[],markFrame?:number,labels?:boolean}} [options] Layout.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Sheet.
 */
function renderContactSheet(frames, options = {}) {
  const items = Array.isArray(frames) ? frames : [];
  const cell = Math.max(8, Number(options.cell || 220));
  const pad = Math.max(1, Number(options.pad || 8));
  const columns = Math.max(1, Number(options.columns || Math.min(items.length || 1, 8)));
  const startIndex = Math.max(0, Math.floor(Number(options.startIndex || 0)));
  const labels = options.labels !== false;
  const grid = options.grid !== false;
  const plant = grid;
  const normalize = String(options.normalize || "cell");
  const guides = options.guides === true;
  const { blitFrameIntoCell } = require("./xsxb_mcp_lock");
  const anchorMode = String(options.anchorMode || "canvas_bottom_center");
  const markFrame = options.markFrame === undefined ? startIndex : Number(options.markFrame);
  const rows = Math.max(1, Math.ceil((items.length || 1) / columns));
  const width = columns * cell + (columns + 1) * pad;
  const height = rows * cell + (rows + 1) * pad;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) writePixel(rgba, width, x, y, 40, 40, 44, 255);
  }
  items.forEach((frame, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const originX = pad + column * (cell + pad);
    const originY = pad + row * (cell + pad);
    const absoluteIndex = options.frameIndexes?.[index] ?? startIndex + index;
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 200 : 150;
        writePixel(rgba, width, originX + x, originY + y, checker, checker, checker, 255);
      }
    }
    if (frame?.width && frame?.height) {
      if (normalize === "cell") {
        for (let y = 0; y < cell; y += 1) {
          for (let x = 0; x < cell; x += 1) {
            const sourceX = Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / cell));
            const sourceY = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / cell));
            const source = (sourceY * frame.width + sourceX) * 4;
            if (frame.data[source + 3] <= 16) continue;
            writePixel(
              rgba,
              width,
              originX + x,
              originY + y,
              frame.data[source],
              frame.data[source + 1],
              frame.data[source + 2],
              255,
            );
          }
        }
      } else {
        blitFrameIntoCell({ data: rgba, width }, frame, originX, originY, cell, normalize, plant);
      }
    }
    if (guides) {
      const footY = originY + cell - 1;
      const headY = originY + 1;
      for (let x = 0; x < cell; x += 1) {
        writePixel(rgba, width, originX + x, footY, 220, 32, 32, 255);
        writePixel(rgba, width, originX + x, headY, 32, 180, 64, 255);
      }
    }
    if (grid && frame?.width && frame?.height) {
      const gridOptions = {
        density: options.gridDensity || options.density,
        divs: options.gridDivs || options.divs,
        gridX: options.gridX,
        gridY: options.gridY,
        scope: options.gridScope || options.scope,
        subject:
          String(options.gridScope || options.scope || "canvas") === "subject"
            ? subjectAnchor(frame.data, frame.width, frame.height)
            : null,
      };
      drawGroupGrid(rgba, width, originX, originY, cell, frame.width, frame.height, anchorMode, gridOptions);
    }
    if (labels) drawIndexBadge(rgba, width, originX, originY, cell, absoluteIndex);
    if (grid && Number.isInteger(markFrame) && markFrame === absoluteIndex) {
      drawMarkBorder(rgba, width, originX, originY, cell);
    }
    if (grid && frame?.width && frame?.height && cell >= GROUP_GRID_MIN_CELL) {
      const origin = paintedOriginCell(frame.width, frame.height, cell, anchorMode);
      writePixel(
        rgba,
        width,
        originX + origin.x,
        originY + origin.y,
        GROUP_GRID.originInk[0],
        GROUP_GRID.originInk[1],
        GROUP_GRID.originInk[2],
        GROUP_GRID.originInk[3],
      );
    }
  });
  return { data: rgba, width, height };
}

/**
 * Measures every PNG path in order.
 * @param {string[]} filePaths Absolute PNG paths.
 * @returns {Array<object>} Per-frame metrics with index.
 */
function measureFrameFiles(filePaths) {
  return (Array.isArray(filePaths) ? filePaths : []).map((filePath, index) => {
    const image = decodePngRgba(filePath);
    return { index, ...measureFrame(image.data, image.width, image.height) };
  });
}

/**
 * Summarizes a list of frame metrics.
 * @param {Array<{bodyHeight:number,nearWhite:number}>} frames Measured frames.
 * @returns {{bodyHeight:{min:number,max:number,median:number},nearWhiteTotal:number,frames:object[]}}
 */
function summarizeMetrics(frames) {
  const heights = frames.map((frame) => Number(frame.bodyHeight || 0));
  return {
    bodyHeight: {
      min: heights.length ? Math.min(...heights) : 0,
      max: heights.length ? Math.max(...heights) : 0,
      median: median(heights),
    },
    nearWhiteTotal: frames.reduce((sum, frame) => sum + Number(frame.nearWhite || 0), 0),
    frames,
  };
}

module.exports = {
  DIGIT_GLYPHS,
  GRID_DENSITY_DIVS,
  GROUP_GRID,
  GROUP_GRID_MIN_CELL,
  HANDLE_FRACTIONS,
  INDEX_BADGE,
  MARK_BORDER,
  canvasAnchor,
  canvasToCell,
  canvasToGroup,
  describeGroupGrid,
  estimateVisualScales,
  findMotionWindow,
  groupGridStep,
  groupToCanvas,
  inclusiveRange,
  measureFrame,
  measureFrameFiles,
  measureLongAxis,
  median,
  paintedOriginCell,
  parseGripT,
  renderContactSheet,
  resolveGridSpec,
  summarizeMetrics,
};
