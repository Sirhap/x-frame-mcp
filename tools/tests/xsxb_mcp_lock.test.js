"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { MCP_TOOL_NAMES, createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const { INSTRUCTIONS } = require("../xsxb_mcp_server");

/**
 * Writes one RGBA pixel.
 * @param {Uint8ClampedArray} rgba Buffer.
 * @param {number} width Width.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {number[]} color RGBA.
 * @returns {void}
 */
function setPixel(rgba, width, x, y, color) {
  rgba.set(color, (y * width + x) * 4);
}

/**
 * Builds a transparent canvas with an opaque standing block.
 * @param {number} canvas Edge length.
 * @param {number} bodyW Body width.
 * @param {number} bodyH Body height.
 * @param {{left?:number,glow?:boolean}} [options] Placement.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function bodyFrame(canvas, bodyW, bodyH, options = {}) {
  const rgba = new Uint8ClampedArray(canvas * canvas * 4);
  const left = options.left === undefined ? Math.floor((canvas - bodyW) / 2) : options.left;
  const top = canvas - bodyH - 1;
  for (let y = top; y < top + bodyH; y += 1) {
    for (let x = left; x < left + bodyW; x += 1) {
      setPixel(rgba, canvas, x, y, [210, 36, 42, 255]);
    }
  }
  if (options.glow) {
    for (let x = left; x < left + bodyW; x += 1) {
      setPixel(rgba, canvas, x, canvas - 1, [250, 250, 255, 255]);
    }
  }
  return { data: rgba, width: canvas, height: canvas };
}

/**
 * Writes a standing body PNG.
 * @param {string} filePath Destination.
 * @param {number} canvas Edge.
 * @param {number} bodyW Width.
 * @param {number} bodyH Height.
 * @param {{left?:number,glow?:boolean}} [options] Placement.
 * @returns {void}
 */
function writeBodyPng(filePath, canvas, bodyW, bodyH, options = {}) {
  const frame = bodyFrame(canvas, bodyW, bodyH, options);
  fs.writeFileSync(filePath, encodePngRgba(frame.data, frame.width, frame.height));
}

/**
 * Isolated tuner root plus MCP service.
 * @param {object} [serviceOptions] Service overrides.
 * @returns {{root:string,service:object,cleanup:Function}} Fixture.
 */
function fixture(serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-lock-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Lock"\n');
  createProjectStore(root).addProject({ id: "lock", label: "Lock", projectRoot: godotRoot });
  return {
    root,
    service: createXsxbMcpService({ root, ...serviceOptions }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("catalog advertises measure_frames, register_clip, overlay, and pack_slot", () => {
  for (const name of [
    "xsxb_measure_frames",
    "xsxb_register_clip",
    "xsxb_export_overlay",
    "xsxb_export_pack_slot",
  ]) {
    assert.ok(MCP_TOOL_NAMES.includes(name), name);
    assert.ok(
      toolDefinitions().some((tool) => tool.name === name),
      `${name} schema`,
    );
  }
});

test("measure_frames reports bbox/body/feet/cx/fx and deltas against idle", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle");
    const runDir = path.join(current.root, "run");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(runDir);
    writeBodyPng(path.join(idleDir, "01.png"), 32, 8, 12);
    writeBodyPng(path.join(runDir, "01.png"), 32, 8, 6);
    writeBodyPng(path.join(runDir, "02.png"), 32, 8, 12);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: runDir,
      animation_id: "run",
    });
    const measured = await current.service.call("xsxb_measure_frames", {
      animation_id: "run",
      reference_animation_id: "idle",
    });
    assert.equal(measured.frames.length, 2);
    assert.equal(measured.frames[0].bboxH, 6);
    assert.equal(measured.frames[0].bodyH, 6);
    assert.equal(measured.frames[1].bboxH, 12);
    assert.equal(measured.reference.bboxH, 12);
    assert.equal(measured.frames[0].dBbox, -6);
    assert.equal(measured.frames[1].dBbox, 0);
    assert.equal(measured.frames[0].dFirst, 0);
    assert.equal(measured.frames[1].dFirst, 6);
    assert.equal(typeof measured.frames[0].cx, "number");
    assert.equal(typeof measured.frames[0].fx, "number");
    assert.equal(typeof measured.frames[0].dCx, "number");
    assert.equal(typeof measured.frames[0].dFx, "number");
    assert.ok(!measured.frames[0].grid, "short receipt must not dump overlay grids");
  } finally {
    current.cleanup();
  }
});

