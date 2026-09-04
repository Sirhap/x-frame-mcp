"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { decodePngRgba, encodePngRgba, subjectAnchor } = require("../xsxb_mcp_cutout");
const { createXsxbMcpService } = require("../xsxb_mcp_service");
const {
  DIGIT_GLYPHS,
  GROUP_GRID,
  INDEX_BADGE,
  MARK_BORDER,
  canvasToGroup,
  describeGroupGrid,
  estimateVisualScales,
  findMotionWindow,
  groupToCanvas,
  measureFrame,
  measureLongAxis,
  renderContactSheet,
} = require("../xsxb_mcp_visual_qa");

/**
 * Fills one RGBA pixel.
 * @param {Uint8ClampedArray} rgba Pixel buffer.
 * @param {number} width Image width.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {number[]} color RGBA color.
 * @returns {void}
 */
function setPixel(rgba, width, x, y, color) {
  rgba.set(color, (y * width + x) * 4);
}

/**
 * Builds a transparent canvas with an opaque block.
 * @param {number} canvas Edge length.
 * @param {number} bodyW Body width.
 * @param {number} bodyH Body height.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function bodyFrame(canvas, bodyW, bodyH) {
  const rgba = new Uint8ClampedArray(canvas * canvas * 4);
  const left = Math.floor((canvas - bodyW) / 2);
  const top = canvas - bodyH - 1;
  for (let y = top; y < top + bodyH; y += 1) {
    for (let x = left; x < left + bodyW; x += 1) {
      setPixel(rgba, canvas, x, y, [210, 36, 42, 255]);
    }
  }
  return { data: rgba, width: canvas, height: canvas };
}

test("estimateVisualScales uses the median as native height and only boosts zoomed-out frames", () => {
  const estimated = estimateVisualScales([12, 20, 20, 20, 28], 20);
  assert.equal(estimated.nativeHeight, 20);
  assert.equal(estimated.targetHeight, 20);
  assert.equal(estimated.groupScale, 1);
  assert.equal(estimated.frames[0].reason, "zoom");
  assert.equal(estimated.frames[0].scale, 1.667);
  assert.equal(estimated.frames[1].reason, "group");
  assert.equal(estimated.frames[4].reason, "group", "taller VFX/pose keeps the group scale");
  assert.equal(estimated.frames[4].scale, 1);
});

test("estimateVisualScales matches a foreign target height", () => {
  const estimated = estimateVisualScales([40, 40, 40], 20);
  assert.equal(estimated.groupScale, 0.5);
  assert.ok(estimated.frames.every((frame) => frame.scale === 0.5));
});

test("findMotionWindow drops leading and trailing holds", () => {
  const series = [
    { opaque: 10, height: 8, cy: 10 },
    { opaque: 10, height: 8, cy: 10 },
    { opaque: 10, height: 8, cy: 10 },
    { opaque: 14, height: 9, cy: 8 },
    { opaque: 18, height: 11, cy: 6 },
    { opaque: 16, height: 10, cy: 7 },
    { opaque: 10, height: 8, cy: 10 },
    { opaque: 10, height: 8, cy: 10 },
  ];
  const found = findMotionWindow(series);
  assert.equal(found.start, 3);
  assert.equal(found.end, 5);
  assert.deepEqual(found.order, [3, 4, 5]);
});

test("measureFrame reports body height and leftover near-white", () => {
  const frame = bodyFrame(16, 4, 8);
  setPixel(frame.data, 16, 2, 2, [250, 250, 250, 255]);
  const metrics = measureFrame(frame.data, 16, 16);
  assert.equal(metrics.bodyHeight, 8);
  assert.equal(metrics.nearWhite, 1);
  assert.ok(metrics.opaque >= 32);
});

test("renderContactSheet places every source frame into a shared cell grid", () => {
  const sheet = renderContactSheet([bodyFrame(16, 4, 8), bodyFrame(16, 4, 8)], {
    cell: 8,
    pad: 2,
    columns: 2,
  });
  assert.equal(sheet.width, 2 * 8 + 3 * 2);
  assert.equal(sheet.height, 8 + 4);
  assert.equal(sheet.data.length, sheet.width * sheet.height * 4);
  assert.ok(sheet.data.some((value, index) => index % 4 === 3 && value > 16));
});

test("grid=false contact sheet keeps pixels below feetY", () => {
  const width = 32;
  const height = 32;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y <= 20; y += 1) {
    for (let x = 12; x <= 19; x += 1) setPixel(rgba, width, x, y, [210, 36, 42, 255]);
  }
  for (let x = 12; x <= 19; x += 1) setPixel(rgba, width, x, 28, [0, 220, 255, 255]);
  const frame = { data: rgba, width, height };
  const planted = renderContactSheet([frame], {
    cell: 32,
    pad: 2,
    columns: 1,
    grid: true,
    normalize: "none",
    labels: false,
  });
  const look = renderContactSheet([frame], {
    cell: 32,
    pad: 2,
    columns: 1,
    grid: false,
    normalize: "none",
    labels: false,
  });
  const countCyan = (sheet) => {
    let count = 0;
    for (let offset = 0; offset < sheet.data.length; offset += 4) {
      if (sheet.data[offset] === 0 && sheet.data[offset + 1] === 220 && sheet.data[offset + 2] === 255) {
        count += 1;
      }
    }
    return count;
  };
  assert.equal(countCyan(planted), 0, "planting sheets clip pixels below feetY");
  assert.equal(countCyan(look), 8, "look sheets must blit the full canvas including ice below the boots");
});

/**
 * Reads one RGBA pixel from a sheet.
 * @param {{data:Uint8ClampedArray,width:number}} sheet Sheet buffer.
 * @param {number} x Column.
 * @param {number} y Row.
 * @returns {number[]} RGBA.
 */
