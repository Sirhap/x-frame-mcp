"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { MCP_TOOL_NAMES, createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const YELLOW = [255, 255, 0, 255];

/**
 * Isolated tuner root plus MCP service.
 * @returns {{root:string,service:object,cleanup:Function}} Fixture.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-slice-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Slice"\n');
  createProjectStore(root).addProject({ id: "slice", label: "Slice", projectRoot: godotRoot });
  return {
    root,
    service: createXsxbMcpService({ root }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Writes a 2×2 packed sheet. A null cell stays fully transparent.
 * @param {string} filePath Destination PNG.
 * @param {(number[]|null)[]} cells Four RGBA colors, LTR TTB.
 * @param {number} [cellSize=4] Uniform cell edge.
 * @returns {void}
 */
function writeColorSheet(filePath, cells, cellSize = 4) {
  const columns = 2;
  const rows = 2;
  const width = columns * cellSize;
  const height = rows * cellSize;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const color = cells[row * columns + col];
      if (!color) continue;
      for (let y = 0; y < cellSize; y += 1) {
        for (let x = 0; x < cellSize; x += 1) {
          rgba.set(color, ((row * cellSize + y) * width + col * cellSize + x) * 4);
        }
      }
    }
  }
  fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
}

/**
 * Reads one RGBA pixel.
 * @param {string} filePath PNG path.
 * @param {number} x Column.
 * @param {number} y Row.
 * @returns {number[]} RGBA.
 */
function pixelAt(filePath, x, y) {
  const image = decodePngRgba(filePath);
  const index = (y * image.width + x) * 4;
  return [...image.data.subarray(index, index + 4)];
}

/**
 * Walk-clip frameCount from xsxb_get_project, or 0 if the clip is absent.
 * @param {object} project Project snapshot receipt.
 * @returns {number} Frame count.
 */
function walkFrameCount(project) {
  const animation = (project.animations || []).find((entry) => entry.id === "walk");
  return animation ? animation.frameCount : 0;
}

test("catalog contains xsxb_slice_sheet immediately after import_video", () => {
  const video = MCP_TOOL_NAMES.indexOf("xsxb_import_video");
  const animation = MCP_TOOL_NAMES.indexOf("xsxb_import_animation");
  assert.ok(video >= 0, "xsxb_import_video");
  assert.equal(MCP_TOOL_NAMES[video + 1], "xsxb_slice_sheet");
  assert.ok(animation > video + 1, "import_animation stays after slice_sheet");
  assert.ok(
    toolDefinitions().some((entry) => entry.name === "xsxb_slice_sheet"),
    "schema",
  );
  const tool = toolDefinitions().find((entry) => entry.name === "xsxb_slice_sheet");
  assert.match(tool.description, /切表|sheet/i);
  assert.deepEqual(
    toolDefinitions().map((entry) => entry.name),
    [...MCP_TOOL_NAMES],
  );
});

test("a 2×2 sheet of known-color cells slices to 4 PNGs with correct colors", async () => {
  const current = fixture();
  try {
    const sheetPath = path.join(current.root, "sheet.png");
    writeColorSheet(sheetPath, [RED, GREEN, BLUE, YELLOW]);
    const sliced = await current.service.call("xsxb_slice_sheet", {
      file_path: sheetPath,
      columns: 2,
      rows: 2,
    });
    assert.equal(sliced.columns, 2);
    assert.equal(sliced.rows, 2);
    assert.equal(sliced.cell, 4);
    assert.equal(sliced.frameCount, 4);
    assert.equal(sliced.paths.length, 4);
    assert.equal(sliced.skipped.length, 0);
    assert.equal(path.basename(sliced.paths[0]), "0.png");
    assert.deepEqual(pixelAt(sliced.paths[0], 1, 1), RED);
    assert.deepEqual(pixelAt(sliced.paths[1], 1, 1), GREEN);
    assert.deepEqual(pixelAt(sliced.paths[2], 1, 1), BLUE);
    assert.deepEqual(pixelAt(sliced.paths[3], 1, 1), YELLOW);
    const byDivs = await current.service.call("xsxb_slice_sheet", {
      file_path: sheetPath,
      grid_divs: "2x2",
      dest: path.join(current.root, "by-divs"),
    });
    assert.equal(byDivs.frameCount, 4);
    assert.deepEqual(pixelAt(byDivs.paths[0], 0, 0), RED);
    const byCell = await current.service.call("xsxb_slice_sheet", {
      file_path: sheetPath,
      cell: 4,
      dest: path.join(current.root, "by-cell"),
    });
    assert.equal(byCell.columns, 2);
    assert.equal(byCell.rows, 2);
    assert.deepEqual(pixelAt(byCell.paths[3], 2, 2), YELLOW);
  } finally {
    current.cleanup();
  }
});