/**
 * Body plus a wide ice splash attached below the boots (impact-frame geometry).
 * @returns {{data:Uint8ClampedArray,width:number,height:number,bootY:number,splashBottom:number}} Frame.
 */
function iceSplashImpactFrame() {
  const width = 96;
  const height = 96;
  const bootY = 58;
  const ice = [84, 190, 251, 255];
  const iceShadow = [40, 90, 140, 255];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 16; y <= bootY; y += 1) {
    for (let x = 40; x <= 55; x += 1) setPixel(rgba, width, x, y, [210, 36, 42, 255]);
  }
  for (let y = bootY + 1; y <= 82; y += 1) {
    for (let x = 8; x <= 88; x += 1) {
      setPixel(rgba, width, x, y, (x + y) % 3 === 0 ? iceShadow : ice);
    }
  }
  return { data: rgba, width, height, bootY, splashBottom: 82 };
}

test("measure_frames feetY ignores a connected ice splash below the boots", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "impact");
    fs.mkdirSync(directory);
    const frame = iceSplashImpactFrame();
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(frame.data, frame.width, frame.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "ice_slash",
    });
    const measured = await current.service.call("xsxb_measure_frames", { animation_id: "ice_slash" });
    assert.equal(measured.frames[0].feetY, frame.bootY);
    assert.ok(
      measured.frames[0].feetY < frame.splashBottom - 8,
      `feetY ${measured.frames[0].feetY} must not be the splash bottom ${frame.splashBottom}`,
    );
    assert.ok(measured.frames[0].maxY >= frame.splashBottom, "bbox still includes the splash");
  } finally {
    current.cleanup();
  }
});

test("register_clip equalize locks bbox and feet to idle in one apply", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle");
    const runDir = path.join(current.root, "run");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(runDir);
    writeBodyPng(path.join(idleDir, "01.png"), 32, 8, 12);
    writeBodyPng(path.join(runDir, "01.png"), 32, 8, 6, { left: 4 });
    writeBodyPng(path.join(runDir, "02.png"), 32, 8, 12, { left: 4 });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: runDir,
      animation_id: "run",
    });
    const preview = await current.service.call("xsxb_register_clip", {
      animation_id: "run",
      reference_animation_id: "idle",
      mode: "equalize",
      anchor: "feet",
      align: "cx",
      dry_run: true,
    });
    assert.equal(preview.applied, false);
    assert.equal(preview.targetBbox, 12);
    assert.ok(preview.frames[0].scale > 1.5);

    const locked = await current.service.call("xsxb_register_clip", {
      animation_id: "run",
      reference_animation_id: "idle",
      mode: "equalize",
      align: "cx",
      apply: true,
    });
    assert.equal(locked.applied, true);
    const after = await current.service.call("xsxb_measure_frames", {
      animation_id: "run",
      reference_animation_id: "idle",
    });
    assert.ok(Math.abs(after.frames[0].bboxH - 12) <= 1, `short frame bbox ${after.frames[0].bboxH}`);
    assert.ok(Math.abs(after.frames[1].bboxH - 12) <= 1, `tall frame bbox ${after.frames[1].bboxH}`);
    assert.ok(Math.abs(after.frames[0].dBbox) <= 1);
    assert.ok(Math.abs(after.frames[0].feetY - after.reference.feetY) <= 1);
    assert.ok(Math.abs(after.frames[0].dCx) <= 1);
  } finally {
    current.cleanup();
  }
});

test("register_clip shared_scale keeps intra-clip height difference", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle");
    const runDir = path.join(current.root, "run");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(runDir);
    writeBodyPng(path.join(idleDir, "01.png"), 32, 8, 12);
    writeBodyPng(path.join(runDir, "01.png"), 32, 8, 6);
    writeBodyPng(path.join(runDir, "02.png"), 32, 8, 12);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: runDir,
      animation_id: "run",
    });
    await current.service.call("xsxb_register_clip", {
      animation_id: "run",
      reference_animation_id: "idle",
      mode: "shared_scale",
      reference_frame: 0,
      apply: true,
    });
    const after = await current.service.call("xsxb_measure_frames", { animation_id: "run" });
    assert.ok(after.frames[1].bboxH - after.frames[0].bboxH >= 4, "shared scale keeps pose/zoom difference");
  } finally {
    current.cleanup();
  }
});