function pixelAt(sheet, x, y) {
  const offset = (y * sheet.width + x) * 4;
  return [sheet.data[offset], sheet.data[offset + 1], sheet.data[offset + 2], sheet.data[offset + 3]];
}

test("renderContactSheet paints absolute frame indexes from the shared glyph table", () => {
  const sheet = renderContactSheet([bodyFrame(16, 4, 8), bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 2,
    startIndex: 7,
  });
  const originX = 4 + INDEX_BADGE.inset + INDEX_BADGE.pad;
  const originY = 4 + INDEX_BADGE.inset + INDEX_BADGE.pad;
  const glyph = DIGIT_GLYPHS[7];
  assert.equal(glyph.length, 5);
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      const expected = glyph[row][column] === "1" ? INDEX_BADGE.ink : INDEX_BADGE.plate;
      assert.deepEqual(pixelAt(sheet, originX + column, originY + row), expected);
    }
  }
});

test("canvas_bottom_center maps the canvas foot to group origin", () => {
  assert.deepEqual(canvasToGroup(8, 16, 16, 16, "canvas_bottom_center"), { x: 0, y: 0 });
  assert.deepEqual(canvasToGroup(10, 10, 16, 16, "canvas_bottom_center"), { x: 2, y: -6 });
  assert.deepEqual(groupToCanvas(0, -8, 16, 16, "canvas_bottom_center"), { x: 8, y: 8 });
});

test("renderContactSheet paints the group origin on the shared axis color", () => {
  const sheet = renderContactSheet([bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 1,
    grid: true,
    labels: false,
    markFrame: -1,
  });
  const originX = 4 + 16;
  const originY = 4 + 31;
  assert.deepEqual(pixelAt(sheet, originX, originY), GROUP_GRID.originInk);
  assert.deepEqual(pixelAt(sheet, originX, 4 + 16), GROUP_GRID.axis, "vertical axis through the body");
});

test("describeGroupGrid matches tuner foot origin and lists negative-y body ticks", () => {
  const described = describeGroupGrid(32, 16, 16, "canvas_bottom_center");
  assert.equal(described.enabled, true);
  assert.equal(described.overlayOnly, true);
  assert.equal(described.ySign, "down");
  assert.deepEqual(described.origin.group, { x: 0, y: 0 });
  assert.deepEqual(described.origin.canvas, { x: 8, y: 16 });
  assert.equal(described.originLabel.text, "0,0");
  assert.ok(described.ticks.some((tick) => tick.axis === "y" && tick.group < 0));
});

test("describeGroupGrid lastPixel is the in-bitmap sole row, not yellow 0,0", () => {
  const height = 384;
  const width = 160;
  const described = describeGroupGrid(160, width, height, "canvas_bottom_center");
  assert.deepEqual(described.lastPixel.group, { x: 0, y: -1 });
  assert.equal(described.lastPixel.canvas.y, height - 1);
  assert.equal(canvasToGroup(width / 2, height - 1, width, height).y, -1);
  assert.equal(groupToCanvas(0, 0, width, height).y, height);
  assert.match(described.note, /y=-1/);
  assert.match(described.note, /ignores connected bright slash/);
});

test("describeGroupGrid 4x4 is sparser than 16x16 on the same 16 canvas", () => {
  const sparse = describeGroupGrid(32, 16, 16, "canvas_bottom_center", { divs: "4x4" });
  const dense = describeGroupGrid(32, 16, 16, "canvas_bottom_center", { divs: "16x16" });
  assert.equal(sparse.enabled, true);
  assert.equal(sparse.overlayOnly, true);
  assert.equal(sparse.scope, "canvas");
  assert.deepEqual(sparse.divs, { x: 4, y: 4 });
  assert.equal(sparse.stepX, 4);
  assert.equal(sparse.stepY, 4);
  assert.deepEqual(dense.divs, { x: 16, y: 16 });
  assert.equal(dense.stepX, 1);
  assert.ok(dense.ticks.length > sparse.ticks.length);
  const sheet = renderContactSheet([bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 1,
    grid: true,
    labels: false,
    markFrame: -1,
    gridDivs: "4x4",
  });
  const xTick = sparse.ticks.find((tick) => tick.axis === "x" && tick.group === 4);
  assert.ok(xTick);
  assert.deepEqual(pixelAt(sheet, 4 + xTick.cell.x, 4 + 16), GROUP_GRID.line);
});

