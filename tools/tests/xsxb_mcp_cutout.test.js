"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { NUMERIC_PARAMETER_LIMITS } = require("../animation_tuner/public/batch_cutout_session_core");
const { createXsxbMcpService, toolDefinitions } = require("../xsxb_mcp_service");
const { measureFrame } = require("../xsxb_mcp_visual_qa");
const {
  alreadyCutOut,
  cutoutFrameFiles,
  compressPngFile,
  decodePngRgba,
  encodePngRgba,
  placeFramesOnCanvas,
  shiftFrameRgba,
  subjectAnchor,
} = require("../xsxb_mcp_cutout");

/**
 * Converts a workbench camelCase slider key to the MCP snake_case argument.
 * @param {string} name Workbench parameter key.
 * @returns {string} MCP argument name.
 */
function toSnake(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

const GREEN = [0, 255, 0, 255];
const BODY = [210, 36, 42, 255];
const SLASH = [240, 250, 255, 255];

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
 * Builds a green-screen frame with a standing body and optional slash below the feet.
 * @param {{slash?:boolean,transparent?:boolean}} [options] Frame options.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function greenScreenFrame(options = {}) {
  const width = 16;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (!options.transparent) {
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(GREEN, offset);
  }
  for (let y = 6; y <= 11; y += 1) {
    setPixel(rgba, width, 7, y, BODY);
    setPixel(rgba, width, 8, y, BODY);
  }
  if (options.slash) {
    for (let x = 6; x <= 14; x += 1) setPixel(rgba, width, x, 14, SLASH);
    for (let x = 8; x <= 14; x += 1) setPixel(rgba, width, x, 15, SLASH);
  }
  return { data: rgba, width, height };
}

test("PNG encode/decode keeps RGBA pixels", () => {
  const source = greenScreenFrame();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-png-"));
  const filePath = path.join(folder, "frame.png");
  try {
    fs.writeFileSync(filePath, encodePngRgba(source.data, source.width, source.height));
    const decoded = decodePngRgba(filePath);
    assert.equal(decoded.width, 16);
    assert.equal(decoded.height, 16);
    assert.deepEqual([...decoded.data.subarray(0, 4)], GREEN);
    assert.deepEqual([...decoded.data.subarray((6 * 16 + 7) * 4, (6 * 16 + 7) * 4 + 4)], BODY);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("subject anchor keeps a large lying body instead of a thin dirt column", () => {
  const width = 24;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 10; y <= 13; y += 1) {
    for (let x = 2; x <= 21; x += 1) setPixel(rgba, width, x, y, BODY);
  }
  for (let y = 1; y <= 8; y += 1) setPixel(rgba, width, 1, y, BODY);
  const anchor = subjectAnchor(rgba, width, height);
  assert.equal(anchor.width, 20);
  assert.equal(anchor.height, 4);
  assert.equal(anchor.feetY, 13);
});

test("subject anchor uses the standing body, not slash pixels below", () => {
  const idle = subjectAnchor(greenScreenFrame({ transparent: true }).data, 16, 16);
  const hit = subjectAnchor(greenScreenFrame({ slash: true, transparent: true }).data, 16, 16);
  assert.equal(idle.feetY, 11);
  assert.equal(hit.feetY, 11);
  assert.equal(idle.height, hit.height);
});

/**
 * Standing body with FX attached to the boot row so they share one island.
 * @param {{glow?:number[]|false,tail?:boolean}} [options] Bright slash or a dark cape.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,bootY:number}} Frame.
 */
function connectedFxFrame(options = {}) {
  const width = 48;
  const height = 48;
  const bootY = 28;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y <= bootY; y += 1) {
    for (let x = 22; x <= 25; x += 1) setPixel(rgba, width, x, y, BODY);
  }
  if (options.tail) {
    for (let y = bootY + 1; y <= bootY + 6; y += 1) {
      for (let x = 23; x <= 25; x += 1) setPixel(rgba, width, x, y, BODY);
    }
  } else if (options.glow !== false) {
    const glow = Array.isArray(options.glow) ? options.glow : SLASH;
    for (let y = bootY + 1; y <= 40; y += 1) setPixel(rgba, width, 25, y, glow);
    for (let y = 41; y <= 42; y += 1) {
      for (let x = 18; x <= 40; x += 1) setPixel(rgba, width, x, y, glow);
    }
  }
  return { data: rgba, width, height, bootY };
}

test("subject anchor ignores connected bright slash below the boots", () => {
  const body = connectedFxFrame({ glow: false });
  const whiteSlash = connectedFxFrame();
  const yellowSlash = connectedFxFrame({ glow: [255, 220, 60, 255] });
  const bodyOnly = subjectAnchor(body.data, body.width, body.height);
  const white = subjectAnchor(whiteSlash.data, whiteSlash.width, whiteSlash.height);
  const yellow = subjectAnchor(yellowSlash.data, yellowSlash.width, yellowSlash.height);
  assert.equal(bodyOnly.feetY, body.bootY);
  assert.equal(white.feetY, body.bootY, "connected near-white slash must not become the sole");
  assert.equal(yellow.feetY, body.bootY, "connected yellow glow must not become the sole");
  assert.equal(white.height, bodyOnly.height);
  assert.equal(measureFrame(whiteSlash.data, 48, 48).feetY, body.bootY);
});

/**
 * Body plus a wide ice splash attached below the boots (one island).
 * Splash is mostly bright ice with darker crystal shadows so luma-only glow skip fails.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,bootY:number,splashBottom:number}} Frame.
 */
function iceSplashFrame() {
  const width = 96;
  const height = 96;
  const bootY = 58;
  const ice = [84, 190, 251, 255];
  const iceShadow = [40, 90, 140, 255];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 16; y <= bootY; y += 1) {
    for (let x = 40; x <= 55; x += 1) setPixel(rgba, width, x, y, BODY);
  }
  for (let y = bootY + 1; y <= 82; y += 1) {
    for (let x = 8; x <= 88; x += 1) {
      setPixel(rgba, width, x, y, (x + y) % 3 === 0 ? iceShadow : ice);
    }
  }
  return { data: rgba, width, height, bootY, splashBottom: 82 };
}

test("subject anchor ignores a wide ice splash below the boots", () => {
  const frame = iceSplashFrame();
  const anchor = subjectAnchor(frame.data, frame.width, frame.height);
  assert.equal(anchor.feetY, frame.bootY, "ice splash must not become the sole");
  assert.ok(anchor.feetY < frame.splashBottom - 8);
  assert.equal(measureFrame(frame.data, frame.width, frame.height).feetY, frame.bootY);
});

/**
 * Impact ice that is NOT a clean wide bright flare: same-width mixed
 * dark/bright crystals plus narrow dark shard tips under the boots.
 * Matches ice_slash_strike impact rows (wideVfx / glow skip do not fire).
 * @returns {{data:Uint8ClampedArray,width:number,height:number,bootY:number,splashBottom:number}} Frame.
 */
function mixedIceFloorFrame() {
  const width = 96;
  const height = 96;
  const bootY = 58;
  const ice = [84, 190, 251, 255];
  const iceShadow = [40, 90, 140, 255];
  const navyTip = [22, 34, 58, 255];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 16; y <= bootY; y += 1) {
    for (let x = 40; x <= 55; x += 1) setPixel(rgba, width, x, y, BODY);
  }
  for (let y = bootY + 1; y <= 74; y += 1) {
    for (let x = 38; x <= 57; x += 1) {
      setPixel(rgba, width, x, y, (x + y) % 3 === 0 ? iceShadow : ice);
    }
  }
  for (let y = 75; y <= 82; y += 1) {
    for (let x = 46; x <= 53; x += 1) setPixel(rgba, width, x, y, navyTip);
  }
  return { data: rgba, width, height, bootY, splashBottom: 82 };
}