test("estimate_visual equalize plus bbox metric uses idle frame 0 not the clip median", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle");
    const runDir = path.join(current.root, "run");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(runDir);
    writeBodyPng(path.join(idleDir, "01.png"), 32, 8, 12, { glow: true });
    writeBodyPng(path.join(runDir, "01.png"), 32, 8, 8);
    writeBodyPng(path.join(runDir, "02.png"), 32, 8, 10);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: runDir,
      animation_id: "run",
    });
    const bodyPlan = await current.service.call("xsxb_estimate_visual", {
      animation_id: "run",
      reference_animation_id: "idle",
      metric: "body",
      reference_frame: 0,
    });
    const bboxPlan = await current.service.call("xsxb_estimate_visual", {
      animation_id: "run",
      reference_animation_id: "idle",
      metric: "bbox",
      reference_frame: 0,
      equalize: true,
    });
    assert.equal(bodyPlan.targetHeight, 12);
    assert.ok(bboxPlan.targetHeight >= 13, "bbox includes the idle glow row");
    assert.equal(bboxPlan.mode, "equalize");
    assert.equal(bboxPlan.frames[0].reason, "equalize");
    assert.notEqual(bboxPlan.frames[0].scale, bboxPlan.frames[1].scale);
  } finally {
    current.cleanup();
  }
});

test("set_visual_transform writes a frames batch and can clear group in one call", async () => {
  const current = fixture();
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
    await current.service.call("xsxb_set_visual_transform", {
      animation_id: "walk",
      level: "group",
      visual_size: 0.5,
    });
    const batched = await current.service.call("xsxb_set_visual_transform", {
      animation_id: "walk",
      clear_group: true,
      frames: [
        { frame: 0, visual_size: 1.2 },
        { frame: 1, visual_size: 0.8 },
      ],
    });
    assert.equal(batched.updatedFrames, 2);
    const readBack = await current.service.call("xsxb_get_animation", {
      animation_id: "walk",
      include: ["visual"],
    });
    assert.equal(readBack.visual.group.visual_size, undefined);
    assert.equal(readBack.visual.frameOverrides["0"].visual_size, 1.2);
    assert.equal(readBack.visual.frameOverrides["1"].visual_size, 0.8);
  } finally {
    current.cleanup();
  }
});

test("cutout short receipt omits inspectFeet.grid and border_flood keys white plates", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "gen");
    fs.mkdirSync(directory);
    const canvas = 16;
    const rgba = new Uint8ClampedArray(canvas * canvas * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([250, 250, 250, 255], offset);
    for (let y = 6; y <= 11; y += 1) {
      for (let x = 7; x <= 8; x += 1) setPixel(rgba, canvas, x, y, [210, 36, 42, 255]);
    }
    setPixel(rgba, canvas, 9, 8, [245, 250, 255, 255]);
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, canvas, canvas));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "frost",
    });
    const cut = await current.service.call("xsxb_cutout", {
      animation_id: "frost",
      key_mode: "border_flood",
      protected_colors: ["#f5faff"],
      receipt: "short",
      canvas: 32,
    });
    assert.ok(!cut.inspectFeet?.grid, "short receipt drops the overlay grid");
    assert.ok(cut.metrics, "metrics stay on the short receipt");
    const measured = await current.service.call("xsxb_measure_frames", { animation_id: "frost" });
    assert.ok(measured.frames[0].bboxH >= 5);
    assert.ok(measured.frames[0].bboxH < 16, "white plate must not remain as body");
    assert.ok(cut.fit !== "fill_canvas", "explicit canvas must not default to filling the person");
  } finally {
    current.cleanup();
  }
});

test("cutout full receipt includes inspectFeet overlay without rematch", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "slash");
    fs.mkdirSync(directory);
    const canvas = 32;
    const rgba = new Uint8ClampedArray(canvas * canvas * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([8, 8, 8, 255], offset);
    for (let y = 8; y <= 22; y += 1) {
      for (let x = 12; x <= 19; x += 1) setPixel(rgba, canvas, x, y, [210, 36, 42, 255]);
    }
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, canvas, canvas));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "ice_slash",
    });
    const cut = await current.service.call("xsxb_cutout", {
      animation_id: "ice_slash",
      key_mode: "border_flood",
      key_color: "#000000",
      receipt: "full",
    });
    assert.ok(cut.inspectFeet, "receipt=full must include inspectFeet");
    assert.ok(cut.inspectFeet.grid, "full inspectFeet must include the overlay grid");
    assert.ok(Array.isArray(cut.inspectFeet.grid.cells), "inspectFeet.grid.cells for plant write-back");
    assert.ok(cut.inspectFeet.sheetPath, "inspectFeet.sheetPath should be a contact sheet");
    assert.ok(fs.existsSync(cut.inspectFeet.sheetPath));
    assert.ok(cut.inspectFeet.cell >= canvas, "inspectFeet must not shrink a 32 canvas into a 160/220 crop");
    assert.ok(cut.preview && cut.preview.path, "cutout must return a magenta look preview");
    assert.ok(fs.existsSync(cut.preview.path));
    const preview = decodePngRgba(cut.preview.path);
    const pad = 8;
    const sample = (pad + 4) * preview.width + (pad + 4);
    assert.deepEqual(
      [...preview.data.subarray(sample * 4, sample * 4 + 3)],
      [255, 0, 255],
      "cutout preview must flatten onto magenta",
    );
  } finally {
    current.cleanup();
  }
});