test("describeGroupGrid density sparse matches 4x4 and dense matches 16x16", () => {
  const sparse = describeGroupGrid(32, 16, 16, "canvas_bottom_center", { density: "sparse" });
  const dense = describeGroupGrid(32, 16, 16, "canvas_bottom_center", { density: "dense" });
  assert.equal(sparse.density, "sparse");
  assert.deepEqual(sparse.divs, { x: 4, y: 4 });
  assert.equal(dense.density, "dense");
  assert.deepEqual(dense.divs, { x: 16, y: 16 });
  assert.ok(dense.ticks.length > sparse.ticks.length);
});

test("describeGroupGrid subject scope keeps ticks on the opaque body box", () => {
  const frame = bodyFrame(16, 4, 8);
  const body = subjectAnchor(frame.data, frame.width, frame.height);
  assert.ok(body);
  const described = describeGroupGrid(32, 16, 16, "canvas_bottom_center", {
    density: "dense",
    scope: "subject",
    subject: body,
  });
  assert.equal(described.scope, "subject");
  assert.ok(described.ticks.length > 0);
  for (const tick of described.ticks) {
    const canvas =
      tick.axis === "x"
        ? groupToCanvas(tick.group, 0, 16, 16, "canvas_bottom_center")
        : groupToCanvas(0, tick.group, 16, 16, "canvas_bottom_center");
    if (tick.axis === "x") {
      assert.ok(canvas.x >= body.minX - 0.51 && canvas.x <= body.maxX + 0.51, `x tick ${tick.group}`);
    } else {
      assert.ok(canvas.y >= body.minY - 0.51 && canvas.y <= body.feetY + 0.51, `y tick ${tick.group}`);
    }
  }
});

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
 * Collects originLabel plus axis labels as boxes.
 * @param {object} described Grid descriptor.
 * @returns {{text:string,x:number,y:number,width:number,height:number}[]} Boxes.
 */
function paintedLabelBoxes(described) {
  return [
    {
      text: described.originLabel.text,
      x: described.originLabel.cell.x,
      y: described.originLabel.cell.y,
      width: described.originLabel.width,
      height: described.originLabel.height,
    },
    ...described.labels.map((label) => ({
      text: label.text,
      x: label.cell.x,
      y: label.cell.y,
      width: label.width,
      height: label.height,
    })),
  ];
}

test("explicit 8x8 overlay cells cover cols 0–7 on a 320 canvas", () => {
  const described = describeGroupGrid(160, 320, 320, "canvas_bottom_center", { grid_divs: "8x8" });
  assert.deepEqual(described.divs, { x: 8, y: 8 });
  assert.equal(described.cells.length, 8, "8 rows");
  assert.equal(described.cells[0].length, 8, "col 7 / group x=120 must exist for write-back");
  assert.equal(described.cells[0][7].col, 7);
  assert.ok(
    described.cells[0][7].x0 >= 100,
    `last column should start near x=120, got ${described.cells[0][7].x0}`,
  );
});

test("overlay paints row/col indices; group coords live in code-generated cells", () => {
  const described = describeGroupGrid(160, 384, 384, "canvas_bottom_center", { density: "dense" });
  assert.equal(described.enabled, true);
  assert.ok(described.ticks.length > 16, "grid lines stay dense");
  assert.equal(described.originLabel.text, "0,0");
  assert.ok(
    described.labels.some((label) => label.text === "-1"),
    "last-pixel plant row -1 must be painted",
  );
  const large = describeGroupGrid(360, 384, 384, "canvas_bottom_center", { density: "dense" });
  assert.equal(large.originLabel.text, "0,0");
  assert.ok(
    large.labels.some((label) => label.text === "-1"),
    "360-cell still paints -1",
  );
  assert.ok(Array.isArray(large.cells) && large.cells.length > 1, "AI lookup is a 2d cells array");
  assert.ok(Array.isArray(large.cells[0]) && large.cells[0].length > 1, "cells[row][col]");
  const rows = large.cells.length;
  const cols = large.cells[0].length;
  for (let row = 0; row < rows; row += 1) {
    assert.ok(
      large.labels.some((label) => label.axis === "row" && label.text === String(row)),
      `overlay must paint row index ${row} matching cells[${row}]`,
    );
  }
  for (let col = 0; col < cols; col += 1) {
    assert.ok(
      large.labels.some((label) => label.axis === "col" && label.text === String(col)),
      `overlay must paint col index ${col} matching cells[*][${col}]`,
    );
  }
  assert.equal(
    large.labels.some((label) => label.text === "-384" || label.text === "-48"),
    false,
    "group coordinates belong in cells JSON, not overlay OCR digits",
  );
  assert.equal(large.cells[0][0].row, 0);
  assert.equal(large.cells[0][0].col, 0);
  assert.ok(
    large.cells[0][0].y < large.cells[large.cells.length - 1][0].y,
    "row 0 is the top (more negative y)",
  );
  assert.ok(large.cells[0][0].x < large.cells[0][large.cells[0].length - 1].x, "col 0 is the left");
  const originCol = large.cells[0].findIndex((square) => square.x0 <= 0 && square.x1 >= 0);
  const originRow = large.cells.findIndex((row) => row[0].y0 <= -1 && row[0].y1 >= 0);
  assert.ok(originCol >= 0, "a column covers x=0");
  assert.ok(originRow >= 0, "a row covers last-pixel y=-1 to origin y=0");
  const square = large.cells[originRow][originCol];
  assert.equal(square.x0 <= 0 && square.x1 >= 0, true);
  const hasNeg48 = large.cells.some((row) =>
    row.some((cell) => cell.y0 <= -48 && cell.y1 >= -48 && cell.x0 <= 0 && cell.x1 >= 0),
  );
  assert.equal(hasNeg48, true, "the array must contain the square covering (0,-48)");
  assert.ok(
    Array.isArray(large.legend) && large.legend.length === rows,
    "legend is one code-generated line per row",
  );
  assert.match(String(large.legend[originRow]), new RegExp(`${originRow},${originCol}=`));
  assert.match(String(large.note), /cells\[row\]\[col\]/);
  assert.match(String(large.note), /do not OCR|OCR/i);
  const painted = paintedLabelBoxes(described);
  for (const box of painted) {
    assert.ok(box.x >= 0 && box.y >= 0, "label stays in the cell");
    assert.ok(box.x + box.width <= 160 && box.y + box.height <= 160, "label stays in the cell");
  }
  for (let i = 0; i < painted.length; i += 1) {
    for (let j = i + 1; j < painted.length; j += 1) {
      assert.equal(
        boxesOverlap(painted[i], painted[j], 2),
        false,
        `label ${painted[i].text} overlaps ${painted[j].text} without gutter`,
      );
    }
  }
});

