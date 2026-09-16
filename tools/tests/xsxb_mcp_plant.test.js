"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectStore } = require("../project_store");
const { MCP_TOOL_NAMES, createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { INSTRUCTIONS } = require("../xsxb_mcp_server");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const { measureSpriteGeometry } = require("../xsxb_mcp_lock");
const { resolveOverlayCell } = require("../xsxb_mcp_plant");
const { canvasToGroup } = require("../xsxb_mcp_visual_qa");

const ICE = Object.freeze([84, 190, 251, 255]);
const BOOT = Object.freeze([210, 36, 42, 255]);

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
 * Feet sit one pixel above the last row (same as lock tests).
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
      setPixel(rgba, canvas, x, y, BOOT);
    }
  }
  return { data: rgba, width: canvas, height: canvas };
}

/**
 * Opaque standing block whose sole sits on an explicit canvas row.
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @param {number} feetY Sole row.
 * @param {number} [bodyW=8] Body width.
 * @param {number} [bodyH=12] Body height.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function bodyOnCanvas(width, height, feetY, bodyW = 8, bodyH = 12) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const left = Math.floor((width - bodyW) / 2);
  const top = feetY - bodyH + 1;
  for (let y = top; y <= feetY; y += 1) {
    for (let x = left; x < left + bodyW; x += 1) {
      setPixel(rgba, width, x, y, BOOT);
    }
  }
  return { data: rgba, width, height };
}

/**
 * Standing figure with disconnected ice crystals hanging below the boots.
 * @param {number} canvas Edge length.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function bodyWithHangingIce(canvas) {
  const rgba = new Uint8ClampedArray(canvas * canvas * 4);
  const bodyW = 8;
  const bodyH = 12;
  const left = Math.floor((canvas - bodyW) / 2);
  const top = 8;
  for (let y = top; y < top + bodyH; y += 1) {
    for (let x = left; x < left + bodyW; x += 1) {
      setPixel(rgba, canvas, x, y, BOOT);
    }
  }
  const iceTop = top + bodyH + 2;
  for (let y = iceTop; y < iceTop + 4; y += 1) {
    for (let x = left + 2; x < left + 6; x += 1) {
      setPixel(rgba, canvas, x, y, ICE);
    }
  }
  return { data: rgba, width: canvas, height: canvas };
}

/**
 * Counts opaque pixels matching an RGB triple.
 * @param {Uint8ClampedArray} rgba Buffer.
 * @param {readonly number[]} color RGBA.
 * @returns {number} Count.
 */
function countColor(rgba, color) {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] < 16) continue;
    if (rgba[offset] === color[0] && rgba[offset + 1] === color[1] && rgba[offset + 2] === color[2]) {
      count += 1;
    }
  }
  return count;
}

/**
 * Isolated tuner root plus MCP service.
 * @param {object} [serviceOptions] Service overrides.
 * @returns {{root:string,service:object,cleanup:Function}} Fixture.
 */