test("subject anchor ignores mixed dark/bright ice under the boots, not only a wide flare", () => {
  const frame = mixedIceFloorFrame();
  const anchor = subjectAnchor(frame.data, frame.width, frame.height);
  assert.equal(anchor.feetY, frame.bootY, "mixed ice floor must not become the sole");
  assert.ok(anchor.feetY < frame.splashBottom - 8);
  assert.equal(measureFrame(frame.data, frame.width, frame.height).feetY, frame.bootY);
});

test("subject anchor keeps boots on a real unplanted ice_slash impact when the file exists", () => {
  const filePath = path.resolve(
    __dirname,
    "../../workspace/projects/test/.xsxb/retest-slash/cut/frame_0007.png",
  );
  if (!fs.existsSync(filePath)) return;
  const image = decodePngRgba(filePath);
  const anchor = subjectAnchor(image.data, image.width, image.height);
  assert.ok(anchor, "impact frame must have a subject");
  assert.ok(
    anchor.feetY >= 220 && anchor.feetY <= 234,
    `real impact feetY ${anchor.feetY} should stay on the boots (~225), not the ice floor`,
  );
  assert.ok(anchor.feetY < 260, `feetY ${anchor.feetY} must not sit on the ice floor`);
});

test("subject anchor keeps a dark cape hanging below the boots", () => {
  const cape = connectedFxFrame({ tail: true });
  const anchor = subjectAnchor(cape.data, cape.width, cape.height);
  assert.equal(anchor.feetY, cape.bootY + 6);
});

test("shiftFrameRgba moves opaque pixels down without resampling", () => {
  const width = 8;
  const height = 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  setPixel(rgba, width, 3, 2, BODY);
  const shifted = shiftFrameRgba(rgba, width, height, 0, 3);
  assert.deepEqual([...rgba.subarray((2 * 8 + 3) * 4, (2 * 8 + 3) * 4 + 4)], BODY);
  assert.deepEqual([...shifted.subarray((2 * 8 + 3) * 4, (2 * 8 + 3) * 4 + 4)], [0, 0, 0, 0]);
  assert.deepEqual([...shifted.subarray((5 * 8 + 3) * 4, (5 * 8 + 3) * 4 + 4)], BODY);
});