test("dense 384 overlay ink for one endpoint does not cover another", () => {
  const described = describeGroupGrid(160, 384, 384, "canvas_bottom_center", { density: "dense" });
  const sheet = renderContactSheet([bodyFrame(384, 80, 160)], {
    cell: 160,
    pad: 4,
    columns: 1,
    grid: true,
    labels: false,
    markFrame: -1,
    gridDensity: "dense",
  });
  const pad = 4;
  const labelInk = [];
  for (const label of described.labels) {
    const hits = [];
    for (let y = 0; y < label.height; y += 1) {
      for (let x = 0; x < label.width; x += 1) {
        const color = pixelAt(sheet, pad + label.cell.x + x, pad + label.cell.y + y);
        if (
          color[0] === GROUP_GRID.label[0] &&
          color[1] === GROUP_GRID.label[1] &&
          color[2] === GROUP_GRID.label[2]
        ) {
          hits.push(`${x},${y}`);
        }
      }
    }
    assert.ok(hits.length > 0, `painted number ${label.text} must be visible`);
    labelInk.push({
      text: label.text,
      hits: new Set(hits.map((hit) => `${label.cell.x}:${label.cell.y}:${hit}`)),
    });
  }
  for (let i = 0; i < labelInk.length; i += 1) {
    for (let j = i + 1; j < labelInk.length; j += 1) {
      for (const hit of labelInk[i].hits) {
        assert.equal(
          labelInk[j].hits.has(hit),
          false,
          `${labelInk[i].text} shares ink with ${labelInk[j].text}`,
        );
      }
    }
  }
});

test("renderContactSheet writes 0,0 on the overlay without covering the origin pixel", () => {
  const described = describeGroupGrid(32, 16, 16, "canvas_bottom_center");
  const sheet = renderContactSheet([bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 1,
    grid: true,
    labels: false,
    markFrame: -1,
  });
  const originX = 4 + described.origin.cell.x;
  const originY = 4 + described.origin.cell.y;
  assert.deepEqual(pixelAt(sheet, originX, originY), GROUP_GRID.originInk);
  const plateX = 4 + described.originLabel.cell.x;
  const plateY = 4 + described.originLabel.cell.y;
  const platePx = pixelAt(sheet, plateX, plateY);
  assert.ok(
    platePx[0] < 40 && platePx[1] < 40 && platePx[2] < 40,
    `dark plate behind 0,0, got ${platePx.join(",")}`,
  );
  const inkPad = Number(GROUP_GRID.labelPad) || 1;
  const glyph = DIGIT_GLYPHS[0];
  assert.deepEqual(
    pixelAt(sheet, plateX + inkPad, plateY + inkPad),
    GROUP_GRID.originInk,
    "origin label starts with 0 after the plate pad",
  );
  assert.equal(glyph[0][0], "1");
  assert.notEqual(plateY + inkPad, originY);
});

test("renderContactSheet grid false omits 0,0 and -1 overlay ink", () => {
  const described = describeGroupGrid(32, 16, 16, "canvas_bottom_center");
  const sheet = renderContactSheet([bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 1,
    grid: false,
    labels: false,
    markFrame: -1,
  });
  const originX = 4 + described.origin.cell.x;
  const originY = 4 + described.origin.cell.y;
  assert.notDeepEqual(
    pixelAt(sheet, originX, originY),
    GROUP_GRID.originInk,
    "grid:false must not paint the yellow 0,0 landmark",
  );
  const plateX = 4 + described.originLabel.cell.x;
  const plateY = 4 + described.originLabel.cell.y;
  assert.notDeepEqual(
    pixelAt(sheet, plateX, plateY),
    [0, 0, 0, 255],
    "grid:false must not paint the dark 0,0 plate",
  );
});