function fixture(serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-plant-"));
  const godotRoot = path.join(root, "godot");
  fs.mkdirSync(godotRoot, { recursive: true });
  fs.writeFileSync(path.join(godotRoot, "project.godot"), '[application]\nconfig/name="Plant"\n');
  createProjectStore(root).addProject({ id: "plant", label: "Plant", projectRoot: godotRoot });
  return {
    root,
    service: createXsxbMcpService({
      root,
      encodeGifImpl: async (job) => {
        fs.writeFileSync(job.outputPath, Buffer.from("GIF89a-fake"));
      },
      ...serviceOptions,
    }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Imports a PNG sequence as walk.
 * @param {object} current Fixture.
 * @param {string} directory Sequence directory.
 * @returns {Promise<object>} Import receipt.
 */
async function importWalk(current, directory) {
  return current.service.call("xsxb_import_animation", {
    source: "png_sequence",
    directory,
    animation_id: "walk",
  });
}

test("catalog contains xsxb_plant_feet immediately after xsxb_shift_frames", () => {
  const shift = MCP_TOOL_NAMES.indexOf("xsxb_shift_frames");
  assert.ok(shift >= 0, "xsxb_shift_frames");
  assert.equal(MCP_TOOL_NAMES[shift + 1], "xsxb_plant_feet");
  assert.ok(MCP_TOOL_NAMES.includes("xsxb_slice_sheet"), "sibling slice_sheet stays in the catalog");
  assert.ok(
    toolDefinitions().some((entry) => entry.name === "xsxb_plant_feet"),
    "schema",
  );
  const names = toolDefinitions().map((entry) => entry.name);
  assert.deepEqual(names, [...MCP_TOOL_NAMES]);
});

test("instructions and plant_feet name walk-loop plant to y=-1 and overlay cell ids", () => {
  const plant = toolDefinitions().find((entry) => entry.name === "xsxb_plant_feet");
  assert.match(INSTRUCTIONS, /xsxb_plant_feet/);
  assert.match(INSTRUCTIONS, /y=-1/);
  assert.match(INSTRUCTIONS, /not 0,0/);
  assert.match(plant.description, /cell:E5|cell ids|overlay cell/i);
  assert.ok(MCP_TOOL_NAMES.includes("xsxb_slice_sheet"));
});

test("apply plants opaque soles onto the last pixel row (±1)", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "seq");
    fs.mkdirSync(directory);
    const frame = bodyFrame(32, 8, 12);
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(frame.data, frame.width, frame.height));
    fs.writeFileSync(path.join(directory, "02.png"), encodePngRgba(frame.data, frame.width, frame.height));
    await importWalk(current, directory);
    const before = measureSpriteGeometry(frame.data, frame.width, frame.height);
    assert.ok(before.feetY < frame.height - 1, "body must stand above y=-1");
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.dryRun, false);
    assert.equal(planted.frames.length, 2);
    assert.equal(planted.frames[0].targetY, -1);
    assert.ok(planted.frames[0].dy >= 1, `expected a downward plant, dy=${planted.frames[0].dy}`);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.ok(
      Math.abs(after.feetY - (image.height - 1)) <= 1,
      `feetY ${after.feetY} should land on last pixel row ${image.height - 1}`,
    );
  } finally {
    current.cleanup();
  }
});

test("plant keeps hanging ice below the sole by padding the canvas", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "seq");
    fs.mkdirSync(directory);
    const frame = bodyWithHangingIce(32);
    const before = measureSpriteGeometry(frame.data, frame.width, frame.height);
    const iceBefore = countColor(frame.data, ICE);
    assert.ok(iceBefore > 0, "fixture must contain ice");
    assert.ok(before.feetY < before.maxY, "ice must hang below the measured sole");
    assert.ok(before.maxY < frame.height - 1, "ice must start on-canvas so a translate can clip it");
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(frame.data, frame.width, frame.height));
    await importWalk(current, directory);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.frames[0].targetY, -1);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    const iceAfter = countColor(image.data, ICE);
    assert.ok(iceAfter >= iceBefore, `ice below the sole was clipped (${iceAfter} < ${iceBefore})`);
    assert.ok(after.feetY < after.maxY, "hanging ice must remain below the sole");
    assert.ok(
      Math.abs(after.feetY - (frame.height - 1)) <= 1,
      `sole ${after.feetY} should still sit on original last pixel ${frame.height - 1}`,
    );
    assert.ok(
      image.height > frame.height,
      "canvas should pad so ice that would leave the bitmap stays visible",
    );
    assert.equal(
      animation.animation.frames[0].height,
      image.height,
      "manifest height must match the padded PNG",
    );
    assert.equal(canvasToGroup(0, after.feetY, image.width, image.height).y, after.feetY - image.height);
    assert.equal(canvasToGroup(0, image.height - 1, image.width, image.height).y, -1);
    const plantedAgain = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      apply: true,
    });
    assert.equal(plantedAgain.frames[0].dy, 0, "a second plant must not walk the origin down the ice");
    const again = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const imageAgain = decodePngRgba(again.animation.frames[0].absolutePath);
    assert.equal(imageAgain.height, image.height);
    assert.equal(again.animation.frames[0].height, imageAgain.height);
    assert.equal(
      measureSpriteGeometry(imageAgain.data, imageAgain.width, imageAgain.height).feetY,
      after.feetY,
    );
  } finally {
    current.cleanup();
  }
});