test("shared canvas placement keeps hit-frame feet on the same ground line", () => {
  const placed = placeFramesOnCanvas(
    [greenScreenFrame({ transparent: true }), greenScreenFrame({ slash: true, transparent: true })],
    16,
    16,
  );
  const idleFeet = subjectAnchor(placed[0].data, 16, 16);
  const hitFeet = subjectAnchor(placed[1].data, 16, 16);
  assert.equal(idleFeet.feetY, 15);
  assert.equal(hitFeet.feetY, 15);
  assert.ok(placed[0].data[(15 * 16 + 8) * 4 + 3] > 16, "idle feet land on the canvas bottom");
  assert.ok(placed[1].data[(15 * 16 + 8) * 4 + 3] > 16, "hit feet land on the same canvas bottom");
});

test("shared canvas placement pins boots, not connected slash, to the ground", () => {
  const placed = placeFramesOnCanvas([connectedFxFrame({ glow: false }), connectedFxFrame()], 48, 48);
  const idleFeet = subjectAnchor(placed[0].data, 48, 48);
  const hitFeet = subjectAnchor(placed[1].data, 48, 48);
  assert.equal(idleFeet.feetY, 47);
  assert.equal(hitFeet.feetY, 47);
  assert.ok(placed[0].data[(47 * 48 + 24) * 4 + 3] > 16, "idle boots land on the canvas bottom");
  assert.ok(placed[1].data[(47 * 48 + 24) * 4 + 3] > 16, "hit boots land on the same canvas bottom");
  let slashOnBottom = 0;
  for (let x = 0; x < 48; x += 1) {
    const offset = (47 * 48 + x) * 4;
    const luma =
      0.2126 * placed[1].data[offset] +
      0.7152 * placed[1].data[offset + 1] +
      0.0722 * placed[1].data[offset + 2];
    if (placed[1].data[offset + 3] > 16 && luma >= 200) slashOnBottom += 1;
  }
  assert.equal(slashOnBottom, 0, "connected slash must not be the planted ground row");
});

