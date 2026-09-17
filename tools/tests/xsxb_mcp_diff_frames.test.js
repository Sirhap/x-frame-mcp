"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { encodePngRgba } = require("../../mcp/xsxb_mcp_cutout");
const { composeFrameDiff, keyStudioPlate } = require("../../mcp/xsxb_mcp_diff_frames");
const { paintGroundedActor } = require("../acceptance_playbooks");

const CANVAS = 64;
const BODY = Object.freeze({ x0: 22, y0: 14, x1: 40, y1: 52 });
const SWORD = Object.freeze({ x0: 43, y0: 16, x1: 46, y1: 44 });
const PLATE = Object.freeze([248, 248, 248, 255]);
const MAGENTA = Object.freeze([255, 0, 255, 255]);

/**
 * True when a painted pixel is the diff magenta mark.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @param {number} [a] Alpha.
 * @returns {boolean} Magenta mark.
 */
function isDiffMagenta(r, g, b, a = 255) {
  return r >= 220 && g <= 40 && b >= 180 && a > 200;
}

/**
 * Raw RGBA mismatch count — the compare that filled generated idle silhouettes.
 * @param {{data:Uint8ClampedArray|Uint8Array}} frameA First frame.
 * @param {{data:Uint8ClampedArray|Uint8Array}} frameB Second frame.
 * @returns {number} Changed pixel count.
 */