test("plant apply pads every clip frame to the max canvas after one frame grows", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "seq");
    fs.mkdirSync(directory);
    const grown = bodyWithHangingIce(32);
    const tight = bodyFrame(32, 8, 12);
    const grownBefore = measureSpriteGeometry(grown.data, grown.width, grown.height);
    const tightBefore = measureSpriteGeometry(tight.data, tight.width, tight.height);
    assert.ok(grownBefore.maxY > grownBefore.feetY, "frame 0 must have hanging ice that plant will keep");
    assert.equal(tightBefore.maxY, tightBefore.feetY, "frame 1 must plant without extra overhang");
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(grown.data, grown.width, grown.height));
    fs.writeFileSync(path.join(directory, "02.png"), encodePngRgba(tight.data, tight.width, tight.height));
    await importWalk(current, directory);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      frames: [0],
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.frames.length, 1);
    assert.ok(planted.frames[0].height > grown.height, "plant must grow frame 0 to keep hanging ice");
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const first = decodePngRgba(animation.animation.frames[0].absolutePath);
    const second = decodePngRgba(animation.animation.frames[1].absolutePath);
    const destWidth = Math.max(first.width, second.width);
    const destHeight = Math.max(first.height, second.height);
    assert.equal(first.width, destWidth);
    assert.equal(first.height, destHeight);
    assert.equal(second.width, destWidth);
    assert.equal(second.height, destHeight);
    assert.equal(animation.animation.frames[0].width, destWidth);
    assert.equal(animation.animation.frames[0].height, destHeight);
    assert.equal(animation.animation.frames[1].width, destWidth);
    assert.equal(animation.animation.frames[1].height, destHeight);
    assert.ok(destHeight > tight.height, "unplanted frame 1 must inherit the grown clip canvas");
    const firstAfter = measureSpriteGeometry(first.data, first.width, first.height);
    const secondAfter = measureSpriteGeometry(second.data, second.width, second.height);
    assert.equal(firstAfter.feetY, grown.height - 1, "grown frame sole stays on its planted pixel row");
    assert.equal(
      canvasToGroup(0, secondAfter.feetY, second.width, second.height).y,
      canvasToGroup(0, tightBefore.feetY, tight.width, tight.height).y,
      "origin-preserving pad must keep the unplanted sole on the same group row",
    );
  } finally {
    current.cleanup();
  }
});

test("catalog plant_feet accepts reference_animation_id", () => {
  const plant = toolDefinitions().find((entry) => entry.name === "xsxb_plant_feet");
  assert.ok(plant.inputSchema.properties.reference_animation_id);
  assert.match(plant.inputSchema.properties.reference_animation_id.description, /idle|canvas/i);
  assert.match(
    `${plant.description} ${plant.inputSchema.properties.reference_animation_id.description}`,
    /omitted reference on walk defaults to idle/i,
  );
});

test("plant_feet pads to reference idle canvas then plants onto idle soles", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-seq");
    const walkDir = path.join(current.root, "walk-seq");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idle = bodyOnCanvas(32, 40, 30);
    const walk = bodyOnCanvas(32, 32, 30);
    const idleFeetY = measureSpriteGeometry(idle.data, idle.width, idle.height).feetY;
    assert.equal(idleFeetY, 30);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, walk.width, walk.height));
    fs.writeFileSync(path.join(walkDir, "02.png"), encodePngRgba(walk.data, walk.width, walk.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      reference_animation_id: "idle",
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.referenceAnimationId, "idle");
    assert.equal(planted.frames[0].targetY, canvasToGroup(0, idleFeetY, idle.width, idle.height).y);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 32);
    assert.equal(image.height, 40);
    assert.equal(animation.animation.frames[0].width, 32);
    assert.equal(animation.animation.frames[0].height, 40);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(after.feetY, idleFeetY, `feetY ${after.feetY} should match idle sole row ${idleFeetY}`);
    const idleAnim = await current.service.call("xsxb_get_animation", { animation_id: "idle" });
    const idleImage = decodePngRgba(idleAnim.animation.frames[0].absolutePath);
    assert.equal(idleImage.width, 32);
    assert.equal(idleImage.height, 40);
  } finally {
    current.cleanup();
  }
});