test("cutout short receipt still returns a magenta preview", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "navy");
    fs.mkdirSync(directory);
    const canvas = 32;
    const navy = [7, 9, 25, 255];
    const rgba = new Uint8ClampedArray(canvas * canvas * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([0, 0, 0, 255], offset);
    for (let y = 6; y <= 14; y += 1) {
      for (let x = 12; x <= 19; x += 1) setPixel(rgba, canvas, x, y, [180, 120, 90, 255]);
    }
    for (let y = 15; y <= 22; y += 1) {
      for (let x = 12; x <= 19; x += 1) setPixel(rgba, canvas, x, y, navy);
    }
    for (let y = 23; y <= 25; y += 1) {
      for (let x = 12; x <= 19; x += 1) setPixel(rgba, canvas, x, y, [80, 160, 200, 255]);
    }
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, canvas, canvas));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "navy_stand",
    });
    const cut = await current.service.call("xsxb_cutout", {
      animation_id: "navy_stand",
      key_mode: "border_flood",
      key_color: "#000000",
      receipt: "short",
    });
    assert.ok(!cut.inspectFeet?.grid, "short receipt still drops the overlay grid");
    assert.equal(cut.keyed, true);
    assert.equal(cut.verify.status, "confirmed");
    assert.ok(cut.preview?.path && fs.existsSync(cut.preview.path));
    const preview = decodePngRgba(cut.preview.path);
    let navyPixels = 0;
    for (let offset = 0; offset < preview.data.length; offset += 4) {
      if (
        preview.data[offset] === navy[0] &&
        preview.data[offset + 1] === navy[1] &&
        preview.data[offset + 2] === navy[2]
      ) {
        navyPixels += 1;
      }
    }
    assert.ok(navyPixels > 0, "magenta preview must show the navy trousers");
  } finally {
    current.cleanup();
  }
});

test("export_sheet normalize=none keeps a short canvas from filling the cell", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "mix");
    fs.mkdirSync(directory);
    writeBodyPng(path.join(directory, "01.png"), 8, 4, 6);
    writeBodyPng(path.join(directory, "02.png"), 16, 4, 6);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "mix",
    });
    const fitted = await current.service.call("xsxb_export_sheet", {
      animation_id: "mix",
      cell: 16,
      pad: 2,
      columns: 2,
      grid: false,
      normalize: "cell",
      output_path: path.join(current.root, "fitted.png"),
    });
    const honest = await current.service.call("xsxb_export_sheet", {
      animation_id: "mix",
      cell: 16,
      pad: 2,
      columns: 2,
      grid: false,
      normalize: "none",
      guides: true,
      output_path: path.join(current.root, "honest.png"),
    });
    assert.equal(honest.normalize, "none");
    const fitSheet = decodePngRgba(fitted.outputPath);
    const honestSheet = decodePngRgba(honest.outputPath);
    const countBody = (sheet, originX) => {
      let count = 0;
      for (let y = 0; y < sheet.height; y += 1) {
        for (let x = originX; x < originX + 16; x += 1) {
          const offset = (y * sheet.width + x) * 4;
          if (sheet.data[offset] === 210 && sheet.data[offset + 1] === 36 && sheet.data[offset + 2] === 42) {
            count += 1;
          }
        }
      }
      return count;
    };
    const fitShort = countBody(fitSheet, 2);
    const fitTall = countBody(fitSheet, 2 + 16 + 2);
    const noneShort = countBody(honestSheet, 2);
    const noneTall = countBody(honestSheet, 2 + 16 + 2);
    assert.ok(
      fitShort > noneShort * 1.3,
      `cell-fit stretches the small canvas fitShort=${fitShort} noneShort=${noneShort} fitTall=${fitTall} noneTall=${noneTall} fitted=${fitted.normalize} honest=${honest.normalize}`,
    );
    assert.ok(Math.abs(noneShort - noneTall) < Math.abs(fitShort - fitTall) || noneShort < fitShort);
  } finally {
    current.cleanup();
  }
});