test("empty cell is skipped", async () => {
  const current = fixture();
  try {
    const sheetPath = path.join(current.root, "sheet.png");
    writeColorSheet(sheetPath, [RED, GREEN, BLUE, null]);
    const sliced = await current.service.call("xsxb_slice_sheet", {
      file_path: sheetPath,
      columns: 2,
      rows: 2,
    });
    assert.equal(sliced.frameCount, 3);
    assert.equal(sliced.paths.length, 3);
    assert.equal(sliced.skipped.length, 1);
    assert.equal(sliced.skipped[0].index, 3);
    assert.equal(sliced.skipped[0].column, 1);
    assert.equal(sliced.skipped[0].row, 1);
    assert.deepEqual(pixelAt(sliced.paths[0], 1, 1), RED);
    assert.deepEqual(pixelAt(sliced.paths[1], 1, 1), GREEN);
    assert.deepEqual(pixelAt(sliced.paths[2], 1, 1), BLUE);
    assert.equal(fs.existsSync(path.join(sliced.outputDir, "3.png")), false);
  } finally {
    current.cleanup();
  }
});

test("dest outside the XSXB root works", async () => {
  const current = fixture();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-slice-outside-"));
  try {
    const sheetPath = path.join(current.root, "sheet.png");
    writeColorSheet(sheetPath, [RED, GREEN, BLUE, YELLOW]);
    assert.ok(!dest.startsWith(current.root));
    const sliced = await current.service.call("xsxb_slice_sheet", {
      file_path: sheetPath,
      columns: 2,
      rows: 2,
      dest,
    });
    assert.equal(sliced.outputDir, dest);
    assert.equal(sliced.frameCount, 4);
    assert.equal(fs.existsSync(path.join(dest, "0.png")), true);
    assert.deepEqual(pixelAt(path.join(dest, "0.png"), 0, 0), RED);
  } finally {
    current.cleanup();
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

/**
 * Writes a 1-row packed sheet of equal square cells (no pad).
 * @param {string} filePath Destination PNG.
 * @param {number[][]} cells RGBA colors, left to right.
 * @param {number} [cellSize=8] Cell edge.
 * @returns {void}
 */
function writeRowSheet(filePath, cells, cellSize = 8) {
  const columns = cells.length;
  const width = columns * cellSize;
  const height = cellSize;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let col = 0; col < columns; col += 1) {
    const color = cells[col];
    for (let y = 0; y < cellSize; y += 1) {
      for (let x = 0; x < cellSize; x += 1) {
        rgba.set(color, (y * width + col * cellSize + x) * 4);
      }
    }
  }
  fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
}

/**
 * Writes a dummy export_sheet sidecar next to a PNG (`*.png` → `*.sheet.json`).
 * @param {string} pngPath Sheet PNG.
 * @param {object} packing columns/rows/cell/pad.
 * @returns {void}
 */
function writeSheetSidecar(pngPath, packing) {
  fs.writeFileSync(
    pngPath.replace(/\.png$/i, ".sheet.json"),
    JSON.stringify({
      kind: "xsxb_contact_sheet",
      schemaVersion: 1,
      grid: true,
      ...packing,
    }),
  );
}

/**
 * Isolated 4×1 contact sheet (32×8) plus sidecar. Not produced by export_sheet.
 * @returns {{root:string,service:object,sheetPath:string,cleanup:Function}} Fixture.
 */
function contactSheetFixture() {
  const current = fixture();
  const sheetPath = path.join(current.root, "contact.png");
  writeRowSheet(sheetPath, [RED, GREEN, BLUE, YELLOW], 8);
  writeSheetSidecar(sheetPath, { columns: 4, rows: 1, cell: 8, pad: 0 });
  return { ...current, sheetPath };
}

test("contact-sheet sidecar: overlay grid_divs 8x8 throws SLICE_PACKING_MISMATCH", async () => {
  const current = contactSheetFixture();
  try {
    await assert.rejects(
      () => current.service.call("xsxb_slice_sheet", { file_path: current.sheetPath, grid_divs: "8x8" }),
      (error) => {
        assert.equal(error.code, "SLICE_PACKING_MISMATCH");
        assert.match(error.message, /export_sheet|columns|rows|cell|pad/i);
        assert.match(error.message, /4/);
        assert.match(error.message, /8/);
        return true;
      },
    );
  } finally {
    current.cleanup();
  }
});

test("contact-sheet sidecar: omitted grid spec uses sidecar packing", async () => {
  const current = contactSheetFixture();
  try {
    const sliced = await current.service.call("xsxb_slice_sheet", { file_path: current.sheetPath });
    assert.equal(sliced.columns, 4);
    assert.equal(sliced.rows, 1);
    assert.equal(sliced.cell, 8);
    assert.equal(sliced.pad, 0);
    assert.equal(sliced.frameCount, 4);
    assert.equal(sliced.paths.length, 4);
    assert.deepEqual(pixelAt(sliced.paths[0], 1, 1), RED);
    assert.deepEqual(pixelAt(sliced.paths[1], 1, 1), GREEN);
    assert.deepEqual(pixelAt(sliced.paths[3], 1, 1), YELLOW);
  } finally {
    current.cleanup();
  }
});

test("contact-sheet sidecar: explicit columns+rows still works", async () => {
  const current = contactSheetFixture();
  try {
    const sliced = await current.service.call("xsxb_slice_sheet", {
      file_path: current.sheetPath,
      columns: 4,
      rows: 1,
      dest: path.join(current.root, "explicit"),
    });
    assert.equal(sliced.frameCount, 4);
    assert.equal(sliced.columns, 4);
    assert.equal(sliced.rows, 1);
    assert.deepEqual(pixelAt(sliced.paths[0], 0, 0), RED);
    assert.deepEqual(pixelAt(sliced.paths[3], 4, 4), YELLOW);
  } finally {
    current.cleanup();
  }
});

test("committed slice+import must create an undo checkpoint", async () => {
  const current = fixture();
  try {
    await current.service.call("xsxb_set_active_project", { project_id: "slice" });
    const sheetPath = path.join(current.root, "sheet.png");
    writeColorSheet(sheetPath, [RED, GREEN, BLUE, YELLOW]);
    const revisionsBeforeStandalone = (await current.service.call("xsxb_list_revisions")).revisions.length;
    const standalone = await current.service.callMcp("xsxb_slice_sheet", {
      file_path: sheetPath,
      columns: 2,
      rows: 2,
      dest: path.join(current.root, "standalone-cells"),
      project_id: "slice",
    });
    assert.equal(standalone.data.frameCount, 4);
    assert.equal(standalone.data.imported, undefined);
    assert.equal(
      (await current.service.call("xsxb_list_revisions")).revisions.length,
      revisionsBeforeStandalone,
      "standalone slice must not create a checkpoint",
    );
    const projectBefore = await current.service.call("xsxb_get_project", { project_id: "slice" });
    const frameCountBefore = projectBefore.frameCount;
    assert.equal(walkFrameCount(projectBefore), 0);
    const revisionsBefore = (await current.service.call("xsxb_list_revisions")).revisions.length;
    const sliced = await current.service.callMcp("xsxb_slice_sheet", {
      file_path: sheetPath,
      columns: 2,
      rows: 2,
      animation_id: "walk",
      project_id: "slice",
    });
    assert.ok(sliced.data.imported, "imported");
    assert.equal(sliced.data.imported.animationId, "walk");
    assert.equal(sliced.data.imported.importedFrameCount, 4);
    assert.equal(sliced.data.frameCount, 4);
    assert.equal(walkFrameCount(await current.service.call("xsxb_get_project", { project_id: "slice" })), 4);
    assert.ok(
      (await current.service.call("xsxb_list_revisions")).revisions.length > revisionsBefore,
      "committed slice+import must create an undo checkpoint",
    );
    const undone = await current.service.call("xsxb_undo", { dry_run: false });
    assert.equal(undone.restored, true);
    const restored = await current.service.call("xsxb_get_project", { project_id: "slice" });
    assert.equal(walkFrameCount(restored), 0);
    assert.equal(restored.frameCount, frameCountBefore);
    assert.equal(
      (restored.animations || []).some((entry) => entry.id === "walk"),
      false,
    );
  } finally {
    current.cleanup();
  }
});

test("wrong path, non-png, and zero columns throw clearly", async () => {
  const current = fixture();
  try {
    const sheetPath = path.join(current.root, "sheet.png");
    writeColorSheet(sheetPath, [RED, GREEN, BLUE, YELLOW]);
    const missing = path.join(current.root, "no-such.png");
    await assert.rejects(
      () => current.service.call("xsxb_slice_sheet", { file_path: missing, columns: 2, rows: 2 }),
      /not found/i,
    );
    const textPath = path.join(current.root, "sheet.txt");
    fs.writeFileSync(textPath, "not a png");
    await assert.rejects(
      () => current.service.call("xsxb_slice_sheet", { file_path: textPath, columns: 2, rows: 2 }),
      /png/i,
    );
    await assert.rejects(
      () => current.service.call("xsxb_slice_sheet", { file_path: sheetPath, columns: 0, rows: 2 }),
      /columns/i,
    );
  } finally {
    current.cleanup();
  }
});