test("plant_feet with idle reference plants walk soles on idle feetY, not padded last row", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-hang");
    const walkDir = path.join(current.root, "walk-tight");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idle = bodyOnCanvas(64, 72, 63);
    const walk = bodyOnCanvas(64, 64, 63);
    const idleBefore = measureSpriteGeometry(idle.data, idle.width, idle.height);
    const walkBefore = measureSpriteGeometry(walk.data, walk.width, walk.height);
    assert.equal(idleBefore.feetY, 63, "idle soles sit on row 63 with 8px hang under the boots");
    assert.equal(idle.height - 1 - idleBefore.feetY, 8);
    assert.equal(walkBefore.feetY, 63, "walk soles sit on the last row of the 64 canvas");
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, walk.width, walk.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      reference_animation_id: "idle",
      target_y: -1,
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.referenceAnimationId, "idle");
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 64);
    assert.equal(image.height, 72);
    assert.equal(animation.animation.frames[0].width, 64);
    assert.equal(animation.animation.frames[0].height, 72);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(
      after.feetY,
      63,
      `walk soles must land on idle feetY 63, not padded last row 71 (got ${after.feetY})`,
    );
    assert.notEqual(after.feetY, image.height - 1, "must not plant onto canvasH-1 of the padded walk canvas");
    const idleAnim = await current.service.call("xsxb_get_animation", { animation_id: "idle" });
    const idleImage = decodePngRgba(idleAnim.animation.frames[0].absolutePath);
    assert.equal(measureSpriteGeometry(idleImage.data, idleImage.width, idleImage.height).feetY, 63);
  } finally {
    current.cleanup();
  }
});

test("plant_feet with idle reference plants onto median idle sole, not the first hang frame", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-span");
    const walkDir = path.join(current.root, "walk-span");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idleHang = bodyOnCanvas(64, 72, 62);
    const idleSole = bodyOnCanvas(64, 72, 63);
    const walk = bodyOnCanvas(64, 64, 63);
    assert.equal(measureSpriteGeometry(idleHang.data, 64, 72).feetY, 62);
    assert.equal(measureSpriteGeometry(idleSole.data, 64, 72).feetY, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idleHang.data, 64, 72));
    fs.writeFileSync(path.join(idleDir, "02.png"), encodePngRgba(idleSole.data, 64, 72));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, 64, 64));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      reference_animation_id: "idle",
      apply: true,
    });
    assert.equal(planted.applied, true);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(
      after.feetY,
      63,
      `walk must land on median idle sole 63, not first-frame hang sole 62 (got ${after.feetY})`,
    );
  } finally {
    current.cleanup();
  }
});

test("plant_feet without reference_animation_id defaults walk to idle canvas and median sole", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-omit");
    const walkDir = path.join(current.root, "walk-omit");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idleHang = bodyOnCanvas(64, 72, 62);
    const idleSole = bodyOnCanvas(64, 72, 63);
    const walk = bodyOnCanvas(64, 64, 63);
    assert.equal(measureSpriteGeometry(idleHang.data, 64, 72).feetY, 62);
    assert.equal(measureSpriteGeometry(idleSole.data, 64, 72).feetY, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idleHang.data, 64, 72));
    fs.writeFileSync(path.join(idleDir, "02.png"), encodePngRgba(idleSole.data, 64, 72));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, 64, 64));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      target_y: -1,
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.referenceAnimationId, "idle");
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 64);
    assert.equal(image.height, 72);
    assert.equal(animation.animation.frames[0].width, 64);
    assert.equal(animation.animation.frames[0].height, 72);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(
      after.feetY,
      63,
      `walk must land on median idle sole 63, not padded last row 71 (got ${after.feetY})`,
    );
    assert.notEqual(after.feetY, image.height - 1, "must not plant onto canvasH-1 of the padded walk canvas");
  } finally {
    current.cleanup();
  }
});