test("dense 384 overlay ink paints -1 and a chunky 0,0 comma", () => {
  const cell = 360;
  const pad = 4;
  const described = describeGroupGrid(cell, 384, 384, "canvas_bottom_center", { density: "dense" });
  const minusOne = described.labels.find((label) => label.text === "-1");
  assert.ok(minusOne, "receipt labels must include painted -1");
  const sheet = renderContactSheet([bodyFrame(384, 80, 160)], {
    cell,
    pad,
    columns: 1,
    grid: true,
    labels: false,
    markFrame: -1,
    gridDensity: "dense",
  });
  let minusInk = 0;
  for (let y = 0; y < minusOne.height; y += 1) {
    for (let x = 0; x < minusOne.width; x += 1) {
      const color = pixelAt(sheet, pad + minusOne.cell.x + x, pad + minusOne.cell.y + y);
      if (
        color[0] === GROUP_GRID.label[0] &&
        color[1] === GROUP_GRID.label[1] &&
        color[2] === GROUP_GRID.label[2]
      ) {
        minusInk += 1;
      }
    }
  }
  assert.ok(minusInk > 0, "painted -1 must be visible");
  const scale = described.originLabel.scale || described.labelScale;
  const inkPad = Number(GROUP_GRID.labelPad) || 1;
  const glyphX = pad + described.originLabel.cell.x + inkPad;
  const glyphY = pad + described.originLabel.cell.y + inkPad;
  const commaX = glyphX + 4 * scale;
  const commaW = 3 * scale;
  const commaH = 5 * scale;
  let commaInk = 0;
  let commaInkAboveLastRow = 0;
  for (let y = 0; y < commaH; y += 1) {
    for (let x = 0; x < commaW; x += 1) {
      const color = pixelAt(sheet, commaX + x, glyphY + y);
      if (
        color[0] === GROUP_GRID.originInk[0] &&
        color[1] === GROUP_GRID.originInk[1] &&
        color[2] === GROUP_GRID.originInk[2]
      ) {
        commaInk += 1;
        if (y < 4 * scale) commaInkAboveLastRow += 1;
      }
    }
  }
  assert.ok(commaInk > 0, "0,0 comma must paint ink, not an empty gap that reads as 0.0");
  assert.ok(commaInkAboveLastRow > 0, "comma must not be a one-row decimal-point speck");
  assert.ok(
    commaInk >= 4 * scale * scale,
    `comma glyph too thin (${commaInk} px at scale ${scale}); zeros would read as 0.0`,
  );
});

test("measureLongAxis reports pommel, tip, and handle fractions on a tapered blade", () => {
  const width = 16;
  const height = 32;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 2; y <= 28; y += 1) {
    const taper = y < 10 ? 0 : y < 20 ? 1 : 2;
    for (let x = 7 - taper; x <= 8 + taper; x += 1) {
      setPixel(rgba, width, x, y, [180, 180, 190, 255]);
    }
  }
  const measured = measureLongAxis(rgba, width, height, { t: 2 / 3 });
  assert.ok(measured.tip.y < measured.pommel.y, "thinner end is the tip");
  assert.equal(measured.fractions["0"].y, measured.pommel.y);
  assert.equal(measured.fractions["1"].y, measured.tip.y);
  const midY = (measured.pommel.y + measured.tip.y) / 2;
  assert.ok(Math.abs(measured.fractions["0.5"].y - midY) < 1.5);
  const twoThirdsY = measured.pommel.y + (measured.tip.y - measured.pommel.y) * (2 / 3);
  assert.ok(Math.abs(measured.at.y - twoThirdsY) < 1.5);
  assert.ok(Math.abs(measured.at.x - 7.5) < 1.5, "grip stays on the shaft centerline");
  assert.deepEqual(measured.localFromCenter, {
    x: measured.at.x - width / 2,
    y: measured.at.y - height / 2,
  });
});

test("measureLongAxis keeps grips on the centerline of a wide pommel", () => {
  const width = 32;
  const height = 48;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 2; y <= 44; y += 1) {
    const half = y < 12 ? 1 : y < 32 ? 2 : 10;
    for (let x = 16 - half; x <= 15 + half; x += 1) {
      setPixel(rgba, width, x, y, [180, 180, 190, 255]);
    }
  }
  const measured = measureLongAxis(rgba, width, height, { t: 0.5 });
  assert.ok(measured.tip.y < measured.pommel.y, "thinner end is the tip");
  assert.ok(Math.abs(measured.at.x - 15.5) < 2, "wide pommel must not pull the mid grip to a corner");
});

test("measureFrame ignores chroma leftover fog at alpha 13", () => {
  const width = 16;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = 1;
    rgba[offset + 1] = 243;
    rgba[offset + 2] = 0;
    rgba[offset + 3] = 13;
  }
  for (let y = 6; y < 10; y += 1) {
    for (let x = 6; x < 10; x += 1) {
      setPixel(rgba, width, x, y, [210, 36, 42, 255]);
    }
  }
  const measured = measureFrame(rgba, width, height);
  assert.equal(measured.opaque, 16, "alpha-13 fog is not a subject pixel");
});