test("cutoutFrameFiles names the first missing path instead of dropping it", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-missing-"));
  const idlePath = path.join(folder, "idle.png");
  try {
    fs.writeFileSync(idlePath, encodePngRgba(greenScreenFrame().data, 16, 16));
    assert.throws(
      () => cutoutFrameFiles([idlePath, path.join(folder, "missing.png")]),
      /missing on-disk frame/,
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("cutoutFrameFiles uses the tuner smart-cutout path and keeps source layout by default", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-smart-"));
  const idlePath = path.join(folder, "idle.png");
  const hitPath = path.join(folder, "hit.png");
  try {
    const idle = greenScreenFrame();
    const hit = greenScreenFrame({ slash: true });
    fs.writeFileSync(idlePath, encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(hitPath, encodePngRgba(hit.data, hit.width, hit.height));

    const result = cutoutFrameFiles([idlePath, hitPath]);
    assert.equal(result.pipeline, "smart_product");
    assert.equal(result.rematched, false);
    assert.equal(result.outputWidth, 16);
    assert.equal(result.outputHeight, 16);

    const cutIdle = decodePngRgba(idlePath);
    const cutHit = decodePngRgba(hitPath);
    assert.ok(cutIdle.data[3] <= 16, "green background becomes transparent");
    assert.equal(cutIdle.data[(6 * 16 + 7) * 4 + 3], 255, "body stays opaque");
    assert.ok(cutIdle.data[(6 * 16 + 7) * 4] > 180, "body red channel is preserved");
    assert.equal(subjectAnchor(cutIdle.data, 16, 16).feetY, 11);
    assert.equal(subjectAnchor(cutHit.data, 16, 16).feetY, 11);
    assert.ok(cutHit.data[(14 * 16 + 10) * 4 + 3] > 16, "slash stays in its source row when layout is kept");
    assert.equal(alreadyCutOut(cutIdle.data, 16, 16), true);

    const skipped = cutoutFrameFiles([idlePath, hitPath]);
    assert.equal(skipped.skippedFrameCount, 2);
    assert.equal(skipped.processedFrameCount, 0);
    assert.equal(result.verify.status, "confirmed");
    assert.equal(
      skipped.verify.status,
      "suspected_noop",
      "all-skip still succeeds but must label suspected_noop",
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Builds a frame whose flat background surrounds a centered opaque block.
 * @param {number[]} background Background RGB.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function flatBackgroundFrame(background) {
  const width = 16;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= 4 && x < 12 && y >= 4 && y < 12;
      setPixel(rgba, width, x, y, inside ? BODY : [...background, 255]);
    }
  }
  return { data: rgba, width, height };
}

/**
 * Counts pixels the cutout turned fully transparent.
 * @param {Uint8ClampedArray} rgba RGBA pixels.
 * @returns {number} Cleared pixel count.
 */
function clearedPixels(rgba) {
  let cleared = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) if (rgba[offset] <= 16) cleared += 1;
  return cleared;
}

// A green screen alone cannot prove the cutout works: a profile that keeps every
// pixel still lands near alpha 13 there, under the "background is gone" threshold.
// A white or gray studio plate comes back fully opaque instead, so cover all three.
for (const [label, background] of [
  ["white", [255, 255, 255]],
  ["studio gray", [128, 128, 128]],
  ["green screen", [0, 177, 64]],
]) {
  test(`cutoutFrameFiles clears a flat ${label} background`, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-plate-"));
    const framePath = path.join(folder, "frame.png");
    try {
      const frame = flatBackgroundFrame(background);
      fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));

      const receipt = cutoutFrameFiles([framePath]);

      assert.equal(receipt.processedFrameCount, 1);
      const cut = decodePngRgba(framePath);
      assert.equal(clearedPixels(cut.data), 16 * 16 - 8 * 8, "every background pixel is cleared");
      assert.equal(cut.data[(6 * 16 + 6) * 4 + 3], 255, "the subject stays opaque");
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
}

test("a frame with transparent corners but an opaque background is not treated as cut out", () => {
  const frame = flatBackgroundFrame([255, 255, 255]);
  for (const [x, y] of [
    [0, 0],
    [15, 0],
    [0, 15],
    [15, 15],
  ]) {
    setPixel(frame.data, 16, x, y, [0, 0, 0, 0]);
  }

  assert.equal(alreadyCutOut(frame.data, 16, 16), false);
});

test("cutout still processes a frame whose corners alone are transparent", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-corners-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const frame = flatBackgroundFrame([255, 255, 255]);
    for (const [x, y] of [
      [0, 0],
      [15, 0],
      [0, 15],
      [15, 15],
    ]) {
      setPixel(frame.data, 16, x, y, [0, 0, 0, 0]);
    }
    fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));

    const receipt = cutoutFrameFiles([framePath]);

    assert.equal(receipt.skippedFrameCount, 0, "a leftover background must not be reported as done");
    assert.equal(receipt.processedFrameCount, 1);
    assert.equal(clearedPixels(decodePngRgba(framePath).data), 16 * 16 - 8 * 8);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("pale subject pixels on the already-cut edge do not force a second cut", () => {
  const width = 32;
  const height = 32;
  const band = 3;
  for (const [label, color] of [
    ["white hair", [250, 248, 245, 255]],
    ["gray cloak", [128, 128, 132, 255]],
    ["near-black outline", [18, 16, 14, 255]],
  ]) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < band; y += 1) {
      for (let x = 0; x < width; x += 1) setPixel(rgba, width, x, y, color);
    }
    for (let y = band; y < height; y += 1) {
      for (let x = 0; x < band; x += 1) setPixel(rgba, width, x, y, color);
    }
    assert.equal(
      alreadyCutOut(rgba, width, height),
      true,
      `${label} on a punched field must stay already-cut`,
    );
  }
});

test("a subject touching the frame edge does not force a second destructive cutout", () => {
  const width = 16;
  const height = 16;
  const rgba = new Uint8ClampedArray(width * height * 4);
  // Already cut out: transparent everywhere except a body column that runs off
  // the bottom edge, so part of the border ring is legitimately opaque.
  for (let y = 4; y < height; y += 1) {
    for (let x = 7; x <= 8; x += 1) setPixel(rgba, width, x, y, BODY);
  }

  assert.equal(alreadyCutOut(rgba, width, height), true);
});

/**
 * Large studio plate with a 1px transparent gutter. The leftover plate sits
 * inside the sampled band but is a minority of that band, so the outer-ring
 * fallback would skip it on canvases bigger than 16×16.
 * @param {number} size Edge length.
 * @param {number[]} background Plate RGB.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} RGBA frame.
 */
function largeGutterPlateFrame(size, background) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (dist === 0) setPixel(rgba, size, x, y, [0, 0, 0, 0]);
      else if (dist <= 2) setPixel(rgba, size, x, y, [...background, 255]);
      else setPixel(rgba, size, x, y, BODY);
    }
  }
  return { data: rgba, width: size, height: size };
}