test("plant_feet idle apply without reference stays on its own canvas y=-1", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-self");
    fs.mkdirSync(idleDir);
    const idle = bodyOnCanvas(64, 72, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "idle",
      target_y: -1,
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.referenceAnimationId, undefined);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "idle" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 64);
    assert.equal(image.height, 72);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(after.feetY, 71, "idle must plant onto its own last pixel row, not its authored sole");
  } finally {
    current.cleanup();
  }
});

test("plant_feet empty reference_animation_id does not default walk to idle", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-empty-ref");
    const walkDir = path.join(current.root, "walk-empty-ref");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idle = bodyOnCanvas(64, 72, 63);
    const walk = bodyOnCanvas(64, 64, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, walk.width, walk.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      reference_animation_id: "",
      target_y: -1,
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.referenceAnimationId, undefined);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 64);
    assert.equal(image.height, 64);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(after.feetY, 63, "empty reference must keep walk on its own last row");
  } finally {
    current.cleanup();
  }
});

test("plant_feet missing reference_animation_id still errors", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-missing-ref");
    const walkDir = path.join(current.root, "walk-missing-ref");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idle = bodyOnCanvas(64, 72, 63);
    const walk = bodyOnCanvas(64, 64, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, walk.width, walk.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    await assert.rejects(
      () =>
        current.service.call("xsxb_plant_feet", {
          animation_id: "walk",
          reference_animation_id: "no-such-clip",
          target_y: -1,
          apply: true,
        }),
      /Reference animation not found: no-such-clip/,
    );
  } finally {
    current.cleanup();
  }
});

test("plant_feet omits reference on jump and does not default to idle", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-jump");
    const jumpDir = path.join(current.root, "jump-seq");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(jumpDir);
    const idle = bodyOnCanvas(64, 72, 63);
    const jump = bodyOnCanvas(64, 64, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(jumpDir, "01.png"), encodePngRgba(jump.data, jump.width, jump.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: jumpDir,
      animation_id: "jump",
    });
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "jump",
      target_y: -1,
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.referenceAnimationId, undefined);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "jump" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 64);
    assert.equal(image.height, 64);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(after.feetY, 63, "jump must keep its own canvas and last-row plant");
  } finally {
    current.cleanup();
  }
});

test("plant_feet with idle reference honors an explicit target_y after pad", async () => {
  const current = fixture();
  try {
    const idleDir = path.join(current.root, "idle-explicit");
    const walkDir = path.join(current.root, "walk-explicit");
    fs.mkdirSync(idleDir);
    fs.mkdirSync(walkDir);
    const idle = bodyOnCanvas(64, 72, 63);
    const walk = bodyOnCanvas(64, 64, 63);
    fs.writeFileSync(path.join(idleDir, "01.png"), encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(path.join(walkDir, "01.png"), encodePngRgba(walk.data, walk.width, walk.height));
    await current.service.call("xsxb_import_animation", {
      source: "png_sequence",
      directory: idleDir,
      animation_id: "idle",
    });
    await importWalk(current, walkDir);
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      reference_animation_id: "idle",
      target_y: -5,
      apply: true,
    });
    assert.equal(planted.applied, true);
    assert.equal(planted.frames[0].targetY, -5);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const image = decodePngRgba(animation.animation.frames[0].absolutePath);
    assert.equal(image.width, 64);
    assert.equal(image.height, 72);
    const after = measureSpriteGeometry(image.data, image.width, image.height);
    assert.equal(after.feetY, 67, "explicit target_y=-5 is group Y of canvas row 67 on the 72 canvas");
    assert.notEqual(after.feetY, 63);
    assert.notEqual(after.feetY, 71);
  } finally {
    current.cleanup();
  }
});