test("export_gif accepts an outside path, flattens onto magenta, and reports baked visual", async () => {
  const jobs = [];
  const current = fixture({
    encodeGifImpl: async (job) => {
      jobs.push(job);
      const flattened = decodePngRgba(job.framePaths[0]);
      jobs[0].firstPixel = [...flattened.data.subarray(0, 4)];
      fs.writeFileSync(job.outputPath, Buffer.from("GIF89a"));
    },
  });
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
    const outside = path.join(os.tmpdir(), `xsxb-gif-${process.pid}.gif`);
    const exported = await current.service.call("xsxb_export_gif", {
      animation_id: "walk",
      output_path: outside,
      background: "magenta",
    });
    assert.equal(exported.outputPath, outside);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].firstPixel, [255, 0, 255, 255]);
    fs.rmSync(outside, { force: true });
  } finally {
    current.cleanup();
  }
});

test("import_animation can duplicate the first frame as the loop tail and returns bbox summary", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "loop");
    fs.mkdirSync(directory);
    writeBodyPng(path.join(directory, "01.png"), 16, 4, 8);
    writeBodyPng(path.join(directory, "02.png"), 16, 4, 6);
    const imported = await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "loop",
      loop_endpoint: "duplicate_first",
    });
    assert.equal(imported.importedFrameCount, 3);
    assert.ok(imported.metrics);
    assert.equal(imported.metrics.canvas.width, 16);
    assert.ok(imported.metrics.bboxH.max >= imported.metrics.bboxH.min);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "loop" });
    assert.equal(animation.frameCount, 3);
    assert.equal((animation.animation?.frames || []).length, 3);
  } finally {
    current.cleanup();
  }
});

test("export_overlay paints A red, B cyan, intersection white", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "pair");
    fs.mkdirSync(directory);
    writeBodyPng(path.join(directory, "01.png"), 16, 4, 8, { left: 4 });
    writeBodyPng(path.join(directory, "02.png"), 16, 4, 8, { left: 6 });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "pair",
    });
    const overlay = await current.service.call("xsxb_export_overlay", {
      animation_id: "pair",
      frame_a: 0,
      frame_b: 1,
    });
    assert.ok(fs.existsSync(overlay.outputPath));
    assert.ok(overlay.mse >= 0);
    const image = decodePngRgba(overlay.outputPath);
    let red = 0;
    let cyan = 0;
    let white = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if (image.data[offset + 3] < 16) continue;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      if (r > 200 && g < 40 && b < 40) red += 1;
      else if (r < 40 && g > 200 && b > 200) cyan += 1;
      else if (r > 200 && g > 200 && b > 200) white += 1;
    }
    assert.ok(red > 0 && cyan > 0 && white > 0, JSON.stringify({ red, cyan, white }));
  } finally {
    current.cleanup();
  }
});

test("export_pack_slot copies frames into a game-pack destination", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "run");
    fs.mkdirSync(directory);
    writeBodyPng(path.join(directory, "01.png"), 16, 4, 8);
    writeBodyPng(path.join(directory, "02.png"), 16, 4, 8);
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory,
      animation_id: "run",
    });
    const dest = path.join(os.tmpdir(), `frost_armed-run-front-${process.pid}`);
    fs.rmSync(dest, { recursive: true, force: true });
    const exported = await current.service.call("xsxb_export_pack_slot", {
      animation_id: "run",
      dest,
      slot: "run",
      view: "front",
    });
    assert.equal(exported.copied, 2);
    assert.ok(fs.existsSync(path.join(dest, "0.png")) || exported.paths.length === 2);
    fs.rmSync(dest, { recursive: true, force: true });
  } finally {
    current.cleanup();
  }
});

test("INSTRUCTIONS lead with measure/register and demote smear for walk loops", () => {
  assert.match(INSTRUCTIONS, /xsxb_measure_frames/);
  assert.match(INSTRUCTIONS, /xsxb_register_clip/);
  assert.match(INSTRUCTIONS, /normalize/);
  assert.match(INSTRUCTIONS, /walk loops do not use|do not use.{0,80}attack_trail|走循环别用/i);
  assert.doesNotMatch(INSTRUCTIONS, /crescent-trail-v4/);
});