function countRawRgbaMismatches(frameA, frameB) {
  const left = frameA.data;
  const right = frameB.data;
  const limit = Math.min(left.length, right.length);
  let changed = 0;
  for (let offset = 0; offset < limit; offset += 4) {
    if (
      left[offset] !== right[offset] ||
      left[offset + 1] !== right[offset + 1] ||
      left[offset + 2] !== right[offset + 2] ||
      left[offset + 3] !== right[offset + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * Counts magenta marks, optionally inside a box.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} frame Compose result.
 * @param {{x0:number,y0:number,x1:number,y1:number}} [box] Inclusive box.
 * @returns {number} Magenta pixel count.
 */
function countDiffMagenta(frame, box) {
  let count = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (box && (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1)) continue;
      const offset = (y * frame.width + x) * 4;
      if (
        isDiffMagenta(
          frame.data[offset],
          frame.data[offset + 1],
          frame.data[offset + 2],
          frame.data[offset + 3],
        )
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Unique-per-pixel navy so a 1px pad or flatten mismatch explodes a raw RGBA compare.
 * @param {number} x Column.
 * @param {number} y Row.
 * @param {number} [tone] Extra channel bias (interior navy mismatch).
 * @returns {number[]} RGBA.
 */
function texturedNavy(x, y, tone = 0) {
  return [
    Math.min(80, 16 + ((x * 3 + y) % 18) + tone),
    Math.min(96, 30 + ((x * 5 + y * 2) % 22)),
    Math.min(140, 70 + ((x * 2 + y * 7) % 26)),
    255,
  ];
}

/**
 * Paints a 64×64 idle plate: textured coat, optional sword, flatten speckle, pad.
 * @param {{
 *   sword?:boolean,
 *   tone?:number,
 *   padY?:number,
 *   speckle?:boolean,
 *   plate?:readonly number[],
 * }} [options] Idle variants.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Frame.
 */
function paintTexturedIdle(options = {}) {
  const width = CANVAS;
  const height = CANVAS;
  const data = new Uint8ClampedArray(width * height * 4);
  const plate = options.plate || PLATE;
  const tone = Number(options.tone) || 0;
  const padY = Number(options.padY) || 0;
  for (let i = 0; i < width * height; i += 1) data.set(plate, i * 4);
  for (let y = BODY.y0; y <= BODY.y1; y += 1) {
    for (let x = BODY.x0; x <= BODY.x1; x += 1) {
      const destY = y + padY;
      if (destY < 0 || destY >= height) continue;
      data.set(texturedNavy(x, y, tone), (destY * width + x) * 4);
    }
  }
  if (options.sword) {
    for (let y = SWORD.y0; y <= SWORD.y1; y += 1) {
      for (let x = SWORD.x0; x <= SWORD.x1; x += 1) {
        const destY = y + padY;
        if (destY < 0 || destY >= height) continue;
        data.set([196, 204, 212, 255], (destY * width + x) * 4);
      }
    }
  }
  if (options.speckle) {
    for (let i = 0; i < 90; i += 1) {
      const x = (i * 11) % width;
      const y = (i * 5 + 3) % height;
      if (x >= BODY.x0 - 1 && x <= BODY.x1 + 1 && y >= BODY.y0 - 1 && y <= BODY.y1 + 1) continue;
      data.set(MAGENTA, (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

test("composeFrameDiff marks the vacated and newly occupied columns", () => {
  const left = paintGroundedActor(32, 32, { originX: 8, originY: 10 });
  const right = paintGroundedActor(32, 32, { originX: 12, originY: 10 });
  const composed = composeFrameDiff(
    { width: 32, height: 32, data: left },
    { width: 32, height: 32, data: right },
    { mode: "diff" },
  );
  assert.equal(composed.width, 32);
  assert.equal(composed.height, 32);
  assert.ok(composed.changedPixelCount >= 20);
  const png = encodePngRgba(composed.data, composed.width, composed.height);
  assert.ok(png.length > 80);
  assert.ok(countDiffMagenta(composed) >= 20);
});

test("composeFrameDiff concentrates idle sword occupancy, not the shared textured body", () => {
  const unarmed = paintTexturedIdle({ speckle: true });
  const armed = paintTexturedIdle({ sword: true, speckle: true, padY: 1 });
  const composed = composeFrameDiff(unarmed, armed, { mode: "diff" });
  const magenta = countDiffMagenta(composed);
  const swordMagenta = countDiffMagenta(composed, {
    x0: SWORD.x0 - 1,
    y0: SWORD.y0 - 1,
    x1: SWORD.x1 + 1,
    y1: SWORD.y1 + 2,
  });
  const bodyBox = { x0: BODY.x0 + 2, y0: BODY.y0 + 2, x1: BODY.x1 - 2, y1: BODY.y1 - 2 };
  const interiorMagenta = countDiffMagenta(composed, bodyBox);
  const bodyArea = (BODY.x1 - BODY.x0 + 1) * (BODY.y1 - BODY.y0 + 1);
  assert.equal(composed.changedPixelCount, magenta);
  assert.ok(
    composed.changedPixelCount >= 20,
    `sword must remain a solid delta, got ${composed.changedPixelCount}`,
  );
  assert.ok(
    composed.changedPixelCount < bodyArea * 0.35,
    `idle diff filled the body (${composed.changedPixelCount} of ${bodyArea})`,
  );
  assert.ok(swordMagenta >= 20, `sword bbox must hold the delta, got ${swordMagenta}`);
  assert.ok(
    swordMagenta / Math.max(1, magenta) >= 0.75,
    `delta leaked off the blade (${swordMagenta}/${magenta})`,
  );
  assert.ok(interiorMagenta <= 8, `interior coat must not fill magenta, got ${interiorMagenta}`);
});

test("composeFrameDiff ignores a 1px transparent pad so the count does not explode", () => {
  const planted = paintTexturedIdle();
  const padded = paintTexturedIdle({ padY: 1 });
  const rawExplodes = countRawRgbaMismatches(planted, padded);
  const composed = composeFrameDiff(planted, padded, { mode: "diff" });
  const bodyArea = (BODY.x1 - BODY.x0 + 1) * (BODY.y1 - BODY.y0 + 1);
  assert.ok(rawExplodes > bodyArea * 0.5, `fixture must still explode a naive compare, got ${rawExplodes}`);
  assert.ok(
    composed.changedPixelCount < 40,
    `1px pad must not paint the silhouette, got ${composed.changedPixelCount}`,
  );
  assert.ok(countDiffMagenta(composed) < 40);
});

test("composeFrameDiff ignores true-magenta flatten leftovers", () => {
  const clean = paintTexturedIdle();
  const flatten = paintTexturedIdle({ speckle: true });
  const composed = composeFrameDiff(clean, flatten, { mode: "diff" });
  assert.equal(composed.changedPixelCount, 0);
  assert.equal(countDiffMagenta(composed), 0);
  const keyed = keyStudioPlate(flatten);
  let leftover = 0;
  for (let i = 0; i < keyed.data.length; i += 4) {
    if (
      keyed.data[i] === 255 &&
      keyed.data[i + 1] === 0 &&
      keyed.data[i + 2] === 255 &&
      keyed.data[i + 3] > 16
    ) {
      leftover += 1;
    }
  }
  assert.equal(leftover, 0);
});

test("composeFrameDiff warns when interior navy disagrees on the same occupancy", () => {
  const idle = paintTexturedIdle();
  const rekeyed = paintTexturedIdle({ tone: 24 });
  const composed = composeFrameDiff(idle, rekeyed, { mode: "diff" });
  const magenta = countDiffMagenta(composed);
  const bodyArea = (BODY.x1 - BODY.x0 + 1) * (BODY.y1 - BODY.y0 + 1);
  assert.equal(composed.qa, "warn");
  assert.ok((composed.issues || []).some((issue) => /interior|navy|key/i.test(issue)));
  assert.ok(magenta < bodyArea * 0.15, `navy mismatch must not fill the body, got ${magenta}`);
  assert.ok(composed.changedPixelCount < 40, `occupancy is unchanged, got ${composed.changedPixelCount}`);
});

test("composeFrameDiff throws when frame sizes differ", () => {
  const left = paintTexturedIdle();
  const right = {
    width: CANVAS,
    height: CANVAS + 1,
    data: new Uint8ClampedArray(CANVAS * (CANVAS + 1) * 4),
  };
  assert.throws(() => composeFrameDiff(left, right, { mode: "diff" }), /same width and height/i);
});
