"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { encodePngRgba, shiftFrameRgba } = require("../xsxb_mcp_cutout");
const {
  GROUP_GRID,
  describeGroupGrid,
  groupToCanvas,
  paintedOriginCell,
  renderContactSheet,
} = require("../xsxb_mcp_visual_qa");

const CANVAS = 384;
const SQUARE = 12;
const FROM_Y = -24;
const TO_Y = -1;
const INK = Object.freeze([210, 36, 42, 255]);

/**
 * Opaque square whose bottom-center sits on a known group point.
 * @param {number} groupY Bottom-edge group y.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Frame.
 */
function squareAtGroupY(groupY) {
  const data = new Uint8ClampedArray(CANVAS * CANVAS * 4);
  const foot = groupToCanvas(0, groupY, CANVAS, CANVAS);
  const left = Math.round(foot.x) - SQUARE / 2;
  const bottom = Math.round(foot.y);
  for (let y = bottom - SQUARE + 1; y <= bottom; y += 1) {
    for (let x = left; x < left + SQUARE; x += 1) {
      data.set(INK, (y * CANVAS + x) * 4);
    }
  }
  return { data, width: CANVAS, height: CANVAS, left, bottom };
}

/**
 * Reads one sheet pixel.
 * @param {{data:Uint8ClampedArray,width:number}} sheet Sheet.
 * @param {number} x Column.
 * @param {number} y Row.
 * @returns {number[]} RGBA.
 */
function pixelAt(sheet, x, y) {
  const offset = (y * sheet.width + x) * 4;
  return Array.from(sheet.data.subarray(offset, offset + 4));
}

test("synthetic overlay paints origin; shift from y=-24 lands the square on lastPixel y=-1", () => {
  const frame = squareAtGroupY(FROM_Y);
  assert.equal(frame.bottom, 360);
  assert.deepEqual(
    Array.from(frame.data.subarray((360 * CANVAS + 192) * 4, (360 * CANVAS + 192) * 4 + 4)),
    INK,
  );
  assert.equal(frame.data[(383 * CANVAS + 192) * 4 + 3], 0, "sole is not already on lastPixel");

  const cell = 360;
  const pad = 8;
  const described = describeGroupGrid(cell, CANVAS, CANVAS, "canvas_bottom_center", { density: "dense" });
  assert.deepEqual(described.origin.group, { x: 0, y: 0 });
  assert.deepEqual(described.lastPixel.group, { x: 0, y: TO_Y });
  assert.equal(described.originLabel.text, "0,0");
  assert.ok(described.labels.some((label) => label.text === "-1"));
  assert.ok(
    described.cells.some((row) =>
      row.some((square) => square.y0 <= FROM_Y && square.y1 >= FROM_Y && square.x0 <= 0 && square.x1 >= 0),
    ),
    "code-generated cells must contain the square covering the sole at y=-24",
  );
  assert.ok(described.labelScale <= 4, `360-cell glyphs too large: ${described.labelScale}`);

  const sheet = renderContactSheet([frame], {
    cell,
    pad,
    columns: 1,
    grid: true,
    gridDensity: "dense",
    labels: true,
    markFrame: -1,
  });
  const origin = paintedOriginCell(CANVAS, CANVAS, cell);
  assert.deepEqual(pixelAt(sheet, pad + origin.x, pad + origin.y), GROUP_GRID.originInk);

  const dy = TO_Y - FROM_Y;
  assert.equal(dy, 23);
  const shifted = shiftFrameRgba(frame.data, CANVAS, CANVAS, 0, dy);
  assert.equal(shifted[(360 * CANVAS + 192) * 4 + 3], 0, "old sole vacated");
  assert.deepEqual(
    Array.from(shifted.subarray((383 * CANVAS + 192) * 4, (383 * CANVAS + 192) * 4 + 4)),
    INK,
    "new sole sits on last pixel row",
  );
  assert.equal(
    shifted[((383 - SQUARE) * CANVAS + 192) * 4 + 3],
    0,
    "square did not grow or clip into a taller stamp",
  );
  assert.deepEqual(
    Array.from(
      shifted.subarray(((383 - SQUARE + 1) * CANVAS + 192) * 4, ((383 - SQUARE + 1) * CANVAS + 192) * 4 + 4),
    ),
    INK,
    "full square height survived the plant",
  );

  const afterSheet = renderContactSheet([{ data: shifted, width: CANVAS, height: CANVAS }], {
    cell,
    pad,
    columns: 1,
    grid: true,
    gridDensity: "dense",
    labels: true,
    markFrame: -1,
  });
  assert.deepEqual(pixelAt(afterSheet, pad + origin.x, pad + origin.y), GROUP_GRID.originInk);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-overlay-vision-"));
  fs.writeFileSync(path.join(dir, "before.png"), encodePngRgba(sheet.data, sheet.width, sheet.height));
  fs.writeFileSync(
    path.join(dir, "after.png"),
    encodePngRgba(afterSheet.data, afterSheet.width, afterSheet.height),
  );
});