test("a 1px gutter on a large still-plated canvas is not treated as cut out", () => {
  for (const [label, background] of [
    ["white", [255, 255, 255]],
    ["green", [0, 177, 64]],
  ]) {
    const frame = largeGutterPlateFrame(256, background);
    assert.equal(
      alreadyCutOut(frame.data, 256, 256),
      false,
      `${label} leftover plate in the inner band must not be skipped`,
    );
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-large-gutter-"));
    const framePath = path.join(folder, "frame.png");
    try {
      fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));
      const keyColor = background[0] === 255 && background[1] === 255 ? "#ffffff" : "#00b140";
      const receipt = cutoutFrameFiles([framePath], { keyColor });
      assert.equal(receipt.skippedFrameCount, 0, `${label} leftover plate must be processed`);
      assert.equal(receipt.processedFrameCount, 1, `${label} leftover plate must be keyed`);
      const cut = decodePngRgba(framePath);
      assert.equal(cut.data[(2 * 256 + 2) * 4 + 3], 0, `${label} leftover plate is keyed`);
      const bodyX = 128;
      const bodyY = 128;
      assert.equal(cut.data[(bodyY * 256 + bodyX) * 4 + 3], 255, `${label} body stays opaque`);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
});

test("a transparent gutter around a still-plated frame is not treated as cut out", () => {
  const frame = flatBackgroundFrame([255, 255, 255]);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      if (y === 0 || y === 15 || x === 0 || x === 15) setPixel(frame.data, 16, x, y, [0, 0, 0, 0]);
    }
  }
  assert.equal(
    alreadyCutOut(frame.data, 16, 16),
    false,
    "a 1px transparent pad must not hide an opaque studio plate",
  );

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-gutter-"));
  const framePath = path.join(folder, "frame.png");
  try {
    fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));
    const receipt = cutoutFrameFiles([framePath]);
    assert.equal(receipt.skippedFrameCount, 0);
    assert.equal(receipt.processedFrameCount, 1);
    const cut = decodePngRgba(framePath);
    assert.equal(cut.data[(2 * 16 + 2) * 4 + 3], 0, "studio plate is keyed");
    assert.equal(cut.data[(6 * 16 + 6) * 4 + 3], 255, "body stays opaque");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("auto-key uses the studio plate, not the majority subject", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-majority-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const width = 32;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const margin = y < 2 || y >= height - 2 || x < 2 || x >= width - 2;
        setPixel(rgba, width, x, y, margin ? [255, 255, 255, 255] : BODY);
      }
    }
    fs.writeFileSync(framePath, encodePngRgba(rgba, width, height));
    const receipt = cutoutFrameFiles([framePath]);
    assert.match(receipt.backgroundColor, /^#f{2}/i, "auto-key must pick the white studio plate");
    const cut = decodePngRgba(framePath);
    assert.equal(cut.data[3], 0, "white margin becomes transparent");
    assert.equal(cut.data[(16 * 32 + 16) * 4 + 3], 255, "center body stays opaque");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("explicit canvas rematch shares one scale and pins body feet to the bottom", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-canvas-"));
  const idlePath = path.join(folder, "idle.png");
  const hitPath = path.join(folder, "hit.png");
  try {
    const idle = greenScreenFrame();
    const hit = greenScreenFrame({ slash: true });
    fs.writeFileSync(idlePath, encodePngRgba(idle.data, idle.width, idle.height));
    fs.writeFileSync(hitPath, encodePngRgba(hit.data, hit.width, hit.height));

    const result = cutoutFrameFiles([idlePath, hitPath], { outputWidth: 20, outputHeight: 20 });
    assert.equal(result.rematched, true);
    assert.equal(result.outputWidth, 20);
    assert.equal(result.outputHeight, 20);
    assert.equal(
      result.verify.status,
      "confirmed",
      "rematch is not a noop even if some frames were already cut",
    );

    const cutIdle = decodePngRgba(idlePath);
    const cutHit = decodePngRgba(hitPath);
    assert.equal(subjectAnchor(cutIdle.data, 20, 20).feetY, 19);
    assert.equal(subjectAnchor(cutHit.data, 20, 20).feetY, 19);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("rematch after an all-skip key is confirmed, not suspected_noop", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-rematch-skip-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const idle = greenScreenFrame({ transparent: true });
    fs.writeFileSync(framePath, encodePngRgba(idle.data, idle.width, idle.height));
    const skipped = cutoutFrameFiles([framePath]);
    assert.equal(skipped.processedFrameCount, 0);
    assert.equal(skipped.rematched, false);
    assert.equal(skipped.verify.status, "suspected_noop");
    const rematched = cutoutFrameFiles([framePath], { outputWidth: 20, outputHeight: 20 });
    assert.equal(rematched.rematched, true);
    assert.equal(rematched.processedFrameCount, 0);
    assert.equal(
      rematched.verify.status,
      "confirmed",
      "rematched true is not a noop even when processed is 0",
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("per-frame scales rematch different body heights to one standing size", () => {
  const short = greenScreenFrame({ transparent: true });
  const tall = greenScreenFrame({ transparent: true });
  for (let y = 6; y <= 7; y += 1) {
    setPixel(short.data, 16, 7, y, [0, 0, 0, 0]);
    setPixel(short.data, 16, 8, y, [0, 0, 0, 0]);
  }
  const shortAnchor = subjectAnchor(short.data, 16, 16);
  const tallAnchor = subjectAnchor(tall.data, 16, 16);
  assert.equal(shortAnchor.height, 4);
  assert.equal(tallAnchor.height, 6);

  const placed = placeFramesOnCanvas([short, tall], 16, 16, { frameScales: [1.5, 1] });
  const shortPlaced = subjectAnchor(placed[0].data, 16, 16);
  const tallPlaced = subjectAnchor(placed[1].data, 16, 16);
  assert.equal(shortPlaced.height, 6);
  assert.equal(tallPlaced.height, 6);
  assert.equal(shortPlaced.feetY, 15);
  assert.equal(tallPlaced.feetY, 15);
});

test("xsxb_cutout slider schema matches the tuner workbench ranges", () => {
  const cutout = toolDefinitions().find((tool) => tool.name === "xsxb_cutout");
  assert.ok(cutout, "xsxb_cutout is in the catalog");
  for (const [key, limits] of Object.entries(NUMERIC_PARAMETER_LIMITS)) {
    const snake = toSnake(key);
    const property = cutout.inputSchema.properties[snake];
    assert.ok(property, `${snake} is declared`);
    assert.equal(property.minimum, limits.minimum, snake);
    assert.equal(property.maximum, limits.maximum, snake);
    assert.equal(
      property.default,
      undefined,
      `${snake} has no advertised idle default so agents omit it for the smart profile`,
    );
  }
  assert.equal(cutout.inputSchema.properties.connected?.type, "boolean");
  assert.equal(cutout.inputSchema.properties.perceptual?.type, "boolean");
  assert.deepEqual(cutout.inputSchema.properties.blend_mode?.enum, ["general", "blend", "chroma"]);
  assert.deepEqual(cutout.inputSchema.properties.despill_mode?.enum, ["general", "blend", "chroma"]);
});

test("protection_tolerance 0 stays off like the tuner slider", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-protect0-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const width = 16;
    const height = 16;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const plate = [0, 177, 64, 255];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inside = x >= 4 && x < 12 && y >= 4 && y < 12;
        setPixel(rgba, width, x, y, inside ? BODY : plate);
      }
    }
    fs.writeFileSync(framePath, encodePngRgba(rgba, width, height));

    const receipt = cutoutFrameFiles([framePath], {
      keyColor: "#00b140",
      protectedColors: ["#00b140"],
      protectionTolerance: 0,
    });

    assert.equal(receipt.options.protectionTolerance, 0);
    const cut = decodePngRgba(framePath);
    assert.ok(cut.data[3] <= 16, "unprotected green plate is keyed");
    assert.equal(cut.data[(6 * 16 + 6) * 4 + 3], 255, "the subject stays opaque");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("perceptual false on a black plate does not re-enable the broken reference key", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-black-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const frame = flatBackgroundFrame([8, 7, 9]);
    fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));
    const receipt = cutoutFrameFiles([framePath], { keyColor: "#080709", perceptual: false });
    assert.equal(receipt.options.referenceChromaKey, false);
    const cut = decodePngRgba(framePath);
    assert.ok(cut.data[3] <= 16, "black plate is still keyed");
    assert.equal(cut.data[(6 * 16 + 6) * 4 + 3], 255, "the subject stays opaque");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Builds a chroma plate with a colored body and a white hair block.
 * A 1×1 or tiny field cannot tell “keyed to alpha 13 fog” from “cleared”.
 * @returns {{data:Uint8ClampedArray,width:number,height:number,subject:number}} RGBA frame.
 */
function chromaHeroFrame() {
  const width = 64;
  const height = 48;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let subject = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const body = x >= 24 && x < 40 && y >= 16 && y < 40;
      const hair = x >= 26 && x < 38 && y >= 10 && y < 16;
      if (hair) {
        setPixel(rgba, width, x, y, [250, 250, 250, 255]);
        subject += 1;
      } else if (body) {
        setPixel(rgba, width, x, y, BODY);
        subject += 1;
      } else {
        setPixel(rgba, width, x, y, [1, 243, 0, 255]);
      }
    }
  }
  return { data: rgba, width, height, subject };
}

test("chroma cutout zeros the plate instead of leaving alpha-13 fog", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-chroma-zero-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const frame = chromaHeroFrame();
    fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));
    cutoutFrameFiles([framePath]);
    const cut = decodePngRgba(framePath);
    assert.equal(cut.data[3], 0, "corner plate must be fully transparent, not alpha-13 fog");
    assert.equal(cut.data[(47 * 64 + 63) * 4 + 3], 0);
    const metrics = measureFrame(cut.data, cut.width, cut.height);
    assert.ok(metrics.opaque < frame.width * frame.height * 0.5, "opaque must not count the fog as subject");
    assert.ok(metrics.opaque >= frame.subject * 0.8, "body and hair stay countable");
    let white = 0;
    for (let offset = 0; offset < cut.data.length; offset += 4) {
      if (cut.data[offset + 3] > 16 && cut.data[offset] > 220 && cut.data[offset + 1] > 220) white += 1;
    }
    assert.ok(white >= 12, "white hair survives the first cut");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("force without a key does not re-key an already-cut chroma frame", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-force-skip-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const frame = chromaHeroFrame();
    fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));
    const first = cutoutFrameFiles([framePath]);
    assert.equal(first.processedFrameCount, 1);
    const afterFirst = decodePngRgba(framePath);
    let whiteBefore = 0;
    for (let offset = 0; offset < afterFirst.data.length; offset += 4) {
      if (
        afterFirst.data[offset + 3] > 16 &&
        afterFirst.data[offset] > 220 &&
        afterFirst.data[offset + 1] > 220
      ) {
        whiteBefore += 1;
      }
    }
    const second = cutoutFrameFiles([framePath], { force: true });
    assert.equal(second.keyed, false, "already-cut frames must not pick a new auto key");
    assert.equal(second.processedFrameCount, 0);
    assert.equal(second.verify.status, "suspected_noop");
    const afterForce = decodePngRgba(framePath);
    let whiteAfter = 0;
    for (let offset = 0; offset < afterForce.data.length; offset += 4) {
      if (
        afterForce.data[offset + 3] > 16 &&
        afterForce.data[offset] > 220 &&
        afterForce.data[offset + 1] > 220
      ) {
        whiteAfter += 1;
      }
    }
    assert.equal(whiteAfter, whiteBefore, "force must not eat the white hair");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("workbench tolerance -1 turns the MCP cutout into a no-op", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-off-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const frame = flatBackgroundFrame([255, 255, 255]);
    fs.writeFileSync(framePath, encodePngRgba(frame.data, frame.width, frame.height));

    const receipt = cutoutFrameFiles([framePath], { keyColor: "#ffffff", tolerance: -1 });

    assert.equal(receipt.options.tolerance, -1);
    assert.equal(clearedPixels(decodePngRgba(framePath).data), 0, "the off-stop must leave every pixel");
    assert.equal(decodePngRgba(framePath).data[(6 * 16 + 6) * 4 + 3], 255);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("compressPngFile shrinks a stored PNG without changing pixels", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-compress-"));
  const framePath = path.join(folder, "frame.png");
  try {
    const width = 48;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        rgba.set([x * 5, y * 7, (x + y) * 3, x % 3 === 0 ? 0 : 255], offset);
      }
    }
    fs.writeFileSync(framePath, encodePngRgba(rgba, width, height, { level: 0 }));
    const before = fs.statSync(framePath).size;
    const preview = compressPngFile(framePath, { dryRun: true });
    assert.equal(preview.wrote, false);
    assert.equal(fs.statSync(framePath).size, before, "dry_run must not write");
    assert.ok(preview.bytesAfter < preview.bytesBefore, "stored PNG must shrink under level 9");

    const result = compressPngFile(framePath);
    assert.equal(result.wrote, true);
    assert.ok(result.bytesAfter < before);
    const roundTrip = decodePngRgba(framePath);
    assert.equal(roundTrip.width, width);
    assert.equal(roundTrip.height, height);
    assert.deepEqual(Buffer.from(roundTrip.data), Buffer.from(rgba), "pixels must stay identical");

    const again = compressPngFile(framePath);
    assert.equal(again.wrote, false, "already tight PNG must not rewrite");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("xsxb_cutout file_path cuts a standalone workspace PNG", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-file-"));
  const service = createXsxbMcpService({ root });
  const escapePath = path.join(os.tmpdir(), "xsxb-cutout-escape.png");
  try {
    const frame = flatBackgroundFrame([255, 255, 255]);
    const filePath = path.join(root, "still.png");
    fs.writeFileSync(filePath, encodePngRgba(frame.data, frame.width, frame.height));
    const before = fs.readFileSync(filePath);
    fs.writeFileSync(escapePath, before);
    const receipt = await service.call("xsxb_cutout", { file_path: filePath });
    assert.equal(receipt.pipeline, "smart_product");
    assert.equal(path.basename(receipt.output_path), "still_cut.png");
    assert.match(receipt.output_path.split(path.sep).join("/"), /\/\.xsxb\//);
    assert.equal(fs.existsSync(path.join(root, "still_cut.png")), false);
    assert.deepEqual(fs.readFileSync(filePath), before, "standalone cutout must not rewrite the source");
    const out = decodePngRgba(receipt.output_path);
    assert.ok(clearedPixels(out.data) > 50, "white studio plate must become transparent");
    assert.equal(out.data[(6 * 16 + 6) * 4 + 3], 255, "the opaque body must remain");
    assert.equal(typeof receipt.transparentRatio, "number");
    assert.ok(receipt.transparentRatio > 0.35 && receipt.transparentRatio < 0.97);
    assert.equal(receipt.keyed, true);
    assert.ok(Array.isArray(receipt.corners) && receipt.corners.length === 4);
    assert.equal(receipt.corners[0].a, 0);
    assert.ok(receipt.inspectFeet == null, "default short receipt must not add inspectFeet");
    const full = await service.call("xsxb_cutout", { file_path: filePath, receipt: "full" });
    assert.ok(full.inspectFeet && typeof full.inspectFeet === "object");
    assert.ok(full.inspectFeet.overlayPath || full.inspectFeet.sheetPath);
    assert.match(String(full.inspectFeet.note || ""), /y=-1/);
    await assert.rejects(() => service.call("xsxb_cutout", { file_path: escapePath }), /inside/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(escapePath)) fs.rmSync(escapePath, { force: true });
  }
});

/**
 * Already-cut 32×32 body on a transparent field (interior 8..24).
 * @returns {Uint8ClampedArray} RGBA pixels.
 */
function alreadyCutBody32() {
  const width = 32;
  const height = 32;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 8; y < 24; y += 1) {
    for (let x = 8; x < 24; x += 1) setPixel(rgba, width, x, y, BODY);
  }
  return rgba;
}