test("dry_run does not write workspace PNGs", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "seq");
    fs.mkdirSync(directory);
    const frame = bodyFrame(32, 8, 12);
    const png = encodePngRgba(frame.data, frame.width, frame.height);
    fs.writeFileSync(path.join(directory, "01.png"), png);
    await importWalk(current, directory);
    const animation = await current.service.call("xsxb_get_animation", { animation_id: "walk" });
    const target = animation.animation.frames[0].absolutePath;
    const before = fs.readFileSync(target);
    const preview = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      dry_run: true,
    });
    assert.equal(preview.applied, false);
    assert.equal(preview.dryRun, true);
    assert.ok(preview.frames[0].dy >= 1);
    assert.deepEqual(fs.readFileSync(target), before);
  } finally {
    current.cleanup();
  }
});

test("shift_frames from/to overlay cell ids move by the grid cell delta", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "seq");
    fs.mkdirSync(directory);
    const width = 16;
    const height = 16;
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba.set([210, 36, 42, 255], (8 * width + 8) * 4);
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(rgba, width, height));
    await importWalk(current, directory);
    const grid = { grid_divs: "8x8" };
    const from = resolveOverlayCell("E5", { width, height, grid });
    const to = resolveOverlayCell("e6", { width, height, grid });
    assert.ok(from.x !== to.x || from.y !== to.y, "E5 and E6 must differ");
    let observation = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    const shifted = await current.service.call("xsxb_shift_frames", {
      animation_id: "walk",
      grid_divs: "8x8",
      basis_snapshot_id: observation.observation.snapshotId,
      frames: [{ frame: 0, from: "E5", to: { cell: "E6" } }],
    });
    assert.equal(shifted.shifted[0].dx, Math.trunc(to.x - from.x));
    assert.equal(shifted.shifted[0].dy, Math.trunc(to.y - from.y));
    observation = await current.service.callMcp("xsxb_get_animation", { animation_id: "walk" });
    const planted = await current.service.call("xsxb_plant_feet", {
      animation_id: "walk",
      to: "E5",
      grid_divs: "8x8",
      basis_snapshot_id: observation.observation.snapshotId,
      dry_run: true,
    });
    assert.equal(planted.frames[0].targetY, from.y);
  } finally {
    current.cleanup();
  }
});

test("add_attack_trail polyline stores sticks but does not emit the Hermite mesh", async () => {
  const current = fixture();
  try {
    const directory = path.join(current.root, "seq");
    fs.mkdirSync(directory);
    const frame = bodyFrame(32, 8, 12);
    fs.writeFileSync(path.join(directory, "01.png"), encodePngRgba(frame.data, frame.width, frame.height));
    fs.writeFileSync(path.join(directory, "02.png"), encodePngRgba(frame.data, frame.width, frame.height));
    await importWalk(current, directory);
    const sticks = [
      { frame: 0, top: { x: -8, y: -20 }, bottom: { x: -8, y: -4 }, layer: "front" },
      { frame: 1, top: { x: 8, y: -20 }, bottom: { x: 8, y: -4 }, layer: "front" },
    ];
    const polyline = await current.service.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "chop",
      path_kind: "polyline",
      sticks,
      sync: false,
    });
    const arc = await current.service.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "cleave",
      path_kind: "smooth_arc",
      sticks,
      sync: false,
    });
    assert.equal(polyline.pathKind, "polyline");
    assert.equal(polyline.useMesh, false);
    assert.equal(polyline.segment.generated, false);
    assert.equal(polyline.segment.pathKind, "polyline");
    assert.equal(polyline.segment.sticks.length, 2);
    assert.equal(arc.pathKind, "smooth_arc");
    assert.equal(arc.useMesh, true);
    assert.equal(arc.segment.generated, true);
    await current.service.call("xsxb_remove_binding", {
      animation_id: "walk",
      kind: "trail",
      id: "cleave",
      sync: false,
    });
    const polyGif = await current.service.call("xsxb_export_gif", { animation_id: "walk" });
    assert.equal(polyGif.bakedTrails, false);
    await current.service.call("xsxb_add_attack_trail", {
      animation_id: "walk",
      id: "cleave",
      path_kind: "smooth_arc",
      sticks,
      sync: false,
    });
    const arcGif = await current.service.call("xsxb_export_gif", { animation_id: "walk" });
    assert.equal(arcGif.bakedTrails, true);
  } finally {
    current.cleanup();
  }
});