test("measureLongAxis names the handle end of a wide-blade sword as the pommel", () => {
  const width = 64;
  const height = 24;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 2; x <= 61; x += 1) {
    const half = x < 14 ? 1 : x < 20 ? 8 : 5;
    for (let y = 12 - half; y <= 11 + half; y += 1) {
      setPixel(rgba, width, x, y, [180, 180, 190, 255]);
    }
  }
  const measured = measureLongAxis(rgba, width, height, { t: 0.5 });
  assert.ok(measured.pommel.x < measured.tip.x, "thin grip is the pommel, wide blade is the tip");
});

/**
 * Whether a (possibly fractional) sample sits on an opaque pixel.
 * @param {Uint8ClampedArray} rgba Pixels.
 * @param {number} width Width.
 * @param {number} x Column.
 * @param {number} y Row.
 * @returns {boolean} Opaque.
 */
function opaqueAt(rgba, width, x, y) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= width) return false;
  const height = rgba.length / (width * 4);
  if (py >= height) return false;
  return rgba[(py * width + px) * 4 + 3] > 16;
}

/**
 * Taller-than-wide diagonal blade (AABB would skip PCA and lock vertical).
 * @param {number} [width=80] Canvas width.
 * @param {number} [height=120] Canvas height.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA blade.
 */
function diagonalIceSword(width = 80, height = 120) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i <= 90; i += 1) {
    const t = i / 90;
    const x = Math.round(12 + t * 52);
    const y = Math.round(108 - t * 96);
    const half = Math.round(2 + (1 - t) * 3);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < width && py < height) {
          setPixel(rgba, width, px, py, [180, 190, 210, 255]);
        }
      }
    }
  }
  return { data: rgba, width, height };
}

test("measureLongAxis follows a diagonal blade instead of locking to a vertical AABB", () => {
  const { data, width, height } = diagonalIceSword();
  const measured = measureLongAxis(data, width, height, { t: 2 / 3 });
  assert.ok(
    Math.abs(measured.direction.x) > 0.2,
    `long axis must follow the opaque blade, not a vertical AABB (direction=${JSON.stringify(measured.direction)})`,
  );
  assert.ok(opaqueAt(data, width, measured.pommel.x, measured.pommel.y), "pommel must sit on opaque pixels");
  assert.ok(opaqueAt(data, width, measured.tip.x, measured.tip.y), "tip must sit on opaque pixels");
  assert.ok(opaqueAt(data, width, measured.at.x, measured.at.y), "t=2/3 must sit on opaque pixels");
  assert.ok(measured.length > 20);
});

test("renderContactSheet keeps the foot origin on the marked cell", () => {
  const sheet = renderContactSheet([bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 1,
    grid: true,
    labels: false,
    markFrame: 0,
  });
  const originX = 4 + 16;
  const originY = 4 + 31;
  assert.deepEqual(pixelAt(sheet, originX, originY), GROUP_GRID.originInk);
});

test("renderContactSheet marks one cell with the shared highlight border", () => {
  const sheet = renderContactSheet([bodyFrame(16, 4, 8), bodyFrame(16, 4, 8)], {
    cell: 32,
    pad: 4,
    columns: 2,
    startIndex: 0,
    markFrame: 1,
  });
  const markedX = 4 + 32 + 4;
  const markedY = 4;
  assert.deepEqual(pixelAt(sheet, markedX, markedY), MARK_BORDER.color);
  assert.notDeepEqual(pixelAt(sheet, 4, 4), MARK_BORDER.color);
});

/**
 * Writes a standing body PNG.
 * @param {string} filePath Destination.
 * @param {number} canvas Edge length.
 * @param {number} bodyW Body width.
 * @param {number} bodyH Body height.
 * @returns {void}
 */
function writeBodyPng(filePath, canvas, bodyW, bodyH) {
  fs.writeFileSync(filePath, encodePngRgba(bodyFrame(canvas, bodyW, bodyH).data, canvas, canvas));
}

function serviceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-visual-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Visual"\n');
  const store = createProjectStore(root);
  store.addProject({ id: "visual", label: "Visual", projectRoot: godotRoot });
  return {
    root,
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("estimate_visual matches a reference animation and apply writes zoom-frame scales", async () => {
  const current = serviceFixture();
  try {
    const idleDir = path.join(current.root, "idle");
    const comboDir = path.join(current.root, "combo");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(comboDir);
    writeBodyPng(path.join(idleDir, "01.png"), 16, 4, 12);
    writeBodyPng(path.join(idleDir, "02.png"), 16, 4, 12);
    writeBodyPng(path.join(comboDir, "01.png"), 16, 4, 6);
    writeBodyPng(path.join(comboDir, "02.png"), 16, 4, 12);
    writeBodyPng(path.join(comboDir, "03.png"), 16, 4, 12);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: comboDir,
      animation_id: "combo",
    });
    await assert.rejects(
      current.service.call("xsxb_estimate_visual", { animation_id: "combo" }),
      /target_height or reference_animation_id/,
    );
    const estimated = await current.service.call("xsxb_estimate_visual", {
      animation_id: "combo",
      reference_animation_id: "idle",
      apply: true,
    });
    assert.equal(estimated.nativeHeight, 12);
    assert.equal(estimated.targetHeight, 12);
    assert.equal(estimated.groupScale, 1);
    assert.equal(estimated.frames[0].reason, "zoom");
    assert.equal(estimated.frames[0].scale, 2);
    assert.equal(estimated.frames[2].reason, "group");
    const readBack = await current.service.call("xsxb_get_animation", {
      animation_id: "combo",
      include: ["visual"],
    });
    assert.equal(readBack.visual.group.visual_size, 1);
    assert.equal(readBack.visual.frameOverrides["0"].visual_size, 2);
    assert.equal(readBack.visual.frameOverrides["2"], undefined);
  } finally {
    current.cleanup();
  }
});