test("file_path cutout does not key an already-cut subject to empty", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-file-skip-"));
  const service = createXsxbMcpService({ root });
  try {
    const rgba = alreadyCutBody32();
    assert.equal(alreadyCutOut(rgba, 32, 32), true);
    const filePath = path.join(root, "cut.png");
    fs.writeFileSync(filePath, encodePngRgba(rgba, 32, 32));
    const receipt = await service.call("xsxb_cutout", { file_path: filePath });
    const out = decodePngRgba(receipt.output_path);
    assert.equal(out.data[(16 * 32 + 16) * 4 + 3], 255, "already-cut body must not be keyed to empty");
    assert.notEqual(out.data[3], 255, "transparent field stays transparent");
    let opaque = 0;
    for (let offset = 3; offset < out.data.length; offset += 4) if (out.data[offset] === 255) opaque += 1;
    assert.ok(opaque > 0, "output must not be fully transparent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("border_flood black plate keeps navy trousers that touch the silhouette", () => {
  const width = 32;
  const height = 32;
  const black = [0, 0, 0, 255];
  const skin = [180, 120, 90, 255];
  // Real ice-warrior trousers: dark navy that still has a blue channel.
  const navy = [7, 9, 25, 255];
  const boot = [80, 160, 200, 255];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(black, offset);
  for (let y = 6; y <= 14; y += 1) {
    for (let x = 12; x <= 19; x += 1) setPixel(rgba, width, x, y, skin);
  }
  for (let y = 15; y <= 22; y += 1) {
    for (let x = 12; x <= 19; x += 1) setPixel(rgba, width, x, y, navy);
  }
  for (let y = 23; y <= 25; y += 1) {
    for (let x = 12; x <= 19; x += 1) setPixel(rgba, width, x, y, boot);
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-navy-"));
  const filePath = path.join(folder, "frame.png");
  try {
    fs.writeFileSync(filePath, encodePngRgba(rgba, width, height));
    const receipt = cutoutFrameFiles([filePath], { keyMode: "border_flood", keyColor: "#000000" });
    assert.equal(receipt.keyed, true, "flood that keys the plate is work, not a smart-skip noop");
    assert.equal(receipt.processedFrameCount, 1);
    assert.equal(receipt.verify.status, "confirmed");
    assert.ok(receipt.darkClothes.after > 0, "receipt must count remaining dark clothes");
    assert.equal(receipt.darkClothes.after, receipt.darkClothes.before);
    const out = decodePngRgba(filePath);
    assert.equal(out.data[3], 0, "black plate must key");
    assert.equal(out.data[(10 * width + 15) * 4 + 3], 255, "torso must remain");
    assert.equal(
      out.data[(18 * width + 15) * 4 + 3],
      255,
      "navy trousers must not be keyed as the black plate",
    );
    assert.deepEqual(
      [...out.data.subarray((18 * width + 15) * 4, (18 * width + 15) * 4 + 3)],
      navy.slice(0, 3),
    );
    assert.equal(out.data[(24 * width + 15) * 4 + 3], 255, "boots must remain");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("in-place file_path cutout does not report processedFrameCount 1 when it skipped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-inplace-skip-"));
  const service = createXsxbMcpService({ root });
  try {
    const rgba = alreadyCutBody32();
    const filePath = path.join(root, "cut.png");
    fs.writeFileSync(filePath, encodePngRgba(rgba, 32, 32));
    const before = fs.readFileSync(filePath);
    const receipt = await service.call("xsxb_cutout", { file_path: filePath, output_path: filePath });
    assert.equal(receipt.skippedFrameCount, 1);
    assert.equal(receipt.processedFrameCount, 0);
    assert.equal(receipt.verify.status, "suspected_noop");
    assert.deepEqual(fs.readFileSync(filePath), before, "skipped in-place cutout must not rewrite bytes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