test("find_motion trims leading and trailing rest holds", async () => {
  const current = serviceFixture();
  try {
    const directory = path.join(current.root, "jump");
    fs.mkdirSync(directory);
    for (let index = 1; index <= 3; index += 1) {
      writeBodyPng(path.join(directory, `${String(index).padStart(2, "0")}.png`), 16, 4, 8);
    }
    for (let index = 4; index <= 6; index += 1) {
      writeBodyPng(path.join(directory, `${String(index).padStart(2, "0")}.png`), 16, 4, 12);
    }
    for (let index = 7; index <= 8; index += 1) {
      writeBodyPng(path.join(directory, `${String(index).padStart(2, "0")}.png`), 16, 4, 8);
    }
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "jump",
    });
    const found = await current.service.call("xsxb_find_motion", { animation_id: "jump" });
    assert.equal(found.start, 3);
    assert.equal(found.end, 5);
    assert.deepEqual(found.order, [3, 4, 5]);
    assert.equal(found.applied, false);
  } finally {
    current.cleanup();
  }
});

test("export_sheet writes a PNG inside the workspace, allows absolute outside paths, and rejects relative escapes", async () => {
  const current = serviceFixture();
  try {
    const directory = path.join(current.root, "walk");
    fs.mkdirSync(directory);
    writeBodyPng(path.join(directory, "01.png"), 16, 4, 8);
    writeBodyPng(path.join(directory, "02.png"), 16, 4, 8);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "walk",
    });
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const sourceFrame = animation.animation.frames[0].absolutePath;
    const sourceBytes = fs.readFileSync(sourceFrame);
    const exported = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 16,
      pad: 2,
      columns: 2,
    });
    assert.equal(exported.frameCount, 2);
    assert.equal(exported.width, 2 * 16 + 3 * 2);
    assert.deepEqual(exported.indexes, [0, 1]);
    assert.equal(exported.markFrame, 0);
    assert.equal(exported.grid.enabled, false, "cell 16 is below the paint threshold");
    assert.equal(exported.grid.overlayOnly, true);
    assert.deepEqual(fs.readFileSync(sourceFrame), sourceBytes, "export_sheet must not mutate source frames");
    assert.ok(fs.existsSync(exported.outputPath));
    assert.match(exported.outputPath.split(path.sep).join("/"), /\/\.xsxb\//);
    assert.equal(fs.existsSync(path.join(current.root, "exports")), false);
    const marked = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 32,
      pad: 4,
      columns: 2,
      mark_frame: 1,
    });
    assert.equal(marked.grid.enabled, true);
    assert.equal(marked.grid.overlayOnly, true);
    assert.equal(marked.grid.originLabel.text, "0,0");
    assert.deepEqual(marked.grid.origin.group, { x: 0, y: 0 });
    assert.equal(marked.grid.anchorMode, "canvas_bottom_center");
    assert.equal(marked.grid.ySign, "down");
    const denseSheet = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 32,
      pad: 4,
      columns: 1,
      grid_divs: "16x16",
      output_path: "exports/walk_dense_sheet.png",
    });
    assert.deepEqual(denseSheet.grid.divs, { x: 16, y: 16 });
    assert.equal(denseSheet.grid.stepX, 1);
    assert.deepEqual(
      fs.readFileSync(sourceFrame),
      sourceBytes,
      "grid_divs overlay still leaves source frames",
    );
    const subjectSheet = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 32,
      pad: 4,
      columns: 1,
      grid_density: "dense",
      grid_scope: "subject",
      output_path: "exports/walk_subject_sheet.png",
    });
    assert.equal(subjectSheet.grid.scope, "subject");
    assert.equal(subjectSheet.grid.density, "dense");
    assert.ok(marked.grid.originCell.y < marked.cell);
    assert.ok(marked.grid.originCell.y >= 0);
    assert.equal(marked.markFrame, 1);
    const markedSheet = decodePngRgba(marked.outputPath);
    const markedX = 4 + 32 + 4;
    assert.deepEqual(
      [
        markedSheet.data[(4 * markedSheet.width + markedX) * 4],
        markedSheet.data[(4 * markedSheet.width + markedX) * 4 + 1],
        markedSheet.data[(4 * markedSheet.width + markedX) * 4 + 2],
        markedSheet.data[(4 * markedSheet.width + markedX) * 4 + 3],
      ],
      MARK_BORDER.color,
    );
    const foot = await current.service.call("xsxb_export_sheet", {
      animation_id: "walk",
      cell: 32,
      pad: 4,
      columns: 1,
      mark_frame: 0,
    });
    const footSheet = decodePngRgba(foot.outputPath);
    const originOffset = ((4 + 31) * footSheet.width + (4 + 16)) * 4;
    assert.deepEqual(
      [
        footSheet.data[originOffset],
        footSheet.data[originOffset + 1],
        footSheet.data[originOffset + 2],
        footSheet.data[originOffset + 3],
      ],
      GROUP_GRID.originInk,
    );
    const outside = path.join(os.tmpdir(), `xsxb-sheet-outside-${process.pid}.png`);
    try {
      const written = await current.service.call("xsxb_export_sheet", {
        animation_id: "walk",
        output_path: outside,
        grid: false,
      });
      assert.equal(written.outputPath, outside);
      assert.ok(fs.existsSync(outside));
    } finally {
      fs.rmSync(outside, { force: true });
    }
    await assert.rejects(
      current.service.call("xsxb_export_sheet", {
        animation_id: "walk",
        output_path: "../../../../../../escape.png",
      }),
      /must stay inside the XSXB workspace root/,
    );
    await assert.rejects(
      current.service.call("xsxb_export_sheet", {
        animation_id: "walk",
        output_path: "sheet.gif",
      }),
      /must end with \.png/,
    );
  } finally {
    current.cleanup();
  }
});

test("export_sheet 8x8 on a 320 canvas includes column 7", async () => {
  const current = serviceFixture();
  try {
    const directory = path.join(current.root, "slash320");
    fs.mkdirSync(directory);
    writeBodyPng(path.join(directory, "01.png"), 320, 40, 80);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "ice_slash",
    });
    const exported = await current.service.call("xsxb_export_sheet", {
      animation_id: "ice_slash",
      grid_divs: "8x8",
      cell: 160,
    });
    assert.deepEqual(exported.grid.divs, { x: 8, y: 8 });
    assert.equal(exported.grid.cells.length, 8);
    assert.equal(exported.grid.cells[0].length, 8, "8×8 JSON must include col 7");
    assert.equal(exported.grid.cells[0][7].col, 7);
  } finally {
    current.cleanup();
  }
});

test("xsxb_measure_image on a diagonal sword keeps pommel/tip/t on the blade", async () => {
  const current = serviceFixture();
  try {
    const sword = diagonalIceSword();
    const filePath = path.join(current.root, "diagonal-sword.png");
    fs.writeFileSync(filePath, encodePngRgba(sword.data, sword.width, sword.height));
    const measured = await current.service.call("xsxb_measure_image", {
      file_path: filePath,
      t: "2/3",
    });
    assert.ok(Math.abs(measured.direction.x) > 0.2, "must not lock a diagonal blade to x=0");
    assert.ok(opaqueAt(sword.data, sword.width, measured.pommel.x, measured.pommel.y));
    assert.ok(opaqueAt(sword.data, sword.width, measured.tip.x, measured.tip.y));
    assert.ok(opaqueAt(sword.data, sword.width, measured.at.x, measured.at.y));
  } finally {
    current.cleanup();
  }
});

test("xsxb_measure_image returns pommel-to-tip handle fractions", async () => {
  const current = serviceFixture();
  try {
    const width = 16;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 2; y <= 28; y += 1) {
      const taper = y < 10 ? 0 : y < 20 ? 1 : 2;
      for (let x = 7 - taper; x <= 8 + taper; x += 1) {
        setPixel(rgba, width, x, y, [180, 180, 190, 255]);
      }
    }
    const filePath = path.join(current.root, "blade.png");
    fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
    const measured = await current.service.call("xsxb_measure_image", {
      file_path: filePath,
      t: "2/3",
    });
    assert.ok(measured.tip.y < measured.pommel.y);
    assert.equal(measured.t, 2 / 3);
    assert.ok(measured.fractions["2/3"]);
    assert.ok(Math.abs(measured.at.x - 7.5) < 1.5);
    assert.equal(measured.localFromCenter.x, measured.at.x - width / 2);
  } finally {
    current.cleanup();
  }
});

test("cutout receipts include body-height and near-white metrics", async () => {
  const current = serviceFixture();
  try {
    const directory = path.join(current.root, "green");
    fs.mkdirSync(directory);
    const width = 16;
    const height = 16;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([0, 255, 0, 255], offset);
    for (let y = 6; y <= 11; y += 1) {
      rgba.set([210, 36, 42, 255], (y * width + 7) * 4);
      rgba.set([210, 36, 42, 255], (y * width + 8) * 4);
    }
    rgba.set([250, 250, 250, 255], (2 * width + 2) * 4);
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, width, height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "slash",
    });
    const cut = await current.service.call("xsxb_cutout", { animation_id: "slash" });
    assert.equal(cut.metrics.bodyHeight.median, 6);
    assert.ok(cut.metrics.frames[0].opaque >= 12);
    const silent = await current.service.call("xsxb_cutout", { animation_id: "slash", metrics: false });
    assert.equal(silent.metrics, undefined);
  } finally {
    current.cleanup();
  }
});
